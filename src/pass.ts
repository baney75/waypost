import { z } from 'zod';
import type { Config } from './config.js';
import { WaypostError } from './errors.js';
import { defineTool } from './tool.js';
import { runExecutable } from './process.js';

const queryText = z.string().min(1).max(80).regex(/^[\p{L}\p{N} .@_+/-]+$/u).describe('Name fragment to match. Not a secret.');
export const passLookupSchema = z.object({
  query: queryText,
  vault: z.string().min(1).max(80).regex(/^[\p{L}\p{N} .@_+/-]+$/u).optional().describe('Vault name. Omit to use the CLI default.'),
}).strict();

const SECRET_KEY = /password|secret|totp|otp|pin|cvv|note|private|username|email/i;

function httpUrls(value: unknown, key = ''): string[] {
  if (typeof value === 'string') return /^https?:\/\//.test(value) && /url/i.test(key) ? [value.slice(0, 500)] : [];
  if (Array.isArray(value)) return value.flatMap(item => httpUrls(item, key));
  if (!value || typeof value !== 'object') return [];
  return Object.entries(value).flatMap(([child, nested]) => SECRET_KEY.test(child) ? [] : httpUrls(nested, child));
}

function itemsOf(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  if (value && typeof value === 'object' && Array.isArray((value as {items?: unknown}).items)) return (value as {items: unknown[]}).items;
  throw new WaypostError('PASS_RESPONSE', 'Proton Pass did not return an item list. No item content was kept.');
}

const vaultNames = (value: unknown): string[] => {
  const list = value && typeof value === 'object' && Array.isArray((value as {vaults?: unknown}).vaults) ? (value as {vaults: unknown[]}).vaults : Array.isArray(value) ? value : [];
  return list.flatMap(item => item && typeof item === 'object' && typeof (item as {name?: unknown}).name === 'string' ? [(item as {name: string}).name] : []).slice(0, 20);
};
// pass-cli 2.x names items "title"; older releases used "name".
const itemName = (item: unknown) => item && typeof item === 'object' ? [(item as {title?: unknown}).title, (item as {name?: unknown}).name].find((value): value is string => typeof value === 'string') : undefined;

export async function passLookup(config: Config, input: unknown) {
  const query = passLookupSchema.parse(input);
  const executable = config.pass?.executable;
  if (!executable) throw new WaypostError('PASS_UNCONFIGURED', 'Set pass.executable to the official pass-cli. This tool never receives item secrets.');
  const json = async (args: string[]) => {
    const output = await runExecutable(executable, args, config.timeoutMs, 4 * 1024 * 1024);
    try { return JSON.parse(output) as unknown; }
    catch { throw new WaypostError('PASS_RESPONSE', 'Proton Pass did not return JSON. No item content was kept.'); }
  };
  // Without a default vault, pass-cli needs one named; search each vault instead of failing.
  const vaults = query.vault ? [query.vault] : vaultNames(await json(['vault', 'list', '--output', 'json']));
  const needle = query.query.toLocaleLowerCase();
  const items: {name: string; vault: string; urls: string[]}[] = [];
  for (const vault of vaults) {
    for (const item of itemsOf(await json(['item', 'list', '--vault-name', vault, '--output', 'json']))) {
      const name = itemName(item)?.slice(0, 200);
      if (!name || !name.toLocaleLowerCase().includes(needle)) continue;
      items.push({name, vault, urls: [...new Set(httpUrls(item))].slice(0, 8)});
      if (items.length >= 20) break;
    }
    if (items.length >= 20) break;
  }
  return {query: query.query, vault: query.vault ?? null, vaultsSearched: vaults.length, items, secretsReturned: false};
}

export const passTools = [
  defineTool({name:'pass_lookup', title:'Find Proton Pass items', description:'Return matching item names and http(s) URLs only. Never returns passwords, TOTP, usernames, or notes. Does not use --show-secrets.', schema:passLookupSchema, readOnly:true, destructive:false, handler:passLookup}),
];
