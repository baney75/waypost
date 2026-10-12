import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import ICAL from 'ical.js';
import { z } from 'zod';
import type { Config } from './config.js';
import { WaypostError } from './errors.js';
import { defineTool } from './tool.js';
import { buildEvent, calendarEvents, calendarEventsSchema, foldLine, readSnapshot, text, utc, zoneName, type EventInput, type Snapshot, type SnapshotEvent } from './calendar.js';
import { feedProvenance, feedUrl, fetchCalendarFeed, feedKey } from './calendar-feed.js';
import { audit, readJson, withLock, writeJson } from './store.js';
import { isIanaZone, localToUtc, vtimezone } from './tz.js';
import { prepareMessage } from './mail.js';

type Feed = NonNullable<Config['calendar']>['feeds'][number];
type AgentConfig = NonNullable<Config['agentCalendar']>;
const storedEvent = z.object({
  uid:z.string(), ics:z.string(), sequence:z.number().int(), created:z.string(), updated:z.string(),
  origin:z.enum(['agent','migrated','adopted']), adoptedFrom:z.object({source:z.string(), uid:z.string()}).optional(),
  importHash:z.string().optional(), deleted:z.string().optional(),
});
const adoption = z.object({source:z.string(), uid:z.string(), agentUid:z.string().nullable(), summary:z.string(), createdAt:z.string(), status:z.enum(['pending','retired']), retiredAt:z.string().optional()});
const invite = z.object({uid:z.string(), sequence:z.number().int(), createdAt:z.string(), source:z.string().optional(), originalUid:z.string().optional(), cancelled:z.string().optional(), ics:z.string()});
const feedToken = z.object({id:z.string(), hash:z.string(), label:z.string(), createdAt:z.string(), revokedAt:z.string().optional()});
const storeSchema = z.object({
  version:z.literal(1), events:z.record(z.string(), storedEvent).default({}), timezones:z.record(z.string(), z.string()).default({}),
  adoptions:z.array(adoption).default([]), invites:z.record(z.string(), invite).default({}), feedTokens:z.array(feedToken).default([]),
});
export type Store = z.output<typeof storeSchema>;
const mirrorSchema = z.object({source:z.string(), content:z.string(), sha256:z.string(), fetchedAt:z.string(), checkedAt:z.string(), etag:z.string().optional(), lastModified:z.string().optional(), changedAt:z.string()});
type Mirror = z.output<typeof mirrorSchema>;

const STORE = 'store.json';
const sha = (value:string) => createHash('sha256').update(value).digest('hex');
const iso = (ms = Date.now()) => new Date(ms).toISOString().replace(/\.\d{3}Z$/,'Z');
export function agentConfig(config:Config):AgentConfig {
  if (!config.agentCalendar) throw new WaypostError('AGENT_CALENDAR_UNCONFIGURED', 'The agent calendar is not set up. Ask the user to run: waypost setup calendar --dir /absolute/private/dir');
  return config.agentCalendar;
}
export async function loadStore(config:Config):Promise<Store> {
  const raw = await readJson<unknown>(agentConfig(config).dir, STORE, () => ({version:1}));
  const parsed = storeSchema.safeParse(raw);
  if (!parsed.success) throw new WaypostError('STORE_CORRUPT', 'The agent calendar store does not match the expected format. Restore it from a backup (waypost store restore).');
  return parsed.data;
}
/** Read, change and write the store under the cross-process lock. */
export async function mutateStore<T>(config:Config, change:(store:Store)=>T | Promise<T>):Promise<T> {
  const dir = agentConfig(config).dir;
  return withLock(dir, async () => {
    const store = await loadStore(config);
    const result = await change(store);
    await writeJson(dir, STORE, store);
    return result;
  });
}

// ---------- iCalendar helpers ----------
function parseCalendar(content:string):ICAL.Component {
  let calendar:ICAL.Component;
  try { calendar = new ICAL.Component(ICAL.parse(content)); } catch { throw new WaypostError('CALENDAR_INVALID', 'The calendar data is not valid iCalendar.'); }
  if (calendar.name !== 'vcalendar') throw new WaypostError('CALENDAR_INVALID', 'Calendar data must contain a VCALENDAR.');
  return calendar;
}
/** Group VEVENTs by UID: the master first, then RECURRENCE-ID overrides. */
export function eventsByUid(calendar:ICAL.Component):Map<string, ICAL.Component[]> {
  const groups = new Map<string, ICAL.Component[]>();
  for (const component of calendar.getAllSubcomponents('vevent')) {
    const uid = component.getFirstPropertyValue('uid');
    if (typeof uid !== 'string' || !uid) continue;
    const list = groups.get(uid) ?? [];
    if (component.hasProperty('recurrence-id')) list.push(component); else list.unshift(component);
    groups.set(uid, list);
  }
  return groups;
}
const serialize = (components:ICAL.Component[]) => components.map(component => component.toString().replace(/\r?\n/g,'\r\n')).join('\r\n');
const tzidsOf = (components:ICAL.Component[]) => [...new Set(components.flatMap(component => component.getAllProperties().map(property => property.getParameter('tzid')).filter((value):value is string => typeof value === 'string')))];
function summaryOf(components:ICAL.Component[]) { return String(components[0]?.getFirstPropertyValue('summary') ?? '').slice(0,200); }
function startOf(components:ICAL.Component[]) { const value = components[0]?.getFirstPropertyValue('dtstart'); return value instanceof ICAL.Time ? value.toString() : null; }

