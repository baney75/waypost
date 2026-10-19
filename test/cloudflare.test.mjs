// waypost setup cloudflare against a fake Cloudflare API. Synthetic ids and credentials only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, rm, readFile, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFile } from 'node:child_process';
import { setupCloudflare } from '../dist/cloudflare.js';
import { WORKER_SOURCE } from '../dist/worker-source.js';

const ACCOUNT = 'a'.repeat(32);
const FAKE_API = ['synthetic', 'api', '0123456789'].join('-');
const FAKE_TUNNEL = ['synthetic', 'tunnel', 'eyJhIjoi'].join('-');

async function root(t) { const dir = await mkdtemp(join(tmpdir(), 'waypost-cf-')); t.after(() => rm(dir, {recursive:true, force:true})); return dir; }

/** A small in-memory Cloudflare: enough of the tunnel, connectivity directory, Workers and zones APIs. */
async function fakeCloudflare(t, state = {}) {
  const cf = {accounts:[{id:ACCOUNT, name:'Mine'}], tunnels:[], services:[], scripts:{}, subdomain:'ada', scriptSubdomain:{}, domains:[], zones:[], ingress:{}, deny:null, calls:[], ...state};
  const ok = result => ({success:true, errors:[], result});
  const fail = (status, code, message) => [status, {success:false, errors:[{code, message}], result:null}];
  const route = async (req, url, body) => {
    if (req.headers.authorization !== `Bearer ${FAKE_API}`) return fail(403, 9109, 'Invalid access token');
    const path = url.pathname.replace(/^\/client\/v4/, '');
    if (cf.deny && path.includes(cf.deny)) return fail(403, 10000, 'Authentication error');
    if (path === '/accounts') return [200, ok(cf.accounts)];
    let m;
    if (/^\/accounts\/\w+\/cfd_tunnel$/.test(path)) {
      if (req.method === 'GET') return [200, ok(cf.tunnels.filter(item => item.name === url.searchParams.get('name')))];
      const json = JSON.parse(body.toString());
      assert.equal(json.config_src, 'cloudflare');
      const tunnel = {id:`1111111${cf.tunnels.length}-2222-3333-4444-555555555555`, name:json.name, config_src:'cloudflare'};
      cf.tunnels.push(tunnel); return [200, ok(tunnel)];
    }
    if (/^\/accounts\/\w+\/cfd_tunnel\/[\w-]+\/token$/.test(path)) return [200, ok(FAKE_TUNNEL)];
    if ((m = path.match(/\/cfd_tunnel\/([\w-]+)\/configurations$/))) return [200, ok({config:{ingress:cf.ingress[m[1]] ?? []}})];
    if ((m = path.match(/\/workers\/scripts\/([\w-]+)\/settings$/))) return cf.scripts[m[1]] ? [200, ok({bindings:cf.scripts[m[1]].metadata.bindings})] : fail(404, 10007, 'workers.api.error.script_not_found');
    if (path.endsWith('/connectivity/directory/services')) {
      if (req.method === 'GET') return [200, {...ok(cf.services), result_info:{page:1, total_pages:1}}];
      const service = {service_id:`svc-${cf.services.length}`, ...JSON.parse(body.toString())};
      cf.services.push(service); return [200, ok(service)];
    }
    if ((m = path.match(/\/connectivity\/directory\/services\/([\w-]+)$/))) {
      const index = cf.services.findIndex(item => item.service_id === m[1]);
      cf.services[index] = {service_id:m[1], ...JSON.parse(body.toString())}; return [200, ok(cf.services[index])];
    }
    if ((m = path.match(/\/workers\/scripts\/([\w-]+)$/))) {
      const form = await new Request('http://x/', {method:'PUT', headers:{'content-type':req.headers['content-type']}, body}).formData();
      cf.scripts[m[1]] = {metadata:JSON.parse(form.get('metadata')), source:await form.get('worker.js').text(), type:form.get('worker.js').type};
      return [200, ok({id:m[1]})];
    }
    if ((m = path.match(/\/workers\/scripts\/([\w-]+)\/subdomain$/))) { cf.scriptSubdomain[m[1]] = JSON.parse(body.toString()); return [200, ok(cf.scriptSubdomain[m[1]])]; }
    if (path.endsWith('/workers/subdomain')) {
      if (req.method === 'GET') return cf.subdomain ? [200, ok({subdomain:cf.subdomain})] : fail(404, 10007, 'workers.dev subdomain not found');
      const wanted = JSON.parse(body.toString()).subdomain;
      if (cf.takenSubdomains?.includes(wanted)) return fail(409, 10036, 'subdomain is unavailable');
      cf.subdomain = wanted; return [200, ok({subdomain:cf.subdomain})];
    }
    if (path.endsWith('/workers/domains')) {
      if (req.method === 'GET') return [200, {...ok(cf.domains), result_info:{page:1, total_pages:1}}];
      const domain = JSON.parse(body.toString());
      cf.domains = [...cf.domains.filter(item => item.hostname !== domain.hostname), domain]; return [200, ok(domain)];
    }
    if (path === '/zones') return [200, ok(cf.zones.filter(zone => zone.name === url.searchParams.get('name')))];
    return fail(404, 7003, `No route for ${req.method} ${path}`);
  };
  const server = createServer(async (req, res) => {
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    const url = new URL(req.url, 'http://127.0.0.1');
    cf.calls.push(`${req.method} ${url.pathname.replace(/^\/client\/v4/, '')}`);
    try { const [status, json] = await route(req, url, Buffer.concat(chunks)); res.writeHead(status, {'content-type':'application/json'}).end(JSON.stringify(json)); }
    catch (error) { res.writeHead(500).end(String(error)); }
  });
  await new Promise(done => server.listen(0, '127.0.0.1', done));
  t.after(() => server.close());
  cf.apiBase = `http://127.0.0.1:${server.address().port}/client/v4`;
  return cf;
}
const run = (cf, tunnelTokenFile, extra = {}) => setupCloudflare({apiToken:FAKE_API, tunnelTokenFile, apiBase:cf.apiBase, ...extra});

