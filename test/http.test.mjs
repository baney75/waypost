import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import ICAL from 'ical.js';
import { request } from 'node:http';

const runtime = resolve('runtime/waypost.mjs');
const cli = (config, ...args) => JSON.parse(execFileSync(process.execPath, [runtime, '--config', config, ...args], {encoding:'utf8'})).data;

async function server(t) {
  const root = await mkdtemp(join(tmpdir(), 'waypost-http-'));
  const port = 20000 + Math.floor(Math.random() * 20000);
  const config = join(root, 'config.json');
  const setup = cli(config, 'setup', 'quick', '--public-url', `http://localhost:${port}`, '--data', join(root, 'data'), '--owner', 'owner@example.com', '--port', String(port), '--enable-writes');
  const child = spawn(process.execPath, [runtime, '--config', config, 'serve'], {stdio:['ignore', 'ignore', 'pipe']});
  let log = '';
  child.stderr.on('data', data => { log += data; });
  t.after(async () => { child.kill(); await rm(root, {recursive:true, force:true}); });
  for (let i = 0; i < 100 && !log.includes('"listening"'); i++) await new Promise(r => setTimeout(r, 30));
  return {root, port, config, base:`http://localhost:${port}`, setup, log:() => log};
}
async function connect(base, token) {
  const client = new Client({name:'waypost-http-test', version:'1.0.0'});
  await client.connect(new StreamableHTTPClientTransport(new URL('/mcp', base), {requestInit:{headers:{Authorization:`Bearer ${token}`}}}));
  return client;
}

test('remote MCP rejects anonymous calls with a discovery challenge and serves a bearer client', async t => {
  const s = await server(t);
  const anonymous = await fetch(`${s.base}/mcp`, {method:'POST', headers:{'Content-Type':'application/json'}, body:'{}'});
  assert.equal(anonymous.status, 401);
  assert.match(anonymous.headers.get('www-authenticate'), /resource_metadata="http:\/\/localhost:\d+\/\.well-known\/oauth-protected-resource\/mcp"/);
  const queryToken = await fetch(`${s.base}/mcp?access_token=wpb_${'a'.repeat(43)}`, {method:'POST', headers:{'Content-Type':'application/json'}, body:'{}'});
  assert.equal(queryToken.status, 401, 'tokens in the query string are never read');
  const {token, id} = cli(s.config, 'auth', 'token', '--label', 'test');
  const client = await connect(s.base, token);
  const tools = await client.listTools();
  assert.ok(tools.tools.some(tool => tool.name === 'calendar_create'));
  assert.ok(!tools.tools.some(tool => tool.name === 'mail_verification_code'), 'verification codes stay local by default');
  const status = await client.callTool({name:'waypost_status', arguments:{}});
  assert.deepEqual(status.structuredContent.data.transport, ['stdio', 'streamable_http']);
  await client.close();
  cli(s.config, 'auth', 'revoke', id);
  const revoked = await fetch(`${s.base}/mcp`, {method:'POST', headers:{'Content-Type':'application/json', Authorization:`Bearer ${token}`}, body:'{}'});
  assert.equal(revoked.status, 401);
  const rebound = await new Promise((done, fail) => request({host:'127.0.0.1', port:s.port, path:'/healthz', headers:{Host:'attacker.example'}}, response => { response.resume(); done(response.statusCode); }).on('error', fail).end());
  assert.equal(rebound, 421, 'a foreign Host header is refused');
  assert.equal(s.log().includes(token), false, 'tokens are never logged');
});

