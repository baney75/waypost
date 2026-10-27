// Regression tests for findings from the v0.6 security and correctness reviews. Synthetic data only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { wildcard, evaluateSieve } from '../dist/sieve.js';
import { registerClient, validateAuthorize, approveAuthorize, setPasscode } from '../dist/oauth.js';

const runtime = resolve('runtime/waypost.mjs');
async function root(t) { const dir = await mkdtemp(join(tmpdir(), 'waypost-review-')); t.after(() => rm(dir, {recursive:true, force:true})); return dir; }

test('the Worker front door never follows a //host path to another origin and strips cookies', async () => {
  const worker = (await import('../deploy/cloudflare-worker/worker.js')).default;
  const seen = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (url, init) => { seen.push(String(url)); return new Response('ok', {headers:{'Set-Cookie':'a=b', 'X-Test':'1'}}); };
  try {
    const env = {ORIGIN:'https://origin.example'};
    const response = await worker.fetch(new Request('https://front.example//evil.example/authorize?x=1', {headers:{Cookie:'session=1'}}), env);
    assert.equal(new URL(seen[0]).origin, 'https://origin.example');
    assert.equal(new URL(seen[0]).pathname, '//evil.example/authorize');
    assert.equal(response.headers.get('set-cookie'), null);
    assert.equal(response.headers.get('x-test'), '1');
  } finally { globalThis.fetch = original; }
});

test('the Worker front door sends VPC traffic only through the binding, keeping the public host', async () => {
  const worker = (await import('../deploy/cloudflare-worker/worker.js')).default;
  const seen = [];
  const original = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error('public fetch used'); };
  try {
    const env = {ORIGIN_VPC:{fetch: async (url, init) => { seen.push({url:String(url), cookie:init.headers.get('cookie')}); return new Response('ok', {headers:{'Set-Cookie':'a=b'}}); }}};
    const response = await worker.fetch(new Request('https://front.example//evil.example/mcp?x=1', {headers:{Cookie:'session=1'}}), env);
    assert.equal(new URL(seen[0].url).origin, 'http://front.example');
    assert.equal(new URL(seen[0].url).pathname, '//evil.example/mcp');
    assert.equal(seen[0].cookie, null);
    assert.equal(response.headers.get('set-cookie'), null);
  } finally { globalThis.fetch = original; }
});

test('the Worker front door answers 502 with a plain reason when the server or tunnel is down', async () => {
  const worker = (await import('../deploy/cloudflare-worker/worker.js')).default;
  const original = globalThis.fetch;
  globalThis.fetch = async () => { throw new TypeError('fetch failed'); };
  try {
    for (const env of [{ORIGIN:'https://origin.example'}, {ORIGIN_VPC:{fetch: async () => { throw new Error('Network connection lost.'); }}}]) {
      const response = await worker.fetch(new Request('https://front.example/mcp', {method:'POST', body:'{}'}), env);
      assert.equal(response.status, 502);
      assert.equal(response.headers.get('cache-control'), 'no-store');
      assert.match(await response.text(), /Waypost server unreachable/);
    }
  } finally { globalThis.fetch = original; }
});

test('Sieve :matches runs in linear time and :regex is never executed', () => {
  assert.equal(wildcard('*@*.example.com', 'ada@mail.example.com'), true);
  assert.equal(wildcard('a?c', 'ABC'), true);
  assert.equal(wildcard('*.*.*.*.example.com', 'x'.repeat(2000)), false);
  const started = Date.now();
  for (let i = 0; i < 50; i++) wildcard('*a*a*a*a*a*b', 'a'.repeat(2000));
  assert.ok(Date.now() - started < 1000, 'hostile patterns stay fast');
  const result = evaluateSieve('if header :regex "subject" "(a+)+$" { fileinto "X"; }', {headers:new Map([['subject',['a'.repeat(5000) + '!']]]), addresses:new Map(), size:1});
  assert.deepEqual(result.folders, []);
  assert.ok(result.unsupported.includes(':regex matching'));
});

