# Self-host Waypost

This page takes a fresh Linux server to a working claude.ai connector in about 15 minutes, for free. You run one Waypost per Proton account. It gives you:

- a remote MCP endpoint that claude.ai, Claude Code and other clients can use, protected by OAuth 2.1 and your own passcode;
- an **Agents** calendar that agents can write to, published as a private feed that Proton Calendar subscribes to;
- a mirror of your own Proton calendars (from their share links), so agents see what you add on your phone;
- optional mail through Proton Mail Bridge, running in the same stack.

You need Docker with Compose, a free Cloudflare account, and a Proton account. You don't need a domain. Mail needs a paid Proton plan that includes Bridge.

**It costs nothing, and it's all yours.** Waypost runs on your server and reaches the internet through your own Cloudflare account: a Cloudflare Tunnel (free), a Workers VPC link (free during its open beta) and a small Worker on the Workers Free plan (100,000 requests a day, far more than one person's agents use). Your address is `https://waypost.<your-subdomain>.workers.dev`. No one else's tunnel, account or server sits between your agents and your Proton data, and no one else pays for it.

## 1. Get the code (1 minute)

```sh
git clone https://github.com/baney75/waypost.git
cd waypost/deploy
```

Use a release tag for a stable install: `git checkout v0.6.0`.

## 2. Make your public address (3 minutes)

