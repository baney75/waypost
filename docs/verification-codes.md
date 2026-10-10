# Verification codes

Waypost can find the one-time code a site just sent to your Proton Mail (2FA, sign-in or email verification codes) and fill it in the browser. On a Mac it can also read SMS codes forwarded from your iPhone. Everything runs on your computer. The feature is off until you turn it on.

Codes are credentials. Waypost never logs a code, never writes one to disk, and keeps no cache: each request reads the mailbox, returns at most one code, and exits.

## How it works

1. You click the Waypost button in the browser toolbar on a page that asks for a code.
2. The extension sends the page's hostname to Waypost through Chrome [native messaging](https://developer.chrome.com/docs/extensions/develop/concepts/native-messaging). The browser starts Waypost as a child process and talks to it over stdin and stdout. No port is opened.
3. Waypost reads messages from the last 10 minutes through the same read-only route as `mail_list` (direct Bridge or the read-only helper), opened with EXAMINE and BODY.PEEK so nothing is marked read.
4. It keeps only messages whose sender belongs to the site (see the rule below), extracts the code, and returns the code, sender, subject, time and a confidence level. It never returns the message body.
5. The popup shows the code and who sent it. **Fill code** types it into the code field, including split one-box-per-digit fields.

To fill without a click, turn on **Fill automatically on this site** in the popup. The browser then asks you to allow the extension on that one site. On that site only, when a code field appears, the extension waits up to two minutes for a code that arrives after the field appeared, and fills it.

## The site-matching rule

A code is offered to a page only when the sender's domain belongs to that page's site:

- The registrable domain of the sender's address must equal the page's registrable domain. `noreply@github.com` matches `github.com` and `www.github.com`; it does not match `github-login.example.com`.
- A few companies send codes from another domain. Built-in aliases: Google (`youtube.com`, `gmail.com`), Microsoft (`live.com`, `outlook.com`, `office.com`, `microsoftonline.com`, `xbox.com` and others), Apple (`icloud.com`), Proton (`protonmail.com`, `pm.me`). Add your own in config under `verificationCodes.siteAliases`, for example `{"examplebank.com": ["examplebank-alerts.com"]}`.
- An SMS has no sender domain. A text is offered to a site only when it ends with the origin-bound line `@site.example #123456`, the [WebOTP format](https://developer.mozilla.org/en-US/docs/Web/API/WebOTP_API) many services use. Other SMS codes are available to the CLI and MCP tool without a site, never to a web page.

Automatic filling has extra conditions: the extraction must be high confidence, the sender must match the site, and Proton must not have recorded a DMARC failure for the sender. When Proton's own `Authentication-Results` header shows `dmarc=pass` for the sender's domain, the popup says "Sender verified by Proton". The read-only helper route does not return headers, so its results are shown as unverified and still fill on one click.

## Set it up on your Mac

1. Update Waypost and build it: `git pull && npm ci --ignore-scripts && npm run build`.
2. Make sure Mail works first: `node dist/cli.js mail doctor` must report `imapAuthenticated: true`. Proton Mail Bridge must be running and signed in, or your read-only helper must be connected (`waypost connect mail --helper ...`).
3. Pair the browser. For Chrome: `node dist/cli.js connect browser`. For Brave, Edge or Chromium add `--browser brave` (or `edge`, `chromium`). For Helium or another Chromium browser, open its `chrome://version` page, take the folder that contains the **Profile Path**, and run `node dist/cli.js connect browser --hosts-dir "<that folder>/NativeMessagingHosts"`.
   This writes a native messaging manifest that only the Waypost extension (ID `bahfokgcpebehdnidclkpdeafnaehdpo`) may use, writes a launcher at `~/.config/waypost/native-host`, and sets `verificationCodes.browser` to `true`.
4. In the browser, open `chrome://extensions`, turn on **Developer mode**, click **Load unpacked**, and choose the `extension` folder of this repository. Pin the Waypost button.
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
  "extensionIds": ["bahfokgcpebehdnidclkpdeafnaehdpo"]
}
```

## Threat model

| Threat | What stops it | What remains |
| --- | --- | --- |
| A phishing page triggers a real site to email you a code, then asks the extension for it. | The code is offered only when the sender's domain matches the page's domain. `github-login.example.com` never receives GitHub's code. | Lookalike senders are rejected, but an attacker who controls mail from a domain that matches the page (their own domain) only gets their own codes. |
| A forged email claims to come from the site. | Automatic fill is blocked when Proton recorded a DMARC failure; the popup labels unverified senders. Proton applies the sender's DMARC policy before delivery. | Senders without DMARC, or the helper route, show as unverified; one-click fill still works after you check the sender. |
| A web page or another extension talks to Waypost. | Native messaging only: no network listener. The browser lets only the extension ID in the host manifest connect, and Waypost checks that ID against `verificationCodes.extensionIds`. The extension has no `externally_connectable`, so pages cannot message it. | Any program running as you can run Waypost directly. Local malware is outside this model. |
| The page reads the code. | Nothing: filling a field gives the page the code. That is the purpose. | Only fill codes on the page you meant to sign in to. |
| Codes leak through logs, storage or caches. | Codes are returned once and never logged or written; the extension stores only the list of auto-fill sites. Message bodies are never returned. | The code stays in the field's page memory and your mailbox, as before. |
| An agent misuses the code. | Agent access is a separate switch, off by default. | When on, the code reaches your model provider. |
| SMS from a spoofed sender. | SMS codes are offered to a site only with the origin-bound `@domain #code` line. | Origin-bound SMS can be spoofed by anyone who can send you texts; it is weaker than DMARC-verified mail. |

The extension asks for `nativeMessaging`, `activeTab`, `scripting` and `storage`. It reads a page only after you click its button, or on sites where you allowed automatic filling. It has no access to other sites.

Not verified yet: the check reads the topmost `Authentication-Results` header whose server name ends in `protonmail.ch`, `proton.me` or `protonmail.com`. That matches the headers Proton adds, but it was tested only with synthetic messages, not a live Bridge mailbox. If your mail shows "unverified" for senders you expect to pass, open the message headers in Proton Mail and file an issue with the header (remove addresses first).
