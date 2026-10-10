import { readFile, stat, open } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { constants } from 'node:fs';
import { createHash, randomUUID, X509Certificate, timingSafeEqual } from 'node:crypto';
import { rootCertificates, type ConnectionOptions } from 'node:tls';
import { ImapFlow, type MessageStructureObject, type FetchMessageObject, type SearchObject } from 'imapflow';
import nodemailer from 'nodemailer';
import { simpleParser, type AddressObject } from 'mailparser';
import { convert } from 'html-to-text';
import { z } from 'zod';
import { checkedPath, saveArtifact, type Config } from './config.js';
import { WaypostError } from './errors.js';
import { defineTool } from './tool.js';
import { ensureArtifactsDirectory } from './artifacts.js';
import { helperMailDoctor, helperMailList, helperMailRead } from './mail-helper.js';

const MAX_BODY = 256 * 1024;
const MAX_DRAFT = 512 * 1024;
const MAX_ATTACHMENT = 25 * 1024 * 1024;
const DEFAULT_TEXT = 12000;
const header = (max:number) => z.string().max(max).refine(value => !/[\x00-\x1f\x7f]/.test(value), 'Header control characters are not permitted.');
const address = header(254).pipe(z.email());
const mailbox = header(256).min(1).default('INBOX').describe('Exact mailbox name from mail_mailboxes; defaults to INBOX. Proton folders are "Folders/<name>", labels are "Labels/<name>", and "All Mail" holds everything.');
const searchText = (what:string) => header(200).min(1).describe(what);
export const mailDoctorSchema = z.object({smtp:z.boolean().default(false).describe('Also authenticate SMTP without sending; direct Bridge only.')}).strict();
const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD.').describe('Calendar day, YYYY-MM-DD.');
const uidSchema = z.number().int().min(1).max(4294967295);
export const mailListSchema = z.object({
  mailbox,
  limit:z.number().int().min(1).max(50).default(10).describe('Headers to return per page, 1–50, newest first.'),
  from:searchText('Only messages whose From contains this text, such as an address or domain.').optional(),
  to:searchText('Only messages whose To contains this text.').optional(),
  subject:searchText('Only messages whose subject contains this text.').optional(),
  text:searchText('Only messages whose headers or body contain this text.').optional(),
  unseen:z.boolean().optional().describe('true for unread messages only, false for read messages only.'),
  since:day.optional().describe('Only messages received on or after this day, YYYY-MM-DD.'),
  before:day.optional().describe('Only messages received before this day, YYYY-MM-DD.'),
  beforeUid:uidSchema.optional().describe('Page cursor: pass nextBeforeUid from the previous result to get older messages.'),
  uidValidity:z.string().regex(/^\d{1,20}$/).optional().describe('Required with beforeUid: the uidValidity from the previous page. A changed value means the mailbox was rebuilt and the cursor is stale.'),
}).strict().refine(value => !value.beforeUid || value.uidValidity !== undefined, {message:'Pass uidValidity from the previous page together with beforeUid.', path:['uidValidity']});
export const mailMailboxesSchema = z.object({counts:z.boolean().default(false).describe('Also return message and unread counts. Slower on large accounts.')}).strict();
export const mailReadSchema = z.object({
  mailbox,
  uid:uidSchema.describe('Message UID returned by mail_list, in the same mailbox.'),
  textOffset:z.number().int().min(0).max(1000000).default(0).describe('Character offset into the body text; pass nextTextOffset to continue a long message.'),
  maxChars:z.number().int().min(100).max(50000).default(DEFAULT_TEXT).describe('Maximum body characters to return, 100–50,000.'),
}).strict();
export const mailThreadSchema = z.object({
  mailbox,
  uid:uidSchema.describe('UID of any message in the conversation.'),
  limit:z.number().int().min(1).max(50).default(20).describe('Maximum related messages to return, 1–50.'),
}).strict();
export const mailAttachmentSchema = z.object({
  mailbox,
  uid:uidSchema.describe('Message UID that holds the attachment.'),
  part:z.string().regex(/^[1-9]\d{0,3}(?:\.[1-9]\d{0,3}){0,9}$/, 'Use a MIME part number such as "2" or "1.2" from mail_read attachments.').describe('MIME part number from mail_read attachments[].part.'),
}).strict();
export const mailDraftSchema = z.object({from:address.describe('Sender email address.'), to:z.array(address).min(1).max(20).describe('Recipient email addresses, 1–20.'), cc:z.array(address).max(20).default([]).describe('Copy recipient email addresses, at most 20.'), subject:header(998).describe('Message subject, without line breaks.'), text:z.string().max(120000).refine(value => !value.includes('\0'), 'NUL is not permitted.').describe('Plain-text body, at most 120,000 characters.')}).strict();
export const mailSendSchema = z.object({path:z.string().min(1).describe('Exact EML path returned by mail draft.'), sha256:z.string().regex(/^[a-f0-9]{64}$/).describe('Exact SHA-256 from the reviewed mail draft; no automatic retries.'), confirm:z.boolean().default(false).describe('Set true on this call only after the user approves this exact recipient and message.')}).strict();

