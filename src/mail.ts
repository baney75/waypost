import { readFile, stat, open } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { createHash, randomUUID, X509Certificate, timingSafeEqual } from 'node:crypto';
import { rootCertificates, type ConnectionOptions } from 'node:tls';
import { ImapFlow } from 'imapflow';
import nodemailer from 'nodemailer';
import { simpleParser } from 'mailparser';
import { z } from 'zod';
import { checkedPath, saveArtifact, type Config } from './config.js';
import { WaypostError } from './errors.js';
import { defineTool } from './tool.js';
import { helperMailDoctor, helperMailList, helperMailRead } from './mail-helper.js';

const MAX_BODY = 256 * 1024;
const MAX_DRAFT = 512 * 1024;
const header = (max:number) => z.string().max(max).refine(value => !/[\x00-\x1f\x7f]/.test(value), 'Header control characters are not permitted.');
const address = header(254).pipe(z.email());
const mailbox = header(256).min(1).default('INBOX').describe('Exact mailbox name; defaults to INBOX.');
export const mailDoctorSchema = z.object({smtp:z.boolean().default(false).describe('Also authenticate SMTP without sending; direct Bridge only.')}).strict();
export const mailListSchema = z.object({mailbox, limit:z.number().int().min(1).max(20).default(10).describe('Most recent headers to read, 1–20.')}).strict();
export const mailReadSchema = z.object({mailbox, uid:z.number().int().min(1).max(4294967295).describe('Message UID returned by mail list, in the same mailbox.')}).strict();
export const mailDraftSchema = z.object({from:address.describe('Sender email address.'), to:z.array(address).min(1).max(20).describe('Recipient email addresses, 1–20.'), cc:z.array(address).max(20).default([]).describe('Copy recipient email addresses, at most 20.'), subject:header(998).describe('Message subject, without line breaks.'), text:z.string().max(120000).refine(value => !value.includes('\0'), 'NUL is not permitted.').describe('Plain-text body, at most 120,000 characters.')}).strict();
export const mailSendSchema = z.object({path:z.string().min(1).describe('Exact EML path returned by mail draft.'), sha256:z.string().regex(/^[a-f0-9]{64}$/).describe('Exact SHA-256 from the reviewed mail draft; no automatic retries.'), confirm:z.boolean().default(false).describe('Set true on this call only after the user approves this exact recipient and message.')}).strict();

async function bridge(config:Config) {
  const mail = config.mail;
  if (!mail) throw new WaypostError('MAIL_UNCONFIGURED', 'Configure a local Proton Bridge connection first.');
  if (!['127.0.0.1','::1'].includes(mail.host)) throw new WaypostError('MAIL_HOST', 'Bridge connections must use an explicit loopback IP.');
  const user = process.env[mail.usernameEnv], pass = process.env[mail.passwordEnv];
  if (!user || !pass) throw new WaypostError('MAIL_CREDENTIALS', 'Bridge-generated client credentials are missing from the configured environment variables. Never supply your Proton account password.');
  let certificate:Buffer, pinned:X509Certificate;
  try {
    const metadata = await stat(mail.certificate);
    if (!metadata.isFile() || metadata.size > 65536) throw new Error('Invalid certificate file');
    certificate = await readFile(mail.certificate);
    const pem = certificate.toString('utf8');
    if (pem.includes('PRIVATE KEY') || (pem.match(/-----BEGIN CERTIFICATE-----/g)?.length ?? 0) !== 1) throw new Error('Expected a public leaf certificate');
    pinned = new X509Certificate(certificate);
  } catch { throw new WaypostError('MAIL_CERTIFICATE', 'Configure a valid public Bridge leaf certificate PEM file.'); }
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
async function imap<T>(config:Config, operation:(client:ImapFlow)=>Promise<T>) {
  const connection = await bridge(config);
  const client = new ImapFlow({host:connection.mail.host, port:connection.mail.imapPort, secure:false, doSTARTTLS:true, auth:connection.auth, tls:connection.tls, logger:false, disableAutoIdle:true, disableCompression:true, connectionTimeout:config.timeoutMs, greetingTimeout:config.timeoutMs, socketTimeout:config.timeoutMs});
  client.on('error', () => { /* Operation errors are returned through the awaited command, without credentials or server text. */ });
  try { await client.connect(); return await operation(client); }
  catch(error) {
    if (error instanceof WaypostError) throw error;
    throw new WaypostError('MAIL_CONNECTION', 'Bridge IMAP authentication or operation failed. Check the local listener, client credentials and pinned certificate.');
  } finally { client.close(); }
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
    catch { throw new WaypostError('MAIL_SMTP', 'Bridge SMTP authentication failed. Check its local listener, credentials and pinned certificate.'); }
    finally { transport.close(); }
  }
  return {imapAuthenticated:true, smtpAuthenticated:options.smtp ? true : null, mailboxRead:false, tls:'STARTTLS with pinned leaf certificate', localBridge:true};
}
function safeAddresses(values: {name?:string | undefined; address?:string | undefined}[] | undefined) {
  return (values ?? []).slice(0,50).map(value => ({name:(value.name ?? '').slice(0,300), address:(value.address ?? '').slice(0,254)}));
}
function safeDate(value:Date | string | undefined) {
  if (!value) return null;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}
