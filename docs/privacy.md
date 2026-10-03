# Privacy

Waypost runs on your computer. It has no account system, telemetry, analytics, or hosted data store. It does not collect Proton account passwords.

The official Drive CLI communicates with Proton and retains its own protected session and caches. Mail Bridge decrypts messages locally. Waypost returns only the requested bounded data to its caller. If that caller is an AI agent, its model provider may receive that content under the provider’s own terms.

Configuration stores local paths and credential-variable names. Calendar share URLs live in separate owner-only files and are sent only to the official Proton calendar endpoint when connecting or querying. They are bearer secrets: holders can read the shared calendar. Waypost excludes them from normal results and errors. Read-only Mail helpers receive only the selected mailbox, limit or UID; credential custody and connection security remain with that helper. Local drafts, ICS files, and downloads remain in the configured artifacts directory until you remove them. Update checks contact GitHub with the Waypost version and normal network metadata; no mail, calendar, or Drive content is included.

Do not publish private snapshots, draft files, configuration, or real account fixtures. Vulnerability reports should use synthetic data.
