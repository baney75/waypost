// Finds one-time-code fields and fills them. Injected on demand (popup) or by the
// per-site autofill script. It never reads other fields and never stores the code.
(() => {
  const SKIP = /zip|postal|promo|coupon|gift|discount|voucher|country|area.?code|phone|tel(?:ephone)?\b|captcha|card|cvv|cvc|search|referr?al|invite/i;
  const HINT = /one.?time|otp|verif|2fa|mfa|two.?factor|security.?code|auth\w*.?code|passcode|login.?code|sign.?in.?code|confirm\w*.?code|access.?code|\bcode\b|\btoken\b|\bpin\b/i;
  const usable = (input) => {
    if (!(input instanceof HTMLInputElement) || input.disabled || input.readOnly) return false;
    if (!['text', 'tel', 'number', 'password', ''].includes(input.type)) return false;
    const box = input.getBoundingClientRect();
    const style = getComputedStyle(input);
    return box.width > 0 && box.height > 0 && style.visibility !== 'hidden' && style.display !== 'none';
  };
  const describe = (input) => [input.name, input.id, input.placeholder, input.getAttribute('aria-label'), input.autocomplete, ...Array.from(input.labels ?? [], (label) => label.textContent)].join(' ');
  function findTargets(root = document) {
    const inputs = Array.from(root.querySelectorAll('input')).filter(usable);
    const tagged = inputs.filter((input) => /one-time-code/i.test(input.autocomplete));
    const singles = inputs.filter((input) => input.maxLength === 1 && input.type !== 'password');
    // Split fields: 4–8 single-character boxes that share a container.
    for (const input of singles) {
      let container = input.parentElement;
      for (let depth = 0; container && depth < 4; depth += 1, container = container.parentElement) {
        const group = singles.filter((other) => container.contains(other));
        if (group.length >= 4 && group.length <= 8) return group;
      }
    }
    if (tagged.length === 1) return tagged;
    const hinted = inputs.filter((input) => input.type !== 'password' && HINT.test(describe(input)) && !SKIP.test(describe(input)));
    const sized = hinted.filter((input) => input.maxLength < 0 || (input.maxLength >= 4 && input.maxLength <= 12));
    return sized.length === 1 ? sized : [];
  }
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
  function type(input, value) {
    input.focus();
    setter.call(input, value);
    input.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: value }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
  }
  function fill(code) {
    const targets = findTargets();
    if (!targets.length) return { filled: false, fields: 0 };
    if (targets.length === 1) type(targets[0], code);
    else {
      if (code.length !== targets.length) return { filled: false, fields: targets.length, reason: `This page has ${targets.length} code boxes but the code has ${code.length} characters.` };
      targets.forEach((input, index) => type(input, code[index]));
    }
    targets.at(-1).blur();
    return { filled: true, fields: targets.length };
  }
  globalThis.__waypost = { findTargets, fill };
})();
