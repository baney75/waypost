# Security

Report a vulnerability through [GitHub private vulnerability reporting](https://github.com/baney75/waypost/security/advisories/new). Include a synthetic reproduction, affected version, and impact. Do not post credentials or real message content in an issue.

## Boundaries

- `waypost mcp` uses stdio and opens no listener. `waypost serve` is opt-in and adds an HTTP listener; see Remote access below.
- Configuration contains paths and environment-variable names, not credentials. On Unix it cannot be writable by other users; new files use mode 0600.
- Bridge credentials come from the named environment variables. Inject them through your host’s protected secret manager. No credentials in arguments or committed files.
- Mail connections are loopback-only and require a pinned Bridge public certificate. No unpinned TLS fallback.
- Drive invokes a configured absolute executable without a shell. Group/world-writable executables and the CLI’s plaintext session store are rejected.
- Calendar input is restricted to approved snapshot files and protected Proton share links. Link fetches allow only the official HTTPS ICS endpoint, reject redirects, and bound response size/time. A share link can live in a private owner-only file, a Proton Pass item, or the macOS login keychain; keychain links are read at runtime by `/usr/bin/security find-generic-password -w` with a fixed argument list and no shell, and are never written to config, caches, logs or tool output. Use a dedicated service name for the item. Upload input is restricted to the real artifacts directory, including private-owner directory and symlink checks. New artifacts never overwrite files.
- Reads, message size, recurrence expansion, process output, and operation duration are bounded. Write timeouts carry an uncertain-outcome warning; sends are never retried automatically.
- Verification codes are off by default, with separate switches for the browser extension and for agents. The extension reaches Waypost only through Chrome native messaging (no listener). Every message carries a pairing code whose SHA-256 is in the 0600 config. Codes go only to pages whose site matches the sender under the Public Suffix List; free-mail addresses, user-content hosts and notification mail never qualify. Fills are bound to the tab and origin the code was fetched for. Codes are never logged or stored, and message bodies are never returned. Same-user processes remain in scope; see [Verification codes](docs/verification-codes.md#threat-model).
- Sending and uploading are separate, opt-in local policies. Even when enabled, every `mail_send` and `drive_upload` call must carry `confirm: true` or it fails with `CONFIRMATION_REQUIRED`. Prepared message digests bind a send to the reviewed artifact.

- Agent calendar writes (`calendar_create`, `calendar_update`, `calendar_delete`, `calendar_propose`, `calendar_cancel_invite`) are off until `agentCalendar.writeEnabled`, and every call needs `confirm: true`. They change only Waypost's own store, never a Proton calendar, and each one appends a line to `audit.jsonl` in the store directory. Deletes are soft. Calendars marked `readOnly` refuse every write path.
- Mail organizing (`mail_flag`, `mail_mark`, `mail_move`, `mail_label`) is off until `mail.organizeEnabled`, and every call needs `confirm: true`, so text in an email cannot move mail on its own. Moves to Trash, Spam, Sent, Drafts, Starred and All Mail are refused, and there is no delete.

## Remote access

`waypost serve` exposes four things. Each has its own threat model.

| Surface | Protection | Residual risk |
| --- | --- | --- |
| `/mcp` | OAuth 2.1 access tokens (1 hour) or static bearer tokens; both checked by SHA-256 lookup. A client can generate its own bearer token and register only the hash (`waypost auth token --sha256`). 401 responses point to RFC 9728 metadata. Tokens in query strings are ignored. Stateless transport: each request gets a fresh server. `mail_verification_code` is not exposed remotely unless `http.tools` lists it. Every other tool is, under the same write switches and `confirm: true` as locally; narrow the list with `http.tools`. `pass_lookup` never returns Proton calendar share links. | Anyone with a valid token has the same tool access as a local agent. Revoke with `waypost auth revoke`. |
| `/authorize` | The owner passcode (scrypt) on a consent page that names the client and its redirect host. The form is HMAC-signed and expires in 10 minutes. PKCE S256 is required, codes are single-use and expire in 5 minutes. After 5 wrong passcodes for one client in 15 minutes, approval for that client pauses. `frame-ancestors 'none'`. | A phished passcode grants access; the page always shows where you will be sent. |
| `/register` | Dynamic client registration accepts only exact https callbacks on `http.redirectUris` (claude.ai's by default) and http loopback URIs, at most 30 registrations per 10 minutes. At most 100 clients are kept; only clients that never finished authorizing are evicted. | Registration alone grants nothing. |
| `/token` | Refresh tokens rotate on every use. A reused refresh token revokes its whole grant. Confidential clients are checked in constant time. | — |
| `/feeds/<token>/agents.ics` | A 256-bit random token in the path; only its SHA-256 is stored; revocation takes effect on the next request. The feed holds agent-owned events only, never your mirrored Proton calendars. Paths are not logged by Waypost. | Anyone who learns the URL can read the Agents calendar until you revoke it. Your proxy or tunnel provider may log request paths. Treat the URL as a password. |

The server checks the Host header against `publicUrl`, loopback names and `http.allowedHosts`, and refuses other hosts with 421, which blocks DNS rebinding. It writes JSON access logs to stderr with method, route, status and time, never tokens, bodies or feed paths. Run it behind TLS (the Cloudflare tunnel or Tailscale Funnel in `deploy/`). The optional Worker front door forwards only to one fixed upstream, either its `ORIGIN` or a Workers VPC service bound to the tunnel (`ORIGIN_VPC`), and strips cookies both ways. With the VPC binding the tunnel has no public hostname, so the Worker is the only way in. The compose stack runs every container as a non-root user with a read-only root filesystem, no capabilities and `no-new-privileges`, and publishes no host port. Bridge shares Waypost's network namespace and is reachable only on its loopback. Secrets come from Docker secret files, never from environment files in the repository.

Mail, event descriptions, and filenames remain untrusted data. The agent must not treat their contents as new authorization. Local configuration is an operator trust boundary; an agent with unrestricted host filesystem or shell access can change it. A tool description or read-only setting cannot isolate processes running as the same user.

Waypost does not preserve Proton’s encryption boundary once content is returned to an agent. Your model provider may receive the selected plaintext. MCP metadata labels read/write behavior; the implementation enforces the local policy.

Keep Bridge, the official Drive CLI, Node.js, and Waypost updated. Install pinned releases and verify their checksums. Security review and passing tests cover checked paths; they do not establish that every possible deployment is safe.
