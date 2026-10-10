# Setup

From a source checkout, replace `waypost` below with `node runtime/waypost.mjs`. To install the command from a fresh clone, first run `npm ci --ignore-scripts` and `npm run build`, then `npm install -g .`.

Run `waypost init`, then connect the services you need:

```sh
waypost connect drive
waypost connect calendar /absolute/path/to/calendar-export.ics
waypost connect mail --certificate /absolute/path/to/bridge-certificate.pem
waypost doctor
```

Before checking direct Mail, provide `WAYPOST_MAIL_USERNAME` and `WAYPOST_MAIL_PASSWORD` through your secret manager; see Mail below. The helper route needs no Bridge credentials on this computer.

Drive discovers the official executable and opens Proton’s browser sign-in. Mail uses local Bridge credentials or an existing read-only helper. Calendar accepts exported files or a protected Proton share link. Use `connect drive --no-signin` to retain an existing session.

For a narrow Drive root, custom ports, or other advanced settings, edit the private JSON file. Keep it mode 0600 and use absolute paths.

```json
{
  "version": 1,
  "artifactsDir": "/absolute/path/to/waypost-artifacts",
  "timeoutMs": 45000,
  "drive": {
    "executable": "/absolute/path/to/proton-drive",
    "root": "/my-files",
    "writeEnabled": false
  },
  "mail": {
    "host": "127.0.0.1",
    "imapPort": 1143,
    "smtpPort": 1025,
    "usernameEnv": "WAYPOST_MAIL_USERNAME",
    "passwordEnv": "WAYPOST_MAIL_PASSWORD",
    "certificate": "/absolute/path/to/bridge-certificate.pem",
    "sendEnabled": false
  },
  "calendar": {
    "files": ["/absolute/path/to/calendar-export.ics"]
  }
}
```

Remove any service block you are not using. Keep `WAYPOST_CONFIG` or the CLI’s `--config` option pointed at this file on the host that runs the MCP.

## Claude Code

From the `waypost` folder:

```sh
claude mcp add waypost --scope user -- node "$PWD/runtime/waypost.mjs" mcp
claude mcp list   # waypost: ... ✔ Connected
```

With a non-default config path, `waypost --config /path/config.json agent-config claude-code` prints the exact command. For direct Bridge, start Claude Code with the Bridge credentials in its environment (see Mail below), for example `pass-cli run --env-file /absolute/path/bridge.references.env -- claude`. Claude Code passes its environment to stdio servers. The helper route needs no credentials in the agent.

## Drive