/** The published Agents calendar: only agent-owned, non-deleted events, so nothing appears twice in Proton. */
export function agentIcs(config:Config, store:Store):string {
  const agent = agentConfig(config);
  const events = Object.values(store.events).filter(event => !event.deleted).sort((a,b) => a.uid.localeCompare(b.uid));
  const zones = new Set<string>();
  for (const event of events) for (const group of eventsByUid(parseCalendar(wrap(event.ics))).values()) for (const tzid of tzidsOf(group)) zones.add(tzid);
  // 1970–2037 is the date range Proton Calendar imports, so every event it can show gets correct offsets.
  // An unknown zone is left out: the reader then skips only that event, instead of the feed failing.
  const zoneLines = [...zones].sort().flatMap(tzid => store.timezones[tzid] ? store.timezones[tzid].split(/\r?\n/) : isIanaZone(tzid) ? vtimezone(tzid, 1970, 2037) : []);
  const header = ['BEGIN:VCALENDAR','VERSION:2.0','PRODID:-//Waypost//Agent calendar//EN','CALSCALE:GREGORIAN','METHOD:PUBLISH',`X-WR-CALNAME:${agent.name.replace(/[\\;,]/g,'')}`,'REFRESH-INTERVAL;VALUE=DURATION:PT1H','X-PUBLISHED-TTL:PT1H'];
  const body = events.flatMap(event => event.ics.split(/\r\n/));
  return refold([...header, ...zoneLines, ...body, 'END:VCALENDAR']);
}
/** ical.js folds by characters; unfold everything and fold again at 75 octets as RFC 5545 requires. */
function refold(lines:string[]) {
  return lines.join('\r\n').replace(/\r\n[ \t]/g, '').split('\r\n').map(foldLine).join('\r\n') + '\r\n';
}

// ---------- Proton mirror ----------
const mirrorName = (feed:Feed) => `mirror-${sha(feedKey(feed)).slice(0,16)}.json`;
async function readMirror(config:Config, feed:Feed):Promise<Mirror | null> {
  const raw = await readJson<unknown>(agentConfig(config).dir, mirrorName(feed), () => null);
  const parsed = mirrorSchema.safeParse(raw);
  return parsed.success ? parsed.data : null;
}
/**
 * Refresh one Proton share link into its mirror. Proton answers 304 when nothing changed;
 * an unchanged body keeps changedAt, so repeated syncs are idempotent.
 */
export async function mirrorFeed(config:Config, feed:Feed):Promise<{source:string; changed:boolean; mirror:Mirror}> {
  const dir = agentConfig(config).dir, source = feedProvenance(feed);
  const previous = await readMirror(config, feed);
  const fetched = await fetchCalendarFeed(await feedUrl(config, feed), config.timeoutMs, previous ? {etag:previous.etag, lastModified:previous.lastModified} : {});
  const now = new Date().toISOString();
  let mirror:Mirror, changed:boolean;
  if (fetched.notModified && previous) { mirror = {...previous, checkedAt:now}; changed = false; }
  else {
    parseCalendar(fetched.content);
    const hash = sha(fetched.content);
    changed = previous?.sha256 !== hash;
    mirror = {source, content:fetched.content, sha256:hash, fetchedAt:fetched.fetchedAt, checkedAt:now, changedAt:changed ? now : previous!.changedAt, ...(fetched.etag ? {etag:fetched.etag} : {}), ...(fetched.lastModified ? {lastModified:fetched.lastModified} : {})};
  }
  await withLock(dir, () => writeJson(dir, mirrorName(feed), mirror));
  return {source, changed, mirror};
}
/** Mirror every configured link, then retire adoptions whose human original is gone. Each feed fails on its own. */
export async function syncCalendars(config:Config) {
  const results:{source:string; ok:boolean; changed?:boolean; code?:string}[] = [];
  const present = new Map<string, Set<string>>();
  for (const feed of config.calendar?.feeds ?? []) {
    try {
      const {source, changed, mirror} = await mirrorFeed(config, feed);
      present.set(source, new Set(eventsByUid(parseCalendar(mirror.content)).keys()));
      results.push({source, ok:true, changed});
    } catch (error) { results.push({source:feedProvenance(feed), ok:false, code:error instanceof WaypostError ? error.code : 'SYNC_FAILED'}); }
  }
  let retired = 0;
  if (present.size) await mutateStore(config, store => {
    for (const item of store.adoptions) if (item.status === 'pending' && present.get(item.source) && !present.get(item.source)!.has(item.uid)) { item.status = 'retired'; item.retiredAt = new Date().toISOString(); retired++; }
  });
  if (retired) await audit(agentConfig(config).dir, {action:'adoptions_retired', count:retired, via:'sync'});
  return {syncedAt:new Date().toISOString(), feeds:results, adoptionsRetired:retired};
}

// ---------- Merged view ----------
async function* mergedSnapshots(config:Config, store:Store):AsyncIterable<Snapshot> {
  for (const path of config.calendar?.files ?? []) yield {path, ...await readSnapshot(path), kind:'file', provenance:'file'};
  const staleAfter = agentConfig(config).syncMinutes * 60000;
  for (const feed of config.calendar?.feeds ?? []) {
    let mirror = await readMirror(config, feed);
    let failure:WaypostError | undefined;
    if (!mirror || Date.now() - Date.parse(mirror.checkedAt) > staleAfter) {
      try { mirror = (await mirrorFeed(config, feed)).mirror; }
      catch (error) { failure = error instanceof WaypostError ? error : new WaypostError('CALENDAR_FEED_FAILED', 'Could not refresh the Proton calendar link.'); }
    }
    if (!mirror) throw failure!;
    yield {path:`feed:${feed.name}`, content:mirror.content, mtime:mirror.fetchedAt, fetchedAt:mirror.fetchedAt, kind:'proton_link', provenance:feedProvenance(feed),
      upstreamDelay:'Proton share links can lag calendar changes by up to 8 hours. The mirror is refreshed every few minutes and on demand when older than the sync interval.',
      ...(failure ? {stale:true, error:{code:failure.code, message:'The last refresh failed; this is the most recent mirrored copy.'}} : {})};
  }
  yield {path:`agent:${agentConfig(config).name}`, content:agentIcs(config, store), mtime:new Date().toISOString(), kind:'agent_store', provenance:'agent'};
}
const pendingKey = (source:string, uid:string) => `${source}\n${uid}`;
export async function mergedEvents(config:Config, input:unknown) {
  const query = calendarEventsSchema.parse(input);
  const store = await loadStore(config);
  const result = await calendarEvents(config, {...query, limit:200}, {snapshots:() => mergedSnapshots(config, store)});
  const pending = new Map(store.adoptions.filter(item => item.status === 'pending').map(item => [pendingKey(item.source, item.uid), item]));
  let suppressed = 0;
  const events:(SnapshotEvent & {pendingRetirement?:boolean})[] = [];
  for (const event of result.events) {
    const hit = event.provenance === 'agent' ? undefined : pending.get(pendingKey(event.provenance, event.uid));
    // An adopted original is shown once, as its agent copy. A pending delete request stays visible, flagged.
    if (hit?.agentUid && store.events[hit.agentUid] && !store.events[hit.agentUid]!.deleted) { suppressed++; continue; }
    events.push(hit ? {...event, pendingRetirement:true} : event);
  }
  const limited = events.length > query.limit;
  return {...result, events:events.slice(0, query.limit), partial:result.partial || limited, ...(limited && !result.reason ? {reason:'Result limit reached.'} : {}), duplicatesSuppressed:suppressed,
    agentCalendar:{name:agentConfig(config).name, writeEnabled:agentConfig(config).writeEnabled, events:Object.values(store.events).filter(event => !event.deleted).length},
    editableNote:'editable is true only for agent-owned events. Change a human-owned event with calendar_propose; read-only sources cannot be changed.'};
}

