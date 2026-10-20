import { constants } from 'node:fs';
import { lstat, open, readFile, rename, rm, stat } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { WaypostError } from './errors.js';
import { WORKER_SOURCE } from './worker-source.js';

// One person's Waypost on their own free Cloudflare account: a tunnel with no public hostname, a Workers VPC
// service that names the waypost container, and the front-door Worker on <name>.<subdomain>.workers.dev.
// No domain, no DNS record and nothing on anyone else's account. Safe to run again: it reuses what exists.

export const API_TOKEN_PERMISSIONS = ['Account: Cloudflare Tunnel Edit', 'Account: Connectivity Directory Admin', 'Account: Workers Scripts Edit'];
const DOMAIN_PERMISSIONS = ['Zone: Workers Routes Edit', 'Zone: Zone Read'];
const NAME = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;
const ACCOUNT_ID = /^[0-9a-f]{32}$/i;

type Options = {apiToken:string; accountId?:string | undefined; name?:string | undefined; tunnelTokenFile:string; workersSubdomain?:string | undefined; hostname?:string | undefined; replace?:boolean | undefined; reuse?:boolean | undefined; originHost?:string | undefined; originPort?:number | undefined; apiBase?:string | undefined};
type Envelope<T> = {success:boolean; result:T; errors?:{code:number; message:string}[]; result_info?:{page?:number; total_pages?:number; total_count?:number}};

