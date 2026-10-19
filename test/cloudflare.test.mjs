// waypost setup cloudflare against a fake Cloudflare API. Synthetic ids and credentials only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { chmod, mkdir, mkdtemp, rm, readFile, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFile } from 'node:child_process';
import { setupCloudflare } from '../dist/cloudflare.js';
import { WORKER_SOURCE } from '../dist/worker-source.js';

const ACCOUNT = 'a'.repeat(32);
const FAKE_API = ['synthetic', 'api', '0123456789'].join('-');
const tokenFor = id => Buffer.from(JSON.stringify({a:ACCOUNT, t:id, s:'synthetic-secret'})).toString('base64');
const FAKE_TUNNEL = tokenFor('11111110-2222-3333-4444-555555555555');
const holdToken = (file, id) => writeFile(file, tokenFor(id));

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
      if (req.method === 'GET') return [200, ok(cf.tunnels.filter(item => item.name === url.searchParams.get('name')).map(item => ({status:'inactive', ...item})))];
      const json = JSON.parse(body.toString());
      assert.equal(json.config_src, 'cloudflare');
      const tunnel = {id:`1111111${cf.tunnels.length + (cf.deletedTunnels?.length ?? 0)}-2222-3333-4444-555555555555`, name:json.name, config_src:'cloudflare'};
      cf.tunnels.push(tunnel); return [200, ok(tunnel)];
    }
    if ((m = path.match(/\/cfd_tunnel\/([\w-]+)\/token$/))) return cf.failTokenRead ? fail(500, 1000, 'internal error') : [200, ok(tokenFor(m[1]))];
    if ((m = path.match(/\/cfd_tunnel\/([\w-]+)$/)) && req.method === 'DELETE') { cf.deletedTunnels = [...cf.deletedTunnels ?? [], ...cf.tunnels.filter(item => item.id === m[1]).map(item => ({...item, deleted_at:'2026-10-19T00:00:00Z'}))]; cf.tunnels = cf.tunnels.filter(item => item.id !== m[1]); return [200, ok({id:m[1]})]; }
    if ((m = path.match(/\/cfd_tunnel\/([\w-]+)$/))) { const found = [...cf.tunnels, ...cf.deletedTunnels ?? []].find(item => item.id === m[1]); return found ? [200, ok({deleted_at:null, ...found})] : fail(404, 1003, 'tunnel not found'); }
    if ((m = path.match(/\/cfd_tunnel\/([\w-]+)\/configurations$/))) return [200, ok({config:{ingress:cf.ingress[m[1]] ?? [], ...(cf.warpRouting ? {'warp-routing':{enabled:true}} : {})}})];
    if (path.endsWith('/teamnet/routes')) return [200, {...ok((cf.privateRoutes ?? []).filter(route => route.tunnel_id === url.searchParams.get('tunnel_id'))), result_info:{page:1, total_pages:1}}];
    if ((m = path.match(/\/workers\/scripts\/([\w-]+)\/settings$/))) return cf.scripts[m[1]] ? [200, ok({bindings:cf.scripts[m[1]].metadata.bindings})] : fail(404, cf.missingScriptCode ?? 10007, 'workers.api.error.script_not_found');
    if (path.endsWith('/connectivity/directory/services')) {
      if (req.method === 'GET') {
        if (!cf.pageSize) return [200, {...ok(cf.services), result_info:{page:1, total_pages:1}}];
        if (cf.ignorePage) return [200, {...ok(cf.services.slice(0, cf.pageSize)), ...(cf.totalCount ? {result_info:{total_count:cf.services.length}} : {})}];
        const page = Number(url.searchParams.get('page')), slice = cf.services.slice((page - 1) * cf.pageSize, page * cf.pageSize);
        return [200, cf.pageCount ? {...ok(slice), result_info:{page, total_pages:Math.ceil(cf.services.length / cf.pageSize)}} : ok(slice)];
      }
      const service = {service_id:`svc-${cf.services.length}`, ...JSON.parse(body.toString())};
      cf.services.push(service); await cf.onServiceWrite?.(); return [200, ok(service)];
    }
    if ((m = path.match(/\/connectivity\/directory\/services\/([\w-]+)$/))) {
      const index = cf.services.findIndex(item => item.service_id === m[1]);
      if (req.method === 'DELETE') { cf.services.splice(index, 1); return [200, ok({service_id:m[1]})]; }
      cf.services[index] = {service_id:m[1], ...JSON.parse(body.toString())}; await cf.onServiceWrite?.(); return [200, ok(cf.services[index])];
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
      if (req.method !== 'GET' && cf.denyDomainAttach) return fail(403, 10000, 'Authentication error');
      if (req.method === 'GET') return [200, {...ok(cf.domains.filter(item => ['service', 'hostname'].every(key => !url.searchParams.has(key) || item[key] === url.searchParams.get(key)))), result_info:{page:1, total_pages:1}}];
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
  assert.equal(await readFile(tokenFile, 'utf8'), tokenFor(cf.tunnels[0].id));
  assert.equal((await stat(tokenFile)).mode & 0o777, 0o600);
  assert.ok(!JSON.stringify(result).includes(tokenFor(cf.tunnels[0].id)) && !JSON.stringify(result).includes(FAKE_API), 'no secret in the output');
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
  assert.deepEqual(cf.calls, [], 'refused before any Cloudflare call');
});

