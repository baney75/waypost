#!/usr/bin/env python3
"""Fail when added lines look like credentials.

    python3 tools/secret_scan.py --diff origin/main...HEAD   # lines a branch adds (CI, rsi gate)
    python3 tools/secret_scan.py --commits A..B              # lines each commit adds (hooks/pre-push)
    python3 tools/secret_scan.py --staged                    # lines staged for commit (hooks/pre-commit)
    python3 tools/secret_scan.py FILE...                     # whole files

Prints the file, line number and pattern name, never the matched value.
Exit 1 on any hit. Test fixtures assemble fake credentials at runtime
("gh" + "p_" + "x" * 36) so GitGuardian never sees a contiguous one. A line that
must still contain a look-alike can end with `secret-scan: allow`; reviewers see
that marker in the diff.
"""

from __future__ import annotations

import argparse
import re
import subprocess
import sys
from pathlib import Path

PATTERNS = {
    "private key block": re.compile(r"-----BEGIN (?:RSA |EC |OPENSSH |DSA |PGP |ENCRYPTED )?PRIVATE KEY-----"),
    "GitHub token": re.compile(r"\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{36}\b|\bgithub_pat_[A-Za-z0-9_]{60,}\b"),
    # A string literal that ends in a token prefix, the fixture shape GitGuardian flags. Build the
    # prefix from pieces ("gh" + "p_") instead.
    "GitHub token prefix literal": re.compile(r"\b(?:ghp|gho|ghu|ghs|ghr)_['\"]"),
    # A URL with user:password@ in it. git@host:org/repo has no scheme, so it doesn't match.
    "Basic Auth URL": re.compile(r"\bhttps?://[^\s/:@'\"]+:[^\s/@'\"]+@"),
    "Anthropic key": re.compile(r"\bsk-ant-[A-Za-z0-9_-]{20,}"),
    "OpenRouter key": re.compile(r"\bsk-or-[A-Za-z0-9_-]{16,}"),
    "OpenAI-style key": re.compile(r"\bsk-(?!or-|ant-|learn)(?:proj-)?[A-Za-z0-9_-]{32,}"),
    "xAI key": re.compile(r"\bxai-[A-Za-z0-9]{32,}"),
    "AWS access key": re.compile(r"\b(?:AKIA|ASIA)(?!IOSFODNN7EXAMPLE)[0-9A-Z]{16}\b"),
    "Google API key": re.compile(r"\bAIza[0-9A-Za-z_-]{35}\b"),
    "Slack token": re.compile(r"\bxox[baprs]-[A-Za-z0-9-]{10,}"),
    "Stripe live key": re.compile(r"\b(?:sk|rk)_live_[A-Za-z0-9]{20,}"),
    "Tailscale auth key": re.compile(r"\btskey-(?:auth|api|client)-[A-Za-z0-9-]{20,}"),
    "fal key": re.compile(r"\bFAL_KEY\s*=\s*['\"]?[A-Za-z0-9:_-]{20,}"),
    "password literal": re.compile(r"(?i)\b(?:password|passwd|secret|api[_-]?key|token)\s*[:=]\s*['\"][^'\"\s]{12,}['\"]"),
}
ALLOW = "secret-scan: allow"

# NAME=value where NAME looks like a secret env var and the value is a literal (not pass://, ${VAR}, empty).
_ASSIGN = re.compile(
    r"^(?:export\s+)?(?P<name>[A-Z][A-Z0-9_]*(?:API_?KEY|TOKEN|SECRET|PASSWORD|PASSWD)|(?:API_?KEY|TOKEN|SECRET|PASSWORD|PASSWD))=(?P<q>[\'\"]?)(?P<val>.*)(?P=q)\s*$"
)
_PLACEHOLDER = re.compile(
    r"(?i)^(?:pass://.+|"
    r"\$\{[A-Za-z_][A-Za-z0-9_]*(?::-[^}]*)?\}|\$[A-Za-z_][A-Za-z0-9_]*|"
    r"<[^>]+>|"
    r"changeme|replace[_-]?me|todo|test|placeholder|xxx+|x+|your[_-].*|redacted|none|null|"
    r"local[_-]?dev[_-]?key|dev[_-]?token[_-]?\d*|cursor_\.+|example.*|dummy.*|sample.*|"
    r"SYNTHETIC_.*|securePassword\d*|newSecurePassword\d*|my-super-secret|"
    r".*EXAMPLE)$"
)


def _strip_inline_comment(text: str) -> str:
    # Drop a shell trailing comment only when "#" is whitespace-delimited outside quotes.
    # Preserve embedded hashes in unquoted values (SOME_SECRET=a1#fakefakefake).
    out, in_q = [], None
    i = 0
    while i < len(text):
        ch = text[i]
        if in_q:
            out.append(ch)
            if ch == in_q and (i == 0 or text[i - 1] != "\\"):
                in_q = None
        elif ch in "\"'":
            in_q = ch
            out.append(ch)
        elif ch == "#" and (i == 0 or text[i - 1].isspace()):
            break
        else:
            out.append(ch)
        i += 1
    return "".join(out).rstrip()


_CODEY_VALUE = re.compile(
    # Expression syntax only: method/attr call, or known module call forms.
    # Do not exempt bare words like "open" / "os" inside otherwise literal values.
    r"(?:\.\w+\s*\(|\b(?:os|sys|pathlib|subprocess)\s*\.|(?:Path|open)\s*\()"
)