export async function setupCloudflare(options:Options) {
  const name = options.name ?? 'waypost';
  if (!NAME.test(name)) throw new WaypostError('INPUT_INVALID', '--name must be lowercase letters, digits and hyphens, up to 63 characters.');
  if (options.workersSubdomain !== undefined && !NAME.test(options.workersSubdomain)) throw new WaypostError('INPUT_INVALID', '--workers-subdomain must be lowercase letters, digits and hyphens, up to 63 characters.');
  if (!isAbsolute(options.tunnelTokenFile)) throw new WaypostError('INPUT_INVALID', '--tunnel-token-file must be an absolute path.');
  // The token destination is checked before any Cloudflare call, so an unusable path leaves nothing half-made.
  const held = await inspectTokenFile(options.tunnelTokenFile);
  // The new token waits here, owner-only beside the token file, from before the VPC service moves until it is renamed
  // into place, so a run killed in between leaves this host proof that the half-made setup is its own.
  const pendingPath = join(dirname(options.tunnelTokenFile), `.${basename(options.tunnelTokenFile)}.pending`);
  const pendingEntry = await lstat(pendingPath).catch(() => null);
  if (pendingEntry && !pendingEntry.isFile()) throw new WaypostError('PATH_UNSAFE', `${pendingPath} must be a regular file, not a link or directory. Remove it and run again.`);
  const pendingToken = await readPending(pendingPath);
  const pending = pendingToken?.tunnelId;
  const owns = (id:string) => held.tunnelId === id || pending === id;
  const hostname = options.hostname === undefined ? undefined : hostOnly(options.hostname);
  if (hostname && options.workersSubdomain !== undefined) throw new WaypostError('INPUT_INVALID', '--workers-subdomain applies only to the workers.dev address; leave it out with --hostname.');
  const api = client(options.apiToken, options.apiBase ?? 'https://api.cloudflare.com/client/v4');
  if (options.accountId && !ACCOUNT_ID.test(options.accountId)) throw new WaypostError('INPUT_INVALID', '--account-id must be the 32-character id from the Cloudflare dashboard.');
  const account = options.accountId || await onlyAccount(api);

  const originHost = options.originHost ?? 'waypost', originPort = options.originPort ?? 8787;

  // Read-only checks first, so a refusal leaves nothing half-made.
  const tunnels = (await api.list<{id:string; name:string; config_src?:string; remote_config?:boolean; status?:string; connections?:unknown[]}>(`/accounts/${account}/cfd_tunnel?name=${encodeURIComponent(name)}&is_deleted=false`, 'list tunnels')).filter(item => item.name === name);
  if (tunnels.length > 1) throw new WaypostError('TUNNEL_EXISTS', `This account has ${tunnels.length} tunnels named ${name}, so this can't tell which is this Waypost's. Delete the extras under Networking → Tunnels, or pass a different --name.`, {tunnels:tunnels.map(item => item.id)});
  const reused = tunnels[0];
  if (reused) {
    // One Waypost per tunnel: a tunnel this host doesn't already hold belongs to another server (two people on one
    // account), and a second connector would split their agents' traffic between two Waypost instances.
    // Only a tunnel that has never connected ('inactive', what a run that stopped partway leaves) may be joined without
    // its token. One that is up, or 'down' after running somewhere, belongs to a server that would lose its traffic.
    // A missing status counts as in use.
    if (!owns(reused.id) && (reused.status !== 'inactive' || (reused.connections?.length ?? 0) > 0)) throw new WaypostError('TUNNEL_IN_USE', reused.status === 'healthy' || reused.status === 'degraded'
      ? `The ${name} tunnel is running on a server right now and this host doesn't hold its token (${options.tunnelTokenFile}). Joining it would split that server's traffic with this one. Pass a different --name for your own tunnel. If it is this host's own cloudflared, stop it (docker compose stop cloudflared), delete the ${name} tunnel, VPC service and Worker in the dashboard and run again.`
      : `The ${name} tunnel has run on a server before and this host doesn't hold its token (${options.tunnelTokenFile}), so it belongs to that server. Pass a different --name for your own tunnel. If it was this host's and the token file was lost, delete the ${name} tunnel, VPC service and Worker in the dashboard and run again.`, {status:reused.status ?? null});
    if (!owns(reused.id) && !options.reuse) throw new WaypostError('TUNNEL_EXISTS', `The ${name} tunnel already exists, nothing is connected to it, and this host doesn't hold its token (${options.tunnelTokenFile}). If an earlier run of this command stopped partway, run again with --reuse. Otherwise pass a different --name for your own tunnel.`);
    // Cloudflare can't see the routes of a locally managed tunnel (they live in a cloudflared config.yml), so it
    // can't promise Worker-only access; a tunnel that doesn't say it's remotely managed counts as local. A remotely
    // managed one may still route public traffic from an earlier setup; only an empty ingress or a catch-all that
    // answers http_status:* is safe.
    if (!(reused.config_src === 'cloudflare' || (reused.config_src === undefined && reused.remote_config === true))) throw new WaypostError('TUNNEL_LOCALLY_MANAGED', `The ${name} tunnel is managed locally, so its public routes live in a cloudflared config file this can't check. Pass a different --name for a fresh tunnel that only your Worker can reach.`);
    const config = (await api.get<{config?:{ingress?:{hostname?:string; service?:string}[]; 'warp-routing'?:{enabled?:boolean}} | null}>(`/accounts/${account}/cfd_tunnel/${reused.id}/configurations`, 'read the tunnel configuration'))?.config;
    const routes = (config?.ingress ?? []).filter(rule => rule.hostname || !/^http_status:\d{3}$/.test(rule.service ?? ''));
    // Private-network routes let WARP clients on the account reach the server without the Worker too.
    const privateRoutes = (await api.list<{network?:string}>(`/accounts/${account}/teamnet/routes?tunnel_id=${reused.id}&is_deleted=false`, 'list the tunnel\'s private routes')).map(route => route.network ?? 'a private route');
    if (config?.['warp-routing']?.enabled || privateRoutes.length) throw new WaypostError('TUNNEL_HAS_PRIVATE_ROUTES', `The ${name} tunnel carries private-network traffic (${privateRoutes.length ? privateRoutes.join(', ') : 'WARP routing is on'}), which reaches the server without the Worker. Remove those routes under Networking → Routes and turn off WARP routing for ${name}, or pass a different --name.`, {routes:privateRoutes});
    if (routes.length) throw new WaypostError('TUNNEL_HAS_PUBLIC_HOSTNAME', `The ${name} tunnel still routes public traffic (${routes.map(rule => rule.hostname ?? `catch-all to ${rule.service}`).join(', ')}), which skips the Worker. Remove those public hostnames (and their DNS records) under Networking → Tunnels → ${name}, or pass a different --name.`, {routes:routes.map(rule => rule.hostname ?? rule.service ?? '')});
  }

  // Everything --replace would overwrite is gathered first and refused together, so one flag never approves a
  // change the user wasn't shown. First: the token of a different tunnel this host runs now, whose address would stop
  // working if a new or shared tunnel's token replaced it.
  const conflicts:{code:string; what:string}[] = [];
  // A token for a tunnel since deleted on this account is stale, not in use: nothing still answers on it. Any error
  // reading the tunnel counts as not deleted.
  const deletedTunnel = async (id:string) => /^[0-9a-f-]{36}$/i.test(id)
    && await api.get<{deleted_at?:string | null}>(`/accounts/${account}/cfd_tunnel/${id}`, 'check a tunnel').then(item => !!item?.deleted_at, () => false);
  const stale = !!held.tunnelId && held.tunnelId !== reused?.id && await deletedTunnel(held.tunnelId);
  // A pending token for a different tunnel that still exists is an unfinished setup this host must not overwrite.
  // A copy of the token file's own token proves nothing new, so it never blocks.
  if (pending && pending !== reused?.id && pending !== held.tunnelId) {
    const abandon = `If you abandoned that setup, delete ${pendingPath} and run again.`;
    if (pendingToken?.account && pendingToken.account !== account) throw new WaypostError('PENDING_EXISTS', `${pendingPath} holds the token of an unfinished setup on another Cloudflare account (${pendingToken.account}). Finish it there with --account-id ${pendingToken.account}. ${abandon}`, {tunnel:pending, account:pendingToken.account});
    if (!(await deletedTunnel(pending))) throw new WaypostError('PENDING_EXISTS', `${pendingPath} holds the token of an unfinished setup for another tunnel. Finish it by running again with the --name you used then. ${abandon}`, {tunnel:pending});
  }
  const tokenInUse = held.present && (!reused || held.tunnelId !== reused.id) && !stale;
  if (tokenInUse) conflicts.push({code:'TOKEN_FILE_IN_USE', what:`${options.tunnelTokenFile} holds the token of a different tunnel, which would be replaced (the address you set up before would stop working and its claude.ai connector would need adding again)`});

  // A same-named VPC service is ours only if it already points at this tunnel's waypost container, or at a deleted
  // tunnel this host can prove was its own. Anyone else's is never repointed, even with --replace: every Worker bound
  // to it would get a path to this server around the front door.
  type Service = {service_id:string; name:string; type?:string; http_port?:number; host?:{hostname?:string; resolver_network?:{tunnel_id?:string}; network?:{tunnel_id?:string}}};
  const services = await api.list<Service>(`/accounts/${account}/connectivity/directory/services`, 'list VPC services');
  const named = services.filter(item => item.name === name);
  if (named.length > 1) throw new WaypostError('VPC_SERVICE_EXISTS', `This account has ${named.length} VPC services named ${name}, so this can't tell which is this Waypost's. Delete the extras under Workers VPC, or pass a different --name.`, {services:named.map(item => item.service_id)});
  const existing = named[0];
  const via = (item:Service) => item.host?.resolver_network?.tunnel_id ?? item.host?.network?.tunnel_id;
  // Ours: it reaches this origin through the reused tunnel, or through the deleted tunnel whose token this host holds.
  // The service is repointed before the new token is written, so the token file stays the proof until both move
  // together. No tunnel id at all is never ours.
  // A failed run removes or restores the services it wrote, so a tunnel this host doesn't hold that already carries a
  // service is a finished setup on another host (maybe not started yet), not one this host left behind.
  if (reused && !owns(reused.id) && services.some(item => via(item) === reused.id)) throw new WaypostError('TUNNEL_IN_USE', `The ${name} tunnel already has a VPC service on it and this host doesn't hold its token (${options.tunnelTokenFile}), so it was set up on another host. Pass a different --name for your own tunnel. If it was this host's and its token files are gone, delete the ${name} tunnel, VPC service and Worker in the dashboard and run again.`, {status:reused.status ?? null});
  const tunnelOf = existing ? via(existing) : undefined;
  const serviceIsOurs = !!existing && !!tunnelOf && existing.host?.hostname === originHost && existing.http_port === originPort
    && ((!!reused && tunnelOf === reused.id) || (stale && tunnelOf === held.tunnelId));
  // Any other VPC service through a reused tunnel lets that service's Workers reach the server around this front door.
  const others = reused ? services.filter(item => item !== existing && via(item) === reused.id).map(item => item.name) : [];
  if (others.length) throw new WaypostError('TUNNEL_HAS_VPC_SERVICES', `The ${name} tunnel also carries the VPC service${others.length > 1 ? 's' : ''} ${others.join(', ')}, which other Workers can use to reach the server without this front door. Delete ${others.length > 1 ? 'them' : 'it'} under Workers VPC, or pass a different --name.`, {services:others});
  if (existing && !serviceIsOurs) throw new WaypostError('VPC_SERVICE_EXISTS', `The VPC service ${name} already exists and isn't this Waypost's. Repointing it would give every Worker bound to it a path to this server, so this won't, even with --replace. Pass a different --name. If it is yours (say, after losing ${options.tunnelTokenFile}), delete the ${name} tunnel, VPC service and Worker in the dashboard and run again.`, {services:[existing.service_id]});

  // Never overwrite someone's other Worker that happens to share the name: it counts as Waypost's only with exactly
  // the one ORIGIN_VPC binding this uploads, bound to the VPC service checked above.
  const current = await api.call<{bindings?:{type:string; name:string; service_id?:string}[]}>('GET', `/accounts/${account}/workers/scripts/${name}/settings`, undefined, 'check for an existing Worker')
    .then(json => json.result, (error:unknown) => { if (error instanceof WaypostError && error.details?.cloudflareCode === 10007) return null; throw error; });
  const bindings = current?.bindings ?? [];
  const workerIsOurs = !!current && serviceIsOurs && bindings.length === 1 && bindings[0]!.name === 'ORIGIN_VPC' && bindings[0]!.type === 'vpc_service' && bindings[0]!.service_id === existing!.service_id;
  if (current && !workerIsOurs) conflicts.push({code:'WORKER_EXISTS', what:`the Worker ${name}, which isn't this Waypost's front door, would be overwritten`});

  // Custom domains: one this Worker already serves must be the one asked for now, or the rerun would leave a second
  // front door whose Host Waypost refuses; one another Worker serves is not taken over without --replace.
  const domains = [
    ...await api.list<{hostname:string; service:string}>(`/accounts/${account}/workers/domains?service=${name}`, 'list Worker custom domains'),
    ...hostname ? await api.list<{hostname:string; service:string}>(`/accounts/${account}/workers/domains?hostname=${hostname}`, 'list Worker custom domains') : [],
  ];
  const attached = domains.filter(item => item.service === name && item.hostname !== hostname).map(item => item.hostname);
  if (attached.length) throw new WaypostError('HOSTNAME_ATTACHED', workerIsOurs
    ? `The ${name} Worker already serves ${attached.join(', ')}. Run again with --hostname ${attached[0]}, or remove ${attached.length > 1 ? 'those domains' : 'that domain'} under Workers & Pages → ${name} → Domains & Routes first.`
    : `The Worker ${name} serves ${attached.join(', ')} and isn't this Waypost's front door. Pass a different --name.`, {hostnames:attached});
  const taken = hostname ? domains.find(item => item.hostname === hostname && item.service !== name) : undefined;
  if (taken) conflicts.push({code:'HOSTNAME_IN_USE', what:`${hostname}, which points at the Worker ${taken.service}, would move to ${name}`});
  if (conflicts.length && !options.replace)
    throw new WaypostError(conflicts[0]!.code, `This would change things on your account that aren't this Waypost's: ${conflicts.map(item => item.what).join('; ')}. Pass a different --name${taken ? ' or --hostname' : ''}${tokenInUse ? ' or --tunnel-token-file' : ''}, or --replace to make ${conflicts.length > 1 ? 'all of these changes' : 'that change'}.`, {conflicts:conflicts.map(item => item.code)});

  const zone = hostname ? await findZone(api, account, hostname) : undefined;
  const subdomain = await workersSubdomain(api, account);
  if (!hostname && !subdomain && !options.workersSubdomain) throw new WaypostError('WORKERS_SUBDOMAIN_NEEDED', `This Cloudflare account has no workers.dev subdomain yet. Run again with --workers-subdomain <name>; your address becomes https://${name}.<name>.workers.dev.`);
  if (!hostname && subdomain && options.workersSubdomain && subdomain !== options.workersSubdomain) throw new WaypostError('INPUT_INVALID', `This account already uses the workers.dev subdomain ${subdomain}, so your address is https://${name}.${subdomain}.workers.dev. Leave out --workers-subdomain.`);

  // Writes, now that nothing above refused. A new workers.dev subdomain goes first: it is the one write that can
  // fail on a name someone else holds, and it routes nothing.
  const registered = hostname ? undefined : subdomain ?? (await api.send<{subdomain:string}>('PUT', `/accounts/${account}/workers/subdomain`, {subdomain:options.workersSubdomain}, 'register your workers.dev subdomain')).subdomain;
  const tunnel = reused ?? await api.send<{id:string; name:string}>('POST', `/accounts/${account}/cfd_tunnel`, {name, config_src:'cloudflare'}, 'create the tunnel');
  // The VPC service moves to the tunnel before the token file does, and a new tunnel's run undoes both on failure, so
  // a rerun always finds the token file and the service agreeing (the token file is this host's proof of ownership).
  const servicesPath = `/accounts/${account}/connectivity/directory/services`;
  // Until the token file is written, this run's tunnel isn't this host's: a failure undoes the service write (judged
  // from what Cloudflare holds now, since a write can land after its response is lost) and a tunnel this run made.
  const undo = !reused || !owns(reused.id);
  let vpc:{service_id:string} | undefined, wrote = false, staged = false;
  // True when Cloudflare no longer shows the service on this run's tunnel, after putting it back if needed.
  const undoService = async () => {
    const now = await api.list<Service>(servicesPath, 'list VPC services').then(items => items.find(item => item.name === name), () => null);
    if (now === null) return false;
    if (!now || via(now) !== tunnel.id) return true;
    return (existing
      ? api.call('PUT', `${servicesPath}/${existing.service_id}`, {name:existing.name, type:existing.type ?? 'http', host:existing.host, http_port:existing.http_port}, 'restore the VPC service')
      : api.call('DELETE', `${servicesPath}/${now.service_id}`, undefined, 'remove the unfinished VPC service')).then(() => true, () => false);
  };
  try {
    const tunnelToken = await api.get<string>(`/accounts/${account}/cfd_tunnel/${tunnel.id}/token`, 'read the tunnel token');
    if (typeof tunnelToken !== 'string' || !tunnelToken) throw new WaypostError('CLOUDFLARE_FAILED', 'Cloudflare returned an empty tunnel token. Try again in a minute.');
    await writeSecret(pendingPath, tunnelToken);
    staged = true;
    const service = {name, type:'http', host:{hostname:originHost, resolver_network:{tunnel_id:tunnel.id}}, http_port:originPort};
    wrote = true;
    vpc = existing
      ? await api.send<{service_id:string}>('PUT', `${servicesPath}/${existing.service_id}`, service, 'update the VPC service')
      : await api.send<{service_id:string}>('POST', servicesPath, service, 'create the VPC service');
    await rename(pendingPath, options.tunnelTokenFile).catch(() => { throw new WaypostError('PATH_UNWRITABLE', `Could not write the tunnel token to ${options.tunnelTokenFile}. Check that its folder exists and that this user can write to it.`); });
  } catch (error) {
    // Undo what this run did to a tunnel this host didn't hold yet: put the VPC service back, then remove the pending
    // token and a tunnel this run made. If the service can't be confirmed back, keep both, so the same command resumes.
    if (undo) {
      if (!wrote || await undoService()) {
        // Only a pending token this run wrote: an earlier run's is that run's proof and stays until it resumes.
        if (staged) await rm(pendingPath, {force:true}).catch(() => undefined);
        if (!reused) await api.call('DELETE', `/accounts/${account}/cfd_tunnel/${tunnel.id}`, undefined, 'remove the unfinished tunnel').catch(() => undefined);
      } else if (error instanceof WaypostError) {
        throw new WaypostError(error.code, `${error.message} Cleanup on Cloudflare couldn't finish, so this host kept what it needs to resume: fix the cause and run the same command again.`, {...error.details, resumable:true});
      }
    }
    throw error;
  }

  const form = new FormData();
  form.set('metadata', JSON.stringify({main_module:'worker.js', compatibility_date:'2026-09-01', bindings:[{type:'vpc_service', name:'ORIGIN_VPC', service_id:vpc.service_id}], observability:{enabled:false}}));
  form.set('worker.js', new File([WORKER_SOURCE], 'worker.js', {type:'application/javascript+module'}));
  await api.send('PUT', `/accounts/${account}/workers/scripts/${name}`, form, 'upload the Worker');

  let publicUrl:string;
  if (hostname) {
    // workers.dev goes off first, so a refused domain attach (a DNS record in the way, a token without Workers Routes
    // Edit) leaves no public address at all rather than the one the caller meant to retire. Rerunning resumes.
    // An account with no workers.dev subdomain serves nothing there, so there is nothing to turn off.
    if (subdomain) await api.send('POST', `/accounts/${account}/workers/scripts/${name}/subdomain`, {enabled:false, previews_enabled:false}, 'turn off the workers.dev address');
    await api.send('PUT', `/accounts/${account}/workers/domains`, {hostname, service:name, zone_id:zone, environment:'production'}, 'attach your domain', DOMAIN_PERMISSIONS);
    publicUrl = `https://${hostname}`;
  } else {
    await api.send('POST', `/accounts/${account}/workers/scripts/${name}/subdomain`, {enabled:true, previews_enabled:false}, 'turn on the workers.dev address');
    publicUrl = `https://${name}.${registered}.workers.dev`;
  }
  // A running cloudflared keeps the token it started with (compose mounts the old file), and `up -d` leaves an unchanged
  // container alone, so the start step always recreates it: an earlier run that swapped the token and then failed
  // leaves nothing this run could see.
  const tokenReplaced = tokenInUse || stale;
  return {publicUrl, accountId:account, tunnel:{id:tunnel.id, name, created:!reused}, vpcService:{id:vpc.service_id, created:!existing}, worker:{name, created:!current}, tunnelTokenFile:options.tunnelTokenFile, tunnelTokenReplaced:tokenReplaced,
    next:[
      `Set up Waypost for this address: docker compose run --rm waypost setup quick --public-url ${publicUrl} --data /data --host 0.0.0.0 --owner <your Proton address> (add --enable-writes to let agents write to the Agents calendar)`,
      'Start it (this also restarts the tunnel so it uses secrets/tunnel_token): docker compose up -d --force-recreate cloudflared && docker compose up -d',
      `Check it from outside: docker compose run --rm waypost doctor --remote ${publicUrl}`,
    ], cost:'Free: Cloudflare Tunnel, Workers VPC (open beta) and the Workers Free plan (100,000 requests a day). Everything lives on your own Cloudflare account.'};
}

