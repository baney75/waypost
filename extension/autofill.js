// Registered only for sites where the user turned on automatic filling.
// When a code field appears, ask the extension for a code that arrived after that moment.
(() => {
  let started = 0, done = false, timer;
  async function attempt() {
    if (done || Date.now() - started > 120000) return;
    const response = await chrome.runtime.sendMessage({ type: 'auto-code', notBefore: new Date(started - 60000).toISOString() }).catch(() => null);
    if (response?.code && response.origin === location.origin) {
      const result = globalThis.__waypost.fill(response.code);
      if (result.filled) { done = true; return; }
    }
    if (response?.stop) { done = true; return; }
    timer = setTimeout(attempt, 4000);
  }
  function check() {
    if (started || done || !globalThis.__waypost.findTargets().length) return;
    started = Date.now();
    attempt();
  }
  check();
  new MutationObserver(check).observe(document.documentElement, { childList: true, subtree: true });
  addEventListener('pagehide', () => clearTimeout(timer));
})();