def _bare_assign_hit(text: str) -> bool:
    m = _ASSIGN.match(_strip_inline_comment(text.strip()))
    if not m:
        return False
    val = m.group("val").strip()
    if not val or len(val) < 8:
        return False
    if val.startswith("pass://") or val.startswith("${") or (val.startswith("$") and not val.startswith("$$")):
        return False
    if _PLACEHOLDER.match(val):
        return False
    # Skip Python/JS expressions mistaken for env files.
    if _CODEY_VALUE.search(val):
        return False
    return True


def _quoted_secret_is_placeholder(text: str) -> bool:
    """True when every password-literal match is only a documented placeholder."""
    rx = re.compile(
        r"(?i)\b(?:password|passwd|secret|api[_-]?key|token)\s*[:=]\s*"
        r"([\'\"][^\'\"\s]{12,}[\'\"])"
    )
    found = False
    for m in rx.finditer(text):
        found = True
        raw = m.group(1)
        val = raw[1:-1]  # strip quotes
        if not _PLACEHOLDER.match(val):
            return False
    return found


def scan_lines(lines) -> list[tuple[str, int, str]]:
    hits = []
    for path, number, text in lines:
        if ALLOW in text:
            continue
        matched = False
        for name, pattern in PATTERNS.items():
            if pattern.search(text):
                if name == "password literal" and _quoted_secret_is_placeholder(text):
                    continue
                hits.append((path, number, name))
                matched = True
                break
        if not matched and _bare_assign_hit(text):
            hits.append((path, number, "bare secret assignment"))
    return hits


def added_lines(diff_args: list[str], cwd: Path) -> list[tuple[str, int, str]]:
    output = subprocess.run(["git", "diff", "--no-color", "--unified=0", *diff_args], cwd=cwd,
                            capture_output=True, text=True, check=True).stdout
    lines, path, number = [], "", 0
    in_hunk = False
    for raw in output.splitlines():
        if raw.startswith("diff "):
            in_hunk = False
        elif raw.startswith("@@"):
            in_hunk = True
            match = re.search(r"\+(\d+)", raw)
            number = int(match.group(1)) if match else 0
        elif not in_hunk and raw.startswith("+++"):
            # File header only outside hunks. Inside a hunk, a content line that
            # begins with "++" is emitted as "+++...", which must still be scanned.
            path = raw[6:] if raw.startswith("+++ b/") or raw.startswith("+++ i/") else raw[4:]
        elif in_hunk and raw.startswith("+"):
            lines.append((path, number, raw[1:]))
            number += 1
    return lines


def commit_shas(rev_range: str, cwd: Path) -> list[str]:
    """Commits that would leave on a push of rev_range (two-dot A..B or a single tip)."""
    args = ["git", "rev-list", "--reverse"]
    if ".." in rev_range:
        args.append(rev_range)
    else:
        args.append(rev_range)
    output = subprocess.run(args, cwd=cwd, capture_output=True, text=True, check=True).stdout
    return [line for line in output.splitlines() if line]


def commit_patch(sha: str, cwd: Path) -> str:
    """Patch for one commit, including merges (diff against each parent with -m)."""
    return subprocess.run(
        ["git", "diff-tree", "-m", "-U0", "-p", "--no-commit-id", "--root", sha],
        cwd=cwd, capture_output=True, text=True, check=True,
    ).stdout


def commit_added_lines(rev_range: str, cwd: Path) -> list[tuple[str, int, str]]:
    """Scan each commit's own patch so a secret added then removed still fails the push."""
    lines: list[tuple[str, int, str]] = []
    for sha in commit_shas(rev_range, cwd):
        patch = commit_patch(sha, cwd)
        path, number = "", 0
        short = sha[:12]
        in_hunk = False
        for raw in patch.splitlines():
            if raw.startswith("diff "):
                in_hunk = False
            elif raw.startswith("@@"):
                in_hunk = True
                match = re.search(r"\+(\d+)", raw)
                number = int(match.group(1)) if match else 0
            elif not in_hunk and raw.startswith("+++"):
                rest = raw[6:] if raw.startswith("+++ b/") or raw.startswith("+++ i/") else raw[4:]
                path = f"{short}:{rest}"
            elif in_hunk and raw.startswith("+"):
                lines.append((path, number, raw[1:]))
                number += 1
    return lines


def file_lines(paths: list[Path]) -> list[tuple[str, int, str]]:
    lines = []
    errors: list[str] = []
    for path in paths:
        try:
            text = path.read_text(encoding="utf-8")
        except (UnicodeDecodeError, OSError) as exc:
            errors.append(f"{path}: unreadable ({exc.__class__.__name__})")
            continue
        lines += [(str(path), n, line) for n, line in enumerate(text.splitlines(), 1)]
    if errors:
        for msg in errors:
            print(msg, file=sys.stderr)
        raise SystemExit(2)
    return lines


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("files", nargs="*", type=Path)
    parser.add_argument("--diff", help="git diff range, e.g. origin/main...HEAD")
    parser.add_argument("--commits", help="scan each commit in a rev-list range, e.g. origin/main..HEAD")
    parser.add_argument("--staged", action="store_true")
    parser.add_argument("--cwd", type=Path, default=Path.cwd())
    args = parser.parse_args(argv)
    if args.commits:
        lines = commit_added_lines(args.commits, args.cwd)
    elif args.diff:
        lines = added_lines([args.diff], args.cwd)
    elif args.staged:
        lines = added_lines(["--cached"], args.cwd)
    else:
        lines = file_lines(args.files)
    hits = scan_lines(lines)
    for path, number, name in hits:
        print(f"{path}:{number}: looks like a {name}")
    print(f"secret scan: {len(hits)} hit(s) in {len(lines)} line(s)")
    return 1 if hits else 0


if __name__ == "__main__":
    raise SystemExit(main())
