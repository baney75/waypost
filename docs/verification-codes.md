# Verification codes

Waypost can find the one-time code a site just sent to your Proton Mail (2FA, sign-in or email verification codes) and fill it in the browser. On a Mac it can also read SMS codes forwarded from your iPhone. Everything runs on your computer. The feature is off until you turn it on.

Codes are credentials. Waypost never logs a code, never writes one to disk, and keeps no cache: each request reads the mailbox, returns at most one code, and exits.

## How it works

1. You click the Waypost button in the browser toolbar on a page that asks for a code.
2. The extension sends the page's hostname and its pairing code to Waypost through Chrome [native messaging](https://developer.chrome.com/docs/extensions/develop/concepts/native-messaging). The browser starts Waypost as a child process and talks to it over stdin and stdout. No port is opened.
3. Waypost reads messages from the last 10 minutes through the same read-only route as `mail_list` (direct Bridge or the read-only helper), opened with EXAMINE and BODY.PEEK so nothing is marked read.
4. It drops notifications and list mail, keeps only messages whose sender belongs to the site (see the rule below), extracts the code, and returns the code, sender, subject, time and a confidence level. It never returns the message body.
5. The popup shows the code and who sent it. **Fill code** types it into the code field, including split one-box-per-digit fields. The code is bound to the tab and origin it was fetched for: if the tab has moved to another site by the time you click, nothing is filled.

To fill without a click, turn on **Fill automatically on this site** in the popup. The browser then asks you to allow the extension on that one site. On that site only, when a code field appears, the extension waits up to two minutes for a code that arrives after the field appeared. It fills on its own only when all of these hold:

- the sender belongs to the site;
- Proton recorded `dmarc=pass` for the sender's domain (the read-only helper route returns no headers, so it never fills on its own);
- the sender is a known one-time-code address (built in: `noreply@github.com`, `@accounts.google.com`, `@accountprotection.microsoft.com`, `@id.apple.com`, `@email.apple.com`), or one you listed in `verifiedSenders`;
- the code was found with high confidence.

Anything less still shows the code, and you decide by clicking **Fill code**.

## The site-matching rule

A code is offered to a page only when the sender belongs to that page's site:

