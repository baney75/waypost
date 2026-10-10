// Talks to Waypost through native messaging only. Codes stay in memory for the
// length of one request and are never written to storage or logs.
const HOST = 'dev.waypost.codes';
const SCRIPT_ID = 'waypost-autofill';

function siteOf(url) {
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'https:' || (parsed.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(parsed.hostname)) ? parsed : null;
  } catch { return null; }
}
async function askWaypost(hostname, notBefore) {
  try {
    return await chrome.runtime.sendNativeMessage(HOST, { type: 'verification_code', site: hostname, ...(notBefore ? { notBefore } : {}) });
  } catch (error) {
    return { ok: false, error: { code: 'HOST_UNAVAILABLE', message: 'Waypost is not paired with this browser. In a terminal run: waypost connect browser' } };
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
// Automatic fill needs all three: the user opted in for this origin, the sender belongs to
// the site, and the extraction is high confidence. A recorded DMARC failure blocks it.
export function autoFillAllowed(data) {
  return Boolean(data?.found && data.confidence === 'high' && data.senderMatchesSite === true && data.senderVerified !== false);
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
    return { ...answer, site: site.hostname, origin: site.origin, auto: (await autoSites()).includes(site.origin) };
  }
  if (message.type === 'popup-fill') {
    const tab = await chrome.tabs.get(message.tabId);
    if (!siteOf(tab.url)) return { ok: false };
    await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['fill.js'] });
    const [result] = await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: (code) => globalThis.__waypost.fill(code), args: [message.code] });
    return { ok: true, result: result?.result };
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
    return autoFillAllowed(answer.data) ? { code: answer.data.code } : {};
  }
  return { ok: false };
}
chrome.runtime.onMessage.addListener((message, sender, respond) => { handle(message, sender).then(respond, () => respond({ ok: false })); return true; });
chrome.runtime.onInstalled.addListener(syncAutofill);
chrome.runtime.onStartup.addListener(syncAutofill);
chrome.permissions.onRemoved.addListener(syncAutofill);
