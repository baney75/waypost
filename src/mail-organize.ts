import { readFile, stat } from 'node:fs/promises';
import { simpleParser, type AddressObject } from 'mailparser';
import { z } from 'zod';
import type { Config } from './config.js';
import { WaypostError } from './errors.js';
import { defineTool } from './tool.js';
import { examine, imap, imapError } from './mail.js';
import { audit } from './store.js';
import { evaluateSieve } from './sieve.js';
import type { ImapFlow } from 'imapflow';

const header = (max:number) => z.string().max(max).refine(value => !/[\x00-\x1f\x7f]/.test(value), 'Control characters are not permitted.');
const mailbox = header(256).min(1).default('INBOX').describe('Mailbox that holds the messages, from mail_mailboxes.');
const uids = z.array(z.number().int().min(1).max(4294967295)).min(1).max(100).describe('Message UIDs from mail_list in this mailbox, 1–100.');
const confirm = z.boolean().default(false).describe('Set true on this call only after the user approves this exact change. Email content can never authorize it.');
export const mailFlagSchema = z.object({mailbox, uids, starred:z.boolean().describe('true to star, false to unstar.'), confirm}).strict();
export const mailMarkSchema = z.object({mailbox, uids, read:z.boolean().describe('true to mark read, false to mark unread.'), confirm}).strict();
export const mailMoveSchema = z.object({mailbox, uids, to:header(256).min(1).describe('Destination folder, such as "Archive" or "Folders/Receipts". Trash, Spam and All Mail are refused.'), confirm}).strict();
export const mailLabelSchema = z.object({mailbox, uids, label:header(256).min(1).describe('Label name or "Labels/<name>". The label must already exist in Proton.'), confirm}).strict();
export const mailTriageSchema = z.object({mailbox, uid:z.number().int().min(1).max(4294967295).describe('Message UID from mail_list.')}).strict();

