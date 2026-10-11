const $ = (id) => document.getElementById(id);
// ?tab=<id> lets tests render the popup for a specific tab; normally it is the active tab.
const requested = Number(new URLSearchParams(location.search).get('tab'));
const tab = requested ? await chrome.tabs.get(requested) : (await chrome.tabs.query({ active: true, currentWindow: true }))[0];
const answer = await chrome.runtime.sendMessage({ type: 'popup-code', tabId: tab.id });
if (answer?.site) $('site').textContent = answer.site;
function ago(iso) {
  const seconds = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 1000));
  return seconds < 60 ? `${seconds} s ago` : `${Math.round(seconds / 60)} min ago`;
}
if (!answer?.ok) {
  $('status').textContent = answer?.error?.message ?? 'Waypost did not answer.';
  if (['PAIRING_REQUIRED', 'PAIRING_INVALID'].includes(answer?.error?.code)) {
    $('pair').hidden = false;
    $('pair').addEventListener('submit', async (event) => {
      event.preventDefault();
      const saved = await chrome.runtime.sendMessage({ type: 'set-pairing', code: $('pair-code').value });
      if (saved?.ok) location.reload(); else $('status').textContent = saved?.error?.message ?? 'Pairing failed.';
    });
  }
} else if (!answer.data.found) {
  $('status').textContent = answer.data.reason;
} else {
  const data = answer.data;
  $('status').hidden = true;
  $('result').hidden = false;
  $('code').textContent = data.code;
  $('meta').textContent = `${data.sender.name || data.sender.address} · ${ago(data.receivedAt)}${data.subject ? ` · ${data.subject}` : ''}`;
  // Green only when Waypost reports the sender as trusted: a known code sender that Proton verified.
  const trusted = data.trusted === true;
  $('trust').textContent = trusted ? 'Known code sender, verified by Proton (DMARC pass), matches this site.' : (data.warning ?? 'Check the sender before you use this code.');
  $('trust').className = trusted ? 'ok' : 'warn';
  $('fill').addEventListener('click', async () => {
    $('fill').disabled = true;
    const filled = await chrome.runtime.sendMessage({ type: 'popup-fill', tabId: tab.id, ticket: answer.ticket });
    $('fill').textContent = filled?.result?.filled ? 'Filled' : (filled?.error?.message ?? filled?.result?.reason ?? 'No code field found. Select the code and paste it.');
    if (filled?.result?.filled) setTimeout(() => window.close(), 600);
  });
}
if (answer?.origin) {
  $('auto-row').hidden = false; $('auto-note').hidden = false;
  $('auto').checked = Boolean(answer.auto);
  $('auto').addEventListener('change', async (event) => {
    const enabled = event.target.checked;
    // The browser's own permission prompt is the per-site consent.
    if (enabled && !(await chrome.permissions.request({ origins: [`${answer.origin}/*`] }))) { event.target.checked = false; return; }
    await chrome.runtime.sendMessage({ type: 'set-auto', origin: answer.origin, enabled });
  });
}
