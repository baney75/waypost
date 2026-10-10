import { open } from 'node:fs/promises';
import { constants } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import ICAL from 'ical.js';
import { z } from 'zod';
import { saveArtifact, type Config } from './config.js';
import { WaypostError } from './errors.js';
import { defineTool } from './tool.js';
import { calendarFeedSnapshots } from './calendar-feed.js';
import { isIanaZone, localIso, localToUtc, vtimezone } from './tz.js';

const MAX_SNAPSHOT = 10 * 1024 * 1024;
const MAX_OCCURRENCES = 20000;
const MAX_TIMEZONES = 64;
const MAX_OBSERVANCES = 16;
const MAX_TIMEZONE_RDATES = 512;
const MAX_TIMEZONE_TRANSITIONS = 8192;
const utc = z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/, 'Use a UTC date-time with seconds and Z.').refine(value => {
  const date = new Date(value);
  return Number.isFinite(date.getTime()) && date.toISOString().replace('.000Z', 'Z') === value && date.getUTCFullYear() >= 1900 && date.getUTCFullYear() <= 2100;
}, 'Invalid date-time; supported years are 1900–2100.').describe('UTC date-time with seconds, YYYY-MM-DDTHH:MM:SSZ; years 1900–2100.');
const text = (max: number) => z.string().max(max).refine(value => !/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(value), 'Control characters are not permitted.');
const zoneName = z.string().max(64).refine(isIanaZone, 'Use an IANA timezone name such as America/Chicago.');
export const calendarEventsSchema = z.object({from:utc, to:utc, limit:z.number().int().min(1).max(200).default(50).describe('Maximum returned events, 1–200.'), timezone:zoneName.optional().describe('IANA timezone such as America/Chicago. When set, each timed event also gets startLocal and endLocal in that zone.')}).strict().refine(value => {
  const duration = Date.parse(value.to) - Date.parse(value.from);
  return duration > 0 && duration <= 366 * 86400000;
}, 'Choose a positive range no longer than 366 days.');
export const calendarPrepareSchema = z.object({
  summary:text(500).min(1).describe('Event title, up to 500 characters.'),
  start:z.string().max(25).describe('Start time. Three forms: UTC "2026-10-12T15:00:00Z"; local "2026-10-12T09:00:00" together with timezone; or a day "2026-10-12" together with allDay: true.'),
  end:z.string().max(25).optional().describe('End time in the same form as start. All-day end is exclusive (the day after the last day). Defaults to one day for all-day events and one hour otherwise.'),
  allDay:z.boolean().default(false).describe('true for an all-day event; start and end are then days, YYYY-MM-DD.'),
  timezone:zoneName.optional().describe('IANA timezone such as America/Chicago. Use with local start and end times so the event keeps its wall-clock time across daylight saving changes.'),
  rrule:z.string().max(300).optional().describe('Optional recurrence rule, such as "FREQ=WEEKLY;BYDAY=TU,TH;COUNT=10". FREQ is DAILY, WEEKLY, MONTHLY or YEARLY. UNTIL is a day (YYYYMMDD) for all-day events and UTC (YYYYMMDDTHHMMSSZ) otherwise.'),
  description:text(12000).default('').describe('Event notes, up to 12,000 characters.'),
  location:text(1000).default('').describe('Event location, up to 1,000 characters.'),
}).strict();

async function readSnapshot(path: string) {
  const file = await open(path, constants.O_RDONLY | constants.O_NONBLOCK);
  try {
    const metadata = await file.stat();
    if (!metadata.isFile() || metadata.size > MAX_SNAPSHOT) throw new WaypostError('CALENDAR_SIZE', 'Calendar snapshots must be regular files no larger than 10 MiB.');
    const data = Buffer.alloc(MAX_SNAPSHOT + 1);
    let length = 0;
    while (length < data.length) {
      const result = await file.read(data, length, data.length - length, null);
      if (!result.bytesRead) break;
      length += result.bytesRead;
    }
    if (length > MAX_SNAPSHOT) throw new WaypostError('CALENDAR_SIZE', 'Calendar snapshot exceeds 10 MiB.');
    return {content:data.subarray(0, length).toString('utf8'), mtime:metadata.mtime.toISOString()};
  } finally { await file.close(); }
}

