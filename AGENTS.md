# Waypost

Local agent tools for Proton users. Mail uses Bridge, Drive uses the unmodified official CLI, and Calendar uses explicit ICS files, approved read-only Proton share links, and import artifacts. A successful fetch proves retrieval time, not immediate upstream freshness. Keep these boundaries visible. Never describe an ICS artifact as a saved live event.

Waypost is for many people: each person self-hosts one instance for their own Proton account. Keep personal names and hosts out of code and defaults; they belong only in a deployment's config. Prefer guided setup (`waypost setup ...`) and one-command compose over hand-edited JSON.

One writer per file. Preserve unrelated changes. Run npm test and npm run check for code changes; exercise the CLI/MCP for interface changes. Keep stdout machine-readable in MCP mode. No account passwords, browser cookies, tokens, or real mailbox/file/calendar content in fixtures, logs, or documentation. Do not weaken TLS or shell boundaries to pass a check.