- Domains are compared as registrable domains under the [Public Suffix List](https://publicsuffix.org/), including its private section, from a pinned copy bundled with Waypost (`scripts/update-psl.mjs` refreshes it). So `shop.com.vn`, `bucket.s3.amazonaws.com` and `name.github.io` are each their own site. `noreply@github.com` matches `github.com` and `www.github.com`; it does not match `login-github.example.com`.
- Some sites get codes from another company domain. The mapping runs one way, from site to sender: `youtube.com` and `gmail.com` accept `google.com` senders; `live.com`, `outlook.com`, `office.com`, `microsoftonline.com`, `xbox.com` and similar accept `microsoft.com`; `icloud.com` accepts `apple.com`; `protonmail.com` and `pm.me` accept `proton.me`. Add your own with `verificationCodes.siteAliases`, for example `{"examplebank.com": ["examplebank-alerts.com"]}` (site first).
- An address at a consumer mailbox provider never authorizes a code, because anyone can create one: `someone@gmail.com`, `@outlook.com`, `@icloud.com`, `@proton.me`, `@pm.me` and other free-mail domains. Providers send their own codes from subdomains (such as `@accounts.google.com`), and those still match. If a provider sends from its bare domain, list that exact address in `verificationCodes.verifiedSenders`, for example `{"proton.me": ["address-you-saw@proton.me"]}`.
- Pages anyone can publish under a big brand's domain never receive codes: `sites.google.com`, `docs.google.com`, `drive.google.com`, `script.google.com`, `storage.googleapis.com`, `gist.github.com`, `raw.githubusercontent.com` and similar.
- Notifications and list mail are skipped entirely: messages with `List-Id`, `List-Unsubscribe`, `X-GitHub-Reason` or similar headers, `Precedence: list` or `bulk`, repository-style subjects such as `[owner/repo] … (#12)`, or bodies that quote other people (`> …`, `@mentions`, "Reply to this email directly"). Someone can write a fake code into a comment that GitHub then emails you from `github.com`. A service that sends codes with a `List-Unsubscribe` header is skipped too; that is a deliberate tradeoff.
- An SMS has no sender domain. A text is offered to a site only when it ends with the origin-bound line `@site.example #123456`, the [WebOTP format](https://developer.mozilla.org/en-US/docs/Web/API/WebOTP_API) many services use, and that domain is the same site. Other SMS codes are available to the CLI and MCP tool without a site, never to a web page.

## Set it up on your Mac

1. Update Waypost and build it: `git pull && npm ci --ignore-scripts && npm run build`.
2. Make sure Mail works first: `node dist/cli.js mail doctor` must report `imapAuthenticated: true`. Proton Mail Bridge must be running and signed in, or your read-only helper must be connected (`waypost connect mail --helper ...`).
3. Pair the browser. For Chrome: `node dist/cli.js connect browser`. For Brave, Edge or Chromium add `--browser brave` (or `edge`, `chromium`). For Helium or another Chromium browser, open its `chrome://version` page, take the folder that contains the **Profile Path**, and run `node dist/cli.js connect browser --hosts-dir "<that folder>/NativeMessagingHosts"`.
   This writes a native messaging manifest that only the Waypost extension (ID `bahfokgcpebehdnidclkpdeafnaehdpo`) may use, writes a launcher at `~/.config/waypost/native-host`, sets `verificationCodes.browser` to `true`, and prints a one-time `pairingCode`. The config keeps only its SHA-256.
4. In the browser, open `chrome://extensions`, turn on **Developer mode**, click **Load unpacked**, and choose the `extension` folder of this repository. Pin the Waypost button. Click it once and paste the `pairingCode` when it asks. Running `connect browser` again issues a new code and the old one stops working.
5. **Direct Bridge only:** the browser starts the launcher with the browser's environment, which has no Bridge password. Edit `~/.config/waypost/native-host` and put your secret manager in front of the `exec` command, for example `exec pass-cli run --env-file /absolute/path/bridge.references.env -- '/path/to/node' ...`. The helper route needs no change.
6. Test it: request a code from a site, click the Waypost button on the code page, and check the sender shown before you click **Fill code**.

### SMS codes from your iPhone (optional, macOS only)

1. On the iPhone: **Settings → Apps → Messages → Text Message Forwarding**, turn on your Mac. Turn on **Messages in iCloud** on both devices.
2. Confirm a text from a short code appears in Messages on the Mac.
3. Add `"messagesDatabase": "/Users/<you>/Library/Messages/chat.db"` inside the `verificationCodes` block of `~/.config/waypost/config.json`.
4. macOS protects that file. Grant **Full Disk Access** (System Settings → Privacy & Security) to the app that runs Waypost: your terminal for the CLI, Claude or your terminal for MCP. For the browser button, macOS treats the browser as the responsible app, so the browser itself would need Full Disk Access. That is a broad grant; skip it unless you accept that tradeoff. Waypost opens the database read-only and reads only the last few minutes of incoming texts.

### Agents (optional)

`mail_verification_code` is also an MCP tool and `waypost mail verification-code` a CLI command. They are off unless you set `"agents": true` in the `verificationCodes` block. Turn this on only if you want an agent to complete sign-ins for you; the code then passes through your model provider. Pass `site` so the agent receives only codes from that site's senders.

```json
"verificationCodes": {
  "browser": true,
  "agents": false,
  "maxAgeMinutes": 10,
  "mailboxes": ["INBOX"],
  "siteAliases": {},
  "verifiedSenders": {},
  "extensionIds": ["bahfokgcpebehdnidclkpdeafnaehdpo"]
}
```

## Threat model

| Threat | What stops it | What remains |
| --- | --- | --- |
| A phishing page triggers a real site to email you a code, then asks the extension for it. | The code is offered only when the sender belongs to the page's site under the Public Suffix List. `login-github.example.com` never receives GitHub's code. | An attacker who controls a whole registrable domain gets only codes sent from that domain. |
| An attacker mails you from a free-mail account (`someone@gmail.com`) to a Google sign-in page. | Bare consumer-mailbox addresses never authorize a code; sender aliases run only from site to sender. | A provider's real codes from its bare domain need a `verifiedSenders` entry. |
| A page hosted on a brand's user-content host (`sites.google.com`) asks for that brand's codes. | Those hosts never receive codes, and PSL private suffixes make hosted subdomains separate sites. | A user-content host missing from the list. Report it. |
| Someone writes a fake code into a comment, and the service emails it to you from its real domain. | Notification and list mail is skipped by header, subject and quoted-content markers. Automatic fill also requires a known code-only sender address. | A notification with none of these markers can still show a code, which you must not use. Automatic fill does not use it. |
| A forged email claims to come from the site. | Automatic fill requires Proton's `dmarc=pass` for the sender's domain. The popup labels unverified senders. | Senders without DMARC, or the helper route, show as unverified and fill only when you click. |
| The tab navigates to another site between fetching the code and clicking Fill. | The code is held in the extension's memory with its tab and origin for two minutes. Fill checks the tab's origin, then the page checks `location.origin` again before typing. | None known. |
| Another program running as you starts the native host itself and claims to be the extension. | Every message must carry the pairing code; Waypost compares its SHA-256 in constant time. The origin argument alone is not trusted. | A same-user process can read the browser profile or the Waypost config and run Waypost directly. Local malware with your account's access is outside this model. Through the host it can get only codes, never message bodies. |
| A web page or another extension talks to Waypost. | Native messaging only, no network listener. The browser lets only the extension ID in the host manifest connect. The extension has no `externally_connectable`, and popup actions are accepted only from extension pages. | None beyond the same-user case. |
| The page reads the code. | Nothing: filling a field gives the page the code. That is the purpose. | Only fill codes on the page you meant to sign in to. |
| Codes leak through logs, storage or caches. | Codes are never logged or written to disk. The extension stores the pairing code and the list of auto-fill sites; a fetched code lives only in memory, bound to one tab, for at most two minutes. Message bodies are never returned. | The code stays in the page and in your mailbox, as before. |
| An agent misuses the code. | Agent access is a separate switch, off by default. | When on, the code reaches your model provider. |
| SMS from a spoofed sender. | SMS codes are offered to a site only with an origin-bound `@domain #code` line for that same site. | Anyone who can text you can send origin-bound SMS; it is weaker than DMARC-verified mail and never auto-fills. |

The extension asks for `nativeMessaging`, `activeTab`, `scripting` and `storage`. It reads a page only after you click its button, or on sites where you allowed automatic filling. It has no access to other sites.

Not verified yet: the check reads the topmost `Authentication-Results` header whose server name ends in `protonmail.ch`, `proton.me` or `protonmail.com`. That matches the headers Proton adds, but it was tested only with synthetic messages, not a live Bridge mailbox. If your mail shows "unverified" for senders you expect to pass, open the message headers in Proton Mail and file an issue with the header (remove addresses first).