**Create a Cloudflare API token.** Sign up at [dash.cloudflare.com](https://dash.cloudflare.com/sign-up) if you have no account; the free plan is enough. Open **My Profile → API Tokens → Create Token → Create Custom Token**, name it `waypost setup`, and add three account permissions:

| Permission | Access | Why |
| --- | --- | --- |
| Cloudflare Tunnel | Edit | create your tunnel and read its token |
| Connectivity Directory | Admin | create the Workers VPC service that points at your server |
| Workers Scripts | Edit | upload the front-door Worker and turn on its workers.dev address |

Under **Account Resources** pick your account, then create the token and copy it. It's needed only for this step. Delete it afterward if you like; Waypost keeps running without it.

**Run the setup.** Still in `waypost/deploy`:

The containers run as user 1000, and this step writes `secrets/tunnel_token` as that user. If `id -u` prints something other than 1000, run `mkdir -p secrets && sudo chown 1000:1000 secrets` before it and `sudo chown "$(id -u)" secrets` after it, every time you run it; the token file stays owned by 1000 and readable only by it. Secret files you make by hand later, such as the mail ones in step 7, are created the same way as always: with `umask 077`, then `sudo chown 1000:1000 secrets/<file>`.

```sh
mkdir -p secrets
read -rs CLOUDFLARE_API_TOKEN && export CLOUDFLARE_API_TOKEN   # paste the token, press Enter (nothing is shown)
docker compose build
docker compose run --rm -e CLOUDFLARE_API_TOKEN -v "$PWD/secrets:/secrets" waypost \
  setup cloudflare --tunnel-token-file /secrets/tunnel_token
unset CLOUDFLARE_API_TOKEN
```

On your account it creates a tunnel named `waypost`, a Workers VPC service that reaches the `waypost` container through that tunnel, and a Worker named `waypost` on workers.dev. It writes the tunnel token to `secrets/tunnel_token` (owner-only, never printed) and prints your `publicUrl`. Use that address in step 3. Run it again whenever you like; it reuses what it made. It checks your account before it changes anything, and it stops rather than overwrite a same-named Worker or VPC service that isn't this Waypost's, or take a domain another Worker serves (`--replace` overrides). It also stops if a reused tunnel could carry traffic around the Worker: one that still publishes a public hostname or carries private-network (WARP) routes, or one made with `cloudflared tunnel create`, whose routes Cloudflare can't see. For those, pass a different `--name`. It also stops if the `waypost` tunnel exists but this server doesn't hold its token, or if another VPC service runs through it: use a different `--name`. Two servers on one tunnel would split your agents between them, so a tunnel with a connector up is never joined; `--reuse` picks up one with nothing connected, such as after a run that stopped partway. And it won't put a new or shared tunnel's token in `secrets/tunnel_token` while that file holds a different one, since the old address would stop working; `--replace` allows it, listed with anything else it would change, after which rerun `setup quick --public-url <new address>` and add the claude.ai connector again. A token for a tunnel you deleted doesn't count; it's replaced without asking. If the stack is already running when you rerun this, start it with `docker compose up -d --force-recreate cloudflared && docker compose up -d` so the tunnel reads the token file again; the command prints that step. It checks that the token file can be written before it touches Cloudflare. With `--hostname`, a failed domain attach leaves the Worker with no public address; fix the cause and run the same command again.

- **First Worker on this account?** If it says the account has no workers.dev subdomain yet, run it again with `--workers-subdomain <name>`. Your address becomes `https://waypost.<name>.workers.dev`. Subdomains are unique across Cloudflare; if yours is taken, it stops before making anything else, so pick another name.
- **Several accounts?** Add `--account-id <id>` (it lists the ones it can see).
- **Set up with an earlier version of this guide?** If a Worker such as `waypost-proxy` already serves Waypost on your domain, skip this step; that tunnel and Worker keep working. Running it would add a second front door on workers.dev, and switching Waypost's address to it would break the claude.ai connector you already have.
- **Already have a domain on Cloudflare?** Add `--hostname waypost.example.com` to serve it there instead. Give the token two more permissions first: **Zone → Workers Routes → Edit** and **Zone → Zone → Read**. The hostname must not already have a DNS record. Cloudflare checks that last, when it attaches the domain; if it refuses, remove the record and run the same command again. Once a domain is set, keep passing the same `--hostname` on every rerun.

The server opens no inbound port and has no public hostname. cloudflared dials out to Cloudflare over QUIC (outbound UDP port 7844), and only your Worker can reach it through Workers VPC.

<details><summary>Prefer the dashboard and Wrangler?</summary>

Create the tunnel under **Networking → Tunnels → Create a tunnel → Cloudflared**, name it `waypost`, and save the token from the install command without echoing it (`umask 077; cat > secrets/tunnel_token`, paste, Enter, Ctrl-D). Add no public hostname. Then, with [Wrangler](https://developers.cloudflare.com/workers/wrangler/) signed in:

```sh
npx wrangler vpc service create waypost --type http \
  --tunnel-id <tunnel id> --hostname waypost --http-port 8787
cd cloudflare-worker && cp wrangler.example.jsonc wrangler.jsonc
```

Fill in your account id and the VPC service id, keep `"workers_dev": true` (or set a custom-domain route), delete the `vars` block, and run `npx wrangler deploy`. It prints your address.
</details>

**Just looking?** `compose.quick.yaml` starts a temporary trycloudflare.com address with no account. It changes every time cloudflared restarts, and quick tunnels don't carry Server-Sent Events, which remote MCP uses. Use it to see the health page, not to connect claude.ai.

**Tailscale Funnel instead.** Funnel is free too, but it doesn't work on a tailnet with Tailnet Lock enabled. Skip the tunnel and run `tailscale funnel --bg 8787` on the server once the stack is up (step 4). Use `compose.funnel.yaml` in the commands below. To serve it on your own domain as well, deploy the proxy in `cloudflare-worker/` with its `vars` origin and add the Funnel hostname to `http.allowedHosts`.

## 3. Set up Waypost (2 minutes)

```sh
docker compose build
docker compose run --rm waypost setup quick \
  --public-url https://waypost.<your-subdomain>.workers.dev \
  --data /data --host 0.0.0.0 \
  --owner you@proton.me --enable-writes
```

It prints three things, once:

- **passcode**: you type this when a client connects. Save it in Proton Pass.
- **protonFeedUrl**: the private link to your Agents calendar. Save it in Proton Pass.
- **mcpUrl**: your address plus `/mcp`, the one you give to claude.ai.

`--enable-writes` lets agents create and change events in the Agents calendar. Each write still needs the agent to pass `confirm: true` after you approve it. Leave it off for a read-only start; you can turn it on later in `/data/config.json` (`agentCalendar.writeEnabled`).

## 4. Start it (1 minute)

```sh
docker compose up -d
docker compose run --rm waypost doctor --remote https://waypost.<your-subdomain>.workers.dev
```

All three `remote:` checks should be `ready`. With Funnel: `docker compose -f compose.yaml -f compose.funnel.yaml up -d waypost`, then `tailscale funnel --bg 8787`.

## 5. Connect claude.ai (1 minute)

1. In claude.ai open **Customize → Connectors** and choose **Add custom connector**. (Team and Enterprise owners: **Organization settings → Connectors**.)
2. Name it **Waypost** and paste the `mcpUrl`. Leave the OAuth fields empty; Waypost registers the client itself.
3. Choose **Connect**. On the Waypost page enter your passcode and choose **Allow**.

Ask Claude to run `waypost_status` to confirm.

**Claude Code:** `claude mcp add --transport http waypost <mcpUrl> --scope user`, then `/mcp` to sign in. **Other clients:** `docker compose exec waypost node /app/waypost.mjs --config /data/config.json auth token --label my-client` prints a bearer token for an `Authorization: Bearer …` header.

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
umask 077
touch secrets/bridge_username secrets/bridge_password   # compose needs the files to exist before Bridge first runs
docker compose -f compose.yaml -f compose.mail.yaml build bridge
docker compose -f compose.yaml -f compose.mail.yaml run --rm -it bridge init
```

In the Bridge prompt type `login` and sign in with your Proton account, then `info` to see the IMAP/SMTP username and password Bridge generated, then `exit`. Save those two values (never your Proton password):

```sh
cat > secrets/bridge_username   # paste, Enter, Ctrl-D
cat > secrets/bridge_password   # paste, Enter, Ctrl-D
docker compose -f compose.yaml -f compose.mail.yaml up -d --force-recreate waypost bridge
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
