# Setup

From a source checkout, replace `waypost` below with `node runtime/waypost.mjs`. To install the command locally, run `npm install -g .`.

Run `waypost init`, then connect the services you need:

```sh
waypost connect drive
waypost connect calendar /absolute/path/to/calendar-export.ics
waypost connect mail --certificate /absolute/path/to/bridge-certificate.pem
waypost doctor
```

Drive discovers the official executable and opens Proton’s browser sign-in. Mail needs Bridge-generated credentials injected through your protected secret manager. Calendar needs an exported snapshot. Use `connect drive --no-signin` to retain an existing session.

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

## Drive

Install the [official CLI](https://proton.me/support/drive-cli), add its absolute executable path, and run `waypost login drive`. Sign in on Proton’s browser page. Sessions use the official CLI’s protected OS store. Its `pass` option means GPG password-store, not Proton Pass. The `unsafe_file` store is unsupported.

`waypost doctor` verifies a directory read within your configured root. Choose a narrow root when an agent needs only one project folder.

## Mail

Install and sign into [Proton Mail Bridge](https://proton.me/mail/bridge). A paid plan including Mail is required. Read the IMAP/SMTP ports and generated username/password from Bridge’s client configuration. In **Settings → Advanced settings → Export TLS certificates**, export to a private directory. Bridge exports a certificate and private key. Point Waypost at the public certificate PEM only; leave the private key out of Waypost and agent configuration. Set **Connection mode** to STARTTLS for these ports. [Official Bridge settings](https://proton.me/support/comprehensive-guide-to-bridge-settings).

Inject the generated client credentials into the named environment variables using your protected secret manager when launching Waypost. The certificate contains no private key. Verify its origin in Bridge; do not trust a certificate obtained from an unknown network endpoint. Account passwords are not valid IMAP credentials.

`waypost mail doctor` authenticates without fetching messages. `--input '{"smtp":true}'` also checks SMTP authentication without sending. `waypost mail list --input '{"mailbox":"INBOX","limit":1}'` proves a bounded mailbox read.

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

For an MCP client, set `command` to the absolute `pass-cli` path and `args` to `["run", "--env-file", "/absolute/path/to/bridge.references.env", "--", "node", "/absolute/path/to/waypost/runtime/waypost.mjs", "mcp"]`. Keep Pass’s output masking enabled. For Codex CLI with the bundled plugin, launch Codex under `pass-cli run` so the plugin inherits these variables. Avoid putting resolved passwords in the client’s plaintext `env` block.

## Calendar

Export the intended calendar through [Proton’s UI](https://proton.me/support/how-to-export-events-from-proton-calendar) and add its local ICS path. A snapshot becomes stale after events change; export again when you need current coverage. Floating times and undeclared timezones fail rather than silently using the host’s timezone. Supported years are 1900–2100. Subdaily recurrence and period-valued RDATE entries are rejected. Recurrence expansion is capped at 20,000 steps and discloses incomplete coverage. A recurring local time inside a spring daylight-saving gap fails explicitly; use corrected UTC events. Timezone definitions are bounded before expansion (64 zones, 16 observances per zone, 512 RDATE values per zone, and 8,192 generated transitions through 2100). Unsupported timezone rules fail with a safe error.

`calendar prepare` requires explicit UTC dates, creates a fresh UID, and returns the artifact and digest. Import it in Proton Calendar, reopen the event, and verify the intended calendar, local date/time, and notification settings. Preparation alone does not save an event.

## Recovery

If `doctor` fails, its JSON identifies the service and a safe error code. Check the official tool’s own sign-in first. Do not delete working sessions or fall back to another account. A timeout is inconclusive. Inspect Drive after a failed upload and the Sent folder after an uncertain SMTP submission before retrying.
