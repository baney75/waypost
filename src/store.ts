import { constants } from 'node:fs';
import { open, readFile, rename, stat, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { ensureArtifactsDirectory } from './artifacts.js';
import { WaypostError } from './errors.js';

// Private state directories (agent calendar store, OAuth state) reuse the artifacts checks:
// owned by this user, mode 700, no symlinked root, parents other users cannot replace.
export const privateDirectory = (path:string):Promise<string> => ensureArtifactsDirectory(path);
const MAX_STATE = 16 * 1024 * 1024;
const LOCK_WAIT_MS = 5000, LOCK_STALE_MS = 30000;
const sleep = (ms:number) => new Promise(resolve => setTimeout(resolve, ms));

export async function readJson<T>(dir:string, name:string, fallback:()=>T):Promise<T> {
  const path = join(await privateDirectory(dir), name);
  let file;
  try { file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW); }
  catch (error) { if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return fallback(); throw new WaypostError('STORE_UNREADABLE', `Could not open ${name} in the Waypost state directory. Check its owner and mode 600.`); }
  try {
    const metadata = await file.stat();
    if (!metadata.isFile() || metadata.size > MAX_STATE || (process.platform !== 'win32' && ((metadata.mode & 0o077) || metadata.uid !== process.getuid?.()))) throw new WaypostError('STORE_PERMISSIONS', `${name} must be a regular owner-only file (chmod 600) no larger than 16 MiB.`);
    return JSON.parse(await file.readFile('utf8')) as T;
  } catch (error) {
    if (error instanceof WaypostError) throw error;
    throw new WaypostError('STORE_CORRUPT', `${name} in the Waypost state directory is not valid JSON. Restore it from a backup (waypost store restore).`);
  } finally { await file.close(); }
}
export async function writeJson(dir:string, name:string, value:unknown):Promise<void> {
  const root = await privateDirectory(dir);
  const content = JSON.stringify(value, null, 1) + '\n';
  if (Buffer.byteLength(content) > MAX_STATE) throw new WaypostError('STORE_SIZE', 'The Waypost state file would exceed 16 MiB. Delete old agent events or archive the store.');
  const temp = join(root, `.${name}.${randomUUID()}.tmp`);
  const file = await open(temp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try { await file.writeFile(content); await file.sync(); } finally { await file.close(); }
  try { await rename(temp, join(root, name)); } catch (error) { await unlink(temp).catch(() => undefined); throw error; }
}
/** One writer at a time across processes (MCP server, sync worker, CLI). A lock older than 30 s is from a crashed writer. */
export async function withLock<T>(dir:string, operation:()=>Promise<T>):Promise<T> {
  const root = await privateDirectory(dir);
  const lock = join(root, 'store.lock');
  const deadline = Date.now() + LOCK_WAIT_MS;
  for (;;) {
    try { const handle = await open(lock, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600); await handle.close(); break; }
    catch (error) {
      if (!(error instanceof Error && 'code' in error && error.code === 'EEXIST')) throw new WaypostError('STORE_LOCK', 'Could not lock the Waypost state directory. Check its permissions.');
      const age = await stat(lock).then(value => Date.now() - value.mtimeMs, () => 0);
      if (age > LOCK_STALE_MS) { await unlink(lock).catch(() => undefined); continue; }
      if (Date.now() > deadline) throw new WaypostError('STORE_BUSY', 'Another Waypost process is writing the calendar store. Retry in a few seconds.');
      await sleep(50);
    }
  }
  try { return await operation(); } finally { await unlink(lock).catch(() => undefined); }
}
/** Append-only audit trail: one JSON line per write, opened with O_APPEND so earlier lines are never rewritten. */
export async function audit(dir:string, entry:Record<string, unknown>):Promise<void> {
  const root = await privateDirectory(dir);
  const file = await open(join(root, 'audit.jsonl'), constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | constants.O_NOFOLLOW, 0o600);
  try { await file.write(JSON.stringify({at:new Date().toISOString(), ...entry}) + '\n'); } finally { await file.close(); }
}
export async function readAudit(dir:string, limit:number):Promise<unknown[]> {
  const root = await privateDirectory(dir);
  const text = await readFile(join(root, 'audit.jsonl'), 'utf8').catch(() => '');
  return text.split('\n').filter(Boolean).slice(-limit).map(line => { try { return JSON.parse(line) as unknown; } catch { return {corrupt:true}; } });
}
