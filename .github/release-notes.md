- Reuse an authenticated read-only Mail helper without copying Bridge credentials.
- Read Calendar exports or refresh protected Proton share links on each query, with retrieval times and upstream-delay reporting.
- Use ordinary CLI flags and `calendar agenda`; JSON calls remain supported.
- Reject unsafe artifact directories and downloaded symlinks before reading their contents.

Calendar writes still produce import files. Proton share links are read-only and can lag by up to eight hours. Direct Bridge is required for SMTP. Account passwords remain in Proton’s official tools.

Release assets include SHA-256 checksums. GitHub Actions builds also attest the CLI and plugin archives. The installable Codex marketplace plugin is separate from OpenAI’s reviewed directory.