function client(token:string, base:string) {
  const call = async <T>(method:string, path:string, body:unknown, step:string, extra:string[] = []):Promise<Envelope<T>> => {
    let response:Response;
    try {
      response = await fetch(base + path, {method, redirect:'error', signal:AbortSignal.timeout(30000), headers:{Authorization:`Bearer ${token}`, ...(body === undefined || body instanceof FormData ? {} : {'Content-Type':'application/json'})}, ...(body === undefined ? {} : {body:body instanceof FormData ? body : JSON.stringify(body)})});
    } catch { throw new WaypostError('CLOUDFLARE_UNREACHABLE', `Could not reach the Cloudflare API to ${step}. Check this machine's internet connection.`); }
    const json = await response.json().catch(() => null) as Envelope<T> | null;
    if (response.ok && json?.success) return json;
    const first = json?.errors?.[0];
    if (first?.code === 6003 || (first?.code === 9109 && /invalid access token/i.test(first.message))) throw new WaypostError('CLOUDFLARE_TOKEN_REJECTED', 'Cloudflare did not accept the API token. Copy it again from My Profile → API Tokens, or roll a new one.', {httpStatus:response.status, cloudflareCode:first.code});
    const denied = response.status === 401 || response.status === 403 || [9109, 10000, 10001].includes(first?.code ?? 0);
    throw new WaypostError(denied ? 'CLOUDFLARE_DENIED' : 'CLOUDFLARE_FAILED', denied
      ? `Cloudflare refused to ${step}. Give the API token these permissions: ${[...API_TOKEN_PERMISSIONS, ...extra].join('; ')}.`
      : `Cloudflare could not ${step}: ${first ? `${first.code} ${first.message}` : `HTTP ${response.status}`}.`.replace(/[\x00-\x1f\x7f]/g, ' ').slice(0, 400), {httpStatus:response.status, ...(first ? {cloudflareCode:first.code} : {})});
  };
  return {
    call,
    get: async <T>(path:string, step:string, extra:string[] = []) => (await call<T>('GET', path, undefined, step, extra)).result,
    send: async <T>(method:string, path:string, body:unknown, step:string, extra:string[] = []) => (await call<T>(method, path, body, step, extra)).result,
    // Ownership checks read these lists, so a partial list is an error, never a shorter answer.
    list: async <T>(path:string, step:string) => {
      const items:T[] = [], perPage = 50;
      let previous = '', firstLength = 0, total:number | undefined;
      const done = () => {
        if (total !== undefined && items.length < total) throw new WaypostError('CLOUDFLARE_FAILED', `Cloudflare reported ${total} results but sent ${items.length} when asked to ${step}, so this can't check them all.`);
        return items;
      };
      for (let page = 1; page <= 40; page++) {
        const json = await call<T[]>('GET', `${path}${path.includes('?') ? '&' : '?'}per_page=${perPage}&page=${page}`, undefined, step);
        const result = json.result ?? [], first = JSON.stringify(result[0] ?? null);
        if (typeof json.result_info?.total_count === 'number') total = json.result_info.total_count;
        // Trust total_pages when Cloudflare sends it. Without it, page on until an empty page, since a server may cap
        // pages below per_page. A page that repeats the last one means the endpoint ignores `page`: that sent
        // everything unless the first page was exactly per_page long, which could be a cap hiding the rest.
        if (!result.length) return done();
        if (first === previous) {
          if (firstLength === perPage) throw new WaypostError('CLOUDFLARE_FAILED', `Cloudflare sent the same ${perPage} results for every page when asked to ${step}, so this can't check them all.`);
          return done();
        }
        if (page === 1) firstLength = result.length;
        previous = first; items.push(...result);
        const pages = json.result_info?.total_pages;
        if (pages !== undefined && pages <= page) return done();
      }
      throw new WaypostError('CLOUDFLARE_FAILED', `Cloudflare returned more than 40 pages when asked to ${step}, so this can't check them all.`);
    },
  };
}
type Api = ReturnType<typeof client>;

