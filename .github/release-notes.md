- `mail_send` and `drive_upload` now require `confirm: true` on every call, in addition to the local send/write policy. A missing or false flag fails with `CONFIRMATION_REQUIRED` before any SMTP or Drive operation. CLI users pass `--confirm`.
- README covers Claude Code (`claude mcp add`) and Claude Desktop setup.

Mail and Calendar stay read-only by default. Calendar writes still produce import files only. Account passwords remain in Proton’s official tools.

Release assets include SHA-256 checksums. GitHub Actions builds also attest the CLI and plugin archives.