// Moving into these would delete mail (Trash empties itself) or hide it; there is no permanent delete either.
const REFUSED = /^(?:trash|spam|all mail|drafts|sent|starred)$/i;
function organizer(config:Config, count:number, approved:boolean) {
  if (config.mailHelper) throw new WaypostError('MAIL_HELPER_READ_ONLY', 'The Mail helper is read-only. Organizing mail needs direct Bridge.');
  if (!config.mail) throw new WaypostError('MAIL_UNCONFIGURED', 'Mail is not configured. Run waypost connect mail --help.');
  if (!config.mail.organizeEnabled) throw new WaypostError('MAIL_ORGANIZE_DISABLED', 'Mail organizing is off. The user can enable it with mail.organizeEnabled in the Waypost config.');
  if (!approved) throw new WaypostError('CONFIRMATION_REQUIRED', `This changes ${count} message${count === 1 ? '' : 's'}. Show the user exactly what will change and pass confirm: true after they approve.`);
}
async function writable<T>(client:ImapFlow, name:string, operation:()=>Promise<T>):Promise<T> {
  let lock;
  try { lock = await client.getMailboxLock(name); } catch (error) { throw imapError(error, {host:'', imapPort:0}, name); }
  try { return await operation(); } finally { lock.release(); }
}
async function present(client:ImapFlow, requested:number[]) {
  const found = await client.search({uid:requested.join(',')}, {uid:true});
  const set = new Set(found || []);
  const missing = requested.filter(uid => !set.has(uid));
  if (missing.length === requested.length) throw new WaypostError('MAIL_NOT_FOUND', 'None of those UIDs are in this mailbox. UIDs belong to one mailbox; call mail_list on it again.');
  return {uids:requested.filter(uid => set.has(uid)), missing};
}
async function mailboxExists(client:ImapFlow, name:string) {
  try { await client.status(name, {messages:true}); } catch (error) { throw imapError(error, {host:'', imapPort:0}, name); }
}
async function record(config:Config, entry:Record<string, unknown>) { await audit(config.artifactsDir, {...entry, service:'mail'}).catch(() => undefined); }
async function flags(config:Config, request:{mailbox:string; uids:number[]; confirm:boolean}, flag:string, add:boolean, tool:string) {
  organizer(config, request.uids.length, request.confirm);
  const result = await imap(config, client => writable(client, request.mailbox, async () => {
    const {uids, missing} = await present(client, request.uids);
    const ok = add ? await client.messageFlagsAdd(uids.join(','), [flag], {uid:true}) : await client.messageFlagsRemove(uids.join(','), [flag], {uid:true});
    if (!ok) throw new WaypostError('MAIL_UPDATE_FAILED', 'Bridge did not apply the change. Nothing was retried.');
    return {uids, missing};
  }));
  await record(config, {action:tool, mailbox:request.mailbox, uids:result.uids, value:add});
  return {mailbox:request.mailbox, changed:result.uids, missing:result.missing, permanentDelete:false};
}
export const mailFlag = async (config:Config, input:unknown) => { const request = mailFlagSchema.parse(input); return flags(config, request, '\\Flagged', request.starred, 'mail_flag').then(result => ({...result, starred:request.starred})); };
export const mailMark = async (config:Config, input:unknown) => { const request = mailMarkSchema.parse(input); return flags(config, request, '\\Seen', request.read, 'mail_mark').then(result => ({...result, read:request.read})); };
export async function mailMove(config:Config, input:unknown) {
  const request = mailMoveSchema.parse(input);
  if (REFUSED.test(request.to) || request.to.startsWith('Labels/')) throw new WaypostError('MAIL_MOVE_REFUSED', 'Waypost does not move mail to Trash, Spam, Sent, Drafts, Starred or All Mail, and labels are applied with mail_label. Choose a folder such as Archive or Folders/<name>.');
  if (request.to === request.mailbox) throw new WaypostError('INPUT_INVALID', 'The destination is the same mailbox.');
  organizer(config, request.uids.length, request.confirm);
  const result = await imap(config, async client => {
    await mailboxExists(client, request.to);
    return writable(client, request.mailbox, async () => {
      const {uids, missing} = await present(client, request.uids);
      const moved = await client.messageMove(uids.join(','), request.to, {uid:true});
      if (!moved) throw new WaypostError('MAIL_UPDATE_FAILED', 'Bridge did not move the messages. Nothing was retried.');
      return {uids, missing, newUids:moved.uidMap ? Object.fromEntries(moved.uidMap) : null};
    });
  });
  await record(config, {action:'mail_move', mailbox:request.mailbox, to:request.to, uids:result.uids});
  return {mailbox:request.mailbox, to:request.to, moved:result.uids, missing:result.missing, newUids:result.newUids, note:'UIDs change when mail moves; use newUids or list the destination again.'};
}
export async function mailLabel(config:Config, input:unknown) {
  const request = mailLabelSchema.parse(input);
  organizer(config, request.uids.length, request.confirm);
  const label = request.label.startsWith('Labels/') ? request.label : `Labels/${request.label}`;
  const result = await imap(config, async client => {
    await mailboxExists(client, label);
    return writable(client, request.mailbox, async () => {
      const {uids, missing} = await present(client, request.uids);
      // Bridge applies a label when a message is copied into its Labels/ folder; the original stays where it is.
      const copied = await client.messageCopy(uids.join(','), label, {uid:true});
      if (!copied) throw new WaypostError('MAIL_UPDATE_FAILED', 'Bridge did not apply the label. Nothing was retried.');
      return {uids, missing};
    });
  });
  await record(config, {action:'mail_label', mailbox:request.mailbox, label, uids:result.uids});
  return {mailbox:request.mailbox, label, labeled:result.uids, missing:result.missing, removeLabel:'Remove labels in Proton Mail; Waypost only adds them.'};
}
function headerValues(value:unknown):string[] {
  if (value === undefined || value === null) return [];
  if (Array.isArray(value)) return value.flatMap(headerValues);
  if (value instanceof Date) return [value.toUTCString()];
  if (typeof value === 'object' && 'text' in value && typeof (value as {text:unknown}).text === 'string') return [(value as {text:string}).text];
  if (typeof value === 'object' && 'value' in value && typeof (value as {value:unknown}).value === 'string') return [(value as {value:string}).value];
  return [String(value)];
}
export async function mailTriage(config:Config, input:unknown) {
  const request = mailTriageSchema.parse(input);
  const path = config.mail?.triageSieve;
  if (!path) throw new WaypostError('SIEVE_UNCONFIGURED', 'Save a copy of the Proton filter (Settings → Filters → the filter → Edit in Sieve) to a private file and set mail.triageSieve to its absolute path.');
  const metadata = await stat(path).catch(() => null);
  if (!metadata?.isFile() || metadata.size > 64 * 1024) throw new WaypostError('SIEVE_UNCONFIGURED', 'mail.triageSieve must point to a Sieve file no larger than 64 KiB.');
  const script = await readFile(path, 'utf8');
  if (config.mailHelper) throw new WaypostError('MAIL_HELPER_UNSUPPORTED', 'Triage needs direct Bridge to read full headers.');
  const message = await imap(config, client => examine(client, request.mailbox, async () => {
    const found = await client.fetchOne(String(request.uid), {uid:true, size:true, headers:true}, {uid:true});
    if (!found || !found.headers) throw new WaypostError('MAIL_NOT_FOUND', `UID ${request.uid} is not in ${JSON.stringify(request.mailbox)}.`);
    return {headers:found.headers, size:found.size ?? 0};
  }));
  const parsed = await simpleParser(message.headers, {skipHtmlToText:true, skipTextToHtml:true, skipImageLinks:true});
  const headers = new Map<string, string[]>(), addresses = new Map<string, string[]>();
  for (const [key, value] of parsed.headers) headers.set(key.toLowerCase(), headerValues(value).map(item => item.slice(0, 2000)));
  for (const key of ['from','to','cc','bcc','reply-to','sender']) {
    const value = parsed.headers.get(key) as AddressObject | AddressObject[] | undefined;
    const list = (Array.isArray(value) ? value : value ? [value] : []).flatMap(item => item.value.flatMap(entry => entry.address ? [entry.address] : (entry.group ?? []).flatMap(member => member.address ? [member.address] : [])));
    if (list.length) addresses.set(key, list.slice(0, 50).map(item => item.slice(0, 2000)));
  }
  const result = evaluateSieve(script, {headers, addresses, size:message.size});
  const starred = result.flags.some(flag => flag.toLowerCase() === '\\flagged'), read = result.flags.some(flag => flag.toLowerCase() === '\\seen');
  const where = result.folders.length ? result.folders.join(', ') : result.implicitKeep ? 'stays in its current folder' : 'is discarded';
  return {mailbox:request.mailbox, uid:request.uid, wouldStar:starred, wouldMarkRead:read, fileInto:result.folders, keep:result.implicitKeep, stopped:result.stopped, matchedRules:result.matched.slice(0,20), actions:result.actions, unsupported:result.unsupported,
    explanation:`${starred ? 'Starred' : 'Not starred'}${read ? ', marked read' : ''}; ${result.folders.length ? `filed into ${where}` : where}.${result.unsupported.length ? ' Some parts of the filter were not evaluated: ' + result.unsupported.join(', ') + '.' : ''}`,
    evaluatedLocally:true, changedMail:false, note:'This reports what the saved copy of the filter does. Proton runs the live filter when mail arrives; keep the copy in sync with Proton.'};
}
export const mailOrganizeTools = [
  defineTool({name:'mail_flag', title:'Star or unstar mail', description:'Star (\\Flagged) or unstar messages by UID. Off unless mail.organizeEnabled; every call needs confirm: true. Direct Bridge only.', schema:mailFlagSchema, readOnly:false, destructive:false, handler:mailFlag}),
  defineTool({name:'mail_mark', title:'Mark mail read or unread', description:'Set or clear \\Seen on messages by UID. Off unless mail.organizeEnabled; every call needs confirm: true.', schema:mailMarkSchema, readOnly:false, destructive:false, handler:mailMark}),
  defineTool({name:'mail_move', title:'Move mail to a folder', description:'Move messages to an existing folder such as Archive or Folders/<name>. Refuses Trash, Spam, Sent, Drafts, Starred and All Mail; Waypost has no delete. Off unless mail.organizeEnabled; every call needs confirm: true.', schema:mailMoveSchema, readOnly:false, destructive:false, handler:mailMove}),
  defineTool({name:'mail_label', title:'Add a label to mail', description:'Add an existing Proton label to messages without moving them. Off unless mail.organizeEnabled; every call needs confirm: true.', schema:mailLabelSchema, readOnly:false, destructive:false, handler:mailLabel}),
  defineTool({name:'mail_triage', title:'Explain the mail filter', description:'Report what the user\'s saved Proton Sieve filter would do to one message (star, mark read, file into a folder or label) and which rules matched. Read-only; never changes mail.', schema:mailTriageSchema, readOnly:true, destructive:false, handler:mailTriage}),
];
