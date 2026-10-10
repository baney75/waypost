# Verification

Observed on October 2, 2026. Tests use synthetic data; live account checks are listed separately. This records checked behavior, not Proton certification.

| Boundary | Observed result |
| --- | --- |
| Mail transport | Loopback IMAP/SMTP tests require STARTTLS, the pinned certificate, and generated client credentials. An alternate trusted certificate and missing SMTP authentication are rejected. |
| Mail reads | EXAMINE and BODY.PEEK preserve flags. Header and body output is bounded; HTML and attachment content are excluded. |
| Mail sends | Disabled by default. Each call needs `confirm: true`, a local EML, and its exact digest. A persistent attempt marker prevents automatic resubmission after uncertainty. Synthetic SMTP tests exercise one submission. |
| Drive | Fixed argument arrays, approved root paths, bounded process output and timeouts. Uploads require write policy, `confirm: true`, and an approved local artifact. Downloads use a new directory and reject symlinks. |
| Calendar | UTC and declared-timezone fixtures cover recurrence, exceptions, DST, invalid dates, mixed endpoint types, and bounded hostile timezone rules. Unsupported spring-gap recurrence is skipped and reported per event. |
| MCP / CLI | Protocol initialization, tool schemas, error envelopes, configuration policies, and the bundled runtime are exercised, including over stdio against a real IMAP server. |
| Verification codes | Extraction fixtures for common sender layouts and false positives (orders, dates, phone numbers), site matching, DMARC parsing, the native host's extension check, and the extension in Chromium. |

## Version 0.5.0 checks

Observed on October 9, 2026, on Arch Linux with Node.js 26.8.

- **Suite:** `npm run verify` passed 103 tests, including two end-to-end tests that need no Proton account:
  - The bundled MCP server, started over stdio by the MCP SDK client, read a real IMAP server ([pymap](https://pypi.org/project/pymap/) 0.36.7, in-memory) through STARTTLS with a pinned certificate. It listed folders, paged 30 messages with no gaps or repeats, searched, decoded RFC 2047 and ISO-8859-1 quoted-printable text, converted HTML-only mail without scripts or tracking images, followed a three-message thread, saved a PDF attachment with a matching SHA-256, and left every message unread. Wrong passwords returned `MAIL_AUTH`, missing folders `MAIL_MAILBOX_NOT_FOUND`.
  - The extension, loaded in Chromium 152, reached Waypost through native messaging and filled a GitHub code from the IMAP server into a single field and into six split fields. A lookalike site got no code. With automatic filling turned on for the site, a code that arrived after the field appeared was filled with no click.
- **Claude Code:** `claude mcp add` (into a throwaway home directory) followed by `claude mcp list` reported `✔ Connected`.
- **Live Drive (read-only):** through MCP, `drive_list` returned normalized entries from a real account, `drive_info` on a missing path returned `DRIVE_NOT_FOUND`, and `drive_download` of a 9 MB file matched the SHA-1 stored with its Drive revision. Nothing was uploaded, moved or deleted.
- **Not checked live:** Proton Mail Bridge was not installed on the test machine, so no live Bridge mailbox was read in this release. SMTP was covered only by the synthetic tests. The verification-code DMARC check and SMS source were tested with synthetic headers and a fixture `chat.db`; neither has been run against a live Proton message or a Mac's Messages database.

## Version 0.4.1 checks

Observed on October 4, 2026. Synthetic tests cover a Proton Pass item that holds a share link: the link and a planted password stay out of config and tool results, a second query inside 10 minutes does not fetch again, and the next query after 10 minutes does. A live Proton share link was not created in this release. The Mac still reads the previously connected ICS file until those Pass items exist.

## Version 0.3 checks

Observed on October 4, 2026. The suite passed with new cases: `mail_send` and `drive_upload` reject a missing or false `confirm` before any SMTP submission or Drive call, and MCP advertises `confirm` in both input schemas. No live send or upload was performed.

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

CI checks Node.js 22 and 24 on Linux and macOS and installs pymap for the end-to-end test. The Chromium extension test runs where Chromium is installed (`WAYPOST_CHROMIUM` picks a binary); hosted CI skips it. Windows execution is not verified. Account-level checks require your own configured official services and are not part of public CI.

The release archive includes the runtime and dependency licenses. Release assets include SHA-256 manifests and GitHub build attestations. Keep the version pin when installing; see [Updates](updates.md).

The landing page and personal-site project entry were inspected at desktop and phone widths. Keyboard navigation and copy fallback were exercised. Independent Sol security review found Calendar cases that the first passing suite missed; those defects gained regression coverage before release. Cursor Opus 5.5 reviewed rendered design and the setup journey; named documentation and setup defects were corrected.
