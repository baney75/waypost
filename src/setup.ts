import { stat } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import type { Config } from './config.js';
import { initConfig, loadConfig } from './config.js';
import { amendConfig } from './connect.js';
import { WaypostError, publicError } from './errors.js';
import { callTool } from './registry.js';
import { privateDirectory } from './store.js';
import { createFeedToken, loadStore } from './agent-calendar.js';
import { feedProvenance } from './calendar-feed.js';
import { listAuth, setPasscode } from './oauth.js';

const absolute = (value:string, flag:string) => { if (!isAbsolute(value)) throw new WaypostError('INPUT_INVALID', `${flag} must be an absolute path.`); return value; };
const email = (value:string | undefined, flag:string) => { if (value !== undefined && !/^[^\s@<>]{1,64}@[^\s@<>]{1,190}\.[^\s@<>]{2,}$/.test(value)) throw new WaypostError('INPUT_INVALID', `${flag} must be an email address.`); return value; };

export async function setupCalendar(path:string, options:{dir:string; name:string; owner?:string | undefined; organizer?:string | undefined; enableWrites?:boolean | undefined}) {
  const dir = absolute(options.dir, '--dir');
  email(options.owner, '--owner'); email(options.organizer, '--organizer');
  await privateDirectory(dir);
  const config = await amendConfig(path, c => ({...c, agentCalendar:{dir, name:options.name, writeEnabled:options.enableWrites ?? c.agentCalendar?.writeEnabled ?? false, syncMinutes:c.agentCalendar?.syncMinutes ?? 30,
    ...(options.owner ?? c.agentCalendar?.owner ? {owner:options.owner ?? c.agentCalendar!.owner!} : {}), ...(options.organizer ?? c.agentCalendar?.organizer ? {organizer:options.organizer ?? c.agentCalendar!.organizer!} : {})}}));
  await loadStore(config);
  return {agentCalendar:config.agentCalendar, next:['Link your Proton calendars: waypost connect calendar --pass-item "<item>" --vault "<vault>" --name Personal --source personal', 'Add --read-only for calendars agents must never change, such as a shared family calendar.', 'Publish the agent calendar: waypost setup remote, then waypost calendar feed create.']};
}
export async function setupRemote(path:string, options:{publicUrl:string; stateDir:string; port:number; host:string}) {
  const stateDir = absolute(options.stateDir, '--state-dir');
  const publicUrl = new URL(options.publicUrl).origin + '/';
  await privateDirectory(stateDir);
  const config = await amendConfig(path, c => ({...c, http:{host:options.host, port:options.port, publicUrl, stateDir, redirectOrigins:c.http?.redirectOrigins ?? ['https://claude.ai','https://claude.com'], allowedHosts:c.http?.allowedHosts ?? [], ...(c.http?.tools ? {tools:c.http.tools} : {})}}));
  const auth = await listAuth(config);
  const passcode = auth.passcodeSet ? null : await setPasscode(config);
  return {mcpUrl:new URL('mcp', publicUrl).href, passcode:passcode?.passcode ?? 'already set (rotate with waypost auth passcode)', start:'waypost serve', next:remoteSteps(publicUrl)};
}
const remoteSteps = (publicUrl:string) => [
  `claude.ai: Customize → Connectors → Add custom connector. Name it Waypost and use ${new URL('mcp', publicUrl).href}. Approve with your Waypost passcode.`,
  `Claude Code: claude mcp add --transport http waypost ${new URL('mcp', publicUrl).href} --scope user, then run /mcp to sign in.`,
  'Other CLI clients: waypost auth token --label <name> prints a bearer token for an Authorization header.',
];
/** Everything a server needs, in one command, under one data directory. Safe to run again: it keeps what exists. */
export async function setupQuick(path:string, options:{publicUrl:string; data:string; owner?:string | undefined; port:number; host:string; enableWrites:boolean}) {
  const data = absolute(options.data, '--data');
  await privateDirectory(data);
  const created = await stat(path).then(() => false, async () => { await initConfig(path); return true; });
  if (created) await amendConfig(path, c => ({...c, artifactsDir:join(data, 'artifacts')}));
  await setupCalendar(path, {dir:join(data, 'calendar'), name:'Agents', owner:options.owner, enableWrites:options.enableWrites});
  const remote = await setupRemote(path, {publicUrl:options.publicUrl, stateDir:join(data, 'auth'), port:options.port, host:options.host});
  const config = await loadConfig(path);
  const store = await loadStore(config);
  const feed = store.feedTokens.some(token => !token.revokedAt) ? null : await createFeedToken(config, 'Proton');
  return {config:path, created, mcpUrl:remote.mcpUrl, passcode:remote.passcode, protonFeedUrl:feed?.url ?? 'already created (list with waypost calendar feed list; create another with waypost calendar feed create)', writesEnabled:options.enableWrites,
    next:[
      'Start the server: waypost serve (the compose stack does this for you).',
      `Proton: Calendar → Other calendars → Add calendar from URL. Paste the feed URL, name it Agents, then open its settings and add default notifications.`,
      ...remote.next,
      'Link your own Proton calendars so agents can see them: waypost connect calendar --help.',
    ], secrets:'The passcode and feed URL are shown only now. Store them in Proton Pass.'};
}

