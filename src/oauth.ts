import { createHash, createHmac, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import type { Config } from './config.js';
import { WaypostError } from './errors.js';
import { audit, readJson, withLock, writeJson } from './store.js';

/**
 * A single-owner OAuth 2.1 authorization server for remote MCP clients such as claude.ai.
 * Dynamic client registration, authorization code with PKCE S256 only, rotating refresh tokens,
 * and an owner passcode on the consent page. Static bearer tokens serve CLI clients.
 * Only SHA-256 hashes of tokens and an scrypt hash of the passcode are stored.
 */
type HttpConfig = NonNullable<Config['http']>;
const STATE = 'oauth.json';
const ACCESS_TTL = 3600, REFRESH_TTL = 30 * 86400, CODE_TTL = 300, REQUEST_TTL = 600;
const MAX_CLIENTS = 100, MAX_TOKENS = 2000;
const client = z.object({client_id:z.string(), client_secret_hash:z.string().optional(), redirect_uris:z.array(z.string()), client_name:z.string(), token_endpoint_auth_method:z.enum(['none','client_secret_post','client_secret_basic']), created_at:z.number(), last_used:z.number().optional()});
const token = z.object({kind:z.enum(['access','refresh']), client_id:z.string(), expires:z.number(), family:z.string(), resource:z.string(), revoked:z.boolean().optional()});
const bearer = z.object({id:z.string(), hash:z.string(), label:z.string(), created:z.string(), revoked:z.string().optional(), last_used:z.string().optional()});
const stateSchema = z.object({version:z.literal(1), key:z.string(), passcode:z.string().optional(), clients:z.record(z.string(), client).default({}), tokens:z.record(z.string(), token).default({}), bearer:z.array(bearer).default([])});
type State = z.output<typeof stateSchema>;
const sha = (value:string) => createHash('sha256').update(value).digest('hex');
const now = () => Math.floor(Date.now() / 1000);
const b64 = (bytes = 32) => randomBytes(bytes).toString('base64url');

export function httpConfig(config:Config):HttpConfig {
  if (!config.http) throw new WaypostError('HTTP_UNCONFIGURED', 'Remote access is not set up. Run: waypost setup remote --public-url https://your.host --state-dir /absolute/private/dir');
  return config.http;
}
export const resourceUrl = (http:HttpConfig) => new URL('mcp', http.publicUrl).href;
const issuer = (http:HttpConfig) => http.publicUrl.replace(/\/$/, '');

async function load(http:HttpConfig):Promise<State> {
  const raw = await readJson<unknown>(http.stateDir, STATE, () => null);
  if (raw === null) return {version:1, key:b64(), clients:{}, tokens:{}, bearer:[]};
  const parsed = stateSchema.safeParse(raw);
  if (!parsed.success) throw new WaypostError('STORE_CORRUPT', 'The OAuth state file is invalid. Move it aside and run waypost setup remote again; every client will need to reconnect.');
  return parsed.data;
}
async function change<T>(http:HttpConfig, update:(state:State)=>T):Promise<T> {
  return withLock(http.stateDir, async () => {
    const state = await load(http);
    const result = update(state);
    const time = now();
    for (const [hash, item] of Object.entries(state.tokens)) if (item.expires < time) delete state.tokens[hash];
    const entries = Object.entries(state.tokens);
    if (entries.length > MAX_TOKENS) for (const [hash] of entries.sort((a,b) => a[1].expires - b[1].expires).slice(0, entries.length - MAX_TOKENS)) delete state.tokens[hash];
    await writeJson(http.stateDir, STATE, state);
    return result;
  });
}

// ---------- Owner passcode ----------
function hashPasscode(passcode:string, salt = randomBytes(16)) {
  const derived = scryptSync(passcode, salt, 32, {N:16384, r:8, p:1});
  return `scrypt$16384$8$1$${salt.toString('base64url')}$${derived.toString('base64url')}`;
}
function checkPasscode(stored:string | undefined, passcode:string) {
  if (!stored || passcode.length < 1 || passcode.length > 200) return false;
  const [scheme, n, r, p, salt, hash] = stored.split('$');
  if (scheme !== 'scrypt' || !salt || !hash) return false;
  const expected = Buffer.from(hash, 'base64url');
  const derived = scryptSync(passcode, Buffer.from(salt, 'base64url'), expected.length, {N:Number(n), r:Number(r), p:Number(p)});
  return timingSafeEqual(derived, expected);
}
/** Generate a passcode and print it once. Rotating it does not end sessions already granted. */
export async function setPasscode(config:Config) {
  const http = httpConfig(config);
  const passcode = randomBytes(15).toString('base64url').replace(/[-_]/g, 'x').match(/.{1,5}/g)!.join('-');
  await change(http, state => { state.passcode = hashPasscode(passcode); });
  await audit(http.stateDir, {action:'passcode_set', via:'cli'});
  return {passcode, shownOnce:true, use:'Enter this on the Waypost approval page when claude.ai or another client connects. Keep it in your password manager.'};
}
/**
 * A static bearer token for a CLI client. With `presetHash`, the client generated the token itself
 * (openssl rand -base64 32 | tr '+/' '-_' | tr -d '=') and only its SHA-256 reaches the server.
 */
export async function createBearer(config:Config, label:string, presetHash?:string) {
  if (!/^[\p{L}\p{N} ._-]{1,60}$/u.test(label)) throw new WaypostError('INPUT_INVALID', 'Use a label of 1–60 letters, digits, spaces, dots, dashes or underscores.');
  if (presetHash !== undefined && !/^[a-f0-9]{64}$/.test(presetHash)) throw new WaypostError('INPUT_INVALID', '--sha256 must be 64 lowercase hex characters: the SHA-256 of a token of 32+ random bytes.');
  const http = httpConfig(config);
  const value = presetHash ? null : `wpb_${b64()}`, id = randomBytes(4).toString('hex');
  await change(http, state => { state.bearer.push({id, hash:presetHash ?? sha(value!), label, created:new Date().toISOString()}); });
  await audit(http.stateDir, {action:'bearer_create', id, preset:!!presetHash, via:'cli'});
  return value ? {id, label, token:value, shownOnce:true, header:`Authorization: Bearer ${value}`, revoke:`waypost auth revoke ${id}`} : {id, label, token:null, registered:'hash', revoke:`waypost auth revoke ${id}`};
}
export async function listAuth(config:Config) {
  const state = await load(httpConfig(config));
  const time = now();
  return {passcodeSet:!!state.passcode, bearer:state.bearer.map(({hash:_, ...item}) => item), clients:Object.values(state.clients).map(item => ({client_id:item.client_id, client_name:item.client_name, redirect_hosts:[...new Set(item.redirect_uris.map(uri => new URL(uri).host))], created:new Date(item.created_at * 1000).toISOString(), activeGrants:new Set(Object.values(state.tokens).filter(t => t.client_id === item.client_id && !t.revoked && t.expires > time).map(t => t.family)).size}))};
}
/** Revoke a bearer token by id, every grant of one OAuth client, or everything. */
export async function revokeAuth(config:Config, target:string) {
  const http = httpConfig(config);
  const result = await change(http, state => {
    if (target === 'all') { const count = Object.keys(state.tokens).length; state.tokens = {}; state.clients = {}; for (const item of state.bearer) item.revoked ??= new Date().toISOString(); return {revoked:'all', tokens:count}; }
    const item = state.bearer.find(entry => entry.id === target && !entry.revoked);
    if (item) { item.revoked = new Date().toISOString(); return {revoked:'bearer', id:target}; }
    if (state.clients[target]) { delete state.clients[target]; for (const [hash, entry] of Object.entries(state.tokens)) if (entry.client_id === target) delete state.tokens[hash]; return {revoked:'client', id:target}; }
    throw new WaypostError('AUTH_NOT_FOUND', 'No bearer token or client has that id. Run waypost auth list.');
  });
  await audit(http.stateDir, {action:'auth_revoke', target, via:'cli'});
  return result;
}

// ---------- Metadata ----------
export function protectedResourceMetadata(http:HttpConfig) {
  return {resource:resourceUrl(http), authorization_servers:[issuer(http)], bearer_methods_supported:['header'], scopes_supported:['waypost'], resource_name:'Waypost'};
}
export function authorizationServerMetadata(http:HttpConfig) {
  const base = issuer(http);
  return {issuer:base, authorization_endpoint:`${base}/authorize`, token_endpoint:`${base}/token`, registration_endpoint:`${base}/register`, revocation_endpoint:`${base}/revoke`,
    response_types_supported:['code'], grant_types_supported:['authorization_code','refresh_token'], code_challenge_methods_supported:['S256'],
    token_endpoint_auth_methods_supported:['none','client_secret_post','client_secret_basic'], revocation_endpoint_auth_methods_supported:['none','client_secret_post','client_secret_basic'], scopes_supported:['waypost']};
}

// ---------- Registration ----------
export class OAuthError extends Error {
  constructor(readonly status:number, readonly error:string, readonly description:string) { super(description); }
}
const LOOPBACK = new Set(['localhost','127.0.0.1','[::1]']);
function redirectAllowed(http:HttpConfig, uri:string) {
  let url:URL;
  try { url = new URL(uri); } catch { return false; }
  if (url.hash || url.username || url.password || uri.length > 500) return false;
  // Native and CLI clients receive the code on a loopback port (RFC 8252); web clients only on an exact approved callback.
  if (url.protocol === 'http:' && LOOPBACK.has(url.hostname)) return true;
  return url.protocol === 'https:' && !url.search && http.redirectUris.includes(url.href);
}
const registration = z.object({redirect_uris:z.array(z.string()).min(1).max(5), client_name:z.string().max(100).optional(), token_endpoint_auth_method:z.enum(['none','client_secret_post','client_secret_basic']).default('none'), grant_types:z.array(z.string()).max(10).optional(), response_types:z.array(z.string()).max(10).optional()}).loose();
const registrations:number[] = [];
export async function registerClient(config:Config, body:unknown) {
  const http = httpConfig(config);
  const time = Date.now();
  while (registrations.length && registrations[0]! < time - 10 * 60000) registrations.shift();
  if (registrations.length >= 30) throw new OAuthError(429, 'temporarily_unavailable', 'Too many client registrations. Try again in a few minutes.');
  registrations.push(time);
  const parsed = registration.safeParse(body);
  if (!parsed.success) throw new OAuthError(400, 'invalid_client_metadata', 'redirect_uris is required (1–5 URIs).');
  const request = parsed.data;
  for (const uri of request.redirect_uris) if (!redirectAllowed(http, uri)) throw new OAuthError(400, 'invalid_redirect_uri', 'Redirect URIs must be an approved https callback (http.redirectUris) or http on localhost.');
  if (request.grant_types?.some(grant => !['authorization_code','refresh_token'].includes(grant))) throw new OAuthError(400, 'invalid_client_metadata', 'Only authorization_code and refresh_token grants are supported.');
  const client_id = `wpc_${b64(16)}`, secret = request.token_endpoint_auth_method === 'none' ? undefined : `wps_${b64()}`;
  const name = (request.client_name ?? 'MCP client').replace(/[\x00-\x1f\x7f<>]/g, '').slice(0, 100) || 'MCP client';
  await change(http, state => {
    const clients = Object.values(state.clients);
    if (clients.length >= MAX_CLIENTS) {
      // Evict only clients that never finished authorizing and are over an hour old, so a registration flood cannot push out real clients.
      const active = new Set(Object.values(state.tokens).map(item => item.client_id));
      const oldest = clients.filter(item => !active.has(item.client_id) && item.last_used === undefined && item.created_at < now() - 3600).sort((a,b) => a.created_at - b.created_at)[0];
      if (!oldest) throw new OAuthError(400, 'invalid_client_metadata', 'Too many registered clients. Revoke unused ones with waypost auth revoke.');
      delete state.clients[oldest.client_id];
    }
    state.clients[client_id] = {client_id, ...(secret ? {client_secret_hash:sha(secret)} : {}), redirect_uris:request.redirect_uris, client_name:name, token_endpoint_auth_method:request.token_endpoint_auth_method, created_at:now()};
  });
  return {client_id, ...(secret ? {client_secret:secret, client_secret_expires_at:0} : {}), client_id_issued_at:now(), client_name:name, redirect_uris:request.redirect_uris, token_endpoint_auth_method:request.token_endpoint_auth_method, grant_types:['authorization_code','refresh_token'], response_types:['code']};
}

// ---------- Authorization ----------
type AuthorizeRequest = {client_id:string; redirect_uri:string; state?:string | undefined; code_challenge:string; resource:string; scope:string; exp:number};
const codes = new Map<string, AuthorizeRequest & {expires:number}>();
const failures:{at:number; client:string}[] = [];
export async function validateAuthorize(config:Config, params:URLSearchParams) {
  const http = httpConfig(config);
  const state = await load(http);
  const client_id = params.get('client_id') ?? '', redirect_uri = params.get('redirect_uri') ?? '';
  const registered = state.clients[client_id];
  // Never redirect to an unverified URI: these errors render on the page instead.
  if (!registered) throw new OAuthError(400, 'invalid_client', 'Unknown client. Remove the connector and add it again so it registers.');
  if (!registered.redirect_uris.includes(redirect_uri)) throw new OAuthError(400, 'invalid_request', 'The redirect URI does not match the registered client.');
  const fail = (error:string, description:string) => { const url = new URL(redirect_uri); url.searchParams.set('error', error); url.searchParams.set('error_description', description); if (params.get('state')) url.searchParams.set('state', params.get('state')!); return {redirect:url.href}; };
  if (params.get('response_type') !== 'code') return fail('unsupported_response_type', 'Only response_type=code is supported.');
  const challenge = params.get('code_challenge') ?? '';
  if (params.get('code_challenge_method') !== 'S256' || !/^[A-Za-z0-9_-]{43}$/.test(challenge)) return fail('invalid_request', 'PKCE with code_challenge_method=S256 is required.');
  const resource = params.get('resource') ?? resourceUrl(http);
  if (resource.replace(/\/$/, '') !== resourceUrl(http)) return fail('invalid_target', 'This server only issues tokens for its own MCP endpoint.');
  const request:AuthorizeRequest = {client_id, redirect_uri, state:params.get('state') ?? undefined, code_challenge:challenge, resource:resourceUrl(http), scope:'waypost', exp:now() + REQUEST_TTL};
  const blob = Buffer.from(JSON.stringify(request)).toString('base64url');
  const signature = createHmac('sha256', state.key).update(blob).digest('base64url');
  return {request, signed:`${blob}.${signature}`, clientName:registered.client_name, redirectHost:new URL(redirect_uri).host, passcodeSet:!!state.passcode};
}
function signedRequest(state:State, signed:string):AuthorizeRequest {
  const [blob = '', signature = ''] = signed.split('.');
  const expected = createHmac('sha256', state.key).update(blob).digest();
  const given = Buffer.from(signature, 'base64url');
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) throw new OAuthError(400, 'invalid_request', 'The approval form is invalid. Start the connection again.');
  const request = JSON.parse(Buffer.from(blob, 'base64url').toString('utf8')) as AuthorizeRequest;
  if (request.exp < now()) throw new OAuthError(400, 'invalid_request', 'The approval form expired. Start the connection again.');
  if (!state.clients[request.client_id]?.redirect_uris.includes(request.redirect_uri)) throw new OAuthError(400, 'invalid_client', 'The client is no longer registered.');
  return request;
}
/** Details to show the consent page again after a wrong passcode, from the already signed request. */
export async function describeSigned(config:Config, signed:string) {
  const state = await load(httpConfig(config));
  const request = signedRequest(state, signed);
  return {request, signed, clientName:state.clients[request.client_id]!.client_name, redirectHost:new URL(request.redirect_uri).host, passcodeSet:!!state.passcode};
}
/** The consent POST: verify the signed request and the owner passcode, then issue a single-use code. */
export async function approveAuthorize(config:Config, form:URLSearchParams) {
  const http = httpConfig(config);
  const state = await load(http);
  const request = signedRequest(state, form.get('request') ?? '');
  const deny = () => { const url = new URL(request.redirect_uri); url.searchParams.set('error', 'access_denied'); if (request.state) url.searchParams.set('state', request.state); return {redirect:url.href}; };
  if (form.get('decision') === 'deny') return deny();
  const time = Date.now();
  while (failures.length && failures[0]!.at < time - 15 * 60000) failures.shift();
  // Limits count per client, so a stranger who registers a client cannot lock the owner out of approving claude.ai.
  // The passcode carries about 120 bits, so the global cap only bounds scrypt work.
  if (failures.filter(item => item.client === request.client_id).length >= 5 || failures.length >= 200) throw new OAuthError(429, 'temporarily_unavailable', 'Too many wrong passcodes for this connection. Wait 15 minutes and try again.');
  if (!checkPasscode(state.passcode, form.get('passcode') ?? '')) { failures.push({at:time, client:request.client_id}); await audit(http.stateDir, {action:'authorize_failed', client_id:request.client_id}).catch(() => undefined); throw new OAuthError(401, 'access_denied', state.passcode ? 'Wrong passcode.' : 'No passcode is set. Run waypost auth passcode on the server.'); }
  const code = `wpk_${b64()}`;
  for (const [key, value] of codes) if (value.expires < now()) codes.delete(key);
  codes.set(sha(code), {...request, expires:now() + CODE_TTL});
  await audit(http.stateDir, {action:'authorize', client_id:request.client_id, via:'oauth'});
  const url = new URL(request.redirect_uri);
  url.searchParams.set('code', code);
  if (request.state) url.searchParams.set('state', request.state);
  url.searchParams.set('iss', issuer(http));
  return {redirect:url.href};
}