function validateTime(time: ICAL.Time) {
  if (!time.isDate && time.zone === ICAL.Timezone.localTimezone) throw new WaypostError('CALENDAR_TIMEZONE', 'Floating or undeclared timezones are unsupported. Export UTC times or include the referenced VTIMEZONE definition.');
  if (time.year < 1900 || time.year > 2100) throw new WaypostError('CALENDAR_DATE', 'Calendar dates must be between 1900 and 2100.');
}
function validateRawDate(value:unknown) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}:\d{2}Z?)?$/.test(value)) throw new WaypostError('CALENDAR_DATE','Unsupported or invalid calendar date value.');
  const input = value.length === 10 ? value+'T00:00:00Z' : value.endsWith('Z') ? value : value+'Z';
  if (!utc.safeParse(input).success) throw new WaypostError('CALENDAR_DATE','Invalid calendar date; no dates are normalized or inferred.');
}
function validateDateProperty(property:ICAL.Property) {
  // Validate raw jCal dates before ICAL normalizes impossible dates such as February 30.
  const raw:unknown[] = property.jCal.slice(3);
  for (const value of raw) validateRawDate(value);
}
function validateRawUntil(property:ICAL.Property) {
  const raw:unknown[] = property.jCal.slice(3);
  for (const value of raw) {
    if (typeof value === 'object' && value !== null && 'until' in value) validateRawDate(value.until);
  }
}
type TimezoneGap = {start:number; end:number};
function localClock(time:ICAL.Time) { return Date.UTC(time.year,time.month-1,time.day,time.hour,time.minute,time.second); }
function validateRecurrenceLocalTime(time:ICAL.Time, gaps:Map<string,TimezoneGap[]>) {
  validateTime(time);
  if (time.isDate || time.zone === ICAL.Timezone.utcTimezone) return;
  const intervals = gaps.get(time.zone.tzid) ?? [];
  const clock = localClock(time);
  let low = 0, high = intervals.length;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    const interval = intervals[middle];
    if (interval && interval.start <= clock) low = middle + 1; else high = middle;
  }
  const interval = intervals[low-1];
  if (interval && clock < interval.end) throw new WaypostError('CALENDAR_RECURRENCE','Recurrence with a nonexistent local time at a timezone transition is unsupported. Export expanded UTC events instead.');
}
function boundedTimezoneRule(rule:ICAL.Recur) {
  const ranges:Record<string,readonly [number,number]> = {BYMONTH:[1,12],BYMONTHDAY:[-31,31],BYYEARDAY:[-366,366],BYWEEKNO:[-53,53],BYSETPOS:[-366,366],BYHOUR:[0,23],BYMINUTE:[0,59],BYSECOND:[0,59]};
  return rule.freq === 'YEARLY' && Number.isInteger(rule.interval) && rule.interval >= 1 && rule.interval <= 1000 && (rule.count === null || (Number.isInteger(rule.count) && rule.count >= 1 && rule.count <= 1000)) && Object.entries(rule.parts).every(([key,values]) => !values || (values.length <= 1 && values.every(value => {
    if (key === 'BYDAY') return typeof value === 'string' && /^(?:[+-]?[1-5])?(?:MO|TU|WE|TH|FR|SA|SU)$/.test(value);
    const range = ranges[key];
    return typeof value === 'number' && Number.isInteger(value) && range !== undefined && value >= range[0] && value <= range[1] && (!['BYMONTHDAY','BYYEARDAY','BYWEEKNO','BYSETPOS'].includes(key) || value !== 0);
  })));
}
function displayTime(time: ICAL.Time) {
  validateTime(time);
  return time.isDate ? time.toString() : time.convertToZone(ICAL.Timezone.utcTimezone).toString();
}
function timestamp(time: ICAL.Time) {
  validateTime(time);
  // DATE values describe calendar days. They are returned as dates, without an invented timezone.
  return time.isDate ? Date.parse(time.toString() + 'T00:00:00Z') : time.toUnixTime() * 1000;
}
type SnapshotEvent = {uid:string; summary:string; description:string; location:string; start:string; end:string; allDay:boolean; timezone?:string; startLocal?:string; endLocal?:string; source:string; recurrence:boolean};
export async function calendarEvents(config: Config, input: unknown) {
  const query = calendarEventsSchema.parse(input);
  if (!config.calendar || !(config.calendar.files.length || config.calendar.feeds?.length)) throw new WaypostError('CALENDAR_UNCONFIGURED', 'Connect a local ICS export or Proton calendar share link first.');
  const from = Date.parse(query.from), to = Date.parse(query.to);
  const events: SnapshotEvent[] = [];
  const sources: {path:string; mtime:string; fetchedAt?:string; kind?:string; upstreamDelay?:string; timezonesFromRuntime?:string[]}[] = [];
  const skipped: {uid:string; source:string; code:string; message:string}[] = [];
  let skippedCount = 0;
  const skip = (uid:string, source:string, error:WaypostError) => { skippedCount++; if (skipped.length < 20) skipped.push({uid:uid.slice(0,200), source, code:error.code, message:error.message}); };
  let examined = 0, partial = false;
  async function* snapshots() {
    for(const path of config.calendar?.files??[]) yield {path,...await readSnapshot(path),kind:'file'};
    yield* calendarFeedSnapshots(config);
  }
  for await (const snapshot of snapshots()) {
    const {path,content:_,...metadata}=snapshot;
    sources.push({path,...metadata});
    let calendar: ICAL.Component;
    try { calendar = new ICAL.Component(ICAL.parse(snapshot.content)); }
    catch { throw new WaypostError('CALENDAR_INVALID', 'An approved snapshot is not valid iCalendar data.'); }
    if (calendar.name !== 'vcalendar') throw new WaypostError('CALENDAR_INVALID', 'Snapshot must contain a VCALENDAR.');
    const timezoneIds = new Set<string>();
    const timezoneGaps = new Map<string,TimezoneGap[]>();
    // Many exporters name an IANA zone without a VTIMEZONE block. Build that block from
    // the runtime's timezone data instead of guessing the host zone or failing the file.
    const declared = new Set(calendar.getAllSubcomponents('vtimezone').map(zone => String(zone.getFirstPropertyValue('tzid'))));
    const synthesized:string[] = [];
    for (const component of calendar.getAllSubcomponents('vevent')) for (const name of ['dtstart','dtend','recurrence-id','rdate','exdate']) for (const property of component.getAllProperties(name)) {
      const tzid = property.getParameter('tzid');
      if (typeof tzid !== 'string' || declared.has(tzid) || !isIanaZone(tzid) || synthesized.length >= 16) continue;
      calendar.addSubcomponent(new ICAL.Component(ICAL.parse(vtimezone(tzid,1970,2100).join('\r\n'))));
      declared.add(tzid); synthesized.push(tzid);
    }
    if (synthesized.length) sources[sources.length-1]!.timezonesFromRuntime = synthesized;
    const zones = calendar.getAllSubcomponents('vtimezone');
    if (zones.length > MAX_TIMEZONES) throw new WaypostError('CALENDAR_TIMEZONE','Snapshot exceeds the 64 timezone definition limit.');
    for (const zone of zones) {
      const id = zone.getFirstPropertyValue('tzid');
      const observances = zone.getAllSubcomponents();
      if (observances.some(component => !['standard','daylight'].includes(component.name))) throw new WaypostError('CALENDAR_TIMEZONE','VTIMEZONE supports only STANDARD and DAYLIGHT subcomponents.');
      if (typeof id !== 'string' || !id || timezoneIds.has(id) || !observances.length || observances.length > MAX_OBSERVANCES) throw new WaypostError('CALENDAR_TIMEZONE','VTIMEZONE definitions require a unique TZID and 1–16 complete observances.');
      timezoneIds.add(id);
      let dateCount = 0;
      let transitionCount = 0;
      const gaps:TimezoneGap[] = [];
      for (const observance of observances) {
        const start = observance.getFirstProperty('dtstart');
        if (!start || !observance.hasProperty('tzoffsetfrom') || !observance.hasProperty('tzoffsetto')) throw new WaypostError('CALENDAR_TIMEZONE','A timezone observance is incomplete.');
        validateDateProperty(start);
        if (start.type !== 'date-time') throw new WaypostError('CALENDAR_TIMEZONE','Timezone observances require a local DATE-TIME DTSTART.');
        const rules = observance.getAllProperties('rrule');
        if (rules.length > 1) throw new WaypostError('CALENDAR_TIMEZONE','A timezone observance supports at most one YEARLY recurrence rule.');
        for (const property of rules) {
          validateRawUntil(property);
          const rule = property.getFirstValue();
          if (!(rule instanceof ICAL.Recur) || !boundedTimezoneRule(rule)) throw new WaypostError('CALENDAR_TIMEZONE','Timezone observances support only bounded YEARLY rules with one value per BY part and COUNT at most 1,000. Export a simpler VTIMEZONE definition or UTC events.');
        }
        const dates = observance.getAllProperties('rdate');
        for (const property of dates) {
          dateCount += property.jCal.length - 3;
          if (dateCount > MAX_TIMEZONE_RDATES) throw new WaypostError('CALENDAR_TIMEZONE','Timezone definition exceeds the 512 explicit transition date limit.');
          validateDateProperty(property);
          if (property.type !== 'date-time') throw new WaypostError('CALENDAR_TIMEZONE','Timezone transition RDATE values must use DATE-TIME.');
        }
        for (const name of ['tzoffsetfrom','tzoffsetto']) {
          const offset = String(observance.getFirstPropertyValue(name));
          if (!/^[+-](?:0\d|1\d|2[0-3]):[0-5]\d(?::[0-5]\d)?$/.test(offset)) throw new WaypostError('CALENDAR_TIMEZONE','A timezone UTC offset is invalid.');
        }
        const before = observance.getFirstPropertyValue('tzoffsetfrom');
        const after = observance.getFirstPropertyValue('tzoffsetto');
        const initial = start.getFirstValue();
        if (!(before instanceof ICAL.UtcOffset) || !(after instanceof ICAL.UtcOffset) || !(initial instanceof ICAL.Time) || initial.zone !== ICAL.Timezone.localTimezone) throw new WaypostError('CALENDAR_TIMEZONE','Timezone observances require explicit offsets and a local DTSTART.');
        const offsetBefore = before.toSeconds(), shift = after.toSeconds() - offsetBefore;
        const transition = (date:ICAL.Time) => {
          if (++transitionCount > MAX_TIMEZONE_TRANSITIONS) throw new WaypostError('CALENDAR_TIMEZONE','Timezone definition exceeds the 8,192 generated transition limit. Export UTC events instead.');
          if (shift > 0) {
            const clock = localClock(date) + (date.zone === ICAL.Timezone.utcTimezone ? offsetBefore * 1000 : 0);
            gaps.push({start:clock,end:clock+shift*1000});
          }
        };
        transition(initial);
        for (const property of dates) for (const date of property.getValues()) {
          if (!(date instanceof ICAL.Time)) throw new WaypostError('CALENDAR_TIMEZONE','Unsupported timezone transition date.');
          transition(date);
        }
        // ical.js applies only the first value of a multi-value RDATE in a VTIMEZONE; split them so every transition counts.
        for (const property of dates) {
          const values = property.getValues();
          if (values.length < 2) continue;
          observance.removeProperty(property);
          for (const value of values) { const single = new ICAL.Property('rdate', observance); single.setValue(value); observance.addProperty(single); }
        }
        for (const property of rules) {
          const rule = property.getFirstValue();
          if (!(rule instanceof ICAL.Recur)) throw new WaypostError('CALENDAR_TIMEZONE','Invalid timezone recurrence.');
          const iterator = rule.iterator(initial);
          while (true) {
            const date = iterator.next();
            if (!date || date.year > 2100) break;
            transition(date);
          }
        }
      }
      gaps.sort((a,b) => a.start-b.start);
      const merged:TimezoneGap[] = [];
      for (const gap of gaps) {
        const last = merged[merged.length-1];
        if (last && gap.start <= last.end) last.end = Math.max(last.end,gap.end); else merged.push(gap);
      }
      timezoneGaps.set(id,merged);
    }
    const components = calendar.getAllSubcomponents('vevent');
    if (components.length > 20000) throw new WaypostError('CALENDAR_SIZE','Snapshot exceeds the 20,000 event safety limit.');
    const masterUids = new Set<string>();
    const exceptionsByUid = new Map<string,ICAL.Component[]>();
    const usable:ICAL.Component[] = [];
    for (const component of components) {
      const uid = component.getFirstPropertyValue('uid');
      if (typeof uid !== 'string' || !uid || !component.hasProperty('dtstart')) { skip(typeof uid === 'string' ? uid : '', path, new WaypostError('CALENDAR_INVALID','The event has no UID or DTSTART.')); continue; }
      if (component.hasProperty('recurrence-id')) {
        const exceptions = exceptionsByUid.get(uid) ?? [];
        exceptions.push(component); exceptionsByUid.set(uid,exceptions);
      } else {
        if (masterUids.has(uid)) { skip(uid, path, new WaypostError('CALENDAR_INVALID','A second master event reuses this UID; only the first was read.')); continue; }
        masterUids.add(uid);
      }
      usable.push(component);
    }
    // Event-level problems skip that event and are reported in skipped[]; one bad event no longer hides the calendar.
    for (const component of usable) {
      const uid = String(component.getFirstPropertyValue('uid'));
      if (component.hasProperty('recurrence-id') && masterUids.has(uid)) continue;
      const before = events.length;
      try {
      const exceptions = component.hasProperty('recurrence-id') ? [] : exceptionsByUid.get(uid) ?? [];
      // ICAL resolves VTIMEZONE through this component tree, so definitions cannot leak across snapshots.
      for (const related of [component, ...exceptions]) {
        const startProperty = related.getFirstProperty('dtstart');
        const endProperty = related.getFirstProperty('dtend');
        if (endProperty && endProperty.type !== startProperty?.type) throw new WaypostError('CALENDAR_DATE','DTSTART and DTEND must both use DATE or both use DATE-TIME.');
        for (const rule of related.getAllProperties('rrule')) validateRawUntil(rule);
        for (const name of ['dtstart','dtend','recurrence-id','rdate','exdate']) {
          for (const property of related.getAllProperties(name)) {
            validateDateProperty(property);
            const tzid = property.getParameter('tzid');
            if (tzid && !calendar.getTimeZoneByID(String(tzid))) throw new WaypostError('CALENDAR_TIMEZONE', 'A referenced timezone has no VTIMEZONE definition in its snapshot.');
            for (const value of property.getValues()) if (value instanceof ICAL.Time) validateTime(value);
          }
        }
      }
      const event = new ICAL.Event(component,{exceptions,strictExceptions:true});
      const add = (item: ICAL.Event, start: ICAL.Time, end: ICAL.Time, recurrence: boolean) => {
        if (item.component.getFirstPropertyValue('status') === 'CANCELLED') return;
        const startMs = timestamp(start), endMs = timestamp(end);
        if (endMs < startMs) throw new WaypostError('CALENDAR_INVALID', 'An event ends before it starts.');
        if (startMs < to && (endMs > from || (endMs === startMs && startMs >= from))) {
          const tzid = start.isDate || start.zone === ICAL.Timezone.utcTimezone ? null : start.zone?.tzid ?? null;
          events.push({uid:item.uid, summary:(item.summary ?? '').slice(0,500), description:(item.description ?? '').slice(0,12000), location:(item.location ?? '').slice(0,1000), start:displayTime(start), end:displayTime(end), allDay:start.isDate, ...(tzid ? {timezone:tzid} : {}), ...(query.timezone && !start.isDate ? {startLocal:localIso(query.timezone,startMs), endLocal:localIso(query.timezone,endMs)} : {}), source:path, recurrence});
        }
      };
      if (!event.isRecurring()) { add(event, event.startDate, event.endDate, false); continue; }
      for (const rule of component.getAllProperties('rrule')) {
        const recurrence = rule.getFirstValue();
        if (!(recurrence instanceof ICAL.Recur) || !['DAILY','WEEKLY','MONTHLY','YEARLY'].includes(recurrence.freq) || !Number.isInteger(recurrence.interval) || recurrence.interval < 1 || Object.values(recurrence.parts).some(part => part && part.length > 366)) throw new WaypostError('CALENDAR_RECURRENCE', 'Unsupported or excessive recurrence; export expanded events instead.');
        if (recurrence.until) validateTime(recurrence.until);
      }
      // Include moved exceptions even when their original recurrence ID is beyond the query.
      let cutoff = to;
      for (const exception of exceptions) {
        const item = new ICAL.Event(exception,{exceptions:[]});
        const recurrenceMs = timestamp(item.recurrenceId);
        cutoff = Math.max(cutoff, recurrenceMs + 1, to + Math.max(0, recurrenceMs - timestamp(item.startDate)));
      }
      const iterator = event.iterator();
      while (true) {
        if (++examined > MAX_OCCURRENCES) { partial = true; break; }
        const occurrence = iterator.next();
        if (!occurrence) break;
        // ICAL's iterator counts spring-gap times and maps them to a different local clock time.
        // Reject the series until invalid instances can be skipped without consuming COUNT.
        validateRecurrenceLocalTime(occurrence,timezoneGaps);
        const details = event.getOccurrenceDetails(occurrence);
        validateRecurrenceLocalTime(details.startDate,timezoneGaps);
        validateRecurrenceLocalTime(details.endDate,timezoneGaps);
        add(details.item, details.startDate, details.endDate, true);
        if (timestamp(occurrence) >= cutoff) break;
      }
      } catch (error) {
        if (!(error instanceof WaypostError) || !['CALENDAR_DATE','CALENDAR_TIMEZONE','CALENDAR_RECURRENCE','CALENDAR_INVALID'].includes(error.code)) throw error;
        events.length = before;
        skip(uid, path, error);
        continue;
      }
      if (partial) break;
    }
    if (partial) break;
  }
  events.sort((a,b) => a.start.localeCompare(b.start) || a.uid.localeCompare(b.uid));
  const limited = events.length > query.limit;
  const reason = partial ? 'Recurrence expansion reached its 20,000 occurrence safety limit.' : limited ? 'Result limit reached.' : skippedCount ? `${skippedCount} event(s) could not be read and were skipped; see skipped[].` : undefined;
  return {snapshot:true, imported:false, sources, events:events.slice(0,query.limit), partial:partial || limited || skippedCount > 0, ...(reason ? {reason} : {}), ...(skippedCount ? {skipped, skippedCount} : {})};
}

