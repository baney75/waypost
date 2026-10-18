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
  const cf = {accounts:[{id:ACCOUNT, name:'Mine'}], tunnels:[], services:[], scripts:{}, subdomain:'ada', scriptSubdomain:{}, domains:[], zones:[], deny:null, calls:[], ...state};
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
      const tunnel = {id:`1111111${cf.tunnels.length}-2222-3333-4444-555555555555`, name:json.name};
      cf.tunnels.push(tunnel); return [200, ok(tunnel)];
    }
    if (/^\/accounts\/\w+\/cfd_tunnel\/[\w-]+\/token$/.test(path)) return [200, ok(FAKE_TUNNEL)];
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
      cf.subdomain = JSON.parse(body.toString()).subdomain; return [200, ok({subdomain:cf.subdomain})];
    }
    if (path.endsWith('/workers/domains')) { cf.domains.push(JSON.parse(body.toString())); return [200, ok({})]; }
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
  assert.ok(cf.calls.includes(`PUT /accounts/${ACCOUNT}/connectivity/directory/services/svc-0`));
});

test('setup cloudflare registers a workers.dev subdomain only when asked', async t => {
  const dir = await root(t);
  const cf = await fakeCloudflare(t, {subdomain:null});
  await assert.rejects(run(cf, join(dir, 't')), {code:'WORKERS_SUBDOMAIN_NEEDED'});
  const result = await run(cf, join(dir, 't'), {workersSubdomain:'grace'});
  assert.equal(result.publicUrl, 'https://waypost.grace.workers.dev');
  await assert.rejects(run(cf, join(dir, 't'), {workersSubdomain:'Not Valid'}), {code:'INPUT_INVALID'});
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
  await assert.rejects(run(cf, join(dir, 't'), {hostname:'waypost.other.org'}), {code:'ZONE_NOT_FOUND'});
});

test('setup cloudflare refuses to write the tunnel token through a link', async t => {
  const dir = await root(t);
  const cf = await fakeCloudflare(t);
  await writeFile(join(dir, 'elsewhere'), '');
  await symlink(join(dir, 'elsewhere'), join(dir, 'tunnel_token'));
  await assert.rejects(run(cf, join(dir, 'tunnel_token')), {code:'PATH_UNSAFE'});
  assert.equal(await readFile(join(dir, 'elsewhere'), 'utf8'), '');
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