Install the [official CLI](https://proton.me/support/drive-cli), then run `waypost connect drive`. Add `--executable /absolute/path/to/proton-drive` if it is not on PATH. Use `waypost login drive` to sign in again later. Sign in on Proton’s browser page. Sessions use the official CLI’s protected OS store. Its `pass` option means GPG password-store, not Proton Pass. The `unsafe_file` store is unsupported.

`waypost doctor` verifies a directory read within your configured root. Choose a narrow root when an agent needs only one project folder.

## Mail

Install and sign into [Proton Mail Bridge](https://proton.me/mail/bridge). A paid plan including Mail is required. Read the IMAP/SMTP ports and generated username/password from Bridge’s client configuration. In **Settings → Advanced settings → Export TLS certificates**, export to a private directory. Bridge exports a certificate and private key. Point Waypost at the public certificate PEM only; leave the private key out of Waypost and agent configuration. Set **Connection mode** to STARTTLS for these ports. [Official Bridge settings](https://proton.me/support/comprehensive-guide-to-bridge-settings).

Inject the generated client credentials into the named environment variables using your protected secret manager when launching Waypost. The certificate contains no private key. Verify its origin in Bridge; do not trust a certificate obtained from an unknown network endpoint. Account passwords are not valid IMAP credentials.

On Linux, Bridge’s default ports are IMAP 1143 and SMTP 1025; check the values Bridge shows. If `mail doctor` returns `MAIL_BRIDGE_UNREACHABLE`, Bridge is not running or uses another port. `MAIL_AUTH` means the Bridge-generated username or password is wrong. `MAIL_TLS` means the certificate changed (re-export it and run `connect mail` again) or Bridge is not in STARTTLS mode.

Mailbox names follow Bridge: `INBOX`, `Sent`, `Drafts`, `Archive`, `Spam`, `Trash`, `All Mail`, `Folders/<name>` and `Labels/<name>`. `waypost mail mailboxes` lists them. Searches run on Bridge’s local index; `since` and `before` use the received date.

`waypost mail doctor` authenticates without fetching messages. `--smtp` also checks SMTP authentication without sending. `waypost mail list --mailbox INBOX --limit 1` proves a bounded mailbox read.

### Reuse an authenticated Mail helper

If Bridge already runs on another computer, a locally configured helper can reuse that connection without putting Bridge credentials in the MCP client. Waypost does not expose Bridge ports or create SSH tunnels.

```sh
waypost connect mail --helper /absolute/path/to/read-only-helper
waypost mail doctor
waypost mail list --limit 5
waypost mail read --uid 123
```

The helper must be an executable owned by you. Setup verifies its authentication response before saving the route. Mail sending and SMTP checks require the direct Bridge route; local drafts work with either route. Missing helper metadata is returned as `null`.

The helper receives argument arrays: `check`, `recent --mailbox=INBOX --limit=5`, or `read 123 --mailbox=INBOX`. It returns the read-only JSON contract implemented in [mail-helper.ts](https://github.com/baney75/waypost/blob/main/src/mail-helper.ts). This is a Waypost adapter contract, not a Proton-provided helper. Switching routes preserves Drive and Calendar settings.

### Inject credentials with Proton Pass

One concrete pattern uses the official [Pass CLI](https://protonpass.github.io/pass-cli/commands/contents/run/). Store only the Bridge-generated client credential in a scoped Pass item. A local reference file contains names, not passwords:

```dotenv
WAYPOST_MAIL_USERNAME=pass://AgentTools/Bridge/username
WAYPOST_MAIL_PASSWORD=pass://AgentTools/Bridge/password
```

Use your actual vault/item identifiers. Keep this reference file private. Pass resolves the fields into the child process:

```sh
pass-cli run --env-file /absolute/path/to/bridge.references.env -- node /absolute/path/to/waypost/runtime/waypost.mjs mail doctor
```

For an MCP client, set `command` to the absolute `pass-cli` path and `args` to `["run", "--env-file", "/absolute/path/to/bridge.references.env", "--", "node", "/absolute/path/to/waypost/runtime/waypost.mjs", "mcp"]`. Keep Pass’s output masking enabled. Avoid putting resolved passwords in the client’s plaintext `env` block.

Codex filters environment variables passed to MCP servers. Run `waypost agent-config codex` and add its complete connection entry to `~/.codex/config.toml`; it explicitly forwards the two Bridge variables. This user connection takes precedence over the bundled plugin’s connection. Launch Codex under `pass-cli run --env-file /absolute/path/to/bridge.references.env -- codex` so Pass supplies those variables. The plugin’s skill remains available.

## Calendar

For a one-time snapshot, export from Proton and run `waypost connect calendar /absolute/path/calendar.ics`. For refreshable reads, use a [Proton share link](https://proton.me/support/share-calendar-via-link) for a calendar you own. Proton offers busy-only or full details. Anyone holding a full-view link can read its events, and Proton temporarily needs access to those details. Create a separately labeled link only if that privacy tradeoff is acceptable; revoke it in Proton when finished. Waypost never creates sharing links.

Save the link in an owner-only file, then connect it:

```sh
chmod 600 /absolute/private/personal-calendar.url
waypost connect calendar --url-file /absolute/private/personal-calendar.url --name Personal
waypost calendar agenda --days 7
```

Alternatively, pipe the link with `--url-stdin --name Personal`; Waypost saves it in a private `calendar-links` directory beside its config. Do not put the URL in command arguments, shell history, agent messages, or public logs. Reconnecting the same name replaces its configuration. An old link file is retained; revoke its link in Proton before removing it if no longer used.

Every query fetches the approved link anew and reports `fetchedAt`. Proton may delay updates by up to eight hours; this is not immediate synchronization. A failed fetch returns an error without silently using stale data. Only the official Proton HTTPS ICS endpoint is accepted; redirects are rejected. Other subscribed calendars cannot be re-exported or shared through Proton. Query their original service separately.

Export the intended calendar through [Proton’s UI](https://proton.me/support/how-to-export-events-from-proton-calendar) and add its local ICS path. A snapshot becomes stale after events change; export again when you need current coverage. An event that names an IANA zone (such as `America/Chicago`) without a VTIMEZONE block is read with Node.js’s built-in timezone data, and `sources[].timezonesFromRuntime` says so. Floating times and unknown zone names are never guessed from the host’s timezone. An event Waypost cannot read is left out and listed in `skipped[]` with a reason; the rest of the calendar is still returned. Pass `timezone` (or `--timezone` on `calendar agenda`) to get local `startLocal`/`endLocal` times. Supported years are 1900–2100. Subdaily recurrence and period-valued RDATE entries are rejected. Recurrence expansion is capped at 20,000 steps and discloses incomplete coverage. A recurring event with a local time inside a spring daylight saving gap is skipped and reported; export corrected UTC events for it. Timezone definitions are bounded before expansion (64 zones, 16 observances per zone, 512 RDATE values per zone, and 8,192 generated transitions through 2100). Unsupported timezone rules fail with a safe error.

`calendar prepare` takes one of three time forms: UTC (`2026-10-12T15:00:00Z`), local time with `timezone` (`2026-10-12T09:00:00` and `America/Chicago`, which keeps 9:00 across daylight saving changes and embeds a VTIMEZONE), or days with `allDay` (`2026-10-12`; the end day is exclusive). `rrule` accepts `FREQ=DAILY|WEEKLY|MONTHLY|YEARLY` with `INTERVAL`, `COUNT` or `UNTIL`, `BYDAY`, `BYMONTHDAY`, `BYMONTH`, `BYSETPOS` and `WKST`. A local time inside a daylight saving gap is rejected. Each file gets a fresh UID; the result returns the path and SHA-256. Import it in Proton Calendar, reopen the event, and verify the intended calendar, local date/time, and notification settings. Preparation alone does not save an event.

## Recovery

If `doctor` fails, its JSON identifies the service and a safe error code. Check the official tool’s own sign-in first. Do not delete working sessions or fall back to another account. A timeout is inconclusive. Inspect Drive after a failed upload and the Sent folder after an uncertain SMTP submission before retrying.