// ---------- Writes ----------
const confirmField = z.boolean().default(false).describe('Set true on this call only after the user approves this exact change.');
const timing = {
  start:z.string().max(25).describe('Start: UTC "2026-10-12T15:00:00Z"; local "2026-10-12T09:00:00" with timezone; or a day "2026-10-12" with allDay: true.'),
  end:z.string().max(25).optional().describe('End in the same form as start. All-day end is exclusive.'),
  allDay:z.boolean().default(false),
  timezone:zoneName.optional().describe('IANA timezone for local start and end times.'),
  rrule:z.string().max(300).optional().describe('Recurrence rule such as "FREQ=WEEKLY;BYDAY=TU;COUNT=10".'),
};
// A bare CR would survive ical.js serialization as a raw line break, so every agent text field normalizes to LF.
const lf = (schema:z.ZodType<string>) => schema.transform(value => value.replace(/\r\n?/g, '\n'));
const textFields = {summary:lf(text(500).min(1)).optional(), description:lf(text(12000)).optional(), location:lf(text(1000)).optional()};
export const calendarCreateSchema = z.object({summary:lf(text(500).min(1)).describe('Event title.'), ...timing, description:lf(text(12000)).default(''), location:lf(text(1000)).default(''), confirm:confirmField}).strict();
const changes = z.object({...textFields, start:timing.start.optional(), end:timing.end, allDay:z.boolean().optional(), timezone:timing.timezone, rrule:z.string().max(300).nullable().optional().describe('New rule, or null to stop repeating. Needs start.')}).strict()
  .refine(value => value.start !== undefined || (value.end === undefined && value.allDay === undefined && value.timezone === undefined && value.rrule === undefined), 'To change timing, give start (plus end, allDay, timezone and rrule as needed); the whole timing is replaced.');
export const calendarUpdateSchema = z.object({uid:z.string().min(1).max(300).describe('UID of an agent-owned event (editable: true in calendar_events).'), changes, confirm:confirmField}).strict();
export const calendarDeleteSchema = z.object({uid:z.string().min(1).max(300), confirm:confirmField}).strict();
export const calendarProposeSchema = z.object({
  source:z.string().regex(/^proton\/[a-z0-9-]{1,40}$/).describe('provenance of the human-owned event, such as "proton/personal".'),
  uid:z.string().min(1).max(300).describe('UID of the human-owned event from calendar_events.'),
  mode:z.enum(['adopt','invite','delete']).default('adopt').describe('adopt (default): move the event into the agent calendar with the changes, and prepare a note asking the user to delete the original. invite: prepare an iTIP invitation with the changed event for the user to accept. delete: prepare a note asking the user to delete the original.'),
  changes:changes.optional(),
  confirm:confirmField,
}).strict();
export const calendarCancelInviteSchema = z.object({uid:z.string().min(1).max(300).describe('UID returned by an earlier invite proposal.'), confirm:confirmField}).strict();
export const calendarFreeBusySchema = z.object({from:utc, to:utc, timezone:zoneName.optional(), includeAllDay:z.boolean().default(false).describe('Count all-day events as busy.')}).strict()
  .refine(value => { const span = Date.parse(value.to) - Date.parse(value.from); return span > 0 && span <= 62 * 86400000; }, 'Choose a positive range of at most 62 days.');

function requireWrite(config:Config, confirm:boolean) {
  const agent = agentConfig(config);
  if (!agent.writeEnabled) throw new WaypostError('CALENDAR_WRITE_DISABLED', 'Agent calendar writes are off. The user can enable them with agentCalendar.writeEnabled in the Waypost config.');
  if (!confirm) throw new WaypostError('CONFIRMATION_REQUIRED', 'This calendar write needs confirm: true on this call. Show the user the exact change first.');
  return agent;
}
function eventInput(fields:{summary:string; description:string; location:string; start:string; end?:string | undefined; allDay:boolean; timezone?:string | undefined; rrule?:string | null | undefined}):EventInput {
  return {summary:fields.summary, description:fields.description, location:fields.location, start:fields.start, allDay:fields.allDay, ...(fields.end !== undefined ? {end:fields.end} : {}), ...(fields.timezone !== undefined ? {timezone:fields.timezone} : {}), ...(fields.rrule ? {rrule:fields.rrule} : {})};
}
const KEPT = ['status','categories','url','class','transp','priority','attach'];
const droppedNote = (dropped:{overrides:number; exceptionDates:number}) => dropped.overrides || dropped.exceptionDates ? {dropped, note:`The timing changed, so ${dropped.overrides} moved occurrence(s) and ${dropped.exceptionDates} cancelled or added date(s) from the old series were removed.`} : {};
const wrap = (ics:string) => `BEGIN:VCALENDAR\r\nVERSION:2.0\r\n${ics}\r\nEND:VCALENDAR`;
/**
 * Apply changes to an event group. Text changes edit the master in place. A timing change
 * rebuilds the master through the same validator as calendar_create, and drops overrides and
 * EXDATEs that belonged to the old timing (reported, never silent).
 */
