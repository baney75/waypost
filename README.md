![Waypost — Mail and files. Calendar handoffs.](assets/github-banner.svg)

![Waypost documentation for Mail, Drive, and Calendar](assets/site-preview.jpg)

Local tools for **Proton Mail, Drive, and Calendar**, shared by a CLI and an MCP server. Built for agents working on your computer.

Built with TypeScript and Node.js.

[Get started](#get-started) · [Add to an agent](#add-to-an-agent) · [Mail with Bridge](#mail-with-proton-bridge) · [Setup](docs/setup.md) · [Proton support](docs/proton-support.md) · [Security](SECURITY.md)

| Service | Connection | What works |
| --- | --- | --- |
| Mail | Proton Mail Bridge, or an authenticated read-only helper | List folders and labels, search and page headers, read messages and threads, save attachments, prepare drafts, optionally send. |
| Drive | Official Proton Drive CLI | List, inspect, download with a checksum check, optionally upload. |
| Calendar | ICS exports or refreshable Proton links | Read an agenda with local times, and prepare import files (timed, all-day, recurring). |
| Codes | Your Proton Mail, plus forwarded SMS on a Mac | Find the newest one-time sign-in code and fill it in the browser. Off until you turn it on. |

Waypost is an independent project. Your Proton account password stays in Proton’s sign-in screens. Bridge and Drive keep separate sessions; Calendar imports need verification in the app. Read the [supported routes and limits](docs/proton-support.md) before connecting an account.

## Get started

Requires **Node.js 22.14+**. You can explore the CLI and prepare calendar files before connecting any service.

```sh
git clone https://github.com/baney75/waypost.git
cd waypost
npm ci --ignore-scripts
npm run build
node dist/cli.js init
node dist/cli.js tools
```

Connect the services you need. Drive opens Proton’s own browser sign-in:

```sh
node dist/cli.js connect drive
node dist/cli.js connect calendar /absolute/path/to/calendar-export.ics
```

Mail uses Bridge’s public certificate and generated credentials, or an existing authenticated read-only helper. Calendar share links are read from a private file or a Proton Pass item and reused for 10 minutes; Proton may delay changes by up to eight hours. Follow [Setup](docs/setup.md), then run:

```sh
node dist/cli.js doctor
```

Each service reports `ready`, `not_configured`, or `failed`. `ready` identifies the check that passed; a parsed Calendar snapshot does not prove live calendar access.

## Add to an agent

The bundled runtime needs only Node.js. From the `waypost` folder, register it with Claude Code for every project:

```sh
claude mcp add waypost --scope user -- node "$PWD/runtime/waypost.mjs" mcp
claude mcp list
```

`claude mcp list` should show `waypost: ... ✔ Connected`. In a session, ask Claude to run `waypost_status`. If you keep the config somewhere other than `~/.config/waypost/config.json`, run `node dist/cli.js --config /path/to/config.json agent-config claude-code` and paste the command it prints.

For Claude Desktop, add this to `claude_desktop_config.json` (Settings, Developer, Edit Config) with the absolute path to your clone, then restart the app. `node dist/cli.js agent-config claude` prints the same entry.

```json
{
  "mcpServers": {
    "waypost": {
      "command": "node",
      "args": ["/absolute/path/to/waypost/runtime/waypost.mjs", "mcp"]
    }
  }
}
```

Direct Bridge reads `WAYPOST_MAIL_USERNAME` and `WAYPOST_MAIL_PASSWORD` from the environment of the process that starts Waypost. See [Mail with Proton Bridge](#mail-with-proton-bridge) and [Setup](docs/setup.md#mail). MCP uses standard input/output and opens no network listener.

### Tools

| Tool | What it does |
| --- | --- |
| `waypost_status` | Which services are set up and which writes are allowed. Works before setup. |
| `mail_mailboxes` | Folder and label names (`Folders/…`, `Labels/…`, `All Mail`). |
| `mail_list` | Newest headers first; filter by `from`, `to`, `subject`, `text`, `unseen`, `since`, `before`; page with `beforeUid`. |
| `mail_read` | One message: text (HTML converted to text), threading IDs, attachment list. Long bodies page with `textOffset`. Never marks mail read. |
| `mail_thread` | Messages in the same conversation. |
| `mail_attachment` | Saves one attachment to the local artifacts folder. |
| `mail_draft`, `mail_send` | Prepare a local EML; sending is off by default and needs `confirm: true` per call. |
| `mail_verification_code` | Newest one-time code, never the body. Off by default. |
| `drive_list`, `drive_info`, `drive_download`, `drive_upload` | Drive under `/my-files`; uploads are off by default and need `confirm: true`. |
| `calendar_events`, `calendar_prepare` | Read events in a window; write an ICS file to import. |
| `pass_lookup` | Proton Pass item names and URLs only. |

Errors come back as `{ok:false, error:{code, message}}`, and the message says what to run or change, for example `MAIL_AUTH`, `MAIL_MAILBOX_NOT_FOUND`, `DRIVE_NOT_FOUND` or `CONFIG_MISSING`.

## Mail with Proton Bridge

[Proton Mail Bridge](https://proton.me/mail/bridge) is Proton's desktop app. It runs on your computer, decrypts your mailbox locally, and serves it on `127.0.0.1` over IMAP and SMTP. Proton Mail has no public mail API, so Waypost reads mail through Bridge. Bridge needs a paid Proton plan that includes Mail.

1. Install Bridge, sign in with your Proton account, and leave it running.
2. In Bridge, open your account and choose **Configure email client** (the account page that lists the hostname, IMAP and SMTP ports, username and password). Bridge generates this username and password for mail clients. Your Proton account password does not work here.
3. In **Settings, Advanced settings, Export TLS certificates**, export to a private folder. Give Waypost only the public certificate PEM, never the private key. Set Bridge's connection mode to STARTTLS.
4. Connect and check:

```sh
node dist/cli.js connect mail --certificate /absolute/path/to/bridge-certificate.pem
WAYPOST_MAIL_USERNAME="bridge-generated-username" \
WAYPOST_MAIL_PASSWORD="bridge-generated-password" \
  node dist/cli.js mail doctor
```

Those two values are placeholders. For daily use, supply them from a secret manager rather than typing them in a shell, for example `pass-cli run --env-file bridge.references.env -- claude`; [Setup](docs/setup.md#mail) shows the pattern. The default ports are IMAP 1143 and SMTP 1025; use whatever Bridge shows.

Without Bridge, these still work:

- **Drive** needs only Proton's [official Drive CLI](https://proton.me/support/drive-cli) and its browser sign-in.
- **Calendar** needs only an exported `.ics` file, or a Proton share link you create yourself. `calendar_prepare` writes import files with no connection at all.
- `waypost_status` and `waypost doctor` run before any setup and report each service as `ready`, `not_configured`, or `failed`.

Mail is the only service that needs Bridge (or an existing read-only helper, see [Setup](docs/setup.md#reuse-an-authenticated-mail-helper)).

## Other agents

`node dist/cli.js agent-config cursor` and `agent-config generic` print entries for other MCP clients; the stdio entry above works in any client that launches a local command.

The [Codex plugin](docs/plugin.md) bundles the runtime and a focused agent skill. Pin it to a release tag from the [releases page](https://github.com/baney75/waypost/releases), replacing `<tag>`:

```sh
codex plugin marketplace add baney75/waypost --ref <tag>
codex plugin add waypost@waypost
```

Service setup is still required after installing the plugin. The GitHub marketplace is separate from OpenAI's reviewed universal directory. Codex filters the environment it passes to MCP servers; see [Setup](docs/setup.md#mail) for the Bridge variables.

## Use the CLI

Install locally with `npm install -g .`, or replace `waypost` below with `node runtime/waypost.mjs`.

```sh
waypost drive list --path /my-files
waypost mail mailboxes
waypost mail list --subject invoice --since 2026-09-01 --limit 20
waypost mail read --uid 123
waypost calendar agenda --days 7 --timezone Europe/London
waypost calendar prepare --summary "Project review" \
  --start 2026-10-05T09:00:00 --end 2026-10-05T09:30:00 --timezone Europe/London \
  --rrule "FREQ=WEEKLY;COUNT=4"
waypost calendar prepare --summary "Vacation" --start 2026-12-21 --end 2026-12-24 --all-day
```

Use normal flags for terminal work, or retain `--input` JSON for scripts. Repeat array flags such as `--to` for each recipient. Commands return JSON. `waypost tools` lists every input schema; `waypost call <tool> --input '{}'` addresses the same tools as MCP.

Mail and Calendar are read-only by default. Mail sends and Drive uploads start disabled; when enabled in local config, each call must still pass `confirm: true` (`--confirm` on the CLI). A send also requires a prepared EML file and its exact SHA-256. Downloads use a new directory. Waypost exposes no permanent-delete or public-sharing tool.

## Fill verification codes

Waypost can find the sign-in code a site just emailed you and fill it in the browser with one click. A small Chromium extension in [`extension/`](extension) talks to Waypost through the browser’s native messaging, so no port is opened. Codes are given only to the site whose domain matches the sender. It is off until you pair it. See [Verification codes](docs/verification-codes.md) for setup on a Mac and the threat model.

## Maintain

`waypost update` checks GitHub release metadata and never installs code. [Updates](docs/updates.md) explains version pinning, checksums, and rollback.

```sh
npm run verify
```

The tests use synthetic data. They drive the MCP server over stdio against a real IMAP server ([pymap](https://pypi.org/project/pymap/), `pipx install pymap==0.36.7`), and run the extension in Chromium when it is installed. Account-level checks require the configured official services. See [Verification](docs/verification.md) for the release’s observed coverage.

[MIT](LICENSE) · [Privacy](docs/privacy.md) · [Contributing](CONTRIBUTING.md)
