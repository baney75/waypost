// Chrome native messaging host for the Waypost browser extension.
// The browser starts this process and talks over stdin/stdout only: no port, no network listener.
// Chrome passes the calling extension's origin as the first argument; only configured IDs are served.
import { z } from 'zod';
import { loadConfig } from './config.js';
import { publicError, WaypostError } from './errors.js';
import { latestVerificationCode } from './codes.js';

const MAX_MESSAGE = 64 * 1024;
const requestSchema = z.object({
  type:z.literal('verification_code'),
  site:z.string().min(1).max(2048),
  notBefore:z.string().datetime().optional(),
}).strict();

export function encode(value:unknown):Buffer {
  const body = Buffer.from(JSON.stringify(value), 'utf8');
  const header = Buffer.alloc(4); header.writeUInt32LE(body.length, 0);
  return Buffer.concat([header, body]);
}
/** Split complete native-messaging frames off the front of a buffer. */
export function decodeFrames(buffer:Buffer):{messages:unknown[]; rest:Buffer} {
  const messages:unknown[] = []; let offset = 0;
  while (buffer.length - offset >= 4) {
    const length = buffer.readUInt32LE(offset);
    if (length > MAX_MESSAGE) throw new WaypostError('NATIVE_MESSAGE_SIZE', 'Native message exceeds 64 KiB.');
    if (buffer.length - offset - 4 < length) break;
    messages.push(JSON.parse(buffer.subarray(offset + 4, offset + 4 + length).toString('utf8')));
    offset += 4 + length;
  }
  return {messages, rest:buffer.subarray(offset)};
}
export function callerId(origin:string | undefined):string | null {
  const match = /^chrome-extension:\/\/([a-p]{32})\/?$/.exec(origin ?? '');
  return match ? match[1]! : null;
}
export async function handleNativeMessage(configPath:string, origin:string | undefined, message:unknown):Promise<unknown> {
  try {
    const config = await loadConfig(configPath);
    const id = callerId(origin);
    if (!id || !config.verificationCodes?.extensionIds.includes(id)) throw new WaypostError('EXTENSION_NOT_ALLOWED', 'This extension is not paired with Waypost. Run: waypost connect browser --extension-id <id>');
    const request = requestSchema.parse(message);
    const data = await latestVerificationCode(config, {site:request.site, ...(request.notBefore ? {notBefore:request.notBefore} : {})}, 'browser');
    return {ok:true, data};
  } catch (error) { return {ok:false, error:publicError(error)}; }
}
export async function runNativeHost(configPath:string, origin:string | undefined):Promise<void> {
  let buffer:Buffer = Buffer.alloc(0);
  for await (const chunk of process.stdin) {
    buffer = Buffer.concat([buffer, chunk as Buffer]);
    let frames;
    try { frames = decodeFrames(buffer); }
    catch (error) { process.stdout.write(encode({ok:false, error:publicError(error)})); return; }
    buffer = Buffer.from(frames.rest);
    for (const message of frames.messages) process.stdout.write(encode(await handleNativeMessage(configPath, origin, message)));
  }
}