// ---------- Tokens ----------
function authenticateClient(state:State, params:URLSearchParams, authorization:string | undefined) {
  let id = params.get('client_id') ?? '', secret = params.get('client_secret') ?? undefined;
  if (authorization?.startsWith('Basic ')) {
    const decoded = Buffer.from(authorization.slice(6), 'base64').toString('utf8');
    const split = decoded.indexOf(':');
    if (split > 0) { id = decodeURIComponent(decoded.slice(0, split)); secret = decodeURIComponent(decoded.slice(split + 1)); }
  }
  const registered = state.clients[id];
  if (!registered) throw new OAuthError(401, 'invalid_client', 'Unknown client.');
  if (registered.client_secret_hash) {
    const given = Buffer.from(sha(secret ?? '')), stored = Buffer.from(registered.client_secret_hash);
    if (!secret || !timingSafeEqual(given, stored)) throw new OAuthError(401, 'invalid_client', 'Client authentication failed.');
  }
  return registered;
}
function issue(state:State, client_id:string, resource:string, family = b64(12)) {
  const access = `wpa_${b64()}`, refresh = `wpr_${b64()}`, time = now();
  state.tokens[sha(access)] = {kind:'access', client_id, expires:time + ACCESS_TTL, family, resource};
  state.tokens[sha(refresh)] = {kind:'refresh', client_id, expires:time + REFRESH_TTL, family, resource};
  const registered = state.clients[client_id];
  if (registered) registered.last_used = time;
  return {access_token:access, token_type:'Bearer', expires_in:ACCESS_TTL, refresh_token:refresh, scope:'waypost'};
}
export async function exchangeToken(config:Config, params:URLSearchParams, authorization:string | undefined) {
  const http = httpConfig(config);
  const grant = params.get('grant_type');
  if (grant === 'authorization_code') {
    const code = params.get('code') ?? '';
    const saved = codes.get(sha(code));
    codes.delete(sha(code));
    return change(http, state => {
      const registered = authenticateClient(state, params, authorization);
      if (!saved || saved.expires < now() || saved.client_id !== registered.client_id) throw new OAuthError(400, 'invalid_grant', 'The authorization code is invalid, expired or already used.');
      if (params.get('redirect_uri') !== saved.redirect_uri) throw new OAuthError(400, 'invalid_grant', 'redirect_uri does not match the authorization request.');
      const verifier = params.get('code_verifier') ?? '';
      if (!/^[A-Za-z0-9._~-]{43,128}$/.test(verifier) || createHash('sha256').update(verifier).digest('base64url') !== saved.code_challenge) throw new OAuthError(400, 'invalid_grant', 'PKCE verification failed.');
      const resource = params.get('resource');
      if (resource && resource.replace(/\/$/, '') !== saved.resource) throw new OAuthError(400, 'invalid_target', 'The resource does not match the authorization request.');
      return issue(state, registered.client_id, saved.resource);
    });
  }
  if (grant === 'refresh_token') {
    const presented = sha(params.get('refresh_token') ?? '');
    const result = await change(http, state => {
      const registered = authenticateClient(state, params, authorization);
      const saved = state.tokens[presented];
      if (!saved || saved.kind !== 'refresh' || saved.client_id !== registered.client_id || saved.expires < now()) throw new OAuthError(400, 'invalid_grant', 'The refresh token is invalid or expired.');
      if (saved.revoked) {
        // A rotated refresh token came back: someone holds a copy. End the whole grant, and save that before refusing.
        for (const [hash, item] of Object.entries(state.tokens)) if (item.family === saved.family) delete state.tokens[hash];
        return null;
      }
      saved.revoked = true;
      for (const item of Object.values(state.tokens)) if (item.family === saved.family && item.kind === 'access') item.revoked = true;
      return issue(state, registered.client_id, saved.resource, saved.family);
    });
    if (!result) throw new OAuthError(400, 'invalid_grant', 'This refresh token was already used. The grant has been revoked; connect again.');
    return result;
  }
  throw new OAuthError(400, 'unsupported_grant_type', 'Use authorization_code or refresh_token.');
}
export async function revokeToken(config:Config, params:URLSearchParams, authorization:string | undefined) {
  const http = httpConfig(config);
  await change(http, state => {
    const registered = authenticateClient(state, params, authorization);
    const saved = state.tokens[sha(params.get('token') ?? '')];
    if (saved && saved.client_id === registered.client_id) for (const [hash, item] of Object.entries(state.tokens)) if (item.family === saved.family) delete state.tokens[hash];
  });
}
/** Check an Authorization header. Returns who is calling, or null. Tokens in query strings are never read. */
export async function verifyBearer(config:Config, header:string | undefined):Promise<{kind:'oauth' | 'bearer'; id:string} | null> {
  const match = /^Bearer ([A-Za-z0-9_-]{20,200})$/.exec(header ?? '');
  if (!match) return null;
  const http = httpConfig(config);
  const state = await load(http);
  const hash = sha(match[1]!);
  const saved = state.tokens[hash];
  if (saved && saved.kind === 'access' && !saved.revoked && saved.expires > now() && saved.resource === resourceUrl(http)) return {kind:'oauth', id:saved.client_id};
  const item = state.bearer.find(entry => !entry.revoked && entry.hash === hash);
  return item ? {kind:'bearer', id:item.id} : null;
}