function applyChanges(components:ICAL.Component[], change:z.output<typeof changes> | undefined, uid:string, sequence:number, created:number) {
  const master = components[0];
  if (!master) throw new WaypostError('CALENDAR_INVALID', 'The event has no master component.');
  const current = {summary:String(master.getFirstPropertyValue('summary') ?? ''), description:String(master.getFirstPropertyValue('description') ?? ''), location:String(master.getFirstPropertyValue('location') ?? '')};
  if (change?.start !== undefined) {
    const built = buildEvent(eventInput({...current, ...Object.fromEntries(Object.entries({summary:change.summary, description:change.description, location:change.location}).filter(([,value]) => value !== undefined)), start:change.start, end:change.end, allDay:change.allDay ?? false, timezone:change.timezone, rrule:change.rrule}), uid, {sequence, created});
    if (!built.vevent.some(line => line.startsWith('SUMMARY:') && line.length > 8)) throw new WaypostError('INPUT_INVALID', 'The event needs a summary.');
    const rebuilt = eventsByUid(parseCalendar(wrap(built.vevent.join('\r\n')))).get(uid)!;
    // Alarms and descriptive properties survive a timing change; exceptions tied to the old timing do not.
    for (const name of KEPT) for (const property of master.getAllProperties(name)) rebuilt[0]!.addProperty(new ICAL.Property(property.toJSON()));
    for (const alarm of master.getAllSubcomponents('valarm')) rebuilt[0]!.addSubcomponent(new ICAL.Component(alarm.toJSON()));
    const exceptions = master.getAllProperties('exdate').length + master.getAllProperties('rdate').length;
    return {ics:serialize(rebuilt), dropped:{overrides:components.length - 1, exceptionDates:exceptions}, timezone:change.timezone};
  }
  for (const component of components) {
    component.updatePropertyWithValue('uid', uid);
    component.updatePropertyWithValue('sequence', sequence);
    component.updatePropertyWithValue('dtstamp', ICAL.Time.fromJSDate(new Date(), true));
    component.updatePropertyWithValue('last-modified', ICAL.Time.fromJSDate(new Date(), true));
    for (const name of ['attendee','organizer']) component.removeAllProperties(name);
  }
  for (const name of ['summary','description','location'] as const) {
    if (change?.[name] === undefined) continue;
    // A moved occurrence that copied the series text follows the rename; one with its own text keeps it.
    for (const override of components.slice(1)) if (String(override.getFirstPropertyValue(name) ?? '') === current[name]) override.updatePropertyWithValue(name, change[name]);
    master.updatePropertyWithValue(name, change[name]);
  }
  return {ics:serialize(components), dropped:{overrides:0, exceptionDates:0}, timezone:undefined};
}
async function conflictsFor(config:Config, startMs:number, endMs:number, excludeUid:string) {
  if (!Number.isFinite(startMs) || endMs <= startMs) return [];
  const from = iso(startMs - 1000), to = iso(Math.min(endMs, startMs + 366 * 86400000 - 2000) + 1000);
  try {
    const result = await mergedEvents(config, {from, to, limit:200});
    return result.events.filter(event => event.uid !== excludeUid && !event.allDay && Date.parse(event.start) < endMs && Date.parse(event.end) > startMs).slice(0,20).map(event => ({uid:event.uid, summary:event.summary, start:event.start, end:event.end, provenance:event.provenance}));
  } catch { return []; }
}
const feedNote = 'Proton refreshes a subscribed calendar every 4 to 16 hours, so this change reaches Proton and its notifications on that schedule, not instantly.';
export async function calendarCreate(config:Config, input:unknown) {
  const request = calendarCreateSchema.parse(input);
  const agent = requireWrite(config, request.confirm);
  const uid = `${randomUUID()}@waypost`;
  const now = Date.now();
  const built = buildEvent(eventInput(request), uid, {sequence:0, created:now});
  const ics = serialize(eventsByUid(parseCalendar(wrap(built.vevent.join('\r\n')))).get(uid)!);
  await mutateStore(config, store => { store.events[uid] = {uid, ics, sequence:0, created:iso(now), updated:iso(now), origin:'agent'}; });
  await audit(agent.dir, {action:'create', uid, sha256:sha(ics), via:'calendar_create'});
  return {uid, created:true, calendar:agent.name, editable:true, start:iso(built.startMs), end:iso(built.endMs), ...(built.recurrence ? {rrule:built.recurrence.rule} : {}), conflicts:await conflictsFor(config, built.startMs, built.endMs, uid), delivery:feedNote};
}
export async function calendarUpdate(config:Config, input:unknown) {
  const request = calendarUpdateSchema.parse(input);
  const agent = requireWrite(config, request.confirm);
  const result = await mutateStore(config, store => {
    const event = store.events[request.uid];
    if (!event || event.deleted) throw new WaypostError('CALENDAR_NOT_AGENT_OWNED', 'No agent-owned event has that UID. Human-owned events change through calendar_propose.');
    const sequence = event.sequence + 1;
    const changed = applyChanges(eventsByUid(parseCalendar(wrap(event.ics))).get(event.uid) ?? [], request.changes, event.uid, sequence, Date.parse(event.created));
    store.events[event.uid] = {...event, ics:changed.ics, sequence, updated:new Date().toISOString()};
    return {sequence, dropped:changed.dropped, ics:changed.ics};
  });
  await audit(agent.dir, {action:'update', uid:request.uid, sequence:result.sequence, sha256:sha(result.ics), via:'calendar_update'});
  const group = eventsByUid(parseCalendar(wrap(result.ics))).get(request.uid) ?? [];
  return {uid:request.uid, updated:true, sequence:result.sequence, start:startOf(group), ...droppedNote(result.dropped), delivery:feedNote};
}
export async function calendarDelete(config:Config, input:unknown) {
  const request = calendarDeleteSchema.parse(input);
  const agent = requireWrite(config, request.confirm);
  await mutateStore(config, store => {
    const event = store.events[request.uid];
    if (!event || event.deleted) throw new WaypostError('CALENDAR_NOT_AGENT_OWNED', 'No agent-owned event has that UID. Waypost never deletes events in Proton; use calendar_propose with mode "delete" for a human-owned event.');
    event.deleted = new Date().toISOString();
    // With the agent copy gone, the Proton original is the only copy again and must show.
    for (const item of store.adoptions) if (item.status === 'pending' && item.agentUid === request.uid) { item.status = 'retired'; item.retiredAt = event.deleted; }
  });
  await audit(agent.dir, {action:'delete', uid:request.uid, via:'calendar_delete'});
  return {uid:request.uid, deleted:true, recoverable:'The event is kept in the store, marked deleted, and leaves the published feed. Restore it with waypost store restore from a backup if needed.', delivery:feedNote};
}
function humanFeed(config:Config, source:string):Feed {
  const feed = (config.calendar?.feeds ?? []).find(item => feedProvenance(item) === source);
  if (!feed) throw new WaypostError('CALENDAR_SOURCE_UNKNOWN', `No configured Proton calendar has provenance ${JSON.stringify(source)}. Use a provenance value from calendar_events.`);
  if (feed.readOnly) throw new WaypostError('CALENDAR_READ_ONLY', `${feed.name} is read-only for agents. Waypost will not adopt, change, invite against or ask to delete its events.`);
  return feed;
}
async function originalEvent(config:Config, feed:Feed, uid:string) {
  const mirror = await readMirror(config, feed) ?? (await mirrorFeed(config, feed)).mirror;
  const group = eventsByUid(parseCalendar(mirror.content)).get(uid);
  if (!group?.length) throw new WaypostError('CALENDAR_EVENT_NOT_FOUND', 'That UID is not in the mirrored Proton calendar. Refresh with calendar_events and use its uid.');
  const zones = new Map(parseCalendar(mirror.content).getAllSubcomponents('vtimezone').map(zone => [String(zone.getFirstPropertyValue('tzid')), zone.toString().replace(/\r?\n/g,'\r\n')]));
  // An event whose timezone is neither defined in the export nor a real IANA zone cannot be published correctly.
  if (tzidsOf(group).some(tzid => !zones.has(tzid) && !isIanaZone(tzid))) throw new WaypostError('CALENDAR_TIMEZONE', 'That event uses a timezone the calendar does not define. Fix its timezone in Proton first.');
  return {group, zones};
}
async function noteDraft(config:Config, subject:string, body:string, ical?:{method:'REQUEST' | 'CANCEL'; content:string}) {
  const agent = agentConfig(config);
  if (!agent.owner) return {noteDraft:null, noteReason:'Set agentCalendar.owner to the user\'s Proton address to prepare notes and invitations.'};
  const from = agent.organizer ?? agent.owner;
  const draft = await prepareMessage(config, {from, to:[agent.owner], cc:[], subject, text:body, ...(ical ? {ical} : {})});
  return {noteDraft:{...draft, to:agent.owner, from, sent:false, next:'Show the user this note. Send it with mail_send (path, sha256, confirm: true) only after they approve.'}};
}
export async function calendarPropose(config:Config, input:unknown) {
  const request = calendarProposeSchema.parse(input);
  const agent = requireWrite(config, request.confirm);
  const feed = humanFeed(config, request.source);
  const {group, zones} = await originalEvent(config, feed, request.uid);
  const summary = summaryOf(group), when = startOf(group) ?? 'unknown time';
  if (request.mode === 'delete') {
    await mutateStore(config, store => { store.adoptions = store.adoptions.filter(item => !(item.status === 'pending' && item.source === request.source && item.uid === request.uid)); store.adoptions.push({source:request.source, uid:request.uid, agentUid:null, summary, createdAt:new Date().toISOString(), status:'pending'}); });
    await audit(agent.dir, {action:'propose_delete', source:request.source, uid:request.uid, via:'calendar_propose'});
    return {mode:'delete', source:request.source, uid:request.uid, pendingRetirement:true, changedInProton:false, ...await noteDraft(config, `Please delete "${summary}" from ${feed.name}`, `An agent asked to remove this event from your ${feed.name} calendar:\n\n${summary}\n${when}\n\nOpen it in Proton Calendar and choose Delete if you agree. Waypost cannot delete Proton events.`)};
  }
  const now = Date.now();
  if (request.mode === 'adopt') {
    const uid = `${randomUUID()}@waypost`;
    const changed = applyChanges(group.map(component => new ICAL.Component(component.toJSON())), request.changes, uid, 0, now);
    await mutateStore(config, store => {
      const taken = store.adoptions.find(item => item.status === 'pending' && item.source === request.source && item.uid === request.uid && item.agentUid);
      if (taken && store.events[taken.agentUid!] && !store.events[taken.agentUid!]!.deleted) throw new WaypostError('CALENDAR_ALREADY_ADOPTED', `That event is already adopted as ${taken.agentUid}. Change the agent copy with calendar_update.`, {agentUid:taken.agentUid});
      for (const tzid of tzidsOf(group)) { const zone = zones.get(tzid); if (zone && !store.timezones[tzid]) store.timezones[tzid] = zone; }
      store.events[uid] = {uid, ics:changed.ics, sequence:0, created:iso(now), updated:iso(now), origin:'adopted', adoptedFrom:{source:request.source, uid:request.uid}};
      store.adoptions = store.adoptions.filter(item => !(item.status === 'pending' && item.source === request.source && item.uid === request.uid));
      store.adoptions.push({source:request.source, uid:request.uid, agentUid:uid, summary, createdAt:new Date().toISOString(), status:'pending'});
    });
    await audit(agent.dir, {action:'adopt', source:request.source, uid:request.uid, agentUid:uid, sha256:sha(changed.ics), via:'calendar_propose'});
    return {mode:'adopt', agentUid:uid, source:request.source, uid:request.uid, editable:true, changedInProton:false, ...droppedNote(changed.dropped), duplicateHandling:'Agents see only the agent copy until the original disappears from the Proton share link.', delivery:feedNote,
      ...await noteDraft(config, `"${summary}" moved to your ${agent.name} calendar`, `An agent took over this event so it can keep it up to date:\n\n${summary}\n${when}\n\nIt now lives in your ${agent.name} calendar (subscribed in Proton). Delete the original from ${feed.name} so it does not show twice on your phone.`)};
  }
  const organizer = agent.organizer, owner = agent.owner;
  if (!organizer || !owner || organizer.toLowerCase() === owner.toLowerCase()) throw new WaypostError('CALENDAR_INVITE_UNCONFIGURED', 'Invitations need agentCalendar.organizer (a sending address you own, different from the attendee) and agentCalendar.owner (the address that receives the invite).');
  const uid = `${randomUUID()}@waypost`;
  const changed = applyChanges([new ICAL.Component(group[0]!.toJSON())], request.changes, uid, 0, now);
  const content = itip('REQUEST', changed.ics, organizer, owner, tzidsOf(group).map(tzid => zones.get(tzid)).filter((zone):zone is string => !!zone));
  await mutateStore(config, store => { store.invites[uid] = {uid, sequence:0, createdAt:new Date().toISOString(), source:request.source, originalUid:request.uid, ics:changed.ics}; });
  await audit(agent.dir, {action:'propose_invite', source:request.source, uid:request.uid, inviteUid:uid, via:'calendar_propose'});
  return {mode:'invite', inviteUid:uid, source:request.source, uid:request.uid, changedInProton:false, note:'Proton adds invitations to the calendar when they arrive and lets the user accept. Accepting creates a new event; the original stays until the user deletes it.',
    ...await noteDraft(config, `Invitation: ${summary}`, `An agent proposes this change to "${summary}" (${when}). Accept to add the updated event, then delete the original from ${feed.name}.`, {method:'REQUEST', content})};
}
function itip(method:'REQUEST' | 'CANCEL', ics:string, organizer:string, attendee:string, zones:string[]) {
  const calendar = parseCalendar(wrap(ics));
  const event = calendar.getFirstSubcomponent('vevent')!;
  event.removeAllProperties('organizer'); event.removeAllProperties('attendee');
  event.addPropertyWithValue('organizer', `mailto:${organizer}`);
  const person = event.addPropertyWithValue('attendee', `mailto:${attendee}`);
  person.setParameter('partstat', method === 'CANCEL' ? 'DECLINED' : 'NEEDS-ACTION'); person.setParameter('rsvp', 'TRUE'); person.setParameter('role', 'REQ-PARTICIPANT');
  if (method === 'CANCEL') event.updatePropertyWithValue('status', 'CANCELLED');
  return refold(['BEGIN:VCALENDAR','VERSION:2.0','PRODID:-//Waypost//Agent calendar//EN','CALSCALE:GREGORIAN',`METHOD:${method}`,...zones.flatMap(zone => zone.split(/\r\n/)),...event.toString().split(/\r?\n/),'END:VCALENDAR']);
}
export async function calendarCancelInvite(config:Config, input:unknown) {
  const request = calendarCancelInviteSchema.parse(input);
  const agent = requireWrite(config, request.confirm);
  if (!agent.organizer || !agent.owner) throw new WaypostError('CALENDAR_INVITE_UNCONFIGURED', 'Set agentCalendar.organizer and agentCalendar.owner first.');
  const sent = await mutateStore(config, store => {
    const item = store.invites[request.uid];
    if (!item || item.cancelled) throw new WaypostError('CALENDAR_INVITE_NOT_FOUND', 'No open invitation has that UID. Only invitations Waypost prepared can be cancelled.');
    item.sequence += 1; item.cancelled = new Date().toISOString();
    const group = eventsByUid(parseCalendar(wrap(item.ics))).get(item.uid) ?? [];
    group[0]?.updatePropertyWithValue('sequence', item.sequence);
    return {ics:serialize(group), summary:summaryOf(group)};
  });
  await audit(agent.dir, {action:'cancel_invite', uid:request.uid, via:'calendar_cancel_invite'});
  return {uid:request.uid, cancelled:true, ...await noteDraft(config, `Cancelled: ${sent.summary}`, `The agent withdrew the invitation for "${sent.summary}".`, {method:'CANCEL', content:itip('CANCEL', sent.ics, agent.organizer, agent.owner, [])})};
}
export async function calendarFreeBusy(config:Config, input:unknown) {
  const query = calendarFreeBusySchema.parse(input);
  const result = await mergedEvents(config, {from:query.from, to:query.to, limit:200, ...(query.timezone ? {timezone:query.timezone} : {})});
  const from = Date.parse(query.from), to = Date.parse(query.to);
  // An all-day event covers whole days in the caller's timezone when one is given, otherwise in UTC.
  const day = (value:string) => { const [y, m, d] = value.split('-').map(Number); return query.timezone ? localToUtc(query.timezone, {year:y!, month:m!, day:d!, hour:0, minute:0, second:0}) ?? Date.parse(value + 'T00:00:00Z') : Date.parse(value + 'T00:00:00Z'); };
  const relevant = result.events.filter(event => query.includeAllDay || !event.allDay).map(event => ({...event, s:Math.max(from, event.allDay ? day(event.start) : Date.parse(event.start)), e:Math.min(to, event.allDay ? day(event.end) : Date.parse(event.end))})).filter(event => event.e > event.s).sort((a,b) => a.s - b.s);
  const busy:{start:string; end:string}[] = [];
  let open:{s:number; e:number} | null = null;
  for (const event of relevant) { if (open && event.s <= open.e) open.e = Math.max(open.e, event.e); else { if (open) busy.push({start:iso(open.s), end:iso(open.e)}); open = {s:event.s, e:event.e}; } }
  if (open) busy.push({start:iso(open.s), end:iso(open.e)});
  const conflicts:{a:{uid:string; summary:string; provenance:string}; b:{uid:string; summary:string; provenance:string}; overlapStart:string; overlapEnd:string}[] = [];
  for (let i = 0; i < relevant.length && conflicts.length < 50; i++) for (let j = i + 1; j < relevant.length && relevant[j]!.s < relevant[i]!.e && conflicts.length < 50; j++) {
    const a = relevant[i]!, b = relevant[j]!;
    if (a.uid === b.uid && a.provenance === b.provenance) continue;
    conflicts.push({a:{uid:a.uid, summary:a.summary, provenance:a.provenance}, b:{uid:b.uid, summary:b.summary, provenance:b.provenance}, overlapStart:iso(b.s), overlapEnd:iso(Math.min(a.e, b.e))});
  }
  return {from:query.from, to:query.to, busy, conflicts, allDayCounted:query.includeAllDay, partial:result.partial, sources:result.sources.map(source => ({path:source.path, provenance:source.provenance, stale:source.stale ?? false}))};
}