test('setup cloudflare builds a free workers.dev front door on the caller\'s own account', async t => {
  const dir = await root(t);
  const cf = await fakeCloudflare(t);
  const tokenFile = join(dir, 'tunnel_token');
  const result = await run(cf, tokenFile);
  assert.equal(result.publicUrl, 'https://waypost.ada.workers.dev');
  assert.equal(result.accountId, ACCOUNT);
  assert.equal(result.tunnel.created, true);
  assert.equal(result.vpcService.created, true);
  assert.equal(await readFile(tokenFile, 'utf8'), FAKE_TUNNEL);
  assert.equal((await stat(tokenFile)).mode & 0o777, 0o600);
  assert.ok(!JSON.stringify(result).includes(FAKE_TUNNEL) && !JSON.stringify(result).includes(FAKE_API), 'no secret in the output');
  assert.deepEqual(cf.services[0], {service_id:'svc-0', name:'waypost', type:'http', host:{hostname:'waypost', resolver_network:{tunnel_id:cf.tunnels[0].id}}, http_port:8787});
  const script = cf.scripts.waypost;
  assert.deepEqual(script.metadata.bindings, [{type:'vpc_service', name:'ORIGIN_VPC', service_id:'svc-0'}]);
  assert.equal(script.metadata.main_module, 'worker.js');
  assert.equal(script.type, 'application/javascript+module');
  assert.equal(script.source, await readFile(resolve('deploy/cloudflare-worker/worker.js'), 'utf8'));
  assert.deepEqual(cf.scriptSubdomain.waypost, {enabled:true, previews_enabled:false});
  assert.match(result.next[0], /setup quick --public-url https:\/\/waypost\.ada\.workers\.dev /);
});

test('setup cloudflare is safe to run again: it reuses the tunnel and updates the VPC service', async t => {
  const dir = await root(t);
  const cf = await fakeCloudflare(t);
  await run(cf, join(dir, 'tunnel_token'));
  const again = await run(cf, join(dir, 'tunnel_token'));
  assert.equal(cf.tunnels.length, 1);
  assert.equal(cf.services.length, 1);
  assert.equal(again.tunnel.created, false);
  assert.equal(again.vpcService.created, false);
  assert.equal(again.worker.created, false);
  assert.ok(cf.calls.includes(`PUT /accounts/${ACCOUNT}/connectivity/directory/services/svc-0`));
});