test('OAuth 2.1: registration, passcode consent, PKCE, refresh rotation and replay revocation', async t => {
  const s = await server(t);
  const meta = await (await fetch(`${s.base}/.well-known/oauth-authorization-server`)).json();
  assert.deepEqual(meta.code_challenge_methods_supported, ['S256']);
  const bad = await fetch(meta.registration_endpoint, {method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({redirect_uris:['https://evil.example/cb']})});
  assert.equal(bad.status, 400, 'only approved redirect origins register');
  const registered = await (await fetch(meta.registration_endpoint, {method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({redirect_uris:['https://claude.ai/api/mcp/auth_callback'], client_name:'Claude'})})).json();
  const verifier = randomBytes(32).toString('base64url');
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  const params = new URLSearchParams({response_type:'code', client_id:registered.client_id, redirect_uri:'https://claude.ai/api/mcp/auth_callback', code_challenge:challenge, code_challenge_method:'S256', state:'xyz', resource:`${s.base}/mcp`});
  const noPkce = await fetch(`${meta.authorization_endpoint}?${new URLSearchParams({...Object.fromEntries(params), code_challenge_method:'plain'})}`, {redirect:'manual'});
  assert.match(noPkce.headers.get('location'), /error=invalid_request/);
  const page = await fetch(`${meta.authorization_endpoint}?${params}`);
  assert.equal(page.status, 200);
  assert.match(page.headers.get('content-security-policy'), /frame-ancestors 'none'/);
  const html = await page.text();
  const signed = /name="request" value="([^"]+)"/.exec(html)[1].replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number(code)));
  const wrong = await fetch(meta.authorization_endpoint, {method:'POST', redirect:'manual', headers:{'Content-Type':'application/x-www-form-urlencoded'}, body:new URLSearchParams({request:signed, passcode:'wrong', decision:'allow'})});
  assert.equal(wrong.status, 401);
  const tampered = await fetch(meta.authorization_endpoint, {method:'POST', redirect:'manual', headers:{'Content-Type':'application/x-www-form-urlencoded'}, body:new URLSearchParams({request:signed.replace(/^./, c => c === 'A' ? 'B' : 'A'), passcode:s.setup.passcode, decision:'allow'})});
  assert.equal(tampered.status, 400);
  const approved = await fetch(meta.authorization_endpoint, {method:'POST', redirect:'manual', headers:{'Content-Type':'application/x-www-form-urlencoded'}, body:new URLSearchParams({request:signed, passcode:s.setup.passcode, decision:'allow'})});
  assert.equal(approved.status, 302);
  const location = new URL(approved.headers.get('location'));
  assert.equal(location.origin + location.pathname, 'https://claude.ai/api/mcp/auth_callback');
  assert.equal(location.searchParams.get('state'), 'xyz');
  const code = location.searchParams.get('code');
  const token = body => fetch(meta.token_endpoint, {method:'POST', headers:{'Content-Type':'application/x-www-form-urlencoded'}, body:new URLSearchParams(body)});
  const wrongVerifier = await token({grant_type:'authorization_code', code, client_id:registered.client_id, redirect_uri:'https://claude.ai/api/mcp/auth_callback', code_verifier:randomBytes(32).toString('base64url')});
  assert.equal(wrongVerifier.status, 400, 'a wrong PKCE verifier burns the code');
  // Get a fresh code: the failed exchange consumed the first one.
  const again = await fetch(meta.authorization_endpoint, {method:'POST', redirect:'manual', headers:{'Content-Type':'application/x-www-form-urlencoded'}, body:new URLSearchParams({request:signed, passcode:s.setup.passcode, decision:'allow'})});
  const code2 = new URL(again.headers.get('location')).searchParams.get('code');
  const issued = await (await token({grant_type:'authorization_code', code:code2, client_id:registered.client_id, redirect_uri:'https://claude.ai/api/mcp/auth_callback', code_verifier:verifier, resource:`${s.base}/mcp`})).json();
  assert.equal(issued.token_type, 'Bearer');
  const reuse = await token({grant_type:'authorization_code', code:code2, client_id:registered.client_id, redirect_uri:'https://claude.ai/api/mcp/auth_callback', code_verifier:verifier});
  assert.equal(reuse.status, 400, 'codes are single use');
  const client = await connect(s.base, issued.access_token);
  assert.ok((await client.listTools()).tools.length > 10);
  await client.close();
  const rotated = await (await token({grant_type:'refresh_token', refresh_token:issued.refresh_token, client_id:registered.client_id})).json();
  assert.ok(rotated.refresh_token && rotated.refresh_token !== issued.refresh_token);
  const oldAccess = await fetch(`${s.base}/mcp`, {method:'POST', headers:{'Content-Type':'application/json', Authorization:`Bearer ${issued.access_token}`}, body:'{}'});
  assert.equal(oldAccess.status, 401, 'refreshing retires the previous access token');
  const replay = await token({grant_type:'refresh_token', refresh_token:issued.refresh_token, client_id:registered.client_id});
  assert.equal(replay.status, 400);
  const afterReplay = await token({grant_type:'refresh_token', refresh_token:rotated.refresh_token, client_id:registered.client_id});
  assert.equal(afterReplay.status, 400, 'replaying a rotated refresh token revokes the whole grant');
});

test('agent calendar feed: created events publish as valid iCalendar and revoked links stop working', async t => {
  const s = await server(t);
  const {token} = cli(s.config, 'auth', 'token');
  const client = await connect(s.base, token);
  const created = await client.callTool({name:'calendar_create', arguments:{summary:'Synthetic review', start:'2026-11-02T09:00:00', end:'2026-11-02T09:30:00', timezone:'America/New_York', rrule:'FREQ=WEEKLY;COUNT=3', confirm:true}});
  assert.equal(created.structuredContent.ok, true, JSON.stringify(created.structuredContent));
  const events = await client.callTool({name:'calendar_events', arguments:{from:'2026-11-01T00:00:00Z', to:'2026-11-30T00:00:00Z'}});
  assert.deepEqual(events.structuredContent.data.events.map(event => [event.start, event.provenance, event.editable]), [['2026-11-02T14:00:00Z','agent',true],['2026-11-09T14:00:00Z','agent',true],['2026-11-16T14:00:00Z','agent',true]]);
  await client.close();
  const feedUrl = new URL(s.setup.protonFeedUrl);
  const feed = await fetch(feedUrl);
  assert.equal(feed.status, 200);
  assert.match(feed.headers.get('content-type'), /^text\/calendar/);
  const text = await feed.text();
  const calendar = new ICAL.Component(ICAL.parse(text));
  assert.equal(calendar.getFirstPropertyValue('x-wr-calname'), 'Agents');
  assert.equal(calendar.getAllSubcomponents('vevent').length, 1);
  assert.ok(calendar.getAllSubcomponents('vtimezone').some(zone => zone.getFirstPropertyValue('tzid') === 'America/New_York'));
  assert.ok(text.split('\r\n').every(line => Buffer.byteLength(line) <= 75), 'lines are folded to 75 octets');
  const cached = await fetch(feedUrl, {headers:{'If-None-Match':feed.headers.get('etag')}});
  assert.equal(cached.status, 304);
  assert.equal((await fetch(`${s.base}/feeds/${'x'.repeat(43)}/agents.ics`)).status, 404);
  const [{id}] = cli(s.config, 'calendar', 'feed', 'list').tokens;
  cli(s.config, 'calendar', 'feed', 'revoke', id);
  assert.equal((await fetch(feedUrl)).status, 404, 'a revoked feed link stops working');
  assert.equal(s.log().includes(feedUrl.pathname.split('/')[2]), false, 'feed tokens are never logged');
  const doctor = cli(s.config, 'doctor', '--remote', s.base).checks.filter(check => check.service.startsWith('remote:'));
  assert.deepEqual(doctor.map(check => check.status), ['ready','ready','ready']);
});
