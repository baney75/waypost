# Self-host Waypost

This page takes a fresh Linux server to a working claude.ai connector in about 15 minutes. You run one Waypost per Proton account. It gives you:

- a remote MCP endpoint that claude.ai, Claude Code and other clients can use, protected by OAuth 2.1 and your own passcode;
- an **Agents** calendar that agents can write to, published as a private feed that Proton Calendar subscribes to;
- a mirror of your own Proton calendars (from their share links), so agents see what you add on your phone;
- optional mail through Proton Mail Bridge, running in the same stack.

You need Docker with Compose, a domain on Cloudflare (or a Tailscale tailnet with Funnel), and a Proton account. Mail needs a paid Proton plan that includes Bridge.

## 1. Get the code (1 minute)

```sh
git clone https://github.com/baney75/waypost.git
cd waypost/deploy
```

Use a release tag for a stable install: `git checkout v0.6.0`.

## 2. Make the public address (5 minutes)

**Cloudflare tunnel (recommended).** In the Cloudflare dashboard open **Zero Trust → Networks → Tunnels → Create a tunnel**, choose **Cloudflared**, name it `waypost`, and copy the token from the install command. Save it without echoing it:

```sh
umask 077
cat > secrets/tunnel_token     # paste the token, press Enter, then Ctrl-D
```

On the tunnel's **Public hostnames** tab add `waypost.example.com` (your hostname) with service `http://waypost:8787`.

**Tailscale Funnel instead.** Skip the tunnel and run `tailscale funnel --bg 8787` on the server once the stack is up (step 4). Use `compose.funnel.yaml` in the commands below. To serve it on your own domain as well, deploy the small proxy in `cloudflare-worker/` and add the Funnel hostname to `http.allowedHosts`.

## 3. Set up Waypost (2 minutes)

```sh
docker compose build
docker compose run --rm waypost setup quick \
  --public-url https://waypost.example.com \
  --data /data --host 0.0.0.0 \
  --owner you@proton.me --enable-writes
```

It prints three things, once:

- **passcode**: you type this when a client connects. Save it in Proton Pass.
- **protonFeedUrl**: the private link to your Agents calendar. Save it in Proton Pass.
- **mcpUrl**: `https://waypost.example.com/mcp`, the address you give to claude.ai.

`--enable-writes` lets agents create and change events in the Agents calendar. Each write still needs the agent to pass `confirm: true` after you approve it. Leave it off for a read-only start; you can turn it on later in `/data/config.json` (`agentCalendar.writeEnabled`).

## 4. Start it (1 minute)

```sh
docker compose up -d
docker compose run --rm waypost doctor --remote https://waypost.example.com
```

All three `remote:` checks should be `ready`. With Funnel: `docker compose -f compose.yaml -f compose.funnel.yaml up -d waypost`, then `tailscale funnel --bg 8787`.

## 5. Connect claude.ai (1 minute)

1. In claude.ai open **Customize → Connectors** and choose **Add custom connector**. (Team and Enterprise owners: **Organization settings → Connectors**.)
2. Name it **Waypost** and paste the `mcpUrl`. Leave the OAuth fields empty; Waypost registers the client itself.
3. Choose **Connect**. On the Waypost page enter your passcode and choose **Allow**.

Ask Claude to run `waypost_status` to confirm.

**Claude Code:** `claude mcp add --transport http waypost https://waypost.example.com/mcp --scope user`, then `/mcp` to sign in. **Other clients:** `docker compose exec waypost node /app/waypost.mjs --config /data/config.json auth token --label my-client` prints a bearer token for an `Authorization: Bearer …` header.

## 6. Connect Proton Calendar (3 minutes)

**Show the Agents calendar on your phone.** In Proton Calendar on the web, choose **Other calendars → Add calendar from URL**, paste the `protonFeedUrl`, and name it **Agents**. Open the new calendar's settings and add default notifications, for example 10 minutes before. Proton refreshes subscribed calendars every 4 to 16 hours, so an agent's change reaches your phone on that schedule, not instantly.

**Let agents see your own calendars.** For each Proton calendar: open its settings, choose **Share → Share via link → Full view**, and copy the link. Store it as the URL of a new Proton Pass login item, or in a private file, then connect it:

```sh
docker compose exec -T waypost sh -c 'umask 077; cat > /data/personal.url'   # paste, Enter, Ctrl-D
docker compose exec waypost node /app/waypost.mjs --config /data/config.json \
  connect calendar --url-file /data/personal.url --name Personal --source personal
```

Add `--read-only` for any calendar agents must never touch, such as a shared family calendar. Changes in Proton can take up to 8 hours to appear in a share link.

## 7. Add mail (optional, 3 minutes)

```sh
docker compose -f compose.yaml -f compose.mail.yaml build bridge
docker compose -f compose.yaml -f compose.mail.yaml run --rm -it bridge init
```

In the Bridge prompt type `login` and sign in with your Proton account, then `info` to see the IMAP/SMTP username and password Bridge generated, then `exit`. Save those two values (never your Proton password):

```sh
umask 077
cat > secrets/bridge_username   # paste, Enter, Ctrl-D
cat > secrets/bridge_password   # paste, Enter, Ctrl-D
docker compose -f compose.yaml -f compose.mail.yaml up -d
docker compose exec waypost node /app/waypost.mjs --config /data/config.json connect mail --certificate /bridge/cert.pem
docker compose exec waypost node /app/waypost.mjs --config /data/config.json mail doctor
```

Bridge runs in Waypost's network namespace, so it listens only on Waypost's loopback. Mail sending and organizing stay off until you enable `mail.sendEnabled` or `mail.organizeEnabled`.

## Back up and restore

`./backup.sh` writes a dated tarball of the data volume (config, Agents calendar, OAuth state) and a JSON store backup inside it. To restore, stop the stack and unpack the tarball into the volume; the command is in the script's header. To restore only the calendar: `waypost store restore --in <file>` (dry run), then add `--confirm`.

## Revoke access

- A feed link: `waypost calendar feed list`, then `waypost calendar feed revoke <id>`, and remove the subscription in Proton.
- A connected client: `waypost auth list`, then `waypost auth revoke <client id>`; `waypost auth revoke all` signs out everything.
- A forgotten passcode: `waypost auth passcode` sets a new one.

Prefix these with `docker compose exec waypost node /app/waypost.mjs --config /data/config.json`.

## What Waypost cannot do

Proton has no public calendar write API and no CalDAV. Waypost never creates, changes or deletes events inside your Proton calendars. Agents write to the Agents calendar, and Proton shows it as a subscription. To change one of your own events, an agent adopts it into Agents and asks you, in a prepared note, to delete the original, or prepares an invitation you accept. See [Proton support](proton-support.md).