test('setup cloudflare registers a workers.dev subdomain only when asked', async t => {
  const dir = await root(t);
  const cf = await fakeCloudflare(t, {subdomain:null});
  await assert.rejects(run(cf, join(dir, 't')), {code:'WORKERS_SUBDOMAIN_NEEDED'});
  const result = await run(cf, join(dir, 't'), {workersSubdomain:'grace'});
  assert.equal(result.publicUrl, 'https://waypost.grace.workers.dev');
  await assert.rejects(run(cf, join(dir, 't'), {workersSubdomain:'Not Valid'}), {code:'INPUT_INVALID'});
  await assert.rejects(run(cf, join(dir, 't'), {workersSubdomain:'hopper'}), error => { assert.equal(error.code, 'INPUT_INVALID'); assert.match(error.message, /waypost\.grace\.workers\.dev/); return true; });
  assert.equal((await run(cf, join(dir, 't'), {workersSubdomain:'grace'})).publicUrl, 'https://waypost.grace.workers.dev');
});

test('setup cloudflare names the missing permissions and never echoes the API credential', async t => {
  const dir = await root(t);
  const cf = await fakeCloudflare(t, {deny:'/connectivity/'});
  await assert.rejects(run(cf, join(dir, 't')), error => {
    assert.equal(error.code, 'CLOUDFLARE_DENIED');
    assert.match(error.message, /Connectivity Directory Admin/);
    assert.ok(!error.message.includes(FAKE_API));
    return true;
  });
});

test('setup cloudflare tells a mistyped token apart from a missing permission', async t => {
  const dir = await root(t);
  const cf = await fakeCloudflare(t);
  await assert.rejects(setupCloudflare({apiToken:'mistyped', tunnelTokenFile:join(dir, 't'), apiBase:cf.apiBase}), {code:'CLOUDFLARE_TOKEN_REJECTED'});
});

test('setup cloudflare asks for --account-id when the token sees several accounts', async t => {
  const dir = await root(t);
  const cf = await fakeCloudflare(t, {accounts:[{id:ACCOUNT, name:'Mine'}, {id:'b'.repeat(32), name:'Work'}]});
  await assert.rejects(run(cf, join(dir, 't')), {code:'ACCOUNT_AMBIGUOUS'});
  assert.equal((await run(cf, join(dir, 't'), {accountId:ACCOUNT})).accountId, ACCOUNT);
});

test('setup cloudflare serves an existing domain when --hostname is given and turns workers.dev off', async t => {
  const dir = await root(t);
  const cf = await fakeCloudflare(t, {zones:[{id:'zone-1', name:'example.com'}]});
  const result = await run(cf, join(dir, 't'), {hostname:'https://Waypost.Example.com/'});
  assert.equal(result.publicUrl, 'https://waypost.example.com');
  assert.deepEqual(cf.domains, [{hostname:'waypost.example.com', service:'waypost', zone_id:'zone-1', environment:'production'}]);
  assert.deepEqual(cf.scriptSubdomain.waypost, {enabled:false, previews_enabled:false});
  assert.equal((await run(cf, join(dir, 't'), {hostname:'waypost.example.com'})).worker.created, false);
  await assert.rejects(run(cf, join(dir, 't'), {hostname:'https://'}), {code:'INPUT_INVALID'});
});

test('a rerun never leaves a second front door: the domain already served must be asked for again', async t => {
  const dir = await root(t);
  const cf = await fakeCloudflare(t, {zones:[{id:'zone-1', name:'example.com'}, {id:'zone-2', name:'other.org'}]});
  await run(cf, join(dir, 't'), {hostname:'waypost.example.com'});
  const calls = cf.calls.length;
  for (const extra of [{}, {hostname:'waypost.other.org'}])
    await assert.rejects(run(cf, join(dir, 't'), extra), error => { assert.equal(error.code, 'HOSTNAME_ATTACHED'); assert.match(error.message, /--hostname waypost\.example\.com/); return true; });
  assert.ok(cf.calls.slice(calls).every(call => call.startsWith('GET ')));
  assert.deepEqual(cf.scriptSubdomain.waypost, {enabled:false, previews_enabled:false});
});