test('an unusable token destination is refused before anything is created on Cloudflare', async t => {
  const dir = await root(t);
  const cf = await fakeCloudflare(t);
  await assert.rejects(run(cf, join(dir, 'no-such-folder', 'tunnel_token')), {code:'PATH_UNWRITABLE'});
  await mkdir(join(dir, 'folder'));
  await assert.rejects(run(cf, join(dir, 'folder')), {code:'PATH_UNSAFE'});
  assert.deepEqual([cf.calls.length, cf.tunnels.length, cf.services.length], [0, 0, 0]);
});

test('a tunnel another server on the account runs is not joined by default', async t => {
  const dir = await root(t);
  const id = '11111110-2222-3333-4444-555555555555';
  const cf = await fakeCloudflare(t, {tunnels:[{id, name:'waypost', config_src:'cloudflare'}]});
  await assert.rejects(run(cf, join(dir, 't')), {code:'TUNNEL_EXISTS'});
  await holdToken(join(dir, 't'), '99999999-2222-3333-4444-555555555555');
  await assert.rejects(run(cf, join(dir, 't')), {code:'TUNNEL_EXISTS'});
  assert.deepEqual([cf.services.length, Object.keys(cf.scripts).length], [0, 0]);
  assert.equal(await readFile(join(dir, 't'), 'utf8'), tokenFor('99999999-2222-3333-4444-555555555555'));
  await assert.rejects(run(cf, join(dir, 't'), {reuse:true}), {code:'TOKEN_FILE_IN_USE'});
  assert.equal(await readFile(join(dir, 't'), 'utf8'), tokenFor('99999999-2222-3333-4444-555555555555'));
  assert.equal((await run(cf, join(dir, 't'), {reuse:true, replace:true})).tunnel.created, false);
  assert.equal(await readFile(join(dir, 't'), 'utf8'), tokenFor(id));
  await rm(join(dir, 't'));
  assert.equal((await run(cf, join(dir, 't'), {reuse:true})).tunnel.created, false);
});

test('the token file is one more change --replace must show, not a separate refusal', async t => {
  const dir = await root(t);
  const cf = await fakeCloudflare(t, {scripts:{waypost:{metadata:{bindings:[{type:'kv_namespace', name:'BLOG'}]}}}});
  await holdToken(join(dir, 't'), '99999999-2222-3333-4444-555555555555');
  await assert.rejects(run(cf, join(dir, 't')), error => { assert.deepEqual(error.details.conflicts, ['TOKEN_FILE_IN_USE', 'WORKER_EXISTS']); assert.match(error.message, /--tunnel-token-file/); return true; });
  assert.deepEqual(cf.calls.filter(call => !call.startsWith('GET ')), []);
});

test('an unreadable token file counts as held, not absent', {skip:process.getuid?.() === 0 && 'root reads everything'}, async t => {
  const dir = await root(t);
  const cf = await fakeCloudflare(t);
  await holdToken(join(dir, 't'), '99999999-2222-3333-4444-555555555555');
  await chmod(join(dir, 't'), 0o000);
  await assert.rejects(run(cf, join(dir, 't')), {code:'TOKEN_FILE_IN_USE'});
  assert.equal(cf.tunnels.length, 0);
});

test('a tunnel this run made but could not hand over is removed, so the rerun starts clean', async t => {
  const dir = await root(t);
  const cf = await fakeCloudflare(t, {failTokenRead:true});
  await assert.rejects(run(cf, join(dir, 't')), {code:'CLOUDFLARE_FAILED'});
  assert.equal(cf.tunnels.length, 0);
  cf.failTokenRead = false;
  assert.equal((await run(cf, join(dir, 't'))).tunnel.created, true);
});

