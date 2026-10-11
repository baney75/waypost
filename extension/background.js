// Talks to Waypost through native messaging only. Codes stay in memory for the
// length of one request and are never written to storage or logs.
import { autoFillAllowed } from './policy.js';

const HOST = 'dev.waypost.codes';
// A fetched code is bound to the tab and origin it was fetched for, in memory, for two minutes.
const TICKET_MS = 120000;
const tickets = new Map();
function issueTicket(code, tabId, origin) {
  for (const [id, ticket] of tickets) if (ticket.expires < Date.now()) tickets.delete(id);
  const id = crypto.randomUUID();
  tickets.set(id, { code, tabId, origin, expires: Date.now() + TICKET_MS });
  return id;
}
const SCRIPT_ID = 'waypost-autofill';

function siteOf(url) {
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'https:' || (parsed.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(parsed.hostname)) ? parsed : null;
  } catch { return null; }
}
async function askWaypost(hostname, notBefore) {
  const { pairingCode } = await chrome.storage.local.get('pairingCode');
  try {
    return await chrome.runtime.sendNativeMessage(HOST, { type: 'verification_code', site: hostname, ...(notBefore ? { notBefore } : {}), ...(pairingCode ? { pairing: pairingCode } : {}) });
  } catch {
    return { ok: false, error: { code: 'HOST_UNAVAILABLE', message: 'Waypost is not set up for this browser. In a terminal run: waypost connect browser' } };
  }
}
async function autoSites() {
  const { autoSites = [] } = await chrome.storage.local.get('autoSites');
  return autoSites;
}
async function syncAutofill() {
  const sites = [];
  for (const origin of await autoSites()) if (await chrome.permissions.contains({ origins: [`${origin}/*`] })) sites.push(origin);
  await chrome.scripting.unregisterContentScripts({ ids: [SCRIPT_ID] }).catch(() => undefined);
  if (sites.length) await chrome.scripting.registerContentScripts([{ id: SCRIPT_ID, matches: sites.map((origin) => `${origin}/*`), js: ['fill.js', 'autofill.js'], runAt: 'document_idle' }]);
}
async function handle(message, sender) {
  if (sender.id !== chrome.runtime.id) return { ok: false };
  // Content scripts share the extension ID, so popup actions must come from an extension page
  // and auto-code only from a content script in a tab.
  const fromExtensionPage = Boolean(sender.url?.startsWith(`chrome-extension://${chrome.runtime.id}/`));
  if (message.type !== 'auto-code' && !fromExtensionPage) return { ok: false };
  if (message.type === 'popup-code') {
    const tab = await chrome.tabs.get(message.tabId);
    const site = siteOf(tab.url);
    if (!site) return { ok: false, error: { code: 'SITE_UNSUPPORTED', message: 'Codes are offered only on https pages.' } };
    const answer = await askWaypost(site.hostname);
    // The popup gets the code to show and a ticket to fill with; Fill sends only the ticket.
    const ticket = answer?.ok && answer.data?.found ? issueTicket(answer.data.code, tab.id, site.origin) : undefined;
    return { ...answer, ticket, site: site.hostname, origin: site.origin, auto: (await autoSites()).includes(site.origin) };
  }
  if (message.type === 'popup-fill') {
    const ticket = tickets.get(message.ticket);
    if (!ticket || ticket.expires < Date.now()) return { ok: false, error: { code: 'TICKET_EXPIRED', message: 'Get the code again.' } };
    const tab = await chrome.tabs.get(ticket.tabId).catch(() => null);
    // The tab must still show the origin the code was fetched for; otherwise drop the code.
    if (!tab || tab.id !== message.tabId || siteOf(tab.url)?.origin !== ticket.origin) {
      tickets.delete(message.ticket);
      return { ok: false, error: { code: 'ORIGIN_CHANGED', message: 'The page changed after the code was fetched, so the code was not filled.' } };
    }
    await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['fill.js'] });
    // Checked again inside the page, in case it navigated between the check above and the injection.
    const [result] = await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: (code, origin) => (location.origin === origin ? globalThis.__waypost.fill(code) : { filled: false, reason: 'The page changed; the code was not filled.' }), args: [ticket.code, ticket.origin] });
    if (result?.result?.filled) tickets.delete(message.ticket);
    return { ok: true, result: result?.result };
  }
  if (message.type === 'set-pairing') {
    if (typeof message.code !== 'string' || !/^[A-Za-z0-9_-]{32,128}$/.test(message.code.trim())) return { ok: false, error: { code: 'PAIRING_FORMAT', message: 'That does not look like a Waypost pairing code.' } };
    await chrome.storage.local.set({ pairingCode: message.code.trim() });
    return { ok: true };
  }
  if (message.type === 'set-auto') {
    const sites = new Set(await autoSites());
    if (message.enabled) sites.add(message.origin); else sites.delete(message.origin);
    await chrome.storage.local.set({ autoSites: [...sites] });
    if (!message.enabled) await chrome.permissions.remove({ origins: [`${message.origin}/*`] }).catch(() => undefined);
    await syncAutofill();
    return { ok: true };
  }
  if (message.type === 'auto-code') {
    // Only the registered content script sends this; the origin comes from the browser, not the page.
    const site = sender.tab && !sender.url?.startsWith('chrome-extension:') && siteOf(sender.url ?? sender.tab.url);
    if (!site || !(await autoSites()).includes(site.origin)) return { stop: true };
    const answer = await askWaypost(site.hostname, message.notBefore);
    if (!answer?.ok) return { stop: answer?.error?.code !== 'MAIL_TIMEOUT' && answer?.error?.code !== 'MAIL_BRIDGE_UNREACHABLE' };
    return autoFillAllowed(answer.data) ? { code: answer.data.code, origin: site.origin } : {};
  }
  return { ok: false };
}
chrome.runtime.onMessage.addListener((message, sender, respond) => { handle(message, sender).then(respond, () => respond({ ok: false })); return true; });
chrome.runtime.onInstalled.addListener(syncAutofill);
chrome.runtime.onStartup.addListener(syncAutofill);
chrome.permissions.onRemoved.addListener(syncAutofill);