test('OAuth: open client registration caps every array it accepts and refuses a huge one fast', async t => {
  const dir = await root(t);
  const config = {version:1, artifactsDir:join(dir, 'artifacts'), timeoutMs:1000, http:{host:'127.0.0.1', port:8787, publicUrl:'https://waypost.example/', stateDir:join(dir, 'auth'), redirectUris:['https://claude.ai/api/mcp/auth_callback'], allowedHosts:[]}};
  const started = Date.now();
  const ok = ['https://claude.ai/api/mcp/auth_callback'];
  const cases = [
    [{redirect_uris:Array(200_000).fill('https://claude.ai/api/mcp/auth_callback')}, /redirect_uris/],
    [{redirect_uris:ok, grant_types:Array(200_000).fill('authorization_code')}, /grant_types/],
    [{redirect_uris:ok, response_types:Array(200_000).fill('code')}, /response_types/],
    [{redirect_uris:ok, grant_types:Array(11).fill('authorization_code')}, /grant_types/],
  ];
  for (const [request, field] of cases) {
    await assert.rejects(registerClient(config, request), error => error.status === 400 && error.error === 'invalid_client_metadata' && field.test(error.description));
  }
  assert.ok(Date.now() - started < 2000, 'a hostile array is refused fast');
});

test('OAuth: exact redirect callbacks only, and wrong passcodes lock out one client, not the owner', async t => {
  const dir = await root(t);
  const config = {version:1, artifactsDir:join(dir, 'artifacts'), timeoutMs:1000, http:{host:'127.0.0.1', port:8787, publicUrl:'https://waypost.example/', stateDir:join(dir, 'auth'), redirectUris:['https://claude.ai/api/mcp/auth_callback'], allowedHosts:[]}};
  const {passcode} = await setPasscode(config);
  await assert.rejects(registerClient(config, {redirect_uris:['https://claude.ai/attacker/path']}), {error:'invalid_redirect_uri'});
  await assert.rejects(registerClient(config, {redirect_uris:['https://claude.ai/api/mcp/auth_callback?x=1']}), {error:'invalid_redirect_uri'});
  const signed = async () => {
    const client = await registerClient(config, {redirect_uris:['https://claude.ai/api/mcp/auth_callback']});
    const params = new URLSearchParams({client_id:client.client_id, redirect_uri:'https://claude.ai/api/mcp/auth_callback', response_type:'code', code_challenge:'a'.repeat(43), code_challenge_method:'S256'});
    return (await validateAuthorize(config, params)).signed;
  };
  const attacker = await signed();
  for (let i = 0; i < 5; i++) await assert.rejects(approveAuthorize(config, new URLSearchParams({request:attacker, passcode:'wrong', decision:'allow'})), {status:401});
  await assert.rejects(approveAuthorize(config, new URLSearchParams({request:attacker, passcode, decision:'allow'})), {status:429});
  const owner = await signed();
  const approved = await approveAuthorize(config, new URLSearchParams({request:owner, passcode, decision:'allow'}));
  assert.match(approved.redirect, /^https:\/\/claude\.ai\/api\/mcp\/auth_callback\?code=wpk_/);
});

test('setup quick run again keeps the stored host, port and write setting', async t => {
  const dir = await root(t);
  const config = join(dir, 'config.json');
  const run = (...args) => JSON.parse(execFileSync(process.execPath, [runtime, '--config', config, 'setup', 'quick', '--public-url', 'https://waypost.example', '--data', join(dir, 'data'), ...args], {encoding:'utf8'})).data;
  run('--host', '0.0.0.0', '--port', '9000', '--enable-writes');
  const again = run();
  const saved = JSON.parse(await readFile(config, 'utf8'));
  assert.equal(saved.http.host, '0.0.0.0');
  assert.equal(saved.http.port, 9000);
  assert.equal(saved.agentCalendar.writeEnabled, true);
  assert.equal(again.writesEnabled, true);
  assert.match(again.passcode, /already set/);
});