test('a new tunnel does not silently replace the token of a tunnel this host runs', async t => {
  const dir = await root(t);
  const cf = await fakeCloudflare(t);
  await holdToken(join(dir, 't'), '99999999-2222-3333-4444-555555555555');
  await assert.rejects(run(cf, join(dir, 't')), {code:'TOKEN_FILE_IN_USE'});
  await writeFile(join(dir, 'junk'), 'not a tunnel token');
  await assert.rejects(run(cf, join(dir, 'junk')), {code:'TOKEN_FILE_IN_USE'});
  assert.deepEqual([cf.tunnels.length, cf.services.length], [0, 0]);
  await writeFile(join(dir, 'empty'), '');
  assert.equal((await run(cf, join(dir, 'empty'))).tunnel.created, true);
  await rm(join(dir, 'empty'));
  const moved = await fakeCloudflare(t);
  await holdToken(join(dir, 't'), '99999999-2222-3333-4444-555555555555');
  assert.equal((await run(moved, join(dir, 't'), {replace:true})).tunnel.created, true);
});

test('a domain Cloudflare refuses to attach leaves no workers.dev address behind', async t => {
  const dir = await root(t);
  const cf = await fakeCloudflare(t, {zones:[{id:'zone-1', name:'example.com'}], denyDomainAttach:true});
  await assert.rejects(run(cf, join(dir, 't'), {hostname:'waypost.example.com'}), {code:'CLOUDFLARE_DENIED'});
  assert.deepEqual(cf.scriptSubdomain.waypost, {enabled:false, previews_enabled:false});
});

test('a same-named service on a later page is still found when Cloudflare omits the page count', async t => {
  const dir = await root(t);
  const foreign = {service_id:'svc-x', name:'waypost', type:'http', host:{hostname:'db', resolver_network:{tunnel_id:'99999999-2222-3333-4444-555555555555'}}, http_port:5432};
  const filler = Array.from({length:50}, (_, i) => ({service_id:`f-${i}`, name:`other-${i}`}));
  const cf = await fakeCloudflare(t, {pageSize:50, services:[...filler, foreign]});
  await assert.rejects(run(cf, join(dir, 't')), {code:'VPC_SERVICE_EXISTS'});
  assert.deepEqual([cf.tunnels.length, cf.services.length], [0, 51]);
});