type Check = {service:string; status:'ready' | 'not_configured' | 'failed' | 'warning'; [key:string]:unknown};
export async function doctorChecks(config:Config):Promise<Check[]> {
  const checks:Check[] = [];
  const now = () => new Date().toISOString().replace(/\.\d{3}Z$/,'Z');
  for (const service of ['mail','drive','calendar']) {
    const configured = service === 'mail' ? !!(config.mail || config.mailHelper) : service === 'drive' ? !!config.drive : !!(config.calendar?.files.length || config.calendar?.feeds?.length || config.agentCalendar);
    if (!configured) { checks.push({service, status:'not_configured', next:`Run waypost connect ${service} --help.`}); continue; }
    try {
      if (service === 'drive') await callTool(config, 'drive_list', {path:config.drive?.root});
      else if (service === 'mail') await callTool(config, 'mail_doctor', {});
      else await callTool(config, 'calendar_events', {from:now(), to:new Date(Date.now() + 86400000).toISOString().replace(/\.\d{3}Z$/,'Z'), limit:1});
      checks.push({service, status:'ready', verified:service === 'calendar' ? (config.calendar?.feeds?.length ? 'feed_fetch_and_snapshot_parse' : 'snapshot_parse') : service === 'mail' ? 'authentication' : 'directory_read'});
    } catch (error) { checks.push({service, status:'failed', error:publicError(error)}); }
  }
  if (config.agentCalendar) {
    try {
      const store = await loadStore(config);
      const tokens = store.feedTokens.filter(token => !token.revokedAt).length;
      checks.push({service:'agentCalendar', status:tokens ? 'ready' : 'warning', verified:'store_read', events:Object.values(store.events).filter(event => !event.deleted).length, pendingAdoptions:store.adoptions.filter(item => item.status === 'pending').length, activeFeedLinks:tokens, writeEnabled:config.agentCalendar.writeEnabled, ...(tokens ? {} : {next:'Create the Proton feed link: waypost calendar feed create.'})});
      for (const feed of config.calendar?.feeds ?? []) checks.push({service:`calendar:${feedProvenance(feed)}`, status:'ready', readOnly:feed.readOnly ?? false});
    } catch (error) { checks.push({service:'agentCalendar', status:'failed', error:publicError(error)}); }
  } else checks.push({service:'agentCalendar', status:'not_configured', next:'Run waypost setup calendar --dir /absolute/private/dir.'});
  if (config.http) {
    try {
      const auth = await listAuth(config);
      checks.push({service:'remote', status:auth.passcodeSet ? 'ready' : 'failed', publicUrl:config.http.publicUrl, listen:`${config.http.host}:${config.http.port}`, passcodeSet:auth.passcodeSet, oauthClients:auth.clients.length, bearerTokens:auth.bearer.filter(item => !item.revoked).length, ...(auth.passcodeSet ? {} : {next:'Run waypost auth passcode.'})});
    } catch (error) { checks.push({service:'remote', status:'failed', error:publicError(error)}); }
  } else checks.push({service:'remote', status:'not_configured', next:'Run waypost setup remote --help for claude.ai and other remote clients.'});
  return checks;
}
/** Check a deployed Waypost from outside: health, OAuth discovery and the MCP auth challenge. Never sends credentials. */
export async function remoteDoctor(base:string):Promise<Check[]> {
  const origin = new URL(base).origin;
  const checks:Check[] = [];
  const get = async (path:string, init:RequestInit = {}) => fetch(new URL(path, origin), {redirect:'manual', signal:AbortSignal.timeout(15000), ...init});
  try { const response = await get('/healthz'); const json = await response.json() as {ok?:boolean; version?:string}; checks.push({service:'remote:health', status:response.ok && json.ok ? 'ready' : 'failed', httpStatus:response.status, version:json.version ?? null}); }
  catch { checks.push({service:'remote:health', status:'failed', error:{code:'REMOTE_UNREACHABLE', message:`Could not reach ${origin}/healthz. Check the tunnel and that waypost serve is running.`}}); return checks; }
  try { const response = await get('/.well-known/oauth-protected-resource/mcp'); const json = await response.json() as {resource?:string; authorization_servers?:string[]}; checks.push({service:'remote:oauth_metadata', status:json.resource === `${origin}/mcp` && json.authorization_servers?.[0] === origin ? 'ready' : 'failed', resource:json.resource ?? null}); }
  catch { checks.push({service:'remote:oauth_metadata', status:'failed'}); }
  try { const response = await get('/mcp', {method:'POST', headers:{'Content-Type':'application/json', Accept:'application/json, text/event-stream'}, body:'{"jsonrpc":"2.0","id":1,"method":"ping"}'}); checks.push({service:'remote:mcp_auth', status:response.status === 401 && /resource_metadata=/.test(response.headers.get('www-authenticate') ?? '') ? 'ready' : 'failed', httpStatus:response.status, verified:'unauthenticated_request_rejected'}); }
  catch { checks.push({service:'remote:mcp_auth', status:'failed'}); }
  return checks;
}
