import { domainToASCII } from 'node:url';
import { PSL_RULES } from './psl-data.js';
// Find one-time verification codes in message text. Pure functions: no I/O, no logging.
// A code is a credential, so callers must never log what these functions return.

const KEYWORDS = /\b(?:verification|verify|one[- ]?time|otp|passcode|pass code|security code|login code|log[- ]?in code|sign[- ]?in|signin|2fa|two[- ]?factor|two[- ]?step|multi[- ]?factor|mfa|authenticat\w*|confirmation code|confirm|access code|auth code|code|pin)\b/i;
// Phrases that put a code right next to its label: "code is 123456", "code: 123456", "123456 is your code".
const BEFORE_STRONG = /(?:code|passcode|pin|otp|password)(?:\s+(?:is|was))?\s*(?:[:\-–—]|is)?\s*$/i;
// A label a few words before a colon: "Steam Guard code you need to log in to account name:".
const LABEL_COLON = /\b(?:code|passcode|otp)\b[^.\n:]{0,60}:\s*$/i;
// A code needs a verification word nearby or in the subject; a bare "code" label is not enough.
const VERIFY = /\b(?:verif\w*|one[- ]?time|otp|passcode|pass code|security code|log ?in|log-in|sign[- ]?in|signin|2fa|two[- ]?(?:factor|step)|multi[- ]?factor|mfa|authenticat\w*|confirm\w*|access code|auth code|guard|activation|activate)\b/i;
const PROMO = /\b(?:promo\w*|coupon|discount|gift|voucher|referral|reward|rebate|offer|sale|save|savings|redeem|checkout)\b/i;
const AFTER_STRONG = /^\s*(?:is|as)\s+(?:your|the)\b[^.\n]{0,60}?\b(?:code|passcode|pin|otp)\b/i;
const NEGATIVE_BEFORE = /(?:order|invoice|receipt|ref(?:erence)?|ticket|case|tracking|account|acct|card|member(?:ship)?|customer|confirmation\s+(?:number|no\.?)|transaction|booking|reservation|flight|policy|claim|serial|model|item|sku|po|zip|postal|ending\s+in|last\s+(?:4|four)(?:\s+digits)?|phone|call|tel|fax|text|sms\s+to|ext\.?|suite|apt|unit|room|#)\s*(?:number|no\.?|num|id)?\s*[:#]?\s*$/i;
const MONTHS = /\b(?:jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\.?\s*$/i;

export type CodeCandidate = { code: string; score: number; confidence: 'high' | 'medium' | 'low'; where: 'subject' | 'body' };

function normalize(text: string): string {
  return text.replace(/ /g, ' ').replace(/[​-‍﻿]/g, '').replace(/\r\n?/g, '\n');
}
// Tokens: 4–8 digits, digits split by one space or hyphen into 2–4 groups ("123 456", "482-193"),
// spaced single digits from HTML layouts ("8 4 2 9 1 7"), or 4–10 letter/digit codes with a digit ("G-482913", "AB12CD").
const TOKEN = /(?<![\w.$€£¥+\/:,-])(?:[A-Z]{1,3}-)?(?:\d(?: \d){3,7}|\d{2,4}(?:[ -]\d{2,4}){1,3}|\d{4,8}|(?=[A-Za-z0-9-]*\d)(?=[A-Za-z0-9-]*[A-Za-z])[A-Za-z0-9]{2,5}-?[A-Za-z0-9]{2,5})(?![\w$€£%]|[.,:\/-]\d)/g;

function digitsOnly(token: string): string { return token.replace(/[ -]/g, ''); }
function plausible(token: string, before: string, after: string): boolean {
  const compact = digitsOnly(token.replace(/^[A-Z]{1,3}-(?=\d+$)/, ''));
  if (compact.length < 4 || compact.length > 10) return false;
  if (/^\d+$/.test(compact)) {
    if (compact.length === 4 && +compact >= 1900 && +compact <= 2100 && !BEFORE_STRONG.test(before.slice(-40))) return false; // a year
    if (/^(\d)\1+$/.test(compact)) return false; // 0000, 111111
    if (/\d{3}[ -]\d{3}[ -]\d{4}/.test(token) || compact.length === 10) return false; // phone number
    if (/[(+]\s*$/.test(before) || /^\s*\)/.test(after)) return false;
  }
  if (MONTHS.test(before.slice(-12)) || /^\s*(?:am|pm|utc|gmt|[a-z]{3}\s+\d{4})\b/i.test(after)) return false; // dates, times
  if (NEGATIVE_BEFORE.test(before.slice(-40))) return false;
  if (/^\s*(?:x|×|px|kb|mb|gb|items?|points?|miles?|usd|eur|dollars?|%)\b/i.test(after)) return false;
  return true;
}
function scoreAt(text: string, index: number, token: string, subject: string): number {
  const before = text.slice(Math.max(0, index - 120), index);
  const after = text.slice(index + token.length, index + token.length + 120);
  if (!plausible(token, before, after)) return 0;
  if (PROMO.test(before.slice(-60)) || PROMO.test(after.slice(0, 40)) || /^\s*(?:for\s+)?\d+\s*%|^\s*off\b/i.test(after)) return 0; // promo and coupon codes
  if (!VERIFY.test(subject) && !VERIFY.test(text.slice(Math.max(0, index - 200), index + token.length + 120))) return 0;
  const labeled = BEFORE_STRONG.test(before.slice(-40)) || LABEL_COLON.test(before.slice(-90)) || AFTER_STRONG.test(after);
  if (/[a-z]/.test(token) && !labeled) return 0; // lowercase codes only directly after a code label
  let score = 0;
  const near = before.slice(-70) + ' ' + after.slice(0, 50);
  if (KEYWORDS.test(near)) score += 3;
  if (labeled) score += 4;
  if (/\b(?:expire|valid for|do not share|don't share|never share|enter|use this|type this)\b/i.test(before.slice(-160) + after.slice(0, 120))) score += 1;
  // A code alone on its own line is how most HTML templates present it.
  if (/(?:^|\n)\s*$/.test(before) && /^\s*(?:\n|$)/.test(after)) score += 2;
  if (/^\d{6}$/.test(digitsOnly(token))) score += 1;
  if (/[a-z]/i.test(token) && !/^[A-Z]{1,3}-\d+$/.test(token) && !labeled) score -= 1; // alphanumerics are rarer than digits
  return score;
}
export function codeCandidates(subject: string, body: string): CodeCandidate[] {
  const found = new Map<string, CodeCandidate>();
  for (const [where, raw] of [['subject', subject], ['body', body]] as const) {
    const text = normalize(raw).slice(0, 60000);
    for (const match of text.matchAll(TOKEN)) {
      const token = match[0];
      const score = scoreAt(text, match.index, token, subject);
      if (score < 3) continue;
      const code = token.replace(/^[A-Z]{1,3}-(?=\d+$)/, '').replace(/[ -]/g, ''); // separators are formatting, not part of the code
      const confidence = score >= 7 ? 'high' : score >= 5 ? 'medium' : 'low';
      const previous = found.get(code);
      const boosted = previous ? Math.max(previous.score, score) + 1 : score; // repeated in subject and body
      found.set(code, { code, score: boosted, confidence: previous && boosted >= 7 ? 'high' : confidence, where: previous?.where ?? where });
    }
  }
  return [...found.values()].sort((a, b) => b.score - a.score);
}
/** The single best code, or null when there is none or two strong codes disagree. */
export function extractCode(subject: string, body: string): { code: string; confidence: 'high' | 'medium' | 'low' } | null {
  const candidates = codeCandidates(subject, body);
  const best = candidates[0];
  if (!best) return null;
  const rival = candidates[1];
  if (rival && rival.score >= best.score - 1 && rival.score >= 5) return { code: best.code, confidence: 'low' };
  return { code: best.code, confidence: best.confidence };
}

// Domains use the bundled Public Suffix List (ICANN and private sections), so
// shop.com.vn and bucket.s3.amazonaws.com are registrable domains of their own.
let suffixRules: {exact:Set<string>; wildcard:Set<string>; exception:Set<string>} | undefined;
function rules() {
  if (!suffixRules) {
    suffixRules = {exact:new Set(), wildcard:new Set(), exception:new Set()};
    for (const rule of PSL_RULES.split(' ')) {
      if (rule.startsWith('!')) suffixRules.exception.add(rule.slice(1));
      else if (rule.startsWith('*.')) suffixRules.wildcard.add(rule.slice(2));
      else suffixRules.exact.add(rule);
    }
  }
  return suffixRules;
}
function normalizeHost(host: string): string | null {
  const ascii = domainToASCII(host.trim().replace(/\.$/, '').toLowerCase());
  if (!ascii || !/^[a-z0-9.-]+$/.test(ascii) || !ascii.includes('.') || /^\d+(?:\.\d+){3}$/.test(ascii) || ascii.split('.').some(label => !label)) return null;
  return ascii;
}
/** The public suffix of a host per the PSL algorithm (the "*" default rule applies when nothing matches). */
export function publicSuffix(host: string): string | null {
  const clean = normalizeHost(host);
  if (!clean) return null;
  const {exact, wildcard, exception} = rules();
  const labels = clean.split('.');
  for (let index = 0; index < labels.length; index++) {
    const candidate = labels.slice(index).join('.');
    if (exception.has(candidate)) return labels.slice(index + 1).join('.');
    if (exact.has(candidate)) return candidate;
    if (index + 1 < labels.length && wildcard.has(labels.slice(index + 1).join('.'))) return candidate;
  }
  return labels.at(-1)!;
}
export function registrableDomain(host: string): string | null {
  const clean = normalizeHost(host);
  const suffix = clean && publicSuffix(clean);
  if (!clean || !suffix || clean === suffix) return null;
  const labels = clean.split('.');
  return labels.slice(-(suffix.split('.').length + 1)).join('.');
}
// Consumer mailbox providers: anyone can get an address at the bare domain, so such an
// address never authorizes a code. Their own transactional mail comes from subdomains.
export const FREE_MAIL = new Set(['gmail.com','googlemail.com','outlook.com','hotmail.com','live.com','msn.com','passport.com','outlook.de','outlook.fr','hotmail.co.uk','hotmail.fr','live.co.uk','yahoo.com','ymail.com','rocketmail.com','yahoo.co.uk','yahoo.co.jp','yahoo.fr','yahoo.de','aol.com','aim.com','icloud.com','me.com','mac.com','proton.me','protonmail.com','protonmail.ch','pm.me','gmx.com','gmx.net','gmx.de','web.de','mail.com','yandex.com','yandex.ru','mail.ru','zoho.com','zohomail.com','fastmail.com','fastmail.fm','hey.com','tutanota.com','tutanota.de','tuta.io','tuta.com','qq.com','163.com','126.com','naver.com','hushmail.com','mailfence.com','posteo.de','posteo.net','mailbox.org','duck.com','skiff.com']);
// Hosts that serve pages anyone can publish under a big brand's domain. Codes are never offered there.
const USER_CONTENT_HOSTS = ['sites.google.com','docs.google.com','drive.google.com','script.google.com','script.googleusercontent.com','sheets.google.com','slides.google.com','forms.google.com','groups.google.com','storage.googleapis.com','storage.cloud.google.com','gist.github.com','raw.githubusercontent.com','gist.githubusercontent.com','onedrive.live.com','1drv.ms','forms.office.com','sway.office.com','dl.dropboxusercontent.com','notion.site'];
// Sites whose codes come from another company domain. Site → sender domains, one direction only.
export const SITE_SENDERS: Record<string, string[]> = {
  'youtube.com':['google.com'], 'gmail.com':['google.com'], 'android.com':['google.com'],
  'live.com':['microsoft.com'], 'outlook.com':['microsoft.com'], 'hotmail.com':['microsoft.com'], 'office.com':['microsoft.com'], 'microsoftonline.com':['microsoft.com'], 'microsoft365.com':['microsoft.com'], 'xbox.com':['microsoft.com'], 'bing.com':['microsoft.com'], 'skype.com':['microsoft.com'], 'azure.com':['microsoft.com'],
  'icloud.com':['apple.com'],
  'protonmail.com':['proton.me'], 'pm.me':['proton.me'],
};
// Addresses known to send only one-time codes. Automatic fill accepts only these, plus verifiedSenders from config.
const KNOWN_OTP_SENDERS: RegExp[] = [/^noreply@github\.com$/, /@accounts\.google\.com$/, /@accountprotection\.microsoft\.com$/, /@(?:id|email)\.apple\.com$/];
export type SenderOptions = {aliases?: Record<string, string[]>; verifiedSenders?: Record<string, string[]>};
function siteHost(site: string): string | null {
  let host = site.trim();
  try { if (/^[a-z][a-z0-9+.-]*:\/\//i.test(host)) host = new URL(host).hostname; } catch { return null; }
  return normalizeHost(host);
}
function splitAddress(address: string): {address:string; host:string} | null {
  const clean = address.trim().toLowerCase();
  const at = clean.lastIndexOf('@');
  if (at < 1) return null;
  const host = normalizeHost(clean.slice(at + 1));
  return host ? {address:`${clean.slice(0, at)}@${host}`, host} : null;
}
function verifiedFor(siteDomain: string, address: string, options: SenderOptions): boolean {
  return (options.verifiedSenders?.[siteDomain] ?? []).some(item => item.trim().toLowerCase() === address);
}
/** Whether mail from this address may carry codes for this site. */
export function senderMatchesSite(address: string, site: string, options: SenderOptions = {}): boolean {
  const host = siteHost(site);
  if (!host || USER_CONTENT_HOSTS.some(blocked => host === blocked || host.endsWith(`.${blocked}`))) return false;
  const siteDomain = registrableDomain(host);
  const sender = splitAddress(address);
  if (!siteDomain || !sender) return false;
  if (verifiedFor(siteDomain, sender.address, options)) return true;
  const senderDomain = registrableDomain(sender.host);
  if (!senderDomain) return false;
  const allowed = new Set([siteDomain, ...(SITE_SENDERS[siteDomain] ?? []), ...(options.aliases?.[siteDomain] ?? []).map(registrableDomain).filter((value): value is string => !!value)]);
  if (!allowed.has(senderDomain)) return false;
  return !(FREE_MAIL.has(senderDomain) && sender.host === senderDomain);
}
/** Whether the address is a known one-time-code sender (built in, or verifiedSenders for this site). */
export function knownOtpSender(address: string, site: string | undefined, options: SenderOptions = {}): boolean {
  const sender = splitAddress(address);
  if (!sender) return false;
  const siteDomain = site ? registrableDomain(siteHost(site) ?? '') : null;
  return KNOWN_OTP_SENDERS.some(pattern => pattern.test(sender.address)) || (!!siteDomain && verifiedFor(siteDomain, sender.address, options));
}
/**
 * Why a message looks like a notification, mailing list or bulk mail rather than a code
 * message, or null. Codes typed by other people (mentions, comments) arrive this way.
 */
export function notificationReason(headers: string, subject: string, body = ''): string | null {
  const unfolded = headers.replace(/\r?\n[ \t]+/g, ' ');
  if (/^(?:list-id|list-unsubscribe|list-post|list-help|x-github-reason|x-github-sender|x-gitlab-[\w-]+|x-discourse-[\w-]+|mailing-list|x-mailing-list):/im.test(unfolded)) return 'mailing-list or notification header';
  if (/^precedence:\s*(?:list|bulk|junk)\b/im.test(unfolded)) return 'bulk precedence';
  if (/^\s*(?:(?:re|fwd?):\s*)*\[[^\]\s]+\/[^\]\s]+\]/i.test(subject) || /\(#\d+\)/.test(subject)) return 'repository notification subject';
  if (/^\s*>/m.test(body) || /(?:^|\n)\s*@[a-z0-9][\w-]*\b/i.test(body) || /\b(?:reply to this email directly|view it on github|you are receiving this because|mentioned you|commented on|wrote:)/i.test(body)) return 'quotes user content';
  return null;
}
/**
 * DMARC result from the topmost Authentication-Results header added by Proton.
 * true: dmarc=pass for the From domain. false: Proton recorded a DMARC failure.
 * null: no Proton result header was present, so the sender is unverified.
 */
export function protonDmarc(headers: string, fromDomain: string | null): boolean | null {
  const unfolded = headers.replace(/\r?\n[ \t]+/g, ' ');
  for (const line of unfolded.split(/\r?\n/)) {
    const match = /^authentication-results:\s*([^;\s]+)\s*;(.*)$/i.exec(line);
    if (!match) continue;
    if (!/(?:^|\.)(?:protonmail\.ch|proton\.me|protonmail\.com)$/i.test(match[1]!)) continue;
    const dmarc = /\bdmarc=(\w+)(?:[^;]*?header\.from=([^\s;]+))?/i.exec(match[2]!);
    if (!dmarc) return null;
    if (dmarc[1]!.toLowerCase() !== 'pass') return false;
    const domain = dmarc[2] ? registrableDomain(dmarc[2]) : null;
    return !fromDomain || !domain || domain === registrableDomain(fromDomain);
  }
  return null;
}
/** Whether an origin-bound SMS domain names this site: same registrable domain, never a user-content host. */
export function originBoundMatchesSite(domain: string, site: string): boolean {
  const host = siteHost(site), bound = normalizeHost(domain);
  if (!host || !bound || USER_CONTENT_HOSTS.some(blocked => host === blocked || host.endsWith(`.${blocked}`))) return false;
  const siteDomain = registrableDomain(host);
  return !!siteDomain && registrableDomain(bound) === siteDomain;
}
/** Origin-bound SMS codes (WebOTP format): last line "@example.com #123456". */
export function originBoundCode(text: string): { domain: string; code: string } | null {
  const match = /(?:^|\n)@([a-z0-9.-]+\.[a-z]{2,})\s+#([A-Za-z0-9]{4,10})\s*$/i.exec(text.trim());
  return match ? { domain: match[1]!.toLowerCase(), code: match[2]! } : null;
}
