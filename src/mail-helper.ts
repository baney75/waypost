import { lstat } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join } from 'node:path';
import { simpleParser } from 'mailparser';
import { z } from 'zod';
import type { Config } from './config.js';
import { WaypostError } from './errors.js';
import { runExecutable } from './process.js';
import { trustedExistingDirectory } from './artifacts.js';

// Python JSON can escape one supplementary character as two six-byte escapes.
const MAX_OUTPUT = 256 * 1024;
const pythonText = (max:number) => z.string().max(max * 2).refine(value => Array.from(value).length <= max);
const header = (max:number) => pythonText(max).refine(value => !/[\x00-\x1f\x7f]/.test(value));
const uid = z.string().regex(/^[1-9][0-9]{0,9}$/).transform(Number).pipe(z.number().int().min(1).max(4294967295));
const headers = z.object({uid, date:header(128), from:header(320), subject:header(500), message_id:header(255)}).strict();
const checkResponse = z.object({state:z.literal('ready'), scope:z.literal('local_bridge_imap'), read_only:z.literal(true)}).strict();
const listResponse = z.object({mailbox:header(256).min(1), messages:z.array(headers).max(20), read_only:z.literal(true)}).strict();
const readResponse = headers.extend({
  body:pythonText(12000).nullable(), body_format:z.enum(['plain','html_to_text','unavailable']),
  partial_fetch:z.boolean(), attachments_included:z.literal(false), flags_changed:z.literal(false),
}).strict().refine(value => value.body_format === 'unavailable' ? value.body === null : value.body !== null);

function invalidResponse():never {
  throw new WaypostError('MAIL_HELPER_RESPONSE', 'The Mail helper returned an invalid or unexpected response. Check its read-only check/recent/read contract.');
}
async function invoke<S extends z.ZodType>(config:Config, args:string[], schema:S):Promise<z.output<S>> {
  const executable = config.mailHelper?.executable;
  if (!executable) throw new WaypostError('MAIL_UNCONFIGURED', 'Configure a Mail helper executable first.');
  // Only the local owner may choose executable code; shared writable executables
  // are rejected by runExecutable. No SSH host or credential is supplied here.
  let approved:string;
  try {
    approved=join(await trustedExistingDirectory(dirname(executable)),basename(executable));
    const metadata = await lstat(approved);
    if (!isAbsolute(executable) || !metadata.isFile() || !process.getuid || metadata.uid !== process.getuid()) throw new Error('owner');
  } catch { throw new WaypostError('MAIL_HELPER_EXECUTABLE', 'The Mail helper must be an absolute path to an executable owned by the current user.'); }
  const output = await runExecutable(approved,args,config.timeoutMs,MAX_OUTPUT);
  let value:unknown;
  try { value = JSON.parse(output); } catch { return invalidResponse(); }
  const parsed = schema.safeParse(value);
  if (!parsed.success) return invalidResponse();
  return parsed.data;
}
function boundedText(value:string, max:number) {
  return value.slice(0,max).replace(/[\uD800-\uDBFF]$/u,'');
}
async function normalizedHeaders(message:z.output<typeof headers>) {
  // Parse a bounded, control-free From header only. No body, links or assets are
  // passed to the MIME parser, and missing helper metadata remains explicit.
  const parsed = await simpleParser(`From: ${message.from}\r\n\r\n`,{skipHtmlToText:true,skipTextToHtml:true,skipImageLinks:true});
  const date = message.date ? new Date(message.date) : null;
  return {
    uid:message.uid, subject:message.subject,
    from:(parsed.from?.value ?? []).slice(0,50).map(value => ({name:boundedText(value.name ?? '',300),address:boundedText(value.address ?? '',254)})),
    to:null, date:date && Number.isFinite(date.getTime()) ? date.toISOString() : null,
    messageId:message.message_id,
  };
}
export async function helperMailDoctor(config:Config) {
  await invoke(config,['check'],checkResponse);
  return {imapAuthenticated:true, smtpAuthenticated:null, mailboxRead:false, tls:'Helper-managed Bridge TLS; consult the configured helper', localBridge:false, helper:true, readOnly:true};
}
export async function helperMailList(config:Config, query:{mailbox:string;limit:number}) {
  const result = await invoke(config,['recent',`--mailbox=${query.mailbox}`,`--limit=${query.limit}`],listResponse);
  if (result.mailbox !== query.mailbox || result.messages.length > query.limit || new Set(result.messages.map(message => message.uid)).size !== result.messages.length) return invalidResponse();
  const messages = await Promise.all(result.messages.map(async message => ({...await normalizedHeaders(message),bytes:null,seen:null})));
  return {mailbox:result.mailbox, messages, readOnly:true, bodyFetched:false, helper:true};
}
export async function helperMailRead(config:Config, query:{mailbox:string;uid:number}) {
  const result = await invoke(config,['read',String(query.uid),`--mailbox=${query.mailbox}`],readResponse);
  if (result.uid !== query.uid) return invalidResponse();
  // Python counts code points; Waypost returns at most 12,000 UTF-16 units.
  // The helper cannot report whether its body was clipped, so also disclose the
  // exact text boundary rather than guessing about completeness.
  const textLimited = (result.body?.length ?? 0) > 12000 || Array.from(result.body ?? '').length >= 12000;
  const bodyUnavailable = result.body_format === 'unavailable';
  const partial = result.partial_fetch || textLimited || bodyUnavailable;
  const reason = result.partial_fetch ? 'The helper fetched at most the first 256 KiB of message source; MIME content may be incomplete.'
    : textLimited ? 'Returned text is subject to the 12,000-character limit; more text may be available.'
    : bodyUnavailable ? 'The helper could not extract a message body.' : undefined;
  return {
    mailbox:query.mailbox, ...await normalizedHeaders(result), text:boundedText(result.body ?? '',12000), bodyFormat:result.body_format,
    htmlOnly:null, attachments:null, attachmentsReturned:false, fetchedBytes:null,
    partial, ...(reason ? {reason} : {}), readOnly:true, helper:true,
  };
}