async function bridge(config:Config) {
  const mail = config.mail;
  if (!mail) throw new WaypostError('MAIL_UNCONFIGURED', 'Mail is not configured. Ask the user to run: waypost connect mail --certificate /path/to/bridge-cert.pem (direct Bridge) or --helper /path/to/helper.');
  if (!['127.0.0.1','::1'].includes(mail.host)) throw new WaypostError('MAIL_HOST', 'Bridge connections must use an explicit loopback IP.');
  const user = process.env[mail.usernameEnv], pass = process.env[mail.passwordEnv];
  if (!user || !pass) throw new WaypostError('MAIL_CREDENTIALS', `Bridge credentials are missing: set ${mail.usernameEnv} and ${mail.passwordEnv} in the environment that launches Waypost, using the username and password Bridge shows for this account. Never use the Proton account password.`);
  let certificate:Buffer, pinned:X509Certificate;
  try {
    const metadata = await stat(mail.certificate);
    if (!metadata.isFile() || metadata.size > 65536) throw new Error('Invalid certificate file');
    certificate = await readFile(mail.certificate);
    const pem = certificate.toString('utf8');
    if (pem.includes('PRIVATE KEY') || (pem.match(/-----BEGIN CERTIFICATE-----/g)?.length ?? 0) !== 1) throw new Error('Expected a public leaf certificate');
    pinned = new X509Certificate(certificate);
  } catch { throw new WaypostError('MAIL_CERTIFICATE', `The pinned Bridge certificate at ${mail.certificate} is missing or invalid. Export it again from Bridge (Settings → Advanced → Export TLS certificates) and rerun waypost connect mail --certificate.`); }
  const tls:ConnectionOptions = {
    minVersion:'TLSv1.2', rejectUnauthorized:true, ca:[...rootCertificates, certificate],
    checkServerIdentity:(_hostname, peer) => {
      // The explicitly approved leaf is the server identity, including Bridge self-signed certificates.
      // CA/expiry verification remains enabled; no hostname fallback can bypass this exact pin.
      if (!peer.raw || peer.raw.length !== pinned.raw.length || !timingSafeEqual(peer.raw,pinned.raw)) return new Error('Bridge certificate pin mismatch');
      return undefined;
    },
  };
  return {mail, auth:{user, pass}, tls};
}
type ImapFailure = Error & {code?:string; authenticationFailed?:boolean; mailboxMissing?:boolean; serverResponseCode?:string; responseStatus?:string};
// Translate transport failures into codes an agent can act on, without server text or credentials.
export function imapError(error:unknown, mail:{host:string; imapPort:number}, mailboxName?:string):WaypostError {
  if (error instanceof WaypostError) return error;
  const failure = (error ?? {}) as ImapFailure;
  const message = String(failure.message ?? '');
  if (failure.code === 'ECONNREFUSED') return new WaypostError('MAIL_BRIDGE_UNREACHABLE', `Nothing is listening on ${mail.host}:${mail.imapPort}. Start Proton Mail Bridge and check its IMAP port in Bridge's mailbox configuration.`);
  if (failure.authenticationFailed || failure.serverResponseCode === 'AUTHENTICATIONFAILED') return new WaypostError('MAIL_AUTH', 'Bridge rejected the IMAP username or password. Use the Bridge-generated credentials for this account, not the Proton account password.');
  if (failure.mailboxMissing || failure.serverResponseCode === 'NONEXISTENT') return new WaypostError('MAIL_MAILBOX_NOT_FOUND', `Mailbox ${JSON.stringify(mailboxName ?? '')} does not exist. Call mail_mailboxes for exact names; Proton folders are "Folders/<name>" and labels are "Labels/<name>".`);
  if (/pin mismatch|certificate|self[- ]signed|TLS|SSL/i.test(message) || /^ERR_TLS|^CERT_|DEPTH_ZERO/.test(failure.code ?? '')) return new WaypostError('MAIL_TLS', 'TLS failed: the server certificate does not match the pinned Bridge certificate, or STARTTLS is off. Re-export the certificate from Bridge, rerun waypost connect mail --certificate, and set Bridge connection mode to STARTTLS.');
  if (/timeout/i.test(message) || /TIMEOUT/i.test(failure.code ?? '')) return new WaypostError('MAIL_TIMEOUT', 'Bridge did not answer in time. Check that Bridge is running and finished syncing, then retry.');
  return new WaypostError('MAIL_CONNECTION', 'Bridge IMAP operation failed. Run waypost mail doctor to check the listener, credentials and pinned certificate.');
}
export async function imap<T>(config:Config, operation:(client:ImapFlow)=>Promise<T>) {
  const connection = await bridge(config);
  const client = new ImapFlow({host:connection.mail.host, port:connection.mail.imapPort, secure:false, doSTARTTLS:true, auth:connection.auth, tls:connection.tls, logger:false, disableAutoIdle:true, disableCompression:true, connectionTimeout:config.timeoutMs, greetingTimeout:config.timeoutMs, socketTimeout:config.timeoutMs});
  client.on('error', () => { /* Operation errors are returned through the awaited command, without credentials or server text. */ });
  try { await client.connect(); return await operation(client); }
  catch(error) { throw imapError(error, connection.mail); }
  finally { client.close(); }
}
export async function examine<T>(client:ImapFlow, name:string, operation:()=>Promise<T>):Promise<T> {
  let lock;
  try { lock = await client.getMailboxLock(name,{readOnly:true}); }
  catch (error) { throw imapError(error,{host:'',imapPort:0},name); }
  try { return await operation(); } finally { lock.release(); }
}
async function smtp(config:Config) {
  const connection = await bridge(config);
  return nodemailer.createTransport({host:connection.mail.host, port:connection.mail.smtpPort, secure:false, requireTLS:true, forceAuth:true, auth:connection.auth, tls:connection.tls, logger:false, debug:false, pool:false, connectionTimeout:config.timeoutMs, greetingTimeout:config.timeoutMs, socketTimeout:config.timeoutMs, disableFileAccess:true, disableUrlAccess:true});
}
export async function mailDoctor(config:Config, input:unknown) {
  const options = mailDoctorSchema.parse(input);
  if (config.mailHelper) {
    if (options.smtp) throw new WaypostError('MAIL_HELPER_READ_ONLY', 'The configured Mail helper supports IMAP reads only. SMTP authentication and sending are unavailable.');
    return helperMailDoctor(config);
  }
  await imap(config, async () => undefined);
  if (options.smtp) {
    const transport = await smtp(config);
    try { await transport.verify(); }
    catch (error) {
      const code = (error as {code?:string})?.code;
      if (code === 'ESOCKET' && /ECONNREFUSED/.test(String((error as Error).message))) throw new WaypostError('MAIL_BRIDGE_UNREACHABLE', `Nothing is listening for SMTP on ${config.mail?.host}:${config.mail?.smtpPort}. Check Bridge's SMTP port.`);
      throw new WaypostError('MAIL_SMTP', 'Bridge SMTP authentication failed. Check its local listener, credentials and pinned certificate.');
    }
    finally { transport.close(); }
  }
  return {imapAuthenticated:true, smtpAuthenticated:options.smtp ? true : null, mailboxRead:false, tls:'STARTTLS with pinned leaf certificate', localBridge:true};
}
type Address = {name?:string | undefined; address?:string | undefined};
function safeAddresses(values: Address[] | undefined) {
  return (values ?? []).slice(0,50).map(value => ({name:(value.name ?? '').slice(0,300), address:(value.address ?? '').slice(0,254)}));
}
function parsedAddresses(value:AddressObject | AddressObject[] | undefined) {
  return safeAddresses(Array.isArray(value) ? value.flatMap(item => item.value) : value?.value);
}
function safeDate(value:Date | string | undefined) {
  if (!value) return null;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}