// ---------- Feed tokens ----------
export async function createFeedToken(config:Config, label:string) {
  if (!/^[\p{L}\p{N} ._-]{1,60}$/u.test(label)) throw new WaypostError('INPUT_INVALID', 'Use a label of 1–60 letters, digits, spaces, dots, dashes or underscores.');
  const token = randomBytes(32).toString('base64url'), id = randomBytes(4).toString('hex');
  await mutateStore(config, store => { store.feedTokens.push({id, hash:sha(token), label, createdAt:new Date().toISOString()}); });
  await audit(agentConfig(config).dir, {action:'feed_token_create', id, via:'cli'});
  const path = `/feeds/${token}/agents.ics`;
  return {id, label, url:config.http ? new URL(path, config.http.publicUrl).href : null, path, shownOnce:true, next:'Subscribe to this URL in Proton Calendar (Add calendar from URL) and turn on its notifications. Treat it like a password; revoke it with waypost calendar feed revoke <id>.'};
}
export async function revokeFeedToken(config:Config, id:string) {
  const found = await mutateStore(config, store => { const item = store.feedTokens.find(token => token.id === id && !token.revokedAt); if (item) item.revokedAt = new Date().toISOString(); return !!item; });
  if (!found) throw new WaypostError('FEED_TOKEN_NOT_FOUND', 'No active feed link has that id. Run waypost calendar feed list.');
  await audit(agentConfig(config).dir, {action:'feed_token_revoke', id, via:'cli'});
  return {id, revoked:true, effect:'The URL stops working on the next request. Proton keeps showing the last copy it fetched until you remove the subscription.'};
}
export async function listFeedTokens(config:Config) {
  const store = await loadStore(config);
  return {tokens:store.feedTokens.map(({hash:_, ...token}) => token)};
}
/** Returns the feed body for a valid, unrevoked token; null otherwise. Only the SHA-256 of a token is stored. */
export async function feedForToken(config:Config, token:string):Promise<string | null> {
  if (!/^[A-Za-z0-9_-]{43}$/.test(token)) return null;
  const store = await loadStore(config);
  const hash = sha(token);
  return store.feedTokens.some(item => !item.revokedAt && item.hash === hash) ? agentIcs(config, store) : null;
}

