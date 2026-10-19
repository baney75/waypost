import { constants } from 'node:fs';
import { lstat, open, rename, rm } from 'node:fs/promises';
import { dirname, isAbsolute, join } from 'node:path';
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

type Options = {apiToken:string; accountId?:string | undefined; name?:string | undefined; tunnelTokenFile:string; workersSubdomain?:string | undefined; hostname?:string | undefined; replace?:boolean | undefined; originHost?:string | undefined; originPort?:number | undefined; apiBase?:string | undefined};
type Envelope<T> = {success:boolean; result:T; errors?:{code:number; message:string}[]; result_info?:{page?:number; total_pages?:number}};

export async function setupCloudflare(options:Options) {
  const name = options.name ?? 'waypost';
  if (!NAME.test(name)) throw new WaypostError('INPUT_INVALID', '--name must be lowercase letters, digits and hyphens, up to 63 characters.');
  if (options.workersSubdomain !== undefined && !NAME.test(options.workersSubdomain)) throw new WaypostError('INPUT_INVALID', '--workers-subdomain must be lowercase letters, digits and hyphens, up to 63 characters.');
  if (!isAbsolute(options.tunnelTokenFile)) throw new WaypostError('INPUT_INVALID', '--tunnel-token-file must be an absolute path.');
  const hostname = options.hostname === undefined ? undefined : hostOnly(options.hostname);
  const api = client(options.apiToken, options.apiBase ?? 'https://api.cloudflare.com/client/v4');
  if (options.accountId && !ACCOUNT_ID.test(options.accountId)) throw new WaypostError('INPUT_INVALID', '--account-id must be the 32-character id from the Cloudflare dashboard.');
  const account = options.accountId || await onlyAccount(api);

  const originHost = options.originHost ?? 'waypost', originPort = options.originPort ?? 8787;

  // Read-only checks first, so a refusal leaves nothing half-made.
  const tunnels = await api.get<{id:string; name:string; config_src?:string; remote_config?:boolean}[]>(`/accounts/${account}/cfd_tunnel?name=${encodeURIComponent(name)}&is_deleted=false`, 'list tunnels');
  const reused = tunnels.find(item => item.name === name);
  if (reused) {
    // Cloudflare can't see the routes of a locally managed tunnel (they live in a cloudflared config.yml), so it
    // can't promise Worker-only access; a tunnel that doesn't say it's remotely managed counts as local. A remotely
    // managed one may still route public traffic from an earlier setup; only an empty ingress or a catch-all that
    // answers http_status:* is safe.
    if (!(reused.config_src === 'cloudflare' || (reused.config_src === undefined && reused.remote_config === true))) throw new WaypostError('TUNNEL_LOCALLY_MANAGED', `The ${name} tunnel is managed locally, so its public routes live in a cloudflared config file this can't check. Pass a different --name for a fresh tunnel that only your Worker can reach.`);
    const ingress = await api.call<{config?:{ingress?:{hostname?:string; service?:string}[]} | null}>('GET', `/accounts/${account}/cfd_tunnel/${reused.id}/configurations`, undefined, 'read the tunnel configuration')
      .then(json => json.result?.config?.ingress ?? [], (error:unknown) => { if (error instanceof WaypostError && error.details?.httpStatus === 404) return []; throw error; });
    const routes = ingress.filter(rule => rule.hostname || !/^http_status:\d{3}$/.test(rule.service ?? ''));
    if (routes.length) throw new WaypostError('TUNNEL_HAS_PUBLIC_HOSTNAME', `The ${name} tunnel still routes public traffic (${routes.map(rule => rule.hostname ?? `catch-all to ${rule.service}`).join(', ')}), which skips the Worker. Remove those public hostnames (and their DNS records) under Networking → Tunnels → ${name}, or pass a different --name.`, {routes:routes.map(rule => rule.hostname ?? rule.service ?? '')});
  }

  // A same-named VPC service is ours only if it already points at this tunnel's waypost container.
  type Service = {service_id:string; name:string; http_port?:number; host?:{hostname?:string; resolver_network?:{tunnel_id?:string}}};
  const services = await api.list<Service>(`/accounts/${account}/connectivity/directory/services`, 'list VPC services');
  const existing = services.find(item => item.name === name);
  const serviceIsOurs = !!existing && !!reused && existing.host?.resolver_network?.tunnel_id === reused.id && existing.host?.hostname === originHost && existing.http_port === originPort;
  if (existing && !serviceIsOurs && !options.replace)
    throw new WaypostError('VPC_SERVICE_EXISTS', `A VPC service named ${name} already exists and points somewhere other than this tunnel's ${originHost}:${originPort}. Pass a different --name, or --replace to repoint it.`);

  // Never overwrite someone's other Worker that happens to share the name: it counts as Waypost's only with exactly
  // the one ORIGIN_VPC binding this uploads, bound to the VPC service checked above.
  const current = await api.call<{bindings?:{type:string; name:string; service_id?:string}[]}>('GET', `/accounts/${account}/workers/scripts/${name}/settings`, undefined, 'check for an existing Worker')
    .then(json => json.result, (error:unknown) => { if (error instanceof WaypostError && (error.details?.httpStatus === 404 || error.details?.cloudflareCode === 10007)) return null; throw error; });
  const bindings = current?.bindings ?? [];
  if (current && !(serviceIsOurs && bindings.length === 1 && bindings[0]!.name === 'ORIGIN_VPC' && bindings[0]!.type === 'vpc_service' && bindings[0]!.service_id === existing!.service_id) && !options.replace)
    throw new WaypostError('WORKER_EXISTS', `A Worker named ${name} already exists on this account and isn't this Waypost's front door. Pass a different --name, or --replace to overwrite it.`);

  // Custom domains: one this Worker already serves must be the one asked for now, or the rerun would leave a second
  // front door whose Host Waypost refuses; one another Worker serves is not taken over without --replace.
  const domains = await api.list<{hostname:string; service:string}>(`/accounts/${account}/workers/domains`, 'list Worker custom domains');
  const attached = domains.filter(item => item.service === name && item.hostname !== hostname).map(item => item.hostname);
  if (attached.length) throw new WaypostError('HOSTNAME_ATTACHED', `The ${name} Worker already serves ${attached.join(', ')}. Run again with --hostname ${attached[0]}, or remove ${attached.length > 1 ? 'those domains' : 'that domain'} under Workers & Pages → ${name} → Domains & Routes first.`, {hostnames:attached});
  const taken = hostname ? domains.find(item => item.hostname === hostname && item.service !== name) : undefined;
  if (taken && !options.replace) throw new WaypostError('HOSTNAME_IN_USE', `${hostname} already points at the Worker ${taken.service}. Pass a different --hostname, or --replace to move it to ${name}.`);

  const zone = hostname ? await findZone(api, account, hostname) : undefined;
  const subdomain = hostname ? undefined : await workersSubdomain(api, account);
  if (!hostname && !subdomain && !options.workersSubdomain) throw new WaypostError('WORKERS_SUBDOMAIN_NEEDED', 'This Cloudflare account has no workers.dev subdomain yet. Run again with --workers-subdomain <name>; your address becomes https://waypost.<name>.workers.dev.');
  if (subdomain && options.workersSubdomain && subdomain !== options.workersSubdomain) throw new WaypostError('INPUT_INVALID', `This account already uses the workers.dev subdomain ${subdomain}, so your address is https://${name}.${subdomain}.workers.dev. Leave out --workers-subdomain.`);

  // Writes, now that nothing above refused. A new workers.dev subdomain goes first: it is the one write that can
  // fail on a name someone else holds, and it routes nothing.
  const registered = hostname ? undefined : subdomain ?? (await api.send<{subdomain:string}>('PUT', `/accounts/${account}/workers/subdomain`, {subdomain:options.workersSubdomain}, 'register your workers.dev subdomain')).subdomain;
  const tunnel = reused ?? await api.send<{id:string; name:string}>('POST', `/accounts/${account}/cfd_tunnel`, {name, config_src:'cloudflare'}, 'create the tunnel');
  const tunnelToken = await api.get<string>(`/accounts/${account}/cfd_tunnel/${tunnel.id}/token`, 'read the tunnel token');
  if (typeof tunnelToken !== 'string' || !tunnelToken) throw new WaypostError('CLOUDFLARE_FAILED', 'Cloudflare returned an empty tunnel token. Try again in a minute.');
  await writeSecret(options.tunnelTokenFile, tunnelToken);

  const service = {name, type:'http', host:{hostname:originHost, resolver_network:{tunnel_id:tunnel.id}}, http_port:originPort};
  const vpc = existing
    ? await api.send<{service_id:string}>('PUT', `/accounts/${account}/connectivity/directory/services/${existing.service_id}`, service, 'update the VPC service')
    : await api.send<{service_id:string}>('POST', `/accounts/${account}/connectivity/directory/services`, service, 'create the VPC service');

  const form = new FormData();
  form.set('metadata', JSON.stringify({main_module:'worker.js', compatibility_date:'2026-09-01', bindings:[{type:'vpc_service', name:'ORIGIN_VPC', service_id:vpc.service_id}], observability:{enabled:false}}));
  form.set('worker.js', new File([WORKER_SOURCE], 'worker.js', {type:'application/javascript+module'}));
  await api.send('PUT', `/accounts/${account}/workers/scripts/${name}`, form, 'upload the Worker');

  let publicUrl:string;
  if (hostname) {
    await api.send('PUT', `/accounts/${account}/workers/domains`, {hostname, service:name, zone_id:zone, environment:'production'}, 'attach your domain', DOMAIN_PERMISSIONS);
    await api.send('POST', `/accounts/${account}/workers/scripts/${name}/subdomain`, {enabled:false, previews_enabled:false}, 'turn off the workers.dev address');
    publicUrl = `https://${hostname}`;
  } else {
    await api.send('POST', `/accounts/${account}/workers/scripts/${name}/subdomain`, {enabled:true, previews_enabled:false}, 'turn on the workers.dev address');
    publicUrl = `https://${name}.${registered}.workers.dev`;
  }
  return {publicUrl, accountId:account, tunnel:{id:tunnel.id, name, created:!reused}, vpcService:{id:vpc.service_id, created:!existing}, worker:{name, created:!current}, tunnelTokenFile:options.tunnelTokenFile,
    next:[
      `Set up Waypost for this address: docker compose run --rm waypost setup quick --public-url ${publicUrl} --data /data --host 0.0.0.0 --owner you@proton.me`,
      'Start it: docker compose up -d',
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
    list: async <T>(path:string, step:string) => {
      const items:T[] = [];
      for (let page = 1; page <= 20; page++) {
        const json = await call<T[]>('GET', `${path}${path.includes('?') ? '&' : '?'}page=${page}`, undefined, step);
        items.push(...(json.result ?? []));
        if (!json.result?.length || (json.result_info?.total_pages ?? 1) <= page) break;
      }
      return items;
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
  if (existing && !existing.isFile()) throw new WaypostError('PATH_UNSAFE', '--tunnel-token-file must be a regular file, not a link or directory.');
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