export async function mailList(config:Config, input:unknown) {
  const query = mailListSchema.parse(input);
  if (config.mailHelper) return helperMailList(config,query);
  return imap(config, async client => {
    const lock = await client.getMailboxLock(query.mailbox,{readOnly:true});
    try {
      const count = client.mailbox ? client.mailbox.exists : 0;
      const messages = [];
      if (count) for await (const message of client.fetch(`${Math.max(1,count-query.limit+1)}:${count}`,{uid:true,envelope:true,size:true,flags:true})) {
        messages.push({uid:message.uid, subject:(message.envelope?.subject ?? '').slice(0,1200), from:safeAddresses(message.envelope?.from), to:safeAddresses(message.envelope?.to), date:safeDate(message.envelope?.date), bytes:message.size ?? null, seen:message.flags?.has('\\Seen') ?? false});
      }
      return {mailbox:query.mailbox, messages:messages.reverse(), readOnly:true, bodyFetched:false};
    } finally { lock.release(); }
  });
}
export async function mailRead(config:Config, input:unknown) {
  const query = mailReadSchema.parse(input);
  if (config.mailHelper) return helperMailRead(config,query);
  return imap(config, async client => {
    const lock = await client.getMailboxLock(query.mailbox,{readOnly:true});
    try {
      const message = await client.fetchOne(query.uid,{uid:true,size:true,source:{start:0,maxLength:MAX_BODY}},{uid:true});
      if (!message || !message.source) throw new WaypostError('MAIL_NOT_FOUND', 'Message UID was not found in the selected mailbox.');
      if (message.source.length > MAX_BODY) throw new WaypostError('MAIL_SIZE', 'Bridge returned more than the requested body limit.');
      const parsed = await simpleParser(message.source,{skipHtmlToText:true, skipTextToHtml:true, skipImageLinks:true, maxHtmlLengthToParse:MAX_BODY});
      // HTML remains inert: never return active markup, follow URLs, or load remote images.
      const htmlOnly = !parsed.text && Boolean(parsed.html);
      const plain = parsed.text || (typeof parsed.html === 'string' ? parsed.html.replace(/<script\b[^>]*>[\s\S]*?<\/script\s*>/gi,'').replace(/<style\b[^>]*>[\s\S]*?<\/style\s*>/gi,'').replace(/<[^>]*>/g,' ').replace(/\s+/g,' ').trim() : '');
      const bodyPartial = message.size === undefined ? message.source.length >= MAX_BODY : message.size > message.source.length;
      return {mailbox:query.mailbox, uid:message.uid, subject:(parsed.subject ?? '').slice(0,1200), from:safeAddresses(parsed.from?.value), to:safeAddresses(Array.isArray(parsed.to) ? parsed.to.flatMap(value => value.value) : parsed.to?.value), date:parsed.date?.toISOString() ?? null, text:plain.slice(0,12000), htmlOnly, attachments:parsed.attachments.length, attachmentsReturned:false, fetchedBytes:message.source.length, partial:bodyPartial || plain.length > 12000, ...(bodyPartial ? {reason:'Only the first 256 KiB of message source was fetched; MIME content may be incomplete.'} : plain.length > 12000 ? {reason:'Returned text is limited to 12,000 characters.'} : {}), readOnly:true};
    } finally { lock.release(); }
  });
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
  defineTool({name:'mail_list', title:'List mail headers', description:'Read at most 20 headers in an EXAMINE mailbox, without flag updates.', schema:mailListSchema, readOnly:true, destructive:false, handler:mailList}),
  defineTool({name:'mail_read', title:'Read one message', description:'Read one UID using BODY.PEEK with at most 256 KiB fetched and 12,000 characters returned. Helper metadata that is unavailable is null. No external content or attachments are returned.', schema:mailReadSchema, readOnly:true, destructive:false, handler:mailRead}),
  defineTool({name:'mail_draft', title:'Prepare local mail draft', description:'Save a local EML artifact and digest. It is not sent or stored in a mailbox.', schema:mailDraftSchema, readOnly:false, destructive:false, handler:mailDraft}),
  defineTool({name:'mail_send', title:'Submit prepared mail', description:'Requires sendEnabled policy, exact prepared EML path and SHA256, and confirm: true on each call. Makes one SMTP submission with no retries. Call only for an explicitly authorized recipient and purpose.', schema:mailSendSchema, readOnly:false, destructive:true, handler:mailSend}),
];