// ---------- Migration ----------
export async function migrateCalendar(config:Config, file:string, options:{confirm:boolean; source:string}) {
  const agent = agentConfig(config);
  if (!/^proton\/[a-z0-9-]{1,40}$/.test(options.source)) throw new WaypostError('INPUT_INVALID', 'Use --source like proton/personal.');
  if ((config.calendar?.feeds ?? []).some(feed => feedProvenance(feed) === options.source && feed.readOnly)) throw new WaypostError('CALENDAR_READ_ONLY', 'That calendar is read-only for agents and cannot be migrated.');
  const {content} = await readSnapshot(file);
  const calendar = parseCalendar(content);
  const groups = eventsByUid(calendar);
  const zones = new Map(calendar.getAllSubcomponents('vtimezone').map(zone => [String(zone.getFirstPropertyValue('tzid')), zone.toString().replace(/\r?\n/g,'\r\n')]));
  // Check every event with the same expander calendar_events uses, over the year ahead, before anything is written.
  const now = Date.now();
  const checked = await calendarEvents(config, {from:iso(now - 30 * 86400000), to:iso(now + 330 * 86400000), limit:1}, {snapshots:async function* () { yield {path:file, content, mtime:new Date().toISOString(), kind:'file'}; }});
  const unreadable = new Set((checked.skipped ?? []).map(item => item.uid));
  const store = await loadStore(config);
  const existing = new Map(Object.values(store.events).filter(event => event.origin === 'migrated' && event.adoptedFrom?.source === options.source).map(event => [event.adoptedFrom!.uid, event]));
  const plan = [...groups].map(([uid, group]) => {
    const hash = sha(serialize(group));
    const previous = existing.get(uid);
    const status = unreadable.has(uid) ? 'skipped' : previous?.deleted ? 'deleted' : !previous ? 'new' : previous.importHash === hash ? 'unchanged' : 'changed';
    const participants = group.reduce((total, component) => total + component.getAllProperties('attendee').length + component.getAllProperties('organizer').length, 0);
    return {uid, group, hash, previous, status, participants, summary:summaryOf(group), start:startOf(group)};
  });
  const counts = Object.fromEntries(['new','changed','unchanged','skipped','deleted'].map(status => [status, plan.filter(item => item.status === status).length]));
  // The Agents feed is published, so attendee and organizer lines are not copied; say how many.
  const participantsRemoved = plan.filter(item => item.status === 'new' || item.status === 'changed').reduce((total, item) => total + item.participants, 0);
  const preview = plan.filter(item => item.status !== 'unchanged').slice(0,50).map(item => ({status:item.status, uid:item.uid, summary:item.summary, start:item.start}));
  if (!options.confirm) return {dryRun:true, file, source:options.source, counts, participantsRemoved, ...(counts.deleted ? {deletedNote:'Events you deleted from the agent calendar stay deleted.'} : {}), preview, ...(checked.skippedCount ? {skippedReasons:checked.skipped} : {}), next:'Review the diff, then run the same command with --confirm.'};
  const nowIso = new Date().toISOString();
  await mutateStore(config, next => {
    for (const [tzid, zone] of zones) if (!next.timezones[tzid]) next.timezones[tzid] = zone;
    for (const item of plan) {
      if (item.status !== 'new' && item.status !== 'changed') continue;
      const uid = item.previous?.uid ?? `${randomUUID()}@waypost`;
      const copy = item.group.map(component => new ICAL.Component(component.toJSON()));
      for (const component of copy) { component.updatePropertyWithValue('uid', uid); component.removeAllProperties('attendee'); component.removeAllProperties('organizer'); }
      const sequence = item.previous ? item.previous.sequence + 1 : 0;
      copy[0]?.updatePropertyWithValue('sequence', sequence);
      next.events[uid] = {uid, ics:serialize(copy), sequence, created:item.previous?.created ?? nowIso, updated:nowIso, origin:'migrated', adoptedFrom:{source:options.source, uid:item.uid}, importHash:item.hash};
      if (!next.adoptions.some(entry => entry.status === 'pending' && entry.source === options.source && entry.uid === item.uid)) next.adoptions.push({source:options.source, uid:item.uid, agentUid:uid, summary:item.summary, createdAt:nowIso, status:'pending'});
    }
  });
  await audit(agent.dir, {action:'migrate', source:options.source, ...counts, via:'cli'});
  return {dryRun:false, file, source:options.source, counts, participantsRemoved, imported:counts.new! + counts.changed!, retireSteps:[
    `Subscribe to the ${agent.name} feed in Proton first (waypost calendar feed create) and wait until its events appear.`,
    `In Proton Calendar, open each migrated event in the source calendar and delete it, or export a backup and delete the old calendar only if it holds nothing else.`,
    'Waypost hides the originals from agents while they still exist, and marks each adoption retired once the original leaves the share link.',
    'Keep the exported ICS file as your backup until you have checked the new calendar on your phone.',
  ]};
}