async function onlyAccount(api:Api) {
  const accounts = (await api.get<{id:string; name:string}[]>('/accounts?per_page=50', 'list your accounts')).filter(item => ACCOUNT_ID.test(item.id));
  if (accounts.length === 1) return accounts[0]!.id;
  if (!accounts.length) throw new WaypostError('CLOUDFLARE_DENIED', `The API token can see no Cloudflare account. Give it these permissions: ${API_TOKEN_PERMISSIONS.join('; ')}.`);
  throw new WaypostError('ACCOUNT_AMBIGUOUS', 'The API token can see more than one Cloudflare account. Pass --account-id with the one to use.', {accounts:accounts.map(item => ({id:item.id, name:item.name}))});
}
async function workersSubdomain(api:Api, account:string):Promise<string | undefined> {
  return api.call<{subdomain?:string}>('GET', `/accounts/${account}/workers/subdomain`, undefined, 'read your workers.dev subdomain').then(json => json.result?.subdomain || undefined, (error:unknown) => {
    if (error instanceof WaypostError && error.details?.cloudflareCode === 10007) return undefined;
    throw error;
  });
}
async function findZone(api:Api, account:string, hostname:string) {
  const labels = hostname.split('.');
  for (let i = 0; i < labels.length - 1; i++) {
    const zones = await api.get<{id:string; name:string}[]>(`/zones?name=${encodeURIComponent(labels.slice(i).join('.'))}&account.id=${account}`, 'find your domain', DOMAIN_PERMISSIONS);
    if (zones[0]) return zones[0].id;
  }
  throw new WaypostError('ZONE_NOT_FOUND', `No domain on this Cloudflare account contains ${hostname}, or the API token can't read it (it needs ${DOMAIN_PERMISSIONS.join(', ')}). Leave out --hostname to use the free workers.dev address.`);
}
function hostOnly(value:string) {
  let host:string;
  try { host = value.includes('://') ? new URL(value).hostname : value.replace(/\/.*$/, ''); }
  catch { throw new WaypostError('INPUT_INVALID', '--hostname must be a hostname such as waypost.example.com.'); }
  if (!/^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/i.test(host)) throw new WaypostError('INPUT_INVALID', '--hostname must be a hostname such as waypost.example.com.');
  return host.toLowerCase();
}
// The token lets anyone run your tunnel, so it is written owner-only and never printed.
async function writeSecret(path:string, value:string) {
  const existing = await lstat(path).catch(() => null);
  if (existing && !existing.isFile()) throw new WaypostError('PATH_UNSAFE', `${path} must be a regular file, not a link or directory.`);
  const temp = join(dirname(path), `.${randomBytes(6).toString('hex')}.tmp`);
  try {
    const file = await open(temp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    try { await file.writeFile(value); await file.sync(); } finally { await file.close(); }
    await rename(temp, path);
  } catch (error) {
    await rm(temp, {force:true});
    if (error instanceof WaypostError) throw error;
    throw new WaypostError('PATH_UNWRITABLE', `Could not write the tunnel token to ${path}. Check that its folder exists and that this user can write to it.`);
  }
}

// The tunnel and account named in a pending token file (setupCloudflare has already refused a link or directory).
// Missing or empty is absent; anything this can't read or parse is refused, since it may be another run's only proof
// of a half-made setup.
async function readPending(path:string):Promise<{tunnelId:string; account:string | undefined} | undefined> {
  const entry = await lstat(path).catch(() => null);
  if (!entry || entry.size === 0) return undefined;
  const refuse = (why:string) => new WaypostError('PATH_UNSAFE', `${path} is left from an earlier run and ${why}. Delete it if you abandoned that setup, and run again.`);
  if (entry.size > 4096) throw refuse('is too large to be a tunnel token');
  const text = await readFile(path, 'utf8').then(value => value.trim(), () => null);
  if (text === null) throw refuse('this user can\'t read it (fix its owner, or run as the user who made it)');
  if (!text) return undefined;
  try {
    const token = JSON.parse(Buffer.from(text, 'base64').toString('utf8')) as {t?:unknown; a?:unknown};
    if (typeof token.t === 'string') return {tunnelId:token.t, account:typeof token.a === 'string' ? token.a : undefined};
  } catch { /* refused below */ }
  throw refuse('doesn\'t hold a tunnel token');
}

// Reads what this host's tunnel token file holds, before any write. Cloudflare's tunnel token is base64 JSON whose
// `t` is the tunnel id. Also proves a temp file can be created next to it, the way writeSecret will.
async function inspectTokenFile(path:string):Promise<{present:boolean; tunnelId?:string}> {
  const unwritable = () => new WaypostError('PATH_UNWRITABLE', `Could not write the tunnel token to ${path}. Check that its folder exists and that this user can write to it.`);
  const folder = await stat(dirname(path)).catch(() => null);
  if (!folder?.isDirectory()) throw unwritable();
  const existing = await lstat(path).catch(() => null);
  if (existing && !existing.isFile()) throw new WaypostError('PATH_UNSAFE', '--tunnel-token-file must be a regular file, not a link or directory.');
  const probe = join(dirname(path), `.${randomBytes(6).toString('hex')}.tmp`);
  try { await (await open(probe, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600)).close(); }
  catch { throw unwritable(); }
  finally { await rm(probe, {force:true}); }
  if (!existing || existing.size === 0 || existing.size > 4096) return {present:!!existing && existing.size > 0};
  const text = await readFile(path, 'utf8').then(value => value.trim(), () => null);
  if (text === null) return {present:true};   // unreadable is not absent
  if (!text) return {present:false};
  try {
    const id = (JSON.parse(Buffer.from(text, 'base64').toString('utf8')) as {t?:unknown}).t;
    return typeof id === 'string' ? {present:true, tunnelId:id} : {present:true};
  } catch { return {present:true}; }
}
