# Verification

Observed on October 2, 2026. Tests use synthetic data; live account checks are listed separately. This records checked behavior, not Proton certification.

| Boundary | Observed result |
| --- | --- |
| Mail transport | Loopback IMAP/SMTP tests require STARTTLS, the pinned certificate, and generated client credentials. An alternate trusted certificate and missing SMTP authentication are rejected. |
| Mail reads | EXAMINE and BODY.PEEK preserve flags. Header and body output is bounded; HTML and attachment content are excluded. |
| Mail sends | Disabled by default. A local EML and exact digest are required. A persistent attempt marker prevents automatic resubmission after uncertainty. Synthetic SMTP tests exercise one submission. |
| Drive | Fixed argument arrays, approved root paths, bounded process output and timeouts. Uploads require an approved local artifact. Downloads use a new directory and reject symlinks. |
| Calendar | UTC and declared-timezone fixtures cover recurrence, exceptions, DST, invalid dates, mixed endpoint types, and bounded hostile timezone rules. Unsupported spring-gap recurrence fails explicitly. |
| MCP / CLI | Protocol initialization, tool schemas, error envelopes, configuration policies, and the bundled runtime are exercised. |

## Version 0.2 connection checks

The local 0.2.0 suite passed 64 tests and the production dependency audit. The Mac CLI and packaged MCP authenticated through an existing read-only Mail helper, read one header and one bounded body, and queried a private Proton-exported calendar. These checks retained only counts and success status. Synthetic tests exercise helper JSON validation, Unicode limits, protected feed URLs, redirect rejection, bounded responses, CLI flag/JSON parity, and artifact directory replacement failures. The helper refuses SMTP; direct Bridge tests continue to cover it.

A live Calendar share-link fetch and live import remain unverified. Do not infer immediate freshness from a fetch timestamp. Proton may delay link updates by up to eight hours.

## Original release live Proton checks

- **Mail Bridge:** authenticated IMAP and SMTP, read one header and one bounded message, then confirmed flags were unchanged. No email was sent.
- **Drive CLI:** listed a directory, uploaded one synthetic text file, inspected it, downloaded it, and compared the bytes. The test file was moved to recoverable trash. The local digest matches the original; this does not verify a Proton-provided remote checksum.
- **Calendar:** snapshot parsing and ICS preparation were tested. Importing into a live Proton calendar and sending invitations were not performed.

Bridge was tested on a Linux host with its existing official session and protected generated credentials. Drive was tested on macOS with its existing official CLI session. Credentials and account content are excluded from the repository.

## Reproduce

```sh
npm ci --ignore-scripts
npm run verify
node scripts/package-plugin.mjs
```

CI checks Node.js 22 and 24 on Linux and macOS. Windows execution is not verified. Account-level checks require your own configured official services and are not part of public CI.

The release archive includes the runtime and dependency licenses. Release assets include SHA-256 manifests and GitHub build attestations. Keep the version pin when installing; see [Updates](updates.md).

The landing page and personal-site project entry were inspected at desktop and phone widths. Keyboard navigation and copy fallback were exercised. Independent Sol security review found Calendar cases that the first passing suite missed; those defects gained regression coverage before release. Cursor Opus 5.5 reviewed rendered design and the setup journey; named documentation and setup defects were corrected.