// ---------- Backup and restore ----------
export async function backupStore(config:Config, out:string) {
  const store = await loadStore(config);
  const content = JSON.stringify({waypostBackup:1, createdAt:new Date().toISOString(), store}, null, 1) + '\n';
  const file = await open(out, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600).catch(() => { throw new WaypostError('BACKUP_PATH', 'Choose a new backup file path; existing files are never overwritten.'); });
  try { await file.writeFile(content); } finally { await file.close(); }
  return {path:out, sha256:sha(content), events:Object.keys(store.events).length, includesFeedTokenHashes:true};
}
export async function restoreStore(config:Config, path:string, confirm:boolean) {
  const {content} = await readSnapshot(path).catch(() => { throw new WaypostError('BACKUP_INVALID', 'The backup file could not be read.'); });
  let parsed:Store;
  try { const raw = JSON.parse(content) as {waypostBackup?:number; store?:unknown}; if (raw.waypostBackup !== 1) throw new Error(); parsed = storeSchema.parse(raw.store); }
  catch { throw new WaypostError('BACKUP_INVALID', 'That file is not a Waypost store backup.'); }
  if (!confirm) return {dryRun:true, events:Object.keys(parsed.events).length, next:'Run again with --confirm to replace the current store. The current store is backed up first.'};
  const dir = agentConfig(config).dir;
  await withLock(dir, async () => {
    const current = await loadStore(config);
    await writeJson(dir, `store.before-restore-${Date.now()}.json`, current);
    await writeJson(dir, STORE, parsed);
  });
  await audit(dir, {action:'restore', events:Object.keys(parsed.events).length, via:'cli'});
  return {restored:true, events:Object.keys(parsed.events).length};
}

