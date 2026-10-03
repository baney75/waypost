# Waypost

Local agent tools for Proton users. Mail uses Bridge, Drive uses the unmodified official CLI, and Calendar uses explicit ICS snapshots/import artifacts. Keep these boundaries visible. Never describe an ICS artifact as a saved live event.

One writer per file. Preserve unrelated changes. Run npm test and npm run check for code changes; exercise the CLI/MCP for interface changes. Keep stdout machine-readable in MCP mode. No account passwords, browser cookies, tokens, or real mailbox/file/calendar content in fixtures, logs, or documentation. Do not weaken TLS or shell boundaries to pass a check.
