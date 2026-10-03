# Proton support

Waypost connects a user’s own official local tools. It is not made, endorsed, or certified by Proton. These source checks were made on October 2, 2026; supported routes and terms can change.

## Authentication

A single Waypost interface does not create a universal Proton session. Enter your email, account password, two-factor code, and any human-verification response only in Proton’s official sign-in flow. Drive uses browser authentication and the CLI’s protected session store. Mail uses Bridge-generated credentials after you sign into Bridge.

Proton maintains an [internal API library](https://github.com/ProtonMail/go-proton-api) with SRP login and Calendar methods. Its existence is not a documented public authorization contract for a third-party universal integration. Waypost does not implement that protocol or reuse browser cookies.

## Drive

The [official CLI](https://proton.me/support/drive-cli) supports automation for users, developers, and businesses. Waypost invokes the unmodified executable with fixed commands and bounded output. Session encryption and network operations remain with Proton’s CLI. Native Proton Docs and Sheets require export in the app.

The [Drive SDK](https://github.com/ProtonDriveApps/sdk) has separate requirements, including application identification, official endpoints, caching, event synchronization, and disclosure for third-party credential collection. Its production-readiness caveat applies to direct SDK integrations. Waypost does not fork the CLI, impersonate an official application identifier, or implement an alternative SDK client. [CLI authentication and storage](https://github.com/ProtonDriveApps/sdk/blob/main/cli/README.md).

## Mail

[Mail Bridge](https://proton.me/mail/bridge) decrypts mail locally and supplies IMAP/SMTP. It requires a paid Proton plan including Mail. The adapter uses loopback connections, a pinned Bridge certificate, and generated client credentials. Reading uses an EXAMINE mailbox and BODY.PEEK to preserve flags. Sending uses one SMTP submission and is disabled by default.

Agent access exposes decrypted content to the agent and its inference provider. Choose the host and requested scope accordingly.

## Calendar

Proton documents [ICS import](https://proton.me/support/how-to-import-calendar-to-proton-calendar), [read-only subscriptions](https://proton.me/support/subscribe-to-external-calendar), and [calendar sharing links](https://proton.me/support/share-calendar-via-link). CalDAV is unsupported. Full-view sharing URLs include decryption material and should be treated as secrets.

Waypost reads approved local ICS files or fetches explicitly configured Proton share links. It reports file dates or fetch times and Proton’s potential eight-hour delay. It creates new ICS artifacts for deliberate import, without importing automatically or sending invitations. Links are read-only and cannot cover external calendars subscribed inside Proton. Verify the imported event, destination calendar, timezone, and alerts in Proton Calendar before describing it as saved. Duplicate imports can update existing events; Waypost generates a new UID for each prepared event.

## Policy basis

The [Proton Terms](https://proton.me/legal/terms) constrain account sharing, resale, abnormal automation traffic, and trademark use. Normal automation is conditionally permitted; a source-code license alone does not settle every service-policy question. Waypost uses separate original branding and collects no account password. It runs locally, without a hosted credential custodian, background polling, telemetry, or security-control bypass.

These implementation choices follow the documented routes. They are not Proton approval or a guarantee of compliance for every deployment. A hosted, commercial, shared-account, or direct-API adaptation needs its own review against the current terms and plan.
