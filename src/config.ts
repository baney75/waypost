import { readFile, realpath, stat, mkdir, open } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { z } from 'zod';
import { WaypostError } from './errors.js';

const absolutePath = z.string().refine(isAbsolute, 'Use an absolute path.');
export const configSchema = z.object({
  version: z.literal(1),
  artifactsDir: absolutePath,
  mail: z.object({
    host: z.enum(['127.0.0.1','::1']).default('127.0.0.1'),
    imapPort: z.number().int().min(1).max(65535).default(1143),
    smtpPort: z.number().int().min(1).max(65535).default(1025),
    usernameEnv: z.string().regex(/^[A-Z][A-Z0-9_]*$/).default('WAYPOST_MAIL_USERNAME'),
    passwordEnv: z.string().regex(/^[A-Z][A-Z0-9_]*$/).default('WAYPOST_MAIL_PASSWORD'),
    certificate: absolutePath,
    sendEnabled: z.boolean().default(false),
  }).strict().optional(),
  drive: z.object({
    executable: absolutePath,
    root: z.string().startsWith('/my-files').default('/my-files'),
    writeEnabled: z.boolean().default(false),
  }).strict().optional(),
  calendar: z.object({files:z.array(absolutePath).max(20).default([])}).strict().optional(),
  timeoutMs: z.number().int().min(1000).max(120000).default(45000),
}).strict();
export type Config = z.infer<typeof configSchema>;
export const defaultConfigPath = () => process.env.WAYPOST_CONFIG ?? join(homedir(), '.config', 'waypost', 'config.json');
export async function loadConfig(path = defaultConfigPath()): Promise<Config> {
  try {
    const file = await stat(path);
    if (process.platform !== 'win32' && (file.mode & 0o022)) throw new WaypostError('CONFIG_PERMISSIONS', 'Configuration must not be writable by other users. Run chmod 600 on your config file.');
    if(file.size > 65536) throw new WaypostError('CONFIG_INVALID','Configuration exceeds 64 KiB.');
    return configSchema.parse(JSON.parse(await readFile(path, 'utf8')));
  } catch (error) {
    if(error instanceof WaypostError) throw error;
    throw new WaypostError('CONFIG_INVALID', 'Configuration is missing or invalid. Run waypost init, then edit the paths in your config.');
  }
}
export async function initConfig(path = defaultConfigPath()): Promise<string> {
  await mkdir(dirname(path), {recursive:true, mode:0o700});
  const handle = await open(path, 'wx', 0o600);
  try { await handle.writeFile(JSON.stringify({version:1, artifactsDir:join(homedir(), '.local','share','waypost','artifacts'),calendar:{files:[]}},null,2)+'\n'); }
  finally {await handle.close();}
  return path;
}
export async function checkedPath(path:string, root:string): Promise<string> {
  const [real, base] = await Promise.all([realpath(path), realpath(root)]);
  const rel = relative(base, real);
  if(rel === '..' || rel.startsWith('..'+(process.platform === 'win32'?'\\':'/')) || isAbsolute(rel)) throw new WaypostError('PATH_DENIED','The file is outside the configured directory.');
  return real;
}
export async function saveArtifact(config:Config, name:string, content:string | Uint8Array):Promise<string> {
  if(!/^[a-z0-9][a-z0-9._-]{0,120}$/i.test(name)) throw new WaypostError('PATH_DENIED','Invalid artifact name.');
  await mkdir(config.artifactsDir,{recursive:true,mode:0o700});
  const root=await realpath(config.artifactsDir);
  const file=resolve(root,name);
  const handle=await open(file,'wx',0o600);
  try {await handle.writeFile(content);} finally {await handle.close();}
  return file;
}
