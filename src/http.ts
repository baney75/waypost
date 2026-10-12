import { createServer as createHttpServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { createHash } from 'node:crypto';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { Config } from './config.js';
import { loadConfig } from './config.js';
import { WaypostError, publicError } from './errors.js';
import { createServer } from './mcp.js';
import { VERSION } from './version.js';
import { approveAuthorize, authorizationServerMetadata, describeSigned, exchangeToken, httpConfig, OAuthError, protectedResourceMetadata, registerClient, revokeToken, validateAuthorize, verifyBearer } from './oauth.js';
import { feedForToken, syncCalendars } from './agent-calendar.js';

const MCP_BODY = 1024 * 1024, FORM_BODY = 16 * 1024;
const log = (entry:Record<string, unknown>) => process.stderr.write(JSON.stringify({at:new Date().toISOString(), ...entry}) + '\n');
const escape = (value:string) => value.replace(/[&<>"']/g, character => `&#${character.charCodeAt(0)};`);
class BodyTooLarge extends Error {}
async function body(req:IncomingMessage, limit:number):Promise<Buffer> {
  const chunks:Buffer[] = []; let size = 0;
  for await (const chunk of req) { size += (chunk as Buffer).length; if (size > limit) throw new BodyTooLarge(); chunks.push(chunk as Buffer); }
  return Buffer.concat(chunks);
}
function send(res:ServerResponse, status:number, payload:unknown, headers:Record<string, string> = {}) {
  const text = typeof payload === 'string' ? payload : JSON.stringify(payload);
  res.writeHead(status, {'Content-Type':typeof payload === 'string' ? 'text/plain; charset=utf-8' : 'application/json', 'Cache-Control':'no-store', ...headers});
  res.end(text);
}
function oauthFailure(res:ServerResponse, error:unknown) {
  if (error instanceof OAuthError) return send(res, error.status, {error:error.error, error_description:error.description});
  log({event:'oauth_error', code:error instanceof WaypostError ? error.code : 'INTERNAL'});
  return send(res, 500, {error:'server_error', error_description:'The authorization server failed. Check the Waypost logs.'});
}
async function formOrJson(req:IncomingMessage):Promise<URLSearchParams> {
  const raw = (await body(req, FORM_BODY)).toString('utf8');
  if ((req.headers['content-type'] ?? '').includes('application/json')) {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    return new URLSearchParams(Object.entries(parsed).filter(([, value]) => typeof value === 'string') as [string, string][]);
  }
  return new URLSearchParams(raw);
}
function consentPage(details:{clientName:string; redirectHost:string; signed:string; passcodeSet:boolean; error?:string}, redirectOrigin:string) {
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Approve Waypost access</title>
<style>:root{color-scheme:light dark;--bg:#f7f7f5;--fg:#1b1b1b;--muted:#5d5d5d;--card:#fff;--line:#d9d9d4;--accent:#3b5bdb}@media (prefers-color-scheme:dark){:root{--bg:#141414;--fg:#ececec;--muted:#a0a0a0;--card:#1e1e1e;--line:#333;--accent:#8ea2ff}}
body{margin:0;background:var(--bg);color:var(--fg);font:16px/1.5 system-ui,sans-serif;display:grid;place-items:center;min-height:100vh;padding:16px;box-sizing:border-box}
main{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:24px;max-width:420px;width:100%}h1{font-size:1.25rem;margin:0 0 8px}p{margin:0 0 16px;color:var(--muted)}
label{display:block;font-weight:600;margin-bottom:6px}input{width:100%;box-sizing:border-box;padding:10px;border:1px solid var(--line);border-radius:8px;background:transparent;color:inherit;font:inherit}
.row{display:flex;gap:8px;margin-top:16px}button{flex:1;padding:10px;border-radius:8px;border:1px solid var(--line);background:transparent;color:inherit;font:inherit;cursor:pointer}button.primary{background:var(--accent);border-color:var(--accent);color:#fff}.error{color:#c92a2a}</style></head>
<body><main><h1>Allow ${escape(details.clientName)} to use Waypost?</h1><p>It will be able to call your Waypost tools: read mail and calendars, and make the changes your Waypost settings allow. After approval you return to <strong>${escape(details.redirectHost)}</strong>.</p>
${details.error ? `<p class="error">${escape(details.error)}</p>` : ''}${details.passcodeSet ? '' : '<p class="error">No passcode is set. Run <code>waypost auth passcode</code> on the server first.</p>'}
<form method="post" action="/authorize"><input type="hidden" name="request" value="${escape(details.signed)}"><label for="passcode">Waypost passcode</label><input id="passcode" name="passcode" type="password" autocomplete="current-password" required autofocus>
<div class="row"><button type="submit" name="decision" value="deny" formnovalidate>Deny</button><button class="primary" type="submit" name="decision" value="allow">Allow</button></div></form></main></body></html>`;
  return {html, headers:{'Content-Type':'text/html; charset=utf-8', 'Cache-Control':'no-store', 'X-Frame-Options':'DENY', 'Content-Security-Policy':`default-src 'none'; style-src 'unsafe-inline'; form-action 'self' ${redirectOrigin}; frame-ancestors 'none'; base-uri 'none'`}};
}
/** The tools a remote client may call. Verification codes stay local unless http.tools lists them explicitly. */
const remoteAllowed = (config:Config) => (name:string) => config.http?.tools ? config.http.tools.includes(name) : name !== 'mail_verification_code';

export async function handle(configPath:string, req:IncomingMessage, res:ServerResponse) {
  const started = Date.now();
  const url = new URL(req.url ?? '/', 'http://localhost');
  const route = url.pathname.startsWith('/feeds/') ? '/feeds/*' : url.pathname;
  res.on('finish', () => log({method:req.method, route, status:res.statusCode, ms:Date.now() - started}));
  res.setHeader('X-Content-Type-Options', 'nosniff'); res.setHeader('Referrer-Policy', 'no-referrer');
  let config:Config;
  try { config = await loadConfig(configPath); } catch (error) { return send(res, 503, {ok:false, error:publicError(error)}); }
  let http;
  try { http = httpConfig(config); } catch (error) { return send(res, 503, {ok:false, error:publicError(error)}); }
  // DNS-rebinding guard: only the public host and loopback names may address this server.
  const host = (req.headers.host ?? '').toLowerCase();
  const allowedHosts = new Set([new URL(http.publicUrl).host, `localhost:${http.port}`, `127.0.0.1:${http.port}`, `[::1]:${http.port}`, 'localhost', '127.0.0.1', ...http.allowedHosts]);
  if (!allowedHosts.has(host)) return send(res, 421, {error:'misdirected_request'});
  try {
    if (url.pathname === '/healthz' && req.method === 'GET') return send(res, 200, {ok:true, version:VERSION});
    if (url.pathname === '/.well-known/oauth-protected-resource' || url.pathname === '/.well-known/oauth-protected-resource/mcp') return send(res, 200, protectedResourceMetadata(http), {'Access-Control-Allow-Origin':'*', 'Cache-Control':'max-age=300'});
    if (url.pathname === '/.well-known/oauth-authorization-server' || url.pathname === '/.well-known/oauth-authorization-server/mcp') return send(res, 200, authorizationServerMetadata(http), {'Access-Control-Allow-Origin':'*', 'Cache-Control':'max-age=300'});
    if (url.pathname === '/register' && req.method === 'POST') {
      try { return send(res, 201, await registerClient(config, JSON.parse((await body(req, FORM_BODY)).toString('utf8')))); } catch (error) { if (error instanceof SyntaxError) return send(res, 400, {error:'invalid_client_metadata', error_description:'Send JSON client metadata.'}); return oauthFailure(res, error); }
    }
    if (url.pathname === '/authorize' && req.method === 'GET') {
      try {
        const result = await validateAuthorize(config, url.searchParams);
        if ('redirect' in result) { res.writeHead(302, {Location:result.redirect, 'Cache-Control':'no-store'}); return res.end(); }
        const page = consentPage(result, new URL(result.request.redirect_uri).origin);
        res.writeHead(200, page.headers); return res.end(page.html);
      } catch (error) { if (error instanceof OAuthError) return send(res, error.status, error.description); return oauthFailure(res, error); }
    }
    if (url.pathname === '/authorize' && req.method === 'POST') {
      const form = new URLSearchParams((await body(req, FORM_BODY)).toString('utf8'));
      try { const result = await approveAuthorize(config, form); res.writeHead(302, {Location:result.redirect, 'Cache-Control':'no-store'}); return res.end(); }
      catch (error) {
        if (error instanceof OAuthError && error.status === 401) {
          const again = await describeSigned(config, form.get('request') ?? '').catch(() => null);
          if (again) { const page = consentPage({...again, error:error.description}, new URL(again.request.redirect_uri).origin); res.writeHead(401, page.headers); return res.end(page.html); }
        }
        if (error instanceof OAuthError) return send(res, error.status, error.description);
        return oauthFailure(res, error);
      }
    }
    if (url.pathname === '/token' && req.method === 'POST') {
      try { return send(res, 200, await exchangeToken(config, await formOrJson(req), req.headers.authorization), {Pragma:'no-cache'}); } catch (error) { return oauthFailure(res, error); }
    }
    if (url.pathname === '/revoke' && req.method === 'POST') {
      try { await revokeToken(config, await formOrJson(req), req.headers.authorization); return send(res, 200, {}); } catch (error) { return oauthFailure(res, error); }
    }
    const feed = /^\/feeds\/([A-Za-z0-9_-]{43})\/[\w-]{1,40}\.ics$/.exec(url.pathname);
    if (feed && (req.method === 'GET' || req.method === 'HEAD')) {
      const content = config.agentCalendar ? await feedForToken(config, feed[1]!) : null;
      if (content === null) return send(res, 404, 'Not found');
      const etag = `"${createHash('sha256').update(content).digest('base64url').slice(0, 27)}"`;
      const headers = {'Content-Type':'text/calendar; charset=utf-8', 'Cache-Control':'private, max-age=300', ETag:etag, 'Content-Disposition':'inline; filename="agents.ics"'};
      if (req.headers['if-none-match'] === etag) { res.writeHead(304, headers); return res.end(); }
      res.writeHead(200, headers); return res.end(req.method === 'HEAD' ? undefined : content);
    }
    if (url.pathname === '/mcp') {
      const caller = await verifyBearer(config, req.headers.authorization);
      if (!caller) return send(res, 401, {error:'invalid_token', error_description:'Authenticate with OAuth or a Waypost bearer token.'}, {'WWW-Authenticate':`Bearer resource_metadata="${new URL('/.well-known/oauth-protected-resource/mcp', http.publicUrl).href}"`});
      if (req.method !== 'POST') return send(res, 405, {error:'method_not_allowed'}, {Allow:'POST'});
      let parsed:unknown;
      try { parsed = JSON.parse((await body(req, MCP_BODY)).toString('utf8')); } catch (error) { return send(res, error instanceof BodyTooLarge ? 413 : 400, {jsonrpc:'2.0', error:{code:-32700, message:'Parse error'}, id:null}); }
      // Stateless: each request gets its own server and transport, so no session can leak between clients.
      const server = createServer(configPath, remoteAllowed(config));
      // Omitting sessionIdGenerator selects stateless mode.
      const transport = new StreamableHTTPServerTransport({enableJsonResponse:true});
      res.on('close', () => { void transport.close(); void server.close(); });
      await server.connect(transport as Parameters<typeof server.connect>[0]);
      return await transport.handleRequest(req, res, parsed);
    }
    return send(res, 404, 'Not found');
  } catch (error) {
    if (error instanceof BodyTooLarge) return send(res, 413, {error:'payload_too_large'});
    log({event:'error', route, code:error instanceof WaypostError ? error.code : 'INTERNAL'});
    if (!res.headersSent) return send(res, 500, {error:'server_error'});
    res.end();
  }
}
/** `waypost serve`: remote MCP, the agent calendar feed, and the Proton mirror sync worker in one process. */
export async function serveHttp(configPath:string):Promise<void> {
  const config = await loadConfig(configPath);
  const http = httpConfig(config);
  const server = createHttpServer((req, res) => { void handle(configPath, req, res); });
  server.requestTimeout = 60000; server.headersTimeout = 20000; server.keepAliveTimeout = 5000;
  let timer:ReturnType<typeof setInterval> | undefined;
  const sync = async () => {
    try { const current = await loadConfig(configPath); if (current.agentCalendar && current.calendar?.feeds.length) log({event:'sync', ...(await syncCalendars(current))}); }
    catch (error) { log({event:'sync_failed', code:error instanceof WaypostError ? error.code : 'INTERNAL'}); }
  };
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(http.port, http.host, () => resolve()); });
  log({event:'listening', host:http.host, port:http.port, publicUrl:http.publicUrl, version:VERSION});
  if (config.agentCalendar) { void sync(); timer = setInterval(() => { void sync(); }, config.agentCalendar.syncMinutes * 60000); timer.unref(); }
  const stop = () => { if (timer) clearInterval(timer); server.close(); };
  process.once('SIGINT', stop); process.once('SIGTERM', stop);
}