export const agentCalendarTools = [
  defineTool({name:'calendar_create', title:'Create an agent calendar event', description:'Create an event in the agent calendar, which the user subscribes to in Proton. Off unless agentCalendar.writeEnabled; needs confirm: true after the user approves. Returns overlapping events as conflicts. Proton picks up changes every 4–16 hours.', schema:calendarCreateSchema, readOnly:false, destructive:false, handler:calendarCreate}),
  defineTool({name:'calendar_update', title:'Change an agent calendar event', description:'Change an agent-owned event (editable: true). Text fields change in place; giving start replaces the whole timing. Needs confirm: true.', schema:calendarUpdateSchema, readOnly:false, destructive:false, handler:calendarUpdate}),
  defineTool({name:'calendar_delete', title:'Remove an agent calendar event', description:'Remove an agent-owned event from the published agent calendar. It stays in the local store marked deleted. Never touches Proton events. Needs confirm: true.', schema:calendarDeleteSchema, readOnly:false, destructive:true, handler:calendarDelete}),
  defineTool({name:'calendar_propose', title:'Propose a change to a human-owned event', description:'For an event the user owns in Proton: adopt it into the agent calendar with changes (default), prepare an invitation with the change, or ask the user to delete it. Prepares a note or iTIP draft for mail_send; never changes Proton directly. Read-only calendars are refused. Needs confirm: true.', schema:calendarProposeSchema, readOnly:false, destructive:false, handler:calendarPropose}),
  defineTool({name:'calendar_cancel_invite', title:'Withdraw a proposed invitation', description:'Prepare an iTIP CANCEL for an invitation Waypost prepared earlier. Needs confirm: true; send it with mail_send.', schema:calendarCancelInviteSchema, readOnly:false, destructive:false, handler:calendarCancelInvite}),
  defineTool({name:'calendar_freebusy', title:'Free/busy and conflicts', description:'Merged busy intervals and overlapping events across every calendar (agent and Proton) for up to 62 days. All-day events are ignored unless includeAllDay is true.', schema:calendarFreeBusySchema, readOnly:true, destructive:false, handler:calendarFreeBusy}),
];