function escapeText(value: string) { return value.replace(/\\/g,'\\\\').replace(/\r\n|\r|\n/g,'\\n').replace(/;/g,'\\;').replace(/,/g,'\\,'); }
function foldLine(value: string) {
  const lines:string[] = []; let line = '';
  for (const character of value) {
    if (Buffer.byteLength(line + character, 'utf8') > 75) { lines.push(line); line = ' '; }
    line += character;
  }
  lines.push(line); return lines.join('\r\n');
}
function icsDate(value:string) { return value.replace(/[-:]/g,''); }
const invalid = (message:string):never => { throw new WaypostError('INPUT_INVALID', message); };
function dayParts(value:string, field:string) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return invalid(`${field} must be a day, YYYY-MM-DD, for an all-day event.`);
  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day || year < 1900 || year > 2100) return invalid(`${field} is not a real date between 1900 and 2100.`);
  return date.getTime();
}
function localParts(value:string, field:string, zone:string) {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/.exec(value);
  if (!match) return invalid(`${field} must be a local time, YYYY-MM-DDTHH:MM:SS without Z or offset, when timezone is set.`);
  const clock = {year:Number(match[1]), month:Number(match[2]), day:Number(match[3]), hour:Number(match[4]), minute:Number(match[5]), second:Number(match[6] ?? 0)};
  dayParts(value.slice(0,10), field);
  if (clock.hour > 23 || clock.minute > 59 || clock.second > 59) return invalid(`${field} has an invalid time of day.`);
  const ms = localToUtc(zone, clock);
  if (ms === null) return invalid(`${field} falls in a daylight saving gap in ${zone} and does not exist. Choose another time.`);
  return {ms, ics:value.replace(/[-:]/g,'').padEnd(15,'0').slice(0,15)};
}
function utcParts(value:string, field:string) {
  if (!utc.safeParse(value).success) return invalid(`${field} must be UTC, YYYY-MM-DDTHH:MM:SSZ. For local wall-clock times pass timezone and omit the Z.`);
  return Date.parse(value);
}
function recurrenceRule(value:string, allDay:boolean, startMs:number) {
  const rule = value.trim().replace(/^RRULE:/i,'').toUpperCase();
  const part = /^(?:FREQ=(?:DAILY|WEEKLY|MONTHLY|YEARLY)|INTERVAL=[1-9]\d{0,2}|COUNT=[1-9]\d{0,3}|UNTIL=\d{8}(?:T\d{6}Z)?|BYDAY=(?:[+-]?[1-5]?(?:MO|TU|WE|TH|FR|SA|SU))(?:,[+-]?[1-5]?(?:MO|TU|WE|TH|FR|SA|SU)){0,6}|BYMONTHDAY=-?\d{1,2}(?:,-?\d{1,2}){0,30}|BYMONTH=\d{1,2}(?:,\d{1,2}){0,11}|BYSETPOS=-?\d{1,3}|WKST=(?:MO|TU|WE|TH|FR|SA|SU))$/;
  const parts = rule.split(';');
  const names = parts.map(item => item.split('=')[0]);
  if (!parts.every(item => part.test(item)) || !names.includes('FREQ') || new Set(names).size !== names.length) return invalid('rrule supports FREQ (DAILY, WEEKLY, MONTHLY, YEARLY), INTERVAL, COUNT, UNTIL, BYDAY, BYMONTHDAY, BYMONTH, BYSETPOS and WKST, each once, for example "FREQ=WEEKLY;BYDAY=MO,WE;COUNT=8".');
  if (names.includes('COUNT') && names.includes('UNTIL')) return invalid('rrule may use COUNT or UNTIL, not both.');
  let recur:ICAL.Recur;
  try { recur = ICAL.Recur.fromString(rule); } catch { return invalid('rrule could not be parsed.'); }
  const until = /UNTIL=(\d{8})(T\d{6}Z)?/.exec(rule);
  if (until) {
    if (allDay && until[2]) return invalid('UNTIL must be a day, YYYYMMDD, for an all-day event.');
    if (!allDay && !until[2]) return invalid('UNTIL must be UTC, YYYYMMDDTHHMMSSZ, for a timed event.');
    if (!recur.until || recur.until.toUnixTime() * 1000 < startMs - 86400000) return invalid('UNTIL must not be before the start.');
  }
  for (const value of recur.parts.BYMONTHDAY ?? []) if (value === 0 || Math.abs(Number(value)) > 31) return invalid('BYMONTHDAY values must be 1–31 or -1 to -31.');
  for (const value of recur.parts.BYMONTH ?? []) if (Number(value) < 1 || Number(value) > 12) return invalid('BYMONTH values must be 1–12.');
  return {rule, untilYear:recur.until?.year ?? null, bounded:Boolean(recur.until || recur.count)};
}
const icsDay = (ms:number) => new Date(ms).toISOString().slice(0,10).replace(/-/g,'');
export async function calendarPrepare(config: Config, input: unknown) {
  const event = calendarPrepareSchema.parse(input);
  const uid = randomUUID() + '@waypost.local';
  let startMs:number, endMs:number, startLine:string, endLine:string, zoneLines:string[] = [];
  const endDefaulted = event.end === undefined;
  if (event.allDay) {
    if (event.timezone) invalid('Omit timezone for an all-day event; all-day dates have no time zone.');
    startMs = dayParts(event.start,'start');
    endMs = event.end === undefined ? startMs + 86400000 : dayParts(event.end,'end');
    startLine = `DTSTART;VALUE=DATE:${icsDay(startMs)}`; endLine = `DTEND;VALUE=DATE:${icsDay(endMs)}`;
  } else if (event.timezone) {
    const start = localParts(event.start,'start',event.timezone);
    startMs = start.ms; startLine = `DTSTART;TZID=${event.timezone}:${start.ics}`;
    if (event.end === undefined) {
      endMs = startMs + 3600000;
      endLine = `DTEND;TZID=${event.timezone}:${localIso(event.timezone,endMs).slice(0,19).replace(/[-:]/g,'')}`;
    } else { const end = localParts(event.end,'end',event.timezone); endMs = end.ms; endLine = `DTEND;TZID=${event.timezone}:${end.ics}`; }
  } else {
    startMs = utcParts(event.start,'start');
    endMs = event.end === undefined ? startMs + 3600000 : utcParts(event.end,'end');
    startLine = `DTSTART:${icsDate(new Date(startMs).toISOString().replace(/\.\d{3}Z$/,'Z'))}`; endLine = `DTEND:${icsDate(new Date(endMs).toISOString().replace(/\.\d{3}Z$/,'Z'))}`;
  }
  if (endMs <= startMs || endMs - startMs > 366 * 86400000) invalid(event.allDay ? 'end must be after start (all-day end is exclusive: use the day after the last day) and at most 366 days later.' : 'end must be after start and at most 366 days later.');
  const recurrence = event.rrule === undefined ? undefined : recurrenceRule(event.rrule, event.allDay, startMs);
  if (event.timezone) {
    const startYear = new Date(startMs).getUTCFullYear();
    zoneLines = vtimezone(event.timezone, startYear - 1, Math.min(2100, recurrence ? (recurrence.untilYear ?? startYear + (recurrence.bounded ? 5 : 20)) + 1 : new Date(endMs).getUTCFullYear() + 1));
  }
  const content = ['BEGIN:VCALENDAR','VERSION:2.0','PRODID:-//Waypost//Local import artifact//EN','CALSCALE:GREGORIAN',...zoneLines,'BEGIN:VEVENT',`UID:${uid}`,`DTSTAMP:${icsDate(new Date().toISOString().replace(/\.\d{3}Z$/,'Z'))}`,startLine,endLine,...(recurrence ? [`RRULE:${recurrence.rule}`] : []),`SUMMARY:${escapeText(event.summary)}`,`DESCRIPTION:${escapeText(event.description)}`,`LOCATION:${escapeText(event.location)}`,'END:VEVENT','END:VCALENDAR'].map(foldLine).join('\r\n') + '\r\n';
  const path = await saveArtifact(config, `event-${randomUUID()}.ics`, content);
  const iso = (ms:number) => event.allDay ? new Date(ms).toISOString().slice(0,10) : new Date(ms).toISOString().replace(/\.\d{3}Z$/,'Z');
  return {path, sha256:createHash('sha256').update(content).digest('hex'), uid, start:iso(startMs), end:iso(endMs), allDay:event.allDay, ...(event.timezone ? {timezone:event.timezone, startLocal:localIso(event.timezone,startMs), endLocal:localIso(event.timezone,endMs)} : {}), ...(recurrence ? {rrule:recurrence.rule} : {}), ...(endDefaulted ? {endDefaulted:true} : {}), imported:false, notifications:false, invitations:false, next:'Import this file from Proton Calendar settings, then open the event and check its calendar, time and reminders.'};
}
export const calendarTools = [
  defineTool({name:'calendar_events', title:'Read calendar snapshots', description:'List events between from and to (UTC, at most 366 days) from configured ICS files and Proton share links, with recurrences expanded. Pass timezone to also get local times. Events that cannot be read are listed in skipped[]. Proton links can lag up to 8 hours; this is not a live calendar.', schema:calendarEventsSchema, readOnly:true, destructive:false, handler:calendarEvents}),
  defineTool({name:'calendar_prepare', title:'Prepare calendar import', description:'Write a new ICS file for the user to import into Proton Calendar. Supports UTC times, local times with an IANA timezone, all-day events and a recurrence rule. Nothing is imported, and no invitations or notifications are sent.', schema:calendarPrepareSchema, readOnly:false, destructive:false, handler:calendarPrepare}),
];
