// IANA timezone support from the runtime's Intl data, used when an ICS file names a
// zone without a VTIMEZONE block, and to write VTIMEZONE blocks into prepared events.
const formatters = new Map<string, Intl.DateTimeFormat>();
function formatter(zone: string): Intl.DateTimeFormat {
  let value = formatters.get(zone);
  if (!value) {
    value = new Intl.DateTimeFormat('en-US', {timeZone:zone, hourCycle:'h23', year:'numeric', month:'2-digit', day:'2-digit', hour:'2-digit', minute:'2-digit', second:'2-digit'});
    formatters.set(zone, value);
  }
  return value;
}
export function isIanaZone(zone: string): boolean {
  if (!/^[A-Za-z][A-Za-z0-9_+\-]*(?:\/[A-Za-z0-9_+\-]+){0,3}$/.test(zone) || zone.length > 64) return false;
  try { formatter(zone); return true; } catch { return false; }
}
type Clock = {year:number; month:number; day:number; hour:number; minute:number; second:number};
export function wallClock(zone: string, ms: number): Clock {
  const parts = Object.fromEntries(formatter(zone).formatToParts(new Date(ms)).filter(part => part.type !== 'literal').map(part => [part.type, Number(part.value)]));
  return {year:parts.year!, month:parts.month!, day:parts.day!, hour:parts.hour!, minute:parts.minute!, second:parts.second!};
}
/** Offset east of UTC in minutes at the instant ms. */
export function offsetMinutes(zone: string, ms: number): number {
  const clock = wallClock(zone, ms);
  const asUtc = Date.UTC(clock.year, clock.month - 1, clock.day, clock.hour, clock.minute, clock.second);
  return Math.round((asUtc - Math.floor(ms / 1000) * 1000) / 60000);
}
const pad = (value: number, width = 2) => String(Math.abs(value)).padStart(width, '0');
export function formatOffset(minutes: number, colon = false): string {
  return `${minutes < 0 ? '-' : '+'}${pad(Math.floor(Math.abs(minutes) / 60))}${colon ? ':' : ''}${pad(Math.abs(minutes) % 60)}`;
}
/** Local ISO time with offset, for display: 2026-10-12T09:00:00-05:00. */
export function localIso(zone: string, ms: number): string {
  const c = wallClock(zone, ms);
  return `${pad(c.year,4)}-${pad(c.month)}-${pad(c.day)}T${pad(c.hour)}:${pad(c.minute)}:${pad(c.second)}${formatOffset(offsetMinutes(zone, ms), true)}`;
}
/**
 * Convert a local wall-clock time in zone to UTC milliseconds.
 * Returns null for a time skipped by a forward transition (spring gap).
 * An ambiguous time (fall back) resolves to the earlier instant, as RFC 5545 requires.
 */
export function localToUtc(zone: string, clock: Clock): number | null {
  const naive = Date.UTC(clock.year, clock.month - 1, clock.day, clock.hour, clock.minute, clock.second);
  const candidates = new Set([offsetMinutes(zone, naive - 86400000), offsetMinutes(zone, naive), offsetMinutes(zone, naive + 86400000)]);
  const matches = [...candidates].map(offset => naive - offset * 60000).filter(ms => {
    const back = wallClock(zone, ms);
    return back.year === clock.year && back.month === clock.month && back.day === clock.day && back.hour === clock.hour && back.minute === clock.minute && back.second === clock.second;
  }).sort((a, b) => a - b);
  return matches[0] ?? null;
}
type Transition = {at: number; from: number; to: number};
const transitionCache = new Map<string, Transition[]>();
function transitions(zone: string, fromYear: number, toYear: number): Transition[] {
  const key = `${zone}:${fromYear}:${toYear}`;
  const cached = transitionCache.get(key);
  if (cached) return cached;
  const found: Transition[] = [];
  const end = Date.UTC(toYear + 1, 0, 1);
  const step = 3 * 86400000;
  let previous = Date.UTC(fromYear, 0, 1), previousOffset = offsetMinutes(zone, previous);
  for (let next = previous + step; next <= end; next += step) {
    const nextOffset = offsetMinutes(zone, next);
    if (nextOffset !== previousOffset) {
      let low = previous, high = next;
      while (high - low > 1000) { const middle = Math.floor((low + high) / 2000) * 1000; if (offsetMinutes(zone, middle) === previousOffset) low = middle; else high = middle; }
      found.push({at:high, from:previousOffset, to:nextOffset});
    }
    previous = next; previousOffset = nextOffset;
  }
  transitionCache.set(key, found);
  return found;
}
const icsLocal = (c: Clock) => `${pad(c.year,4)}${pad(c.month)}${pad(c.day)}T${pad(c.hour)}${pad(c.minute)}${pad(c.second)}`;
/**
 * A VTIMEZONE built from Intl data for the given years. Transitions with the same
 * offsets share one observance: DTSTART is the first, one RDATE line per later date
 * (ical.js reads only the first value of a multi-value RDATE in VTIMEZONE).
 */
export function vtimezone(zone: string, fromYear: number, toYear: number): string[] {
  const all = transitions(zone, Math.max(1900, fromYear), Math.min(2100, toYear));
  const lines = ['BEGIN:VTIMEZONE', `TZID:${zone}`];
  if (!all.length) {
    const offset = offsetMinutes(zone, Date.UTC(Math.max(1900, fromYear), 0, 1));
    lines.push('BEGIN:STANDARD', `DTSTART:${pad(Math.max(1900, fromYear),4)}0101T000000`, `TZOFFSETFROM:${formatOffset(offset)}`, `TZOFFSETTO:${formatOffset(offset)}`, 'END:STANDARD');
  } else {
    const groups = new Map<string, Transition[]>();
    for (const item of all) { const key = `${item.from}:${item.to}`; groups.set(key, [...(groups.get(key) ?? []), item]); }
    const first = all[0]!;
    // Anchor the first offset so instants before the first transition resolve correctly.
    lines.push('BEGIN:STANDARD', `DTSTART:${pad(Math.max(1900, fromYear),4)}0101T000000`, `TZOFFSETFROM:${formatOffset(first.from)}`, `TZOFFSETTO:${formatOffset(first.from)}`, 'END:STANDARD');
    for (const group of groups.values()) {
      const kind = group[0]!.to > group[0]!.from ? 'DAYLIGHT' : 'STANDARD';
      // Observance DTSTART and RDATE are local times in the offset before the transition.
      const local = group.map(item => icsLocal(wallClock('UTC', item.at + item.from * 60000)));
      lines.push(`BEGIN:${kind}`, `DTSTART:${local[0]}`, ...local.slice(1).map(value => `RDATE:${value}`), `TZOFFSETFROM:${formatOffset(group[0]!.from)}`, `TZOFFSETTO:${formatOffset(group[0]!.to)}`, `END:${kind}`);
    }
  }
  lines.push('END:VTIMEZONE');
  return lines;
}
