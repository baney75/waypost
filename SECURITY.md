# Security

Report a vulnerability through [GitHub private vulnerability reporting](https://github.com/baney75/waypost/security/advisories/new). Include a synthetic reproduction, affected version, and impact. Do not post credentials or real message content in an issue.

## Boundaries

- The MCP server uses stdio. It has no HTTP listener or public endpoint.
- Configuration contains paths and environment-variable names, not credentials. On Unix it cannot be writable by other users; new files use mode 0600.
- Bridge credentials come from the named environment variables. Inject them through your host’s protected secret manager. No credentials in arguments or committed files.
- Mail connections are loopback-only and require a pinned Bridge public certificate. No unpinned TLS fallback.
- Drive invokes a configured absolute executable without a shell. Group/world-writable executables and the CLI’s plaintext session store are rejected.
- Calendar input is restricted to approved snapshot files and protected Proton share links. Link fetches allow only the official HTTPS ICS endpoint, reject redirects, and bound response size/time. Upload input is restricted to the real artifacts directory, including private-owner directory and symlink checks. New artifacts never overwrite files.
- Reads, message size, recurrence expansion, process output, and operation duration are bounded. Write timeouts carry an uncertain-outcome warning; sends are never retried automatically.
- Verification codes are off by default, with separate switches for the browser extension and for agents. The extension reaches Waypost only through Chrome native messaging (no listener). Every message carries a pairing code whose SHA-256 is in the 0600 config. Codes go only to pages whose site matches the sender under the Public Suffix List; free-mail addresses, user-content hosts and notification mail never qualify. Fills are bound to the tab and origin the code was fetched for. Codes are never logged or stored, and message bodies are never returned. Same-user processes remain in scope; see [Verification codes](docs/verification-codes.md#threat-model).
- Sending and uploading are separate, opt-in local policies. Even when enabled, every `mail_send` and `drive_upload` call must carry `confirm: true` or it fails with `CONFIRMATION_REQUIRED`. Prepared message digests bind a send to the reviewed artifact.

Mail, event descriptions, and filenames remain untrusted data. The agent must not treat their contents as new authorization. Local configuration is an operator trust boundary; an agent with unrestricted host filesystem or shell access can change it. A tool description or read-only setting cannot isolate processes running as the same user.

Waypost does not preserve Proton’s encryption boundary once content is returned to an agent. Your model provider may receive the selected plaintext. MCP metadata labels read/write behavior; the implementation enforces the local policy.

Keep Bridge, the official Drive CLI, Node.js, and Waypost updated. Install pinned releases and verify their checksums. Security review and passing tests cover checked paths; they do not establish that every possible deployment is safe.
