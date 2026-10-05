# Codex plugin

The plugin uses the portable Agent Plugins format, with a bundled Node.js runtime, the MCP connection, and the Waypost skill. Node.js 22.14+ and local service setup are required. The package contains no credentials, cookies, or real account data.

Install the pinned release:

```sh
codex plugin marketplace add baney75/waypost --ref v0.3.0
codex plugin add waypost@waypost
```

Open a new agent session after installing. Ask it to read Waypost’s status, then run one scoped read. `waypost_status` reports configuration; `mail_doctor`, `drive_list`, and `calendar_events` verify different service operations.

The GitHub marketplace distributes this local plugin to Codex. It is separate from the universal ChatGPT/Codex plugin directory, which requires verified publisher identity, automated checks, review materials, and approval. Public directory submission currently requires a remote HTTPS MCP endpoint. Waypost uses local stdio; OpenAI’s package guide directs local MCP authors to contact OpenAI for local support. See [OpenAI package requirements](https://developers.openai.com/plugins/build/plugins#bundled-mcp-servers-and-lifecycle-hooks) and [submission requirements](https://developers.openai.com/plugins/deploy/submission).