test('setup cloudflare stops when a reused tunnel still publishes a public hostname', async t => {
  const dir = await root(t);
  const id = '11111110-2222-3333-4444-555555555555';
  const cf = await fakeCloudflare(t, {tunnels:[{id, name:'waypost', config_src:'cloudflare'}], ingress:{[id]:[{hostname:'waypost.example.com', service:'http://waypost:8787'}, {service:'http_status:404'}]}});
  await holdToken(join(dir, 't'), id);
  await assert.rejects(run(cf, join(dir, 't')), error => { assert.equal(error.code, 'TUNNEL_HAS_PUBLIC_HOSTNAME'); assert.match(error.message, /waypost\.example\.com/); return true; });
  assert.equal(await readFile(join(dir, 't'), 'utf8'), tokenFor(id));
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

test('a same-named Worker bound to another service is refused even beside our own tunnel and service', async t => {
  const dir = await root(t);
  const id = '11111110-2222-3333-4444-555555555555';
  const ours = {service_id:'svc-0', name:'waypost', type:'http', host:{hostname:'waypost', resolver_network:{tunnel_id:id}}, http_port:8787};
  const cf = await fakeCloudflare(t, {tunnels:[{id, name:'waypost', config_src:'cloudflare'}], services:[ours], scripts:{waypost:{metadata:{bindings:[{type:'vpc_service', name:'ORIGIN_VPC', service_id:'svc-other'}]}}}});
  await holdToken(join(dir, 't'), id);
  await assert.rejects(run(cf, join(dir, 't')), {code:'WORKER_EXISTS'});
  assert.deepEqual(cf.calls.filter(call => !call.startsWith('GET ')), []);
  cf.scripts.waypost.metadata.bindings[0].service_id = 'svc-0';
  assert.equal((await run(cf, join(dir, 't'))).worker.created, false);
});

test('--replace is never asked for one overwrite while hiding another', async t => {
  const dir = await root(t);
  const cf = await fakeCloudflare(t, {scripts:{waypost:{metadata:{bindings:[{type:'kv_namespace', name:'BLOG'}]}}}, domains:[{hostname:'waypost.example.com', service:'blog'}], zones:[{id:'z1', name:'example.com'}]});
  await assert.rejects(run(cf, join(dir, 't'), {hostname:'waypost.example.com'}), error => {
    assert.deepEqual(error.details.conflicts, ['WORKER_EXISTS', 'HOSTNAME_IN_USE']);
    assert.match(error.message, /Worker waypost.*waypost\.example\.com/);
    return true;
  });
});

test('a missing Worker is only one Cloudflare says is missing; other 404s stop the run', async t => {
  const dir = await root(t);
  const cf = await fakeCloudflare(t, {missingScriptCode:7003});
  await assert.rejects(run(cf, join(dir, 't')), {code:'CLOUDFLARE_FAILED'});
  assert.deepEqual(cf.calls.filter(call => !call.startsWith('GET ')), []);
});

test('a reused tunnel with private-network routes or WARP routing is refused', async t => {
  const dir = await root(t);
  const id = '11111110-2222-3333-4444-555555555555';
  const routed = await fakeCloudflare(t, {tunnels:[{id, name:'waypost', config_src:'cloudflare'}], privateRoutes:[{network:'172.16.0.0/12', tunnel_id:id}]});
  await holdToken(join(dir, 't'), id);
  await assert.rejects(run(routed, join(dir, 't')), error => { assert.equal(error.code, 'TUNNEL_HAS_PRIVATE_ROUTES'); assert.match(error.message, /172\.16\.0\.0\/12/); return true; });
  const warp = await fakeCloudflare(t, {tunnels:[{id, name:'waypost', config_src:'cloudflare'}], warpRouting:true});
  await assert.rejects(run(warp, join(dir, 't')), {code:'TUNNEL_HAS_PRIVATE_ROUTES'});
  for (const cf of [routed, warp]) assert.deepEqual(cf.calls.filter(call => !call.startsWith('GET ')), []);
});

test('--workers-subdomain with --hostname is refused before any call', async t => {
  const dir = await root(t);
  const cf = await fakeCloudflare(t, {zones:[{id:'zone-1', name:'example.com'}]});
  await assert.rejects(run(cf, join(dir, 't'), {hostname:'waypost.example.com', workersSubdomain:'grace'}), {code:'INPUT_INVALID'});
  assert.deepEqual(cf.calls, []);
});

test('a page shorter than asked for is not taken as the last one without a page count', async t => {
  const dir = await root(t);
  const filler = Array.from({length:20}, (_, i) => ({service_id:`f-${i}`, name:`other-${i}`}));
  const foreign = {service_id:'svc-x', name:'waypost', type:'http', host:{hostname:'db'}, http_port:5432};
  const cf = await fakeCloudflare(t, {pageSize:20, services:[...filler, foreign]});
  await assert.rejects(run(cf, join(dir, 't')), {code:'VPC_SERVICE_EXISTS'});
  const big = await fakeCloudflare(t, {pageSize:60, ignorePage:true, services:Array.from({length:60}, (_, i) => ({service_id:`g-${i}`, name:`other-${i}`}))});
  assert.equal((await run(big, join(dir, 'big'))).vpcService.created, true);
});

test('ownership checks read every page of a list', async t => {
  const dir = await root(t);
  const filler = n => Array.from({length:n}, (_, i) => ({service_id:`svc-f${i}`, name:`other-${i}`, type:'http', host:{hostname:'x'}, http_port:80}));
  const foreign = {service_id:'svc-x', name:'waypost', type:'http', host:{hostname:'db'}, http_port:5432};
  const paged = await fakeCloudflare(t, {pageSize:2, pageCount:true, services:[...filler(5), foreign]});
  await assert.rejects(run(paged, join(dir, 't')), {code:'VPC_SERVICE_EXISTS'});
  const unpaged = await fakeCloudflare(t, {pageSize:2, ignorePage:true, services:filler(2)});
  assert.equal((await run(unpaged, join(dir, 'unpaged'))).vpcService.created, true);
  const endless = await fakeCloudflare(t, {pageSize:1, pageCount:true, services:filler(101)});
  await assert.rejects(run(endless, join(dir, 'endless')), error => { assert.equal(error.code, 'CLOUDFLARE_FAILED'); assert.match(error.message, /more than 40 pages/); return true; });
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
  await holdToken(join(dir, 't'), id);
  const forwarding = await fakeCloudflare(t, {tunnels:[{id, name:'waypost', config_src:'cloudflare'}], ingress:{[id]:[{service:'http://waypost:8787'}]}});
  await assert.rejects(run(forwarding, join(dir, 't')), {code:'TUNNEL_HAS_PUBLIC_HOSTNAME'});
  const local = await fakeCloudflare(t, {tunnels:[{id, name:'waypost', config_src:'local'}]});
  await assert.rejects(run(local, join(dir, 't')), {code:'TUNNEL_LOCALLY_MANAGED'});
  const unknown = await fakeCloudflare(t, {tunnels:[{id, name:'waypost'}]});
  await assert.rejects(run(unknown, join(dir, 't')), {code:'TUNNEL_LOCALLY_MANAGED'});
  assert.equal(await readFile(join(dir, 't'), 'utf8'), tokenFor(id));
});

test('a same-named VPC service that points elsewhere is never repointed, even with --replace', async t => {
  const dir = await root(t);
  const foreign = {service_id:'svc-x', name:'waypost', type:'http', host:{hostname:'db', resolver_network:{tunnel_id:'99999999-2222-3333-4444-555555555555'}}, http_port:5432};
  const cf = await fakeCloudflare(t, {services:[foreign]});
  await assert.rejects(run(cf, join(dir, 't')), {code:'VPC_SERVICE_EXISTS'});
  assert.deepEqual([cf.tunnels.length, cf.services[0]], [0, foreign]);
  await assert.rejects(stat(join(dir, 't')), {code:'ENOENT'});
  await assert.rejects(run(cf, join(dir, 't'), {replace:true}), error => { assert.equal(error.code, 'VPC_SERVICE_EXISTS'); assert.match(error.message, /even with --replace/); return true; });
  assert.deepEqual([cf.tunnels.length, cf.services[0]], [0, foreign]);
  // Two services with this name can't be told apart, so neither is touched.
  const twice = await fakeCloudflare(t, {services:[{...foreign, host:{hostname:'waypost', resolver_network:{tunnel_id:'99999999-2222-3333-4444-555555555555'}}, http_port:8787}, foreign]});
  await assert.rejects(run(twice, join(dir, 'twice')), error => { assert.equal(error.code, 'VPC_SERVICE_EXISTS'); assert.match(error.message, /2 VPC services named waypost/); return true; });
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

test('the committed src/worker-source.ts is what embed-worker.mjs generates from deploy/cloudflare-worker/worker.js', async t => {
  // npm test rebuilds src/ and dist/ from worker.js first, so only the committed blob can show drift.
  const committed = await new Promise(done => execFile('git', ['show', 'HEAD:src/worker-source.ts'], {maxBuffer:1 << 24}, (error, stdout) => done(error ? null : stdout)));
  if (committed === null) return t.skip('not a git checkout');
  const worker = await readFile(resolve('deploy/cloudflare-worker/worker.js'), 'utf8');
  assert.equal(committed, `// Generated by scripts/embed-worker.mjs from deploy/cloudflare-worker/worker.js. Do not edit.\nexport const WORKER_SOURCE:string=${JSON.stringify(worker)};\n`);
  assert.equal(WORKER_SOURCE, worker);
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

test('an endpoint that ignores page and fills every page is not taken as complete', async t => {
  const dir = await root(t);
  const filler = Array.from({length:70}, (_, i) => ({service_id:`f-${i}`, name:`other-${i}`}));
  const capped = await fakeCloudflare(t, {pageSize:50, ignorePage:true, services:filler});
  await assert.rejects(run(capped, join(dir, 't')), error => { assert.equal(error.code, 'CLOUDFLARE_FAILED'); assert.match(error.message, /same 50 results/); return true; });
  const counted = await fakeCloudflare(t, {pageSize:20, ignorePage:true, totalCount:true, services:filler.slice(0, 25)});
  await assert.rejects(run(counted, join(dir, 'c')), error => { assert.equal(error.code, 'CLOUDFLARE_FAILED'); assert.match(error.message, /reported 25 results but sent 20/); return true; });
  assert.deepEqual([capped.tunnels.length, counted.tunnels.length], [0, 0]);
});

test('a token for a deleted tunnel is stale, not in use, and a swapped token says to restart the tunnel', async t => {
  const dir = await root(t);
  const cf = await fakeCloudflare(t);
  const first = await run(cf, join(dir, 't'));
  assert.equal(first.tunnelTokenReplaced, false);
  // The start step always recreates cloudflared: a run that swapped the token and then failed leaves no trace a retry could see.
  assert.ok(first.next.some(step => step.includes('docker compose up -d --force-recreate cloudflared')));
  const again = await run(cf, join(dir, 't'));
  assert.equal(again.tunnelTokenReplaced, false);
  // Deleted in the dashboard: the rerun makes a new tunnel without --replace and says to restart cloudflared.
  cf.deletedTunnels = cf.tunnels.map(item => ({...item, deleted_at:'2026-10-19T00:00:00Z'})); cf.tunnels = [];
  const fresh = await run(cf, join(dir, 't'));
  assert.equal(fresh.tunnel.created, true);
  assert.notEqual(fresh.tunnel.id, first.tunnel.id);
  assert.equal(await readFile(join(dir, 't'), 'utf8'), tokenFor(fresh.tunnel.id));
  assert.equal(fresh.tunnelTokenReplaced, true);
  assert.ok(fresh.next.some(step => step.includes('docker compose up -d --force-recreate cloudflared')));
  // A token for a tunnel that still exists elsewhere is still in use, and --replace also says to restart.
  await holdToken(join(dir, 'u'), '99999999-2222-3333-4444-555555555555');
  cf.tunnels.push({id:'99999999-2222-3333-4444-555555555555', name:'other', config_src:'cloudflare'});
  await assert.rejects(run(cf, join(dir, 'u'), {name:'second'}), {code:'TOKEN_FILE_IN_USE'});
  const replaced = await run(cf, join(dir, 'u'), {name:'second', replace:true});
  assert.ok(replaced.next.some(step => step.includes('--force-recreate cloudflared')));
});

test('the missing-subdomain message names the address this --name gets', async t => {
  const dir = await root(t);
  const cf = await fakeCloudflare(t, {subdomain:null});
  await assert.rejects(run(cf, join(dir, 't'), {name:'alice-waypost'}), error => { assert.match(error.message, /https:\/\/alice-waypost\.<name>\.workers\.dev/); return true; });
});

test('a tunnel with a connector up is never joined, even with --reuse', async t => {
  const dir = await root(t);
  const id = '11111110-2222-3333-4444-555555555555';
  const cf = await fakeCloudflare(t, {tunnels:[{id, name:'waypost', config_src:'cloudflare', status:'healthy', connections:[{id:'c1'}]}]});
  await assert.rejects(run(cf, join(dir, 't')), {code:'TUNNEL_IN_USE'});
  await assert.rejects(run(cf, join(dir, 't'), {reuse:true}), error => { assert.equal(error.code, 'TUNNEL_IN_USE'); assert.match(error.message, /docker compose stop cloudflared/); return true; });
  await assert.rejects(stat(join(dir, 't')), {code:'ENOENT'});
  cf.tunnels[0] = {id, name:'waypost', config_src:'cloudflare', status:'inactive', connections:[]};
  await assert.rejects(run(cf, join(dir, 't')), error => { assert.equal(error.code, 'TUNNEL_EXISTS'); assert.match(error.message, /stopped partway, run again with --reuse/); return true; });
  assert.equal((await run(cf, join(dir, 't'), {reuse:true})).tunnel.created, false);
  // Holding the token is enough on a live tunnel: that is this host's own rerun.
  cf.tunnels[0].status = 'healthy';
  assert.equal((await run(cf, join(dir, 't'))).tunnel.created, false);
});

test('a reused tunnel that carries another VPC service is refused', async t => {
  const dir = await root(t);
  const id = '11111110-2222-3333-4444-555555555555';
  for (const other of [
    {service_id:'svc-blog', name:'blog-origin', type:'http', host:{hostname:'waypost', resolver_network:{tunnel_id:id}}, http_port:8787},
    {service_id:'svc-ip', name:'db', type:'tcp', host:{ipv4:'172.18.0.5', network:{tunnel_id:id}}, tcp_port:5432},
  ]) {
    const cf = await fakeCloudflare(t, {tunnels:[{id, name:'waypost', config_src:'cloudflare'}], services:[other]});
    await holdToken(join(dir, other.name), id);
    await assert.rejects(run(cf, join(dir, other.name)), error => { assert.equal(error.code, 'TUNNEL_HAS_VPC_SERVICES'); assert.deepEqual(error.details.services, [other.name]); return true; });
    assert.deepEqual([cf.services.length, Object.keys(cf.scripts).length], [1, 0]);
  }
});

test('a run interrupted after making a tunnel, over a deleted one, resumes with --reuse and keeps its own service', async t => {
  const dir = await root(t);
  const deleted = '99999999-2222-3333-4444-555555555555', made = '11111110-2222-3333-4444-555555555555';
  const ours = {service_id:'svc-0', name:'waypost', type:'http', host:{hostname:'waypost', resolver_network:{tunnel_id:deleted}}, http_port:8787};
  const cf = await fakeCloudflare(t, {tunnels:[{id:made, name:'waypost', config_src:'cloudflare', status:'inactive'}], deletedTunnels:[{id:deleted, name:'waypost', deleted_at:'2026-10-19T00:00:00Z'}], services:[ours], scripts:{waypost:{metadata:{bindings:[{type:'vpc_service', name:'ORIGIN_VPC', service_id:'svc-0'}]}}}});
  await holdToken(join(dir, 't'), deleted);
  await assert.rejects(run(cf, join(dir, 't')), {code:'TUNNEL_EXISTS'});
  const resumed = await run(cf, join(dir, 't'), {reuse:true});
  assert.deepEqual([resumed.tunnel.id, resumed.vpcService.created, resumed.worker.created, resumed.tunnelTokenReplaced], [made, false, false, true]);
  assert.equal(await readFile(join(dir, 't'), 'utf8'), tokenFor(made));
  assert.equal(cf.services[0].host.resolver_network.tunnel_id, made);
});

test('a same-named service with no tunnel id is never taken as ours', async t => {
  const dir = await root(t);
  const cf = await fakeCloudflare(t, {services:[{service_id:'svc-x', name:'waypost', type:'http', host:{hostname:'waypost'}, http_port:8787}], scripts:{waypost:{metadata:{bindings:[{type:'vpc_service', name:'ORIGIN_VPC', service_id:'svc-x'}]}}}});
  await assert.rejects(run(cf, join(dir, 't'), {replace:true}), {code:'VPC_SERVICE_EXISTS'});
  assert.deepEqual([cf.calls.filter(call => !call.startsWith('GET ')), cf.tunnels.length], [[], 0]);
});

test('a tunnel that ran somewhere before, or reports no status, is not joined without its token', async t => {
  const dir = await root(t);
  const id = '11111110-2222-3333-4444-555555555555';
  for (const status of ['down', undefined]) {
    const cf = await fakeCloudflare(t, {tunnels:[{id, name:'waypost', config_src:'cloudflare', status}]});
    await assert.rejects(run(cf, join(dir, String(status)), {reuse:true}), error => { assert.equal(error.code, 'TUNNEL_IN_USE'); assert.match(error.message, /delete the waypost tunnel, VPC service and Worker/); return true; });
    await holdToken(join(dir, `${status}-held`), id);
    assert.equal((await run(cf, join(dir, `${status}-held`))).tunnel.created, false);
  }
});

test('a fresh host never adopts a service on another person\'s deleted tunnel', async t => {
  const dir = await root(t);
  const deleted = '99999999-2222-3333-4444-555555555555';
  const theirs = {service_id:'svc-a', name:'waypost', type:'http', host:{hostname:'waypost', resolver_network:{tunnel_id:deleted}}, http_port:8787};
  const cf = await fakeCloudflare(t, {deletedTunnels:[{id:deleted, name:'waypost', deleted_at:'2026-10-19T00:00:00Z'}], services:[theirs], scripts:{waypost:{metadata:{bindings:[{type:'vpc_service', name:'ORIGIN_VPC', service_id:'svc-a'}]}}}});
  await assert.rejects(run(cf, join(dir, 't'), {replace:true}), error => { assert.equal(error.code, 'VPC_SERVICE_EXISTS'); assert.match(error.message, /delete the waypost tunnel, VPC service and Worker/); return true; });
  assert.deepEqual([cf.calls.filter(call => !call.startsWith('GET ')), cf.services[0]], [[], theirs]);
  // Holding that deleted tunnel's token is the proof that makes it this host's.
  await holdToken(join(dir, 'mine'), deleted);
  assert.equal((await run(cf, join(dir, 'mine'))).vpcService.created, false);
});

test('holding only the new tunnel\'s token never adopts a service on a deleted tunnel', async t => {
  const dir = await root(t);
  const deleted = '99999999-2222-3333-4444-555555555555', made = '11111110-2222-3333-4444-555555555555';
  const theirs = {service_id:'svc-a', name:'waypost', type:'http', host:{hostname:'waypost', resolver_network:{tunnel_id:deleted}}, http_port:8787};
  const cf = await fakeCloudflare(t, {tunnels:[{id:made, name:'waypost', config_src:'cloudflare'}], deletedTunnels:[{id:deleted, name:'waypost', deleted_at:'2026-10-19T00:00:00Z'}], services:[theirs]});
  await holdToken(join(dir, 't'), made);
  await assert.rejects(run(cf, join(dir, 't'), {replace:true}), {code:'VPC_SERVICE_EXISTS'});
  assert.deepEqual([cf.calls.filter(call => !call.startsWith('GET ')), cf.services[0]], [[], theirs]);
});

const asRoot = process.getuid?.() === 0 && 'root writes anywhere';

test('a recovery that fails after repointing the service puts it back, so the rerun still owns it', {skip:asRoot}, async t => {
  const dir = await root(t);
  const deleted = '99999999-2222-3333-4444-555555555555';
  const ours = {service_id:'svc-0', name:'waypost', type:'http', host:{hostname:'waypost', resolver_network:{tunnel_id:deleted}}, http_port:8787};
  const folder = join(dir, 'secrets'); await mkdir(folder);
  t.after(() => chmod(folder, 0o700).catch(() => undefined));
  // The token file's folder turns read-only the moment the service is written, so writing the token fails after it.
  const cf = await fakeCloudflare(t, {deletedTunnels:[{id:deleted, name:'waypost', deleted_at:'2026-10-19T00:00:00Z'}], services:[structuredClone(ours)], scripts:{waypost:{metadata:{bindings:[{type:'vpc_service', name:'ORIGIN_VPC', service_id:'svc-0'}]}}}, onServiceWrite:() => chmod(folder, 0o500)});
  await holdToken(join(folder, 't'), deleted);
  await assert.rejects(run(cf, join(folder, 't')), {code:'PATH_UNWRITABLE'});
  assert.deepEqual([cf.tunnels.length, cf.services[0]], [0, ours]);
  await chmod(folder, 0o700); cf.onServiceWrite = undefined;
  const resumed = await run(cf, join(folder, 't'));
  assert.deepEqual([resumed.tunnel.created, resumed.vpcService.created, resumed.worker.created], [true, false, false]);
  assert.equal(cf.services[0].host.resolver_network.tunnel_id, resumed.tunnel.id);
});

test('a first run that fails after creating the service leaves no tunnel and no service behind', {skip:asRoot}, async t => {
  const dir = await root(t);
  const folder = join(dir, 'secrets'); await mkdir(folder);
  t.after(() => chmod(folder, 0o700).catch(() => undefined));
  const cf = await fakeCloudflare(t, {onServiceWrite:() => chmod(folder, 0o500)});
  await assert.rejects(run(cf, join(folder, 't')), {code:'PATH_UNWRITABLE'});
  assert.deepEqual([cf.tunnels.length, cf.services.length], [0, 0]);
});

test('with --hostname on an account with no workers.dev subdomain, nothing is turned off there', async t => {
  const dir = await root(t);
  const cf = await fakeCloudflare(t, {subdomain:null, zones:[{id:'z1', name:'example.com'}]});
  const result = await run(cf, join(dir, 't'), {hostname:'waypost.example.com'});
  assert.equal(result.publicUrl, 'https://waypost.example.com');
  assert.ok(!cf.calls.some(call => call.endsWith('/workers/scripts/waypost/subdomain')));
  assert.ok(!cf.calls.some(call => call.startsWith('PUT ') && call.endsWith('/workers/subdomain')));
});

test('two tunnels with the same name are refused before anything is written', async t => {
  const dir = await root(t);
  const cf = await fakeCloudflare(t, {tunnels:[{id:'11111110-2222-3333-4444-555555555555', name:'waypost', config_src:'cloudflare'}, {id:'11111111-2222-3333-4444-555555555555', name:'waypost', config_src:'cloudflare'}]});
  await assert.rejects(run(cf, join(dir, 't')), error => { assert.equal(error.code, 'TUNNEL_EXISTS'); assert.match(error.message, /2 tunnels named waypost/); return true; });
  assert.deepEqual(cf.calls.filter(call => !call.startsWith('GET ')), []);
});
