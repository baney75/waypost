# Contributing

Use Node.js 22.14+, run `npm ci --ignore-scripts`, and run `npm run verify` before proposing a change. Add a test for meaningful changed behavior. Use synthetic account data only.

Keep service rules in the shared adapters so CLI and MCP behavior agree. A new capability must state its Proton-supported route, permissions, failure behavior, and observable verification. Prepared artifacts are not remote writes.

Report vulnerabilities privately as described in SECURITY.md. Ordinary issues should include the version, safe error code, and a reproduction without credentials.