type Attachment = {part:string; filename:string | null; contentType:string; bytes:number | null; inline:boolean};
// Walk BODYSTRUCTURE; anything that is not the readable text/plain or text/html body is an attachment.
export function attachmentsOf(node:MessageStructureObject | undefined):Attachment[] {
  const found:Attachment[] = [];
  const walk = (current:MessageStructureObject) => {
    if (found.length >= 100) return;
    const type = (current.type ?? 'application/octet-stream').toLowerCase();
    // A forwarded message is one attachment, even though BODYSTRUCTURE also describes its parts.
    if (current.childNodes?.length && type !== 'message/rfc822') { for (const child of current.childNodes) walk(child); return; }
    const filename = current.dispositionParameters?.filename ?? current.parameters?.name ?? null;
    const disposition = (current.disposition ?? '').toLowerCase();
    if ((type === 'text/plain' || type === 'text/html') && disposition !== 'attachment' && !filename) return;
    found.push({part:current.part ?? '1', filename:filename ? filename.slice(0,255) : null, contentType:type.slice(0,127), bytes:typeof current.size === 'number' ? current.size : null, inline:disposition === 'inline'});
  };
  if (node) walk(node);
  return found;
}
function headerRow(message:FetchMessageObject, mailboxName?:string) {
  return {
    ...(mailboxName ? {mailbox:mailboxName} : {}),
    uid:message.uid, messageId:message.envelope?.messageId ?? null, subject:(message.envelope?.subject ?? '').slice(0,1200),
    from:safeAddresses(message.envelope?.from), to:safeAddresses(message.envelope?.to), date:safeDate(message.envelope?.date),
    bytes:message.size ?? null, seen:message.flags?.has('\\Seen') ?? false, attachments:message.bodyStructure ? attachmentsOf(message.bodyStructure).filter(item => !item.inline).length : null,
  };
}
const headerQuery = {uid:true, envelope:true, size:true, flags:true, bodyStructure:true} as const;
async function fetchRows(client:ImapFlow, uids:number[], mailboxName?:string) {
  if (!uids.length) return [];
  const rows = [];
  for await (const message of client.fetch(uids.join(','),headerQuery,{uid:true})) rows.push(headerRow(message,mailboxName));
  return rows;
}
const searched = (query:z.output<typeof mailListSchema>) => Boolean(query.from || query.to || query.subject || query.text || query.unseen !== undefined || query.since || query.before);
export async function mailList(config:Config, input:unknown) {
  const query = mailListSchema.parse(input);
  if (config.mailHelper) {
    if (query.to || query.subject || query.text || query.unseen !== undefined || query.beforeUid || query.uidValidity || query.limit > 20) throw new WaypostError('MAIL_HELPER_UNSUPPORTED', 'The Mail helper supports only mailbox, limit (at most 20), from, since and before. Use direct Bridge for other filters and paging.');
    const helperQuery: {mailbox:string; limit:number; from?:string; since?:string; before?:string} = {mailbox:query.mailbox, limit:query.limit};
    if (query.from) helperQuery.from = query.from;
    if (query.since) helperQuery.since = query.since;
    if (query.before) helperQuery.before = query.before;
    return helperMailList(config, helperQuery);
  }
  const filtered = searched(query);
  return imap(config, client => examine(client, query.mailbox, async () => {
    const uidValidity = client.mailbox && client.mailbox.uidValidity !== undefined ? String(client.mailbox.uidValidity) : null;
    if (query.beforeUid && query.uidValidity !== uidValidity) throw new WaypostError('MAIL_CURSOR_STALE', 'The mailbox changed since the previous page (UIDVALIDITY differs), so beforeUid no longer points to the same message. Start again without beforeUid.');
    const page = (rows:ReturnType<typeof headerRow>[], total:number, oldest:number | null) => ({mailbox:query.mailbox, messages:rows, total, nextBeforeUid:oldest, uidValidity, readOnly:true, bodyFetched:false, searched:filtered});
    // total always counts every message in the mailbox that matches the filters, ignoring the cursor.
    if (!filtered && !query.beforeUid) {
      // Fast path: newest messages by sequence number, no SEARCH of the whole mailbox.
      const total = client.mailbox ? client.mailbox.exists : 0;
      const rows = [];
      if (total) for await (const message of client.fetch(`${Math.max(1,total-query.limit+1)}:${total}`,headerQuery)) rows.push(headerRow(message));
      rows.sort((a,b) => b.uid-a.uid);
      return page(rows, total, total > rows.length && rows.length ? rows[rows.length-1]!.uid : null);
    }
    const criteria:SearchObject = {};
    if (query.from) criteria.from = query.from;
    if (query.to) criteria.to = query.to;
    if (query.subject) criteria.subject = query.subject;
    if (query.text) criteria.text = query.text;
    if (query.unseen !== undefined) criteria.seen = !query.unseen;
    if (query.since) criteria.since = new Date(`${query.since}T00:00:00Z`);
    if (query.before) criteria.before = new Date(`${query.before}T00:00:00Z`);
    if (!Object.keys(criteria).length) criteria.all = true;
    const found = await client.search(criteria,{uid:true});
    if (!found) throw new WaypostError('MAIL_SEARCH','Bridge rejected the mailbox search. Simplify the filters and retry.');
    const matches = [...new Set(found)].sort((a,b) => a-b);
    const older = query.beforeUid ? matches.filter(uid => uid < query.beforeUid!) : matches;
    const uids = older.slice(-query.limit);
    const rows = await fetchRows(client, uids);
    rows.sort((a,b) => b.uid-a.uid);
    return page(rows, matches.length, older.length > uids.length && uids.length ? uids[0]! : null);
  }));
}
export async function mailMailboxes(config:Config, input:unknown) {
  const options = mailMailboxesSchema.parse(input);
  if (config.mailHelper) throw new WaypostError('MAIL_HELPER_UNSUPPORTED', 'The Mail helper cannot list mailboxes. Use INBOX or a mailbox name you already know.');
  return imap(config, async client => {
    const listed = await client.list(options.counts ? {statusQuery:{messages:true, unseen:true}} : {});
    const mailboxes = listed.slice(0,500).map(item => ({
      path:item.path.slice(0,256), name:item.name.slice(0,256), specialUse:item.specialUse ?? null, selectable:!item.flags.has('\\Noselect'),
      ...(options.counts ? {messages:item.status?.messages ?? null, unseen:item.status?.unseen ?? null} : {}),
    }));
    return {mailboxes, truncated:listed.length > 500, readOnly:true};
  });
}
// Inert text only: scripts, styles and images (tracking pixels) are dropped, link targets stay as plain text, nothing is fetched.
export function htmlText(html:string):string {
  return convert(html.slice(0,MAX_BODY),{wordwrap:false, selectors:[{selector:'img',format:'skip'},{selector:'script',format:'skip'},{selector:'style',format:'skip'},{selector:'a',options:{hideLinkHrefIfSameAsText:true, ignoreHref:false}},{selector:'table',format:'block'},{selector:'tr',format:'block'},{selector:'td',format:'block'},{selector:'th',format:'block'},...['h1','h2','h3','h4','h5','h6'].map(selector => ({selector,options:{uppercase:false}}))]}).replace(/\n{3,}/g,'\n\n').trim();
}
export async function parseMessage(source:Buffer) {
  return simpleParser(source,{skipHtmlToText:true, skipTextToHtml:true, skipImageLinks:true, maxHtmlLengthToParse:MAX_BODY});
}
export async function mailRead(config:Config, input:unknown) {
  const query = mailReadSchema.parse(input);
  if (config.mailHelper) {
    if (query.textOffset || query.maxChars !== DEFAULT_TEXT) throw new WaypostError('MAIL_HELPER_UNSUPPORTED', 'The Mail helper returns at most the first 12,000 characters. Omit textOffset and maxChars.');
    return helperMailRead(config,{mailbox:query.mailbox, uid:query.uid});
  }
  return imap(config, client => examine(client, query.mailbox, async () => {
    const message = await client.fetchOne(String(query.uid),{uid:true, size:true, flags:true, bodyStructure:true, source:{start:0,maxLength:MAX_BODY}},{uid:true});
    if (!message || !message.source) throw new WaypostError('MAIL_NOT_FOUND', `UID ${query.uid} is not in ${JSON.stringify(query.mailbox)}. UIDs belong to one mailbox; call mail_list on the same mailbox.`);
    if (message.source.length > MAX_BODY) throw new WaypostError('MAIL_SIZE', 'Bridge returned more than the requested body limit.');
    const parsed = await parseMessage(message.source);
    const htmlOnly = !parsed.text && typeof parsed.html === 'string' && parsed.html.length > 0;
    const plain = (parsed.text || (htmlOnly ? htmlText(parsed.html as string) : '')).replace(/\r\n/g,'\n');
    const bodyPartial = message.size === undefined ? message.source.length >= MAX_BODY : message.size > message.source.length;
    const end = query.textOffset + query.maxChars;
    const textLimited = plain.length > end;
    const references = (Array.isArray(parsed.references) ? parsed.references : parsed.references ? [parsed.references] : []).slice(0,50);
    const attachments = attachmentsOf(message.bodyStructure);
    return {
      mailbox:query.mailbox, uid:message.uid, messageId:parsed.messageId ?? null, inReplyTo:parsed.inReplyTo ?? null, references,
      subject:(parsed.subject ?? '').slice(0,1200), from:parsedAddresses(parsed.from), to:parsedAddresses(parsed.to), cc:parsedAddresses(parsed.cc), replyTo:parsedAddresses(parsed.replyTo),
      date:parsed.date?.toISOString() ?? null, seen:message.flags?.has('\\Seen') ?? false,
      text:plain.slice(query.textOffset,end), textLength:plain.length, nextTextOffset:textLimited ? end : null, htmlOnly,
      attachments, attachmentsReturned:false, fetchedBytes:message.source.length,
      partial:bodyPartial || textLimited,
      ...(bodyPartial ? {reason:'Only the first 256 KiB of message source was fetched; later MIME parts may be missing. Attachments can still be saved with mail_attachment.'} : textLimited ? {reason:'More text is available; call mail_read again with textOffset set to nextTextOffset.'} : {}),
      readOnly:true,
    };
  }));
}
const messageIdPattern = /^<[^<>\s"\\]{1,250}>$/;
export async function mailThread(config:Config, input:unknown) {
  const query = mailThreadSchema.parse(input);
  if (config.mailHelper) throw new WaypostError('MAIL_HELPER_UNSUPPORTED', 'The Mail helper cannot search conversations. Use direct Bridge.');
  return imap(config, client => examine(client, query.mailbox, async () => {
    const message = await client.fetchOne(String(query.uid),{uid:true, envelope:true, headers:['references','in-reply-to']},{uid:true});
    if (!message) throw new WaypostError('MAIL_NOT_FOUND', `UID ${query.uid} is not in ${JSON.stringify(query.mailbox)}.`);
    const parsed = await simpleParser(message.headers ?? Buffer.alloc(0),{skipHtmlToText:true, skipTextToHtml:true, skipImageLinks:true});
    const references = Array.isArray(parsed.references) ? parsed.references : parsed.references ? [parsed.references] : [];
    const ids = [...new Set([...references, parsed.inReplyTo ?? '', message.envelope?.messageId ?? ''].filter(id => messageIdPattern.test(id)))].slice(-20);
    const root = references.find(id => messageIdPattern.test(id)) ?? (message.envelope?.messageId && messageIdPattern.test(message.envelope.messageId) ? message.envelope.messageId : undefined);
    let uids = [message.uid];
    if (ids.length) {
      // Related messages carry one of these IDs as Message-ID, or the root in References / In-Reply-To.
      const terms:SearchObject[] = ids.map(id => ({header:{'message-id':id}}));
      if (root) terms.push({header:{references:root}}, {header:{'in-reply-to':root}});
      const own = message.envelope?.messageId;
      if (own && messageIdPattern.test(own)) terms.push({header:{references:own}}, {header:{'in-reply-to':own}});
      const found = await client.search(terms.length === 1 ? terms[0]! : {or:terms},{uid:true});
      if (!found) throw new WaypostError('MAIL_SEARCH','Bridge rejected the conversation search.');
      uids = [...new Set([...found, message.uid])].sort((a,b) => a-b);
    }
    const total = uids.length;
    const rows = await fetchRows(client, uids.slice(-query.limit));
    rows.sort((a,b) => (a.date ?? '').localeCompare(b.date ?? '') || a.uid-b.uid);
    return {mailbox:query.mailbox, rootMessageId:root ?? null, messages:rows, total, partial:total > rows.length, ...(total > rows.length ? {reason:`Showing the newest ${rows.length} of ${total} related messages.`} : {}), scope:'One mailbox. Use mailbox "All Mail" to include sent replies.', readOnly:true};
  }));
}
function safeFilename(name:string | null, part:string) {
  const cleaned = (name ?? '').normalize('NFC').replace(/[^\p{L}\p{N}._ -]/gu,'_').replace(/^[.\s]+/,'').slice(0,80).trim();
  return cleaned || `part-${part.replace(/\./g,'-')}.bin`;
}
export async function mailAttachment(config:Config, input:unknown) {
  const query = mailAttachmentSchema.parse(input);
  if (config.mailHelper) throw new WaypostError('MAIL_HELPER_UNSUPPORTED', 'The Mail helper does not return attachments. Use direct Bridge.');
  return imap(config, client => examine(client, query.mailbox, async () => {
    const message = await client.fetchOne(String(query.uid),{uid:true, bodyStructure:true},{uid:true});
    if (!message) throw new WaypostError('MAIL_NOT_FOUND', `UID ${query.uid} is not in ${JSON.stringify(query.mailbox)}.`);
    const attachment = attachmentsOf(message.bodyStructure).find(item => item.part === query.part);
    if (!attachment) throw new WaypostError('MAIL_ATTACHMENT_NOT_FOUND', `Part ${query.part} is not an attachment of UID ${query.uid}. Use attachments[].part from mail_read.`);
    // Encoded size bounds the decoded size; base64 is about 4/3 larger.
    if (attachment.bytes !== null && attachment.bytes > MAX_ATTACHMENT * 1.4) throw new WaypostError('FILE_LIMIT', 'The attachment exceeds 25 MiB. Save it from Proton Mail instead.');
    const root = await ensureArtifactsDirectory(config.artifactsDir);
    const path = join(root, `attachment-${randomUUID()}-${safeFilename(attachment.filename, query.part)}`);
    const download = await client.download(String(query.uid), query.part, {uid:true, maxBytes:MAX_ATTACHMENT + 1});
    const handle = await open(path, constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW, 0o600);
    const hash = createHash('sha256'); let bytes = 0;
    try {
      for await (const chunk of download.content as AsyncIterable<Buffer>) {
        bytes += chunk.length;
        if (bytes > MAX_ATTACHMENT) throw new WaypostError('FILE_LIMIT', 'The attachment exceeds 25 MiB. The partial file was kept for inspection; save it from Proton Mail instead.');
        hash.update(chunk); await handle.write(chunk);
      }
    } finally { await handle.close(); }
    return {path, filename:attachment.filename, contentType:attachment.contentType, bytes, sha256:hash.digest('hex'), mailbox:query.mailbox, uid:query.uid, part:query.part, flagsChanged:false, note:'Attachment content is untrusted. Do not open or execute it without the user.'};
  }));
}
export async function mailDraft(config:Config, input:unknown) {
  const message = mailDraftSchema.parse(input);
  const transport = nodemailer.createTransport({streamTransport:true, buffer:true, newline:'windows', disableFileAccess:true, disableUrlAccess:true});
  const result = await transport.sendMail({...message, headers:{'X-Waypost-Prepared':'1'}});
  if (!Buffer.isBuffer(result.message) || result.message.length > MAX_DRAFT) throw new WaypostError('MAIL_SIZE', 'Prepared message exceeds 512 KiB.');
  const sha256 = createHash('sha256').update(result.message).digest('hex');
  const path = await saveArtifact(config, `draft-${randomUUID()}.eml`, result.message);
  return {path, sha256, sent:false, storedInMailbox:false, bytes:result.message.length};
}
export async function mailSend(config:Config, input:unknown) {
  const request = mailSendSchema.parse(input);
  if (config.mailHelper) throw new WaypostError('MAIL_HELPER_READ_ONLY', 'The configured Mail helper supports IMAP reads only. Prepare a local draft for review and send it through Proton Mail.');
  if (!config.mail?.sendEnabled) throw new WaypostError('MAIL_SEND_DISABLED', 'Mail sending is disabled by policy. Prepare a local draft instead.');
  if (!request.confirm) throw new WaypostError('CONFIRMATION_REQUIRED', 'Mail send requires confirm: true on this call. Show the user the draft and recipients first.');
  const path = await checkedPath(request.path,config.artifactsDir);
  if (!/^draft-[0-9a-f-]+\.eml$/.test(basename(path))) throw new WaypostError('MAIL_DRAFT', 'Send requires an artifact prepared by mail_draft.');
  const metadata = await stat(path);
  if (!metadata.isFile() || metadata.size > MAX_DRAFT) throw new WaypostError('MAIL_SIZE', 'Prepared mail must be no larger than 512 KiB.');
  const raw = await readFile(path);
  if (raw.length > MAX_DRAFT || createHash('sha256').update(raw).digest('hex') !== request.sha256) throw new WaypostError('MAIL_DIGEST', 'Prepared message digest does not match. Review and prepare the draft again.');
  // Derive the SMTP envelope from the exact hashed message, never an unbound sidecar.
  const prepared = await simpleParser(raw,{skipHtmlToText:true,skipTextToHtml:true,skipImageLinks:true});
  const toAddresses = (value:typeof prepared.to) => Array.isArray(value) ? value.flatMap(item => item.value) : value?.value ?? [];
  if (prepared.headers.get('x-waypost-prepared') !== '1' || prepared.from?.value.length !== 1 || prepared.bcc || prepared.attachments.length) throw new WaypostError('MAIL_DRAFT','Send requires a text draft prepared by mail_draft, with one sender and no hidden recipients or attachments.');
  const envelope = z.object({from:address,to:z.array(address).min(1).max(40)}).parse({from:prepared.from.value[0]?.address,to:[...toAddresses(prepared.to),...toAddresses(prepared.cc)].map(value => value.address)});
  const transport = await smtp(config);
  // Reserve once before SMTP. A failure may follow acceptance, so a digest is never retried automatically.
  let attempt;
  try { attempt = await open(join(config.artifactsDir, `sent-${request.sha256}.attempt`),'wx',0o600); }
  catch (error) {
    transport.close();
    if (error instanceof Error && 'code' in error && error.code === 'EEXIST') throw new WaypostError('MAIL_ALREADY_ATTEMPTED', 'This draft already has a send attempt. Inspect delivery before explicitly preparing another draft.');
    throw new WaypostError('ARTIFACT_WRITE','Could not reserve the send attempt. Check artifact directory permissions.');
  }
  await attempt.close();
  try {
    const result = await transport.sendMail({raw, envelope, disableFileAccess:true, disableUrlAccess:true});
    return {submitted:true, delivered:false, messageId:String(result.messageId ?? ''), accepted:result.accepted.map(String), rejected:result.rejected.map(String), sha256:request.sha256, automaticRetry:false};
  } catch { throw new WaypostError('MAIL_SEND_UNCERTAIN', 'SMTP submission failed; delivery may be uncertain. This digest will not be retried. Inspect the Sent folder before preparing another draft.'); }
  finally { transport.close(); }
}
export const mailTools = [
  defineTool({name:'mail_doctor', title:'Check Bridge authentication', description:'Authenticate to Bridge directly or through a configured read-only helper without reading messages. SMTP checks require the direct Bridge route.', schema:mailDoctorSchema, readOnly:true, destructive:false, handler:mailDoctor}),
  defineTool({name:'mail_mailboxes', title:'List mail folders and labels', description:'List mailbox names to use with other mail tools. Proton folders appear as "Folders/<name>", labels as "Labels/<name>". Direct Bridge only.', schema:mailMailboxesSchema, readOnly:true, destructive:false, handler:mailMailboxes}),
  defineTool({name:'mail_list', title:'Search and list mail headers', description:'Return up to 50 headers, newest first, from one mailbox opened read-only. Filter by from, to, subject, text, unseen, since and before. When nextBeforeUid is not null, pass it as beforeUid, with uidValidity, for the next older page. Does not fetch bodies or change flags.', schema:mailListSchema, readOnly:true, destructive:false, handler:mailList}),
  defineTool({name:'mail_read', title:'Read one message', description:'Read one message by UID without marking it read. Returns sender, recipients, threading IDs, plain text (HTML converted to text), and attachment metadata with part numbers. Long bodies page with textOffset. Attachment bytes are not returned; use mail_attachment.', schema:mailReadSchema, readOnly:true, destructive:false, handler:mailRead}),
  defineTool({name:'mail_thread', title:'Read a conversation', description:'Find messages in the same conversation as one UID using Message-ID, In-Reply-To and References. Searches one mailbox; use "All Mail" to include sent replies. Returns headers only.', schema:mailThreadSchema, readOnly:true, destructive:false, handler:mailThread}),
  defineTool({name:'mail_attachment', title:'Save one attachment locally', description:'Save one attachment (part number from mail_read) as a new file in the local artifacts directory, up to 25 MiB, and return its path and SHA-256. Does not change the message.', schema:mailAttachmentSchema, readOnly:false, destructive:false, handler:mailAttachment}),
  defineTool({name:'mail_draft', title:'Prepare local mail draft', description:'Save a local EML artifact and digest. It is not sent or stored in a mailbox.', schema:mailDraftSchema, readOnly:false, destructive:false, handler:mailDraft}),
  defineTool({name:'mail_send', title:'Submit prepared mail', description:'Off by default. Requires sendEnabled in local config, the exact EML path and SHA-256 from mail_draft, and confirm: true on this call after the user approves the recipients and text. Makes one SMTP submission with no retries.', schema:mailSendSchema, readOnly:false, destructive:true, handler:mailSend}),
];
