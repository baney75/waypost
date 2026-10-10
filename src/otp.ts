// Find one-time verification codes in message text. Pure functions: no I/O, no logging.
// A code is a credential, so callers must never log what these functions return.

const KEYWORDS = /\b(?:verification|verify|one[- ]?time|otp|passcode|pass code|security code|login code|log[- ]?in code|sign[- ]?in|signin|2fa|two[- ]?factor|two[- ]?step|multi[- ]?factor|mfa|authenticat\w*|confirmation code|confirm|access code|auth code|code|pin)\b/i;
// Phrases that put a code right next to its label: "code is 123456", "code: 123456", "123456 is your code".
const BEFORE_STRONG = /(?:code|passcode|pin|otp|password)(?:\s+(?:is|was))?\s*(?:[:\-–—]|is)?\s*$/i;
const AFTER_STRONG = /^\s*(?:is|as)\s+(?:your|the)\b[^.\n]{0,60}?\b(?:code|passcode|pin|otp)\b/i;
const NEGATIVE_BEFORE = /(?:order|invoice|receipt|ref(?:erence)?|ticket|case|tracking|account|acct|card|member(?:ship)?|customer|confirmation\s+(?:number|no\.?)|transaction|booking|reservation|flight|policy|claim|serial|model|item|sku|po|zip|postal|ending\s+in|last\s+(?:4|four)(?:\s+digits)?|phone|call|tel|fax|text|sms\s+to|ext\.?|suite|apt|unit|room|#)\s*(?:number|no\.?|num|id)?\s*[:#]?\s*$/i;
const MONTHS = /\b(?:jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\.?\s*$/i;

export type CodeCandidate = { code: string; score: number; confidence: 'high' | 'medium' | 'low'; where: 'subject' | 'body' };

function normalize(text: string): string {
  return text.replace(/ /g, ' ').replace(/[​-‍﻿]/g, '').replace(/\r\n?/g, '\n');
}
// Tokens: 4–8 digits, digits split by one space or hyphen into 2–4 groups ("123 456", "482-193"),
// spaced single digits from HTML layouts ("8 4 2 9 1 7"), or 4–10 letter/digit codes with a digit ("G-482913", "AB12CD").
const TOKEN = /(?<![\w.$€£¥+\/:,-])(?:[A-Z]{1,3}-)?(?:\d(?: \d){3,7}|\d{2,4}(?:[ -]\d{2,4}){1,3}|\d{4,8}|(?=[A-Z0-9-]*\d)(?=[A-Z0-9-]*[A-Z])[A-Z0-9]{2,5}-?[A-Z0-9]{2,5})(?![\w$€£%]|[.,:\/-]\d)/g;

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
function scoreAt(text: string, index: number, token: string): number {
  const before = text.slice(Math.max(0, index - 120), index);
  const after = text.slice(index + token.length, index + token.length + 120);
  if (!plausible(token, before, after)) return 0;
  let score = 0;
  const near = before.slice(-70) + ' ' + after.slice(0, 50);
  if (KEYWORDS.test(near)) score += 3;
  if (BEFORE_STRONG.test(before.slice(-40)) || AFTER_STRONG.test(after)) score += 4;
  if (/\b(?:expire|valid for|do not share|don't share|never share|enter|use this|type this)\b/i.test(before.slice(-160) + after.slice(0, 120))) score += 1;
  // A code alone on its own line is how most HTML templates present it.
  if (/(?:^|\n)\s*$/.test(before) && /^\s*(?:\n|$)/.test(after)) score += 2;
  if (/^\d{6}$/.test(digitsOnly(token))) score += 1;
  if (/[a-z]/i.test(token) && !/^[A-Z]{1,3}-\d+$/.test(token)) score -= 1; // alphanumerics are rarer than digits
  return score;
}
export function codeCandidates(subject: string, body: string): CodeCandidate[] {
  const found = new Map<string, CodeCandidate>();
  for (const [where, raw] of [['subject', subject], ['body', body]] as const) {
    const text = normalize(raw).slice(0, 60000);
    for (const match of text.matchAll(TOKEN)) {
      const token = match[0];
      const score = scoreAt(text, match.index, token);
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

// Domains. Registrable domain = the label before a public suffix. A small built-in list
// covers common multi-part suffixes; it is not the full Public Suffix List.
const MULTI_PART_SUFFIXES = new Set(['co.uk','org.uk','ac.uk','gov.uk','me.uk','com.au','net.au','org.au','co.nz','co.jp','ne.jp','or.jp','co.kr','com.br','com.mx','com.ar','co.in','net.in','com.cn','com.hk','com.sg','com.tw','co.za','com.tr','co.il']);
export function registrableDomain(host: string): string | null {
  const clean = host.trim().toLowerCase().replace(/\.$/, '');
  if (!/^[a-z0-9.-]+$/.test(clean) || !clean.includes('.') || /^\d+(?:\.\d+){3}$/.test(clean)) return null;
  const labels = clean.split('.');
  const lastTwo = labels.slice(-2).join('.');
  return MULTI_PART_SUFFIXES.has(lastTwo) && labels.length >= 3 ? labels.slice(-3).join('.') : lastTwo;
}
// Companies that send codes from a different domain than the sign-in page.
export const BUILT_IN_ALIASES: Record<string, string[]> = {
  'google.com': ['youtube.com', 'gmail.com', 'android.com'],
  'microsoft.com': ['live.com', 'outlook.com', 'office.com', 'microsoftonline.com', 'microsoft365.com', 'xbox.com', 'bing.com', 'skype.com', 'azure.com'],
  'apple.com': ['icloud.com'],
  'proton.me': ['protonmail.com', 'protonmail.ch', 'pm.me'],
  'github.com': ['githubusercontent.com'],
  'amazon.com': ['aws.amazon.com', 'amazonaws.com'],
};
/** Every registrable domain whose mail may carry codes for this site. */
export function senderDomainsFor(site: string, extra: Record<string, string[]> = {}): Set<string> {
  const base = registrableDomain(site);
  const domains = new Set<string>();
  if (!base) return domains;
  domains.add(base);
  for (const table of [BUILT_IN_ALIASES, extra]) for (const [owner, aliases] of Object.entries(table)) {
    const group = [owner, ...aliases].map(registrableDomain).filter((value): value is string => !!value);
    if (group.includes(base)) for (const domain of group) domains.add(domain);
  }
  return domains;
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
/** Origin-bound SMS codes (WebOTP format): last line "@example.com #123456". */
export function originBoundCode(text: string): { domain: string; code: string } | null {
  const match = /(?:^|\n)@([a-z0-9.-]+\.[a-z]{2,})\s+#([A-Za-z0-9]{4,10})\s*$/i.exec(text.trim());
  return match ? { domain: match[1]!.toLowerCase(), code: match[2]! } : null;
}