test('a domain another Worker serves is not taken over unless told to, and a refusal writes nothing', async t => {
  const dir = await root(t);
  const cf = await fakeCloudflare(t, {zones:[{id:'zone-1', name:'example.com'}], domains:[{hostname:'waypost.example.com', service:'blog', zone_id:'zone-1', environment:'production'}]});
  await assert.rejects(run(cf, join(dir, 't'), {hostname:'waypost.example.com'}), {code:'HOSTNAME_IN_USE'});
  assert.deepEqual([cf.tunnels.length, cf.services.length, Object.keys(cf.scripts).length], [0, 0, 0]);
  await assert.rejects(stat(join(dir, 't')), {code:'ENOENT'});
  await run(cf, join(dir, 't'), {hostname:'waypost.example.com', replace:true});
  assert.deepEqual(cf.domains.map(item => item.service), ['waypost']);
});

test('setup cloudflare refuses to write the tunnel token through a link', async t => {
  const dir = await root(t);
  const cf = await fakeCloudflare(t);
  await writeFile(join(dir, 'elsewhere'), '');
  await symlink(join(dir, 'elsewhere'), join(dir, 'tunnel_token'));
  await assert.rejects(run(cf, join(dir, 'tunnel_token')), {code:'PATH_UNSAFE'});
  assert.equal(await readFile(join(dir, 'elsewhere'), 'utf8'), '');
});

test('setup cloudflare stops when a reused tunnel still publishes a public hostname', async t => {
  const dir = await root(t);
  const id = '11111110-2222-3333-4444-555555555555';
  const cf = await fakeCloudflare(t, {tunnels:[{id, name:'waypost', config_src:'cloudflare'}], ingress:{[id]:[{hostname:'waypost.example.com', service:'http://waypost:8787'}, {service:'http_status:404'}]}});
  await assert.rejects(run(cf, join(dir, 't')), error => { assert.equal(error.code, 'TUNNEL_HAS_PUBLIC_HOSTNAME'); assert.match(error.message, /waypost\.example\.com/); return true; });
  await assert.rejects(stat(join(dir, 't')), {code:'ENOENT'});
});

test('setup cloudflare never overwrites a different Worker that shares the name unless told to', async t => {
  const dir = await root(t);
  const cf = await fakeCloudflare(t, {scripts:{waypost:{metadata:{bindings:[{type:'kv_namespace', name:'BLOG'}]}}}});
  await assert.rejects(run(cf, join(dir, 't')), {code:'WORKER_EXISTS'});
  assert.deepEqual(cf.scripts.waypost.metadata.bindings, [{type:'kv_namespace', name:'BLOG'}]);
  assert.equal((await run(cf, join(dir, 't'), {replace:true})).worker.created, false);
});

test('a same-named Worker bound to some other VPC service is not Waypost\'s', async t => {
  const dir = await root(t);
  const foreign = {type:'vpc_service', name:'ORIGIN_VPC', service_id:'svc-other'};
  const cf = await fakeCloudflare(t, {scripts:{waypost:{metadata:{bindings:[foreign]}}}});
  await assert.rejects(run(cf, join(dir, 't')), {code:'WORKER_EXISTS'});
  assert.deepEqual([cf.tunnels.length, cf.services.length, cf.scripts.waypost.metadata.bindings], [0, 0, [foreign]]);
  await assert.rejects(stat(join(dir, 't')), {code:'ENOENT'});
});

test('a same-named Worker with no bindings is not Waypost\'s either, and a refusal writes nothing', async t => {
  const dir = await root(t);
  const cf = await fakeCloudflare(t, {scripts:{waypost:{metadata:{bindings:[]}}}});
  await assert.rejects(run(cf, join(dir, 't')), {code:'WORKER_EXISTS'});
  await assert.rejects(stat(join(dir, 't')), {code:'ENOENT'});
  assert.deepEqual([cf.tunnels.length, cf.services.length], [0, 0]);
});

