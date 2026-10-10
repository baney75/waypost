// Latest one-time verification code from Proton Mail (and, on a Mac, forwarded SMS).
// Codes are credentials: nothing here logs, caches or persists a code or a message body.
import { z } from 'zod';
import type { Config } from './config.js';
import { WaypostError } from './errors.js';
import { defineTool } from './tool.js';
import { imap, examine, parseMessage, htmlText } from './mail.js';
import { helperMailList, helperMailRead } from './mail-helper.js';
import { extractCode, originBoundCode, protonDmarc, registrableDomain, senderDomainsFor } from './otp.js';

const MAX_SOURCE = 96 * 1024;
const MAX_MESSAGES = 30;
const siteSchema = z.string().max(2048).transform((value, context) => {
  let host = value.trim();
  try { if (/^[a-z][a-z0-9+.-]*:\/\//i.test(host)) host = new URL(host).hostname; } catch { /* checked below */ }
  host = host.toLowerCase().replace(/\.$/, '');
  if (!registrableDomain(host)) { context.addIssue({code:'custom', message:'Use a site hostname or URL such as github.com or https://github.com/login.'}); return z.NEVER; }
  return host;
});
export const verificationCodeSchema = z.object({
  site: siteSchema.optional().describe('Site that asked for the code, such as github.com. Only codes from senders that belong to this site are returned.'),
  from: z.string().min(1).max(200).refine(value => !/[\x00-\x1f\x7f]/.test(value)).optional().describe('Only messages whose From contains this text.'),
  maxAgeMinutes: z.number().int().min(1).max(60).optional().describe('Look back this many minutes; defaults to the configured value (10).'),
  notBefore: z.string().datetime().optional().describe('Ignore messages received before this ISO time, for example when the sign-in started.'),
}).strict();
type Query = z.output<typeof verificationCodeSchema>;
type Match = {code:string; confidence:'high'|'medium'|'low'; source:'mail'|'sms'; sender:{name:string; address:string}; subject:string|null; receivedAt:string; senderMatchesSite:boolean|null; senderVerified:boolean|null; mailbox?:string; uid?:number};

function policy(config:Config, caller:'agents'|'browser') {
  const settings = config.verificationCodes;
  if (!settings?.[caller]) throw new WaypostError('VERIFICATION_CODES_DISABLED', caller === 'agents'
    ? 'Verification-code lookup for agents is off. The user can turn it on by setting "verificationCodes": {"agents": true} in the Waypost config. Codes are credentials; leave it off unless the user asked for it.'
    : 'Verification-code lookup for the browser extension is off. Run: waypost connect browser');
  return settings;
}
const domainOf = (address:string) => address.includes('@') ? registrableDomain(address.split('@').pop()!) : null;
function siteMatch(query:Query, address:string, aliases:Record<string,string[]>):boolean|null {
  if (!query.site) return null;
  const domain = domainOf(address);
  return !!domain && senderDomainsFor(query.site, aliases).has(domain);
}
function headerBlock(source:Buffer):string {
  const text = source.toString('latin1');
  const end = text.search(/\r?\n\r?\n/);
  return end < 0 ? text : text.slice(0, end);
}
async function fromBridge(config:Config, query:Query, cutoff:number, aliases:Record<string,string[]>, mailboxes:string[]) {
  const matches:Match[] = []; let otherSenders = 0;
  await imap(config, async client => {
    for (const mailbox of mailboxes) await examine(client, mailbox, async () => {
      const criteria:Record<string,unknown> = {since:new Date(cutoff - 86400000)};
      if (query.from) criteria.from = query.from;
      const found = await client.search(criteria, {uid:true});
      const uids = (found || []).sort((a,b) => a-b).slice(-MAX_MESSAGES);
      if (!uids.length) return;
      for await (const message of client.fetch(uids.join(','), {uid:true, envelope:true, internalDate:true, source:{start:0, maxLength:MAX_SOURCE}}, {uid:true})) {
        const received = message.internalDate ? new Date(message.internalDate).getTime() : NaN;
        if (!Number.isFinite(received) || received < cutoff || !message.source) continue;
        const from = message.envelope?.from?.[0];
        const address = (from?.address ?? '').toLowerCase();
        const matchesSite = siteMatch(query, address, aliases);
        if (matchesSite === false) { otherSenders++; continue; }
        const parsed = await parseMessage(message.source);
        const text = parsed.text || (typeof parsed.html === 'string' ? htmlText(parsed.html) : '');
        const result = extractCode(parsed.subject ?? '', text);
        if (!result) continue;
        matches.push({...result, source:'mail', sender:{name:(from?.name ?? '').slice(0,200), address:address.slice(0,254)}, subject:(parsed.subject ?? '').slice(0,300), receivedAt:new Date(received).toISOString(), senderMatchesSite:matchesSite, senderVerified:protonDmarc(headerBlock(message.source), domainOf(address)), mailbox, uid:message.uid});
      }
    });
  });
  return {matches, otherSenders};
}
async function fromHelper(config:Config, query:Query, cutoff:number, aliases:Record<string,string[]>) {
  const matches:Match[] = []; let otherSenders = 0;
  const since = new Date(cutoff - 86400000).toISOString().slice(0,10);
  const listed = await helperMailList(config, {mailbox:'INBOX', limit:20, since, ...(query.from ? {from:query.from} : {})});
  const recent = listed.messages.filter(message => message.date && Date.parse(message.date) >= cutoff);
  for (const message of recent.slice(0,8)) {
    const address = (message.from[0]?.address ?? '').toLowerCase();
    const matchesSite = siteMatch(query, address, aliases);
    if (matchesSite === false) { otherSenders++; continue; }
    const read = await helperMailRead(config, {mailbox:'INBOX', uid:message.uid});
    const result = extractCode(read.subject, read.text);
    if (result) matches.push({...result, source:'mail', sender:{name:message.from[0]?.name ?? '', address}, subject:read.subject.slice(0,300), receivedAt:message.date!, senderMatchesSite:matchesSite, senderVerified:null, mailbox:'INBOX', uid:message.uid});
  }
  return {matches, otherSenders};
}
// macOS Messages stores newer message text in attributedBody, an NSAttributedString typedstream.
export function attributedBodyText(blob:Uint8Array | null | undefined):string {
  if (!blob) return '';
  const bytes = Buffer.from(blob);
  const marker = bytes.indexOf('NSString');
  if (marker < 0) return '';
  let index = bytes.indexOf(0x2b, marker + 8); // '+' starts the string record
  if (index < 0 || index > marker + 20) return '';
  index++;
  let length = bytes[index]!; index++;
  if (length === 0x81) { length = bytes.readUInt16LE(index); index += 2; }
  else if (length === 0x82) { length = bytes.readUInt32LE(index); index += 4; }
  return bytes.subarray(index, Math.min(bytes.length, index + Math.min(length, 8192))).toString('utf8');
}
const APPLE_EPOCH_SECONDS = 978307200;
async function fromMessages(path:string, query:Query, cutoff:number, aliases:Record<string,string[]>) {
  const matches:Match[] = []; let otherSenders = 0;
  let sqlite:typeof import('node:sqlite');
  try { sqlite = await import('node:sqlite'); } catch { throw new WaypostError('SMS_UNAVAILABLE', 'This Node.js has no node:sqlite. Use Node.js 22.14 or newer.'); }
  let database;
  try { database = new sqlite.DatabaseSync(path, {readOnly:true}); }
  catch { throw new WaypostError('SMS_UNAVAILABLE', `Could not open the Messages database read-only at ${path}. On a Mac, give the app that runs Waypost Full Disk Access (System Settings → Privacy & Security).`); }
  try {
    // Messages stores nanoseconds since 2001-01-01 on current macOS (seconds on very old versions).
    // Nanosecond dates exceed 2^53, so read them as BigInt; sub-microsecond precision is irrelevant here.
    const cutoffSeconds = Math.floor(cutoff / 1000 - APPLE_EPOCH_SECONDS);
    const statement = database.prepare('SELECT m.text AS text, m.attributedBody AS body, m.date AS date, h.id AS sender FROM message m LEFT JOIN handle h ON m.handle_id = h.ROWID WHERE m.is_from_me = 0 AND (m.date >= ? OR (m.date < 100000000000 AND m.date >= ?)) ORDER BY m.date DESC LIMIT ?');
    statement.setReadBigInts(true);
    const rows = statement.all(BigInt(cutoffSeconds) * 1000000000n, BigInt(cutoffSeconds), BigInt(MAX_MESSAGES)) as {text:string|null; body:Uint8Array|null; date:bigint; sender:string|null}[];
    for (const row of rows) {
      const text = (row.text || attributedBodyText(row.body)).slice(0, 4000);
      const seconds = row.date > 100000000000n ? Number(row.date / 1000000n) / 1000 : Number(row.date);
      const receivedAt = new Date((seconds + APPLE_EPOCH_SECONDS) * 1000).toISOString();
      const bound = originBoundCode(text);
      let matchesSite:boolean|null = null;
      if (query.site) {
        // SMS senders have no domain. Only the origin-bound format ("@site #code") can tie a text to a site.
        matchesSite = !!bound && senderDomainsFor(query.site, aliases).has(registrableDomain(bound.domain) ?? '');
        if (!matchesSite) { otherSenders++; continue; }
      }
      if (query.from && !(row.sender ?? '').includes(query.from)) continue;
      const result = bound ? {code:bound.code, confidence:'high' as const} : extractCode('', text);
      if (result) matches.push({...result, source:'sms', sender:{name:'', address:(row.sender ?? '').slice(0,64)}, subject:null, receivedAt, senderMatchesSite:matchesSite, senderVerified:null});
    }
  } finally { database.close(); }
  return {matches, otherSenders};
}
export async function latestVerificationCode(config:Config, input:unknown, caller:'agents'|'browser' = 'agents') {
  const query = verificationCodeSchema.parse(input);
  const settings = policy(config, caller);
  if (caller === 'browser' && !query.site) throw new WaypostError('INPUT_INVALID', 'The browser extension must name the site.');
  const aliases = settings.siteAliases;
  const cutoff = Math.max(Date.now() - (query.maxAgeMinutes ?? settings.maxAgeMinutes) * 60000, query.notBefore ? Date.parse(query.notBefore) : 0);
  const results = [];
  if (config.mail) results.push(await fromBridge(config, query, cutoff, aliases, settings.mailboxes));
  else if (config.mailHelper) results.push(await fromHelper(config, query, cutoff, aliases));
  if (settings.messagesDatabase) results.push(await fromMessages(settings.messagesDatabase, query, cutoff, aliases));
  if (!results.length) throw new WaypostError('MAIL_UNCONFIGURED', 'Connect Mail (waypost connect mail) or set verificationCodes.messagesDatabase before looking up codes.');
  const order = {high:0, medium:1, low:2};
  const matches = results.flatMap(result => result.matches).filter(match => match.confidence !== 'low').sort((a,b) => b.receivedAt.localeCompare(a.receivedAt) || order[a.confidence]-order[b.confidence]);
  const otherSenders = results.reduce((sum,result) => sum + result.otherSenders, 0);
  const best = matches[0];
  if (!best) return {found:false, since:new Date(cutoff).toISOString(), ...(otherSenders ? {reason:`${otherSenders} recent message(s) came from senders that do not belong to ${query.site}; their codes were not returned.`} : {reason:'No message with a verification code arrived in the time window. Wait a few seconds and ask again.'})};
  return {found:true, ...best, bodyReturned:false, ...(matches.length > 1 ? {olderCodes:matches.length - 1} : {})};
}
export const codeTools = [
  defineTool({name:'mail_verification_code', title:'Latest verification code', description:'Off unless the user set verificationCodes.agents in local config. Returns the newest one-time code (2FA, sign-in or verification) received in the last few minutes, with sender, subject, time and confidence, never the message body. Pass site to accept only senders that belong to that site. Treat the code as a password: use it only for the sign-in the user asked for, and do not repeat it elsewhere.', schema:verificationCodeSchema, readOnly:true, destructive:false, handler:(config,input) => latestVerificationCode(config,input,'agents')}),
];
