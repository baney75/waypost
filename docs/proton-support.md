# Proton support

Waypost connects a user’s own official local tools. It is not made, endorsed, or certified by Proton. These source checks were made on October 2, 2026, and the calendar and mail limits below were checked again on October 12, 2026. Supported routes and terms can change.

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

Proton documents [ICS import](https://proton.me/support/how-to-import-calendar-to-proton-calendar), [subscriptions to external calendars](https://proton.me/support/subscribe-to-external-calendar), [calendar sharing links](https://proton.me/support/share-calendar-via-link), [notifications](https://proton.me/support/calendar-notifications-overview) and [automatic adding of invitations](https://proton.me/support/auto-add-invites). Checked October 12, 2026:

| Limit | What Proton documents | What Waypost does |
| --- | --- | --- |
| No write API | Proton Calendar does not support CalDAV, so there is no two-way sync with an external calendar. No public API writes to a Proton calendar. | Waypost never creates, changes or deletes an event inside a Proton calendar. |
| Subscriptions are view-only and refresh slowly | Subscribed calendars are view-only and sync every 4–16 hours depending on the provider. You can set default notifications on a calendar subscribed by URL. | Agent events live in Waypost's Agents calendar, published as a private ICS feed you subscribe to. Set default notifications on that subscription. A change reaches your phone within Proton's 4–16 hour refresh, not instantly. |
| Share links lag | A share link offers busy-only or full view. Changes can take up to eight hours to reach people using the link. Deleting the link stops syncing. | Waypost mirrors full-view links into its store with ETag/Last-Modified checks, reports when it last fetched, and shows the mirror as stale (with the error) when a refresh fails. |
| Invitations | Invitations that arrive in Proton Mail are added to your calendar automatically, and organizer updates are applied; you still respond to them. | `calendar_propose` with mode `invite` prepares an iTIP REQUEST from an organizer address you own to your Proton address; you send it with `mail_send`. Accepting creates a new event; the original stays until you delete it. Waypost has not verified how Proton treats an organizer address on the same account, so set `agentCalendar.organizer` to an address that is not the attendee. |
| Import | ICS import accepts files up to 10 MB. | `calendar_prepare` writes import files; `calendar migrate` reads an export into the Agents calendar. |

Full-view sharing URLs include decryption material and are treated as secrets. Waypost reads them from an owner-only file, a Proton Pass item, or the macOS login keychain, and never writes them to logs or tool results. Links are read-only and cannot cover external calendars subscribed inside Proton. Waypost generates a new UID for each prepared event.

**Agent edits to your own events.** An agent cannot change a native Proton event. By default `calendar_propose` adopts the event: it copies it into the Agents calendar with the change and prepares a note asking you to delete the original. Until the original leaves the share link, agents see only the agent copy, so nothing is double-booked. If the agent copy is deleted, the original shows again. Mode `delete` prepares a note asking you to delete an event and marks it `pendingRetirement`. A calendar connected with `--read-only` (for example a shared family calendar) is never adopted, changed, invited against or migrated.

## Sending addresses

Proton sends from Proton addresses, addresses on [custom domains you own](https://proton.me/support/addresses-and-aliases), and a [connected Gmail account](https://proton.me/blog/proton-mail-connect-gmail). It cannot send as an address on a domain you do not control, such as a university Outlook account. Waypost does not work around that: `mail_send` submits only through Bridge, and Bridge accepts only your account's own addresses. Forward that mail into Proton to read it.

## Filters

Proton supports [Sieve filters](https://proton.me/support/sieve-advanced-custom-filters), including `fileinto`, `addflag` and `stop`. `mail_triage` evaluates a saved copy of your filter against one message and explains what it would do. It does not run or change the live filter; keep the saved copy in step with Proton.

## Policy basis

The [Proton Terms](https://proton.me/legal/terms) constrain account sharing, resale, abnormal automation traffic, and trademark use. Normal automation is conditionally permitted; a source-code license alone does not settle every service-policy question. Waypost uses separate original branding and collects no account password. It runs on hardware you control, with no hosted credential custodian, telemetry, or security-control bypass. The optional server mode polls your own share links on a schedule you set (default every 30 minutes), well within normal client traffic.

These implementation choices follow the documented routes. They are not Proton approval or a guarantee of compliance for every deployment. A hosted, commercial, shared-account, or direct-API adaptation needs its own review against the current terms and plan.
