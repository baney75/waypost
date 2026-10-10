// Pair the browser extension: write a native messaging host manifest that only the
// named extension may use, a launcher script, and turn on browser code lookup.
import { mkdir, open, rename, unlink } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { amendConfig } from './connect.js';
import { WaypostError } from './errors.js';

export const HOST_NAME = 'dev.waypost.codes';
// The extension's manifest carries a public key, so an unpacked install always gets this ID.
export const PINNED_EXTENSION_ID = 'bahfokgcpebehdnidclkpdeafnaehdpo';
const BROWSER_DIRS:Record<string,{linux:string; darwin:string}> = {
  chrome:{linux:'.config/google-chrome', darwin:'Library/Application Support/Google/Chrome'},
  chromium:{linux:'.config/chromium', darwin:'Library/Application Support/Chromium'},
  brave:{linux:'.config/BraveSoftware/Brave-Browser', darwin:'Library/Application Support/BraveSoftware/Brave-Browser'},
  edge:{linux:'.config/microsoft-edge', darwin:'Library/Application Support/Microsoft Edge'},
  helium:{linux:'.config/net.imput.helium', darwin:'Library/Application Support/net.imput.helium'},
};
export function hostsDirectory(browser:string, platform = process.platform, home = homedir()):string {
  const dirs = BROWSER_DIRS[browser];
  if (!dirs) throw new WaypostError('INPUT_INVALID', `Unknown browser ${JSON.stringify(browser)}. Use chrome, chromium, brave, edge or helium, or pass --hosts-dir.`);
  if (platform !== 'linux' && platform !== 'darwin') throw new WaypostError('PLATFORM_UNSUPPORTED', 'Browser pairing supports Linux and macOS. On Windows the host is registered in the registry; pass --hosts-dir and register it yourself.');
  return join(home, dirs[platform], 'NativeMessagingHosts');
}
async function writePrivate(path:string, content:string, mode:number) {
  const temp = `${path}.${randomUUID()}.tmp`;
  const handle = await open(temp, 'wx', mode);
  try { await handle.writeFile(content); await handle.sync(); } finally { await handle.close(); }
  try { await rename(temp, path); } catch (error) { await unlink(temp).catch(() => undefined); throw error; }
}
const shellQuote = (value:string) => `'${value.replace(/'/g, `'\\''`)}'`;
export async function connectBrowser(configPath:string, options:{extensionId?:string | undefined; browser:string; hostsDir?:string | undefined}) {
  const id = options.extensionId ?? PINNED_EXTENSION_ID;
  if (!/^[a-p]{32}$/.test(id)) throw new WaypostError('INPUT_INVALID', 'An extension ID is 32 letters a–p, as shown on chrome://extensions.');
  const directory = options.hostsDir ? resolve(options.hostsDir) : hostsDirectory(options.browser);
  const runtime = fileURLToPath(new URL('../runtime/waypost.mjs', import.meta.url));
  const launcher = join(dirname(resolve(configPath)), 'native-host');
  // The browser starts this script with its own environment. For direct Bridge, wrap the
  // exec line with your secret manager (for example pass-cli run --env-file FILE --).
  await writePrivate(launcher, `#!/bin/sh\n# Started by the browser for the Waypost extension (native messaging, stdin/stdout only).\n# For direct Bridge, prefix the command with your secret manager so it gets WAYPOST_MAIL_* variables.\nexec ${[process.execPath, runtime, '--config', resolve(configPath), 'native-host'].map(shellQuote).join(' ')} "$@"\n`, 0o700);
  await mkdir(directory, {recursive:true, mode:0o700});
  const manifest = join(directory, `${HOST_NAME}.json`);
  await writePrivate(manifest, JSON.stringify({name:HOST_NAME, description:'Waypost verification codes', path:launcher, type:'stdio', allowed_origins:[`chrome-extension://${id}/`]}, null, 2) + '\n', 0o600);
  await amendConfig(configPath, config => ({...config, verificationCodes:{agents:false, maxAgeMinutes:10, mailboxes:['INBOX'], siteAliases:{}, ...config.verificationCodes, browser:true, extensionIds:[...new Set([...(config.verificationCodes?.extensionIds ?? []), id])]}}));
  return {service:'browser', paired:true, extensionId:id, hostManifest:manifest, launcher, next:'Load the extension folder from chrome://extensions (Developer mode → Load unpacked → the extension/ folder), then click the Waypost button on a page that asks for a code.'};
}