test('a reused tunnel that forwards traffic, or whose routes Cloudflare cannot see, is refused', async t => {
  const dir = await root(t);
  const id = '11111110-2222-3333-4444-555555555555';
  const forwarding = await fakeCloudflare(t, {tunnels:[{id, name:'waypost', config_src:'cloudflare'}], ingress:{[id]:[{service:'http://waypost:8787'}]}});
  await assert.rejects(run(forwarding, join(dir, 't')), {code:'TUNNEL_HAS_PUBLIC_HOSTNAME'});
  const local = await fakeCloudflare(t, {tunnels:[{id, name:'waypost', config_src:'local'}]});
  await assert.rejects(run(local, join(dir, 't')), {code:'TUNNEL_LOCALLY_MANAGED'});
  const unknown = await fakeCloudflare(t, {tunnels:[{id, name:'waypost'}]});
  await assert.rejects(run(unknown, join(dir, 't')), {code:'TUNNEL_LOCALLY_MANAGED'});
  await assert.rejects(stat(join(dir, 't')), {code:'ENOENT'});
});

test('a same-named VPC service that points elsewhere is not repointed unless told to', async t => {
  const dir = await root(t);
  const foreign = {service_id:'svc-x', name:'waypost', type:'http', host:{hostname:'db', resolver_network:{tunnel_id:'99999999-2222-3333-4444-555555555555'}}, http_port:5432};
  const cf = await fakeCloudflare(t, {services:[foreign]});
  await assert.rejects(run(cf, join(dir, 't')), {code:'VPC_SERVICE_EXISTS'});
  assert.deepEqual([cf.tunnels.length, cf.services[0]], [0, foreign]);
  await assert.rejects(stat(join(dir, 't')), {code:'ENOENT'});
  const result = await run(cf, join(dir, 't'), {replace:true});
  assert.equal(result.vpcService.id, 'svc-x');
  assert.equal(cf.services[0].host.resolver_network.tunnel_id, cf.tunnels[0].id);
});

test('a missing workers.dev subdomain or domain is caught before anything is written', async t => {
  const dir = await root(t);
  const none = await fakeCloudflare(t, {subdomain:null});
  await assert.rejects(run(none, join(dir, 't')), {code:'WORKERS_SUBDOMAIN_NEEDED'});
  const nozone = await fakeCloudflare(t);
  await assert.rejects(run(nozone, join(dir, 't'), {hostname:'waypost.other.org'}), {code:'ZONE_NOT_FOUND'});
  const held = await fakeCloudflare(t, {subdomain:null, takenSubdomains:['ada']});
  await assert.rejects(run(held, join(dir, 't'), {workersSubdomain:'ada'}), {code:'CLOUDFLARE_FAILED'});
  for (const cf of [none, nozone, held]) assert.deepEqual([cf.tunnels.length, cf.services.length, Object.keys(cf.scripts).length], [0, 0, 0]);
  await assert.rejects(stat(join(dir, 't')), {code:'ENOENT'});
});

test('setup cloudflare rejects a malformed account id', async t => {
  const dir = await root(t);
  const cf = await fakeCloudflare(t);
  await assert.rejects(run(cf, join(dir, 't'), {accountId:'../zones'}), {code:'INPUT_INVALID'});
});

test('the embedded front door is the committed deploy/cloudflare-worker/worker.js', async () => {
  assert.equal(WORKER_SOURCE, await readFile(resolve('deploy/cloudflare-worker/worker.js'), 'utf8'));
});

test('the CLI reads the API credential only from CLOUDFLARE_API_TOKEN', async t => {
  const dir = await root(t);
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('CLOUDFLARE_')));
  const cli = args => new Promise(done => execFile(process.execPath, [resolve('runtime/waypost.mjs'), '--config', join(dir, 'config.json'), ...args], {env}, (error, stdout, stderr) => done({error, stdout, stderr})));
  const missing = await cli(['setup', 'cloudflare', '--tunnel-token-file', join(dir, 't')]);
  assert.equal(missing.error?.code, 1);
  assert.match(JSON.parse(missing.stderr).error.message, /CLOUDFLARE_API_TOKEN/);
  const flag = await cli(['setup', 'cloudflare', '--tunnel-token-file', join(dir, 't'), '--api-token', 'x']);
  assert.match(flag.stderr, /unknown option/);
});
