# Codex plugin

The plugin contains a bundled Node.js runtime, the MCP connection, and the Waypost skill. Node.js 22.14+ and local service setup are required. The package contains no credentials, cookies, or real account data.

After the public `v0.1.0` tag is available:

```sh
codex plugin marketplace add baney75/waypost --ref v0.1.0
codex plugin add waypost@waypost
```

Open a new agent session after installing. Ask it to read Waypost’s status, then run one scoped read. `waypost_status` reports configuration; `mail_doctor`, `drive_list`, and `calendar_events` verify different service operations.

The GitHub marketplace distributes this local plugin to Codex. It is separate from the universal ChatGPT/Codex plugin directory, which requires verified publisher identity, automated checks, review materials, and approval. Its submission process may require hosted MCP connectivity; a local stdio adapter should not be replaced with a credential-collecting public endpoint just to satisfy that flow. See [OpenAI submission requirements](https://developers.openai.com/plugins/deploy/submission).
