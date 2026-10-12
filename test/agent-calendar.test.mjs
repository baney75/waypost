import test from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdtemp, mkdir, readFile, readdir, realpath, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { simpleParser } from 'mailparser';
import * as ac from '../dist/agent-calendar.js';
import { mailSend } from '../dist/mail.js';
import { clearCalendarFeedCache } from '../dist/calendar-feed.js';

// ---------- fixtures (synthetic data only) ----------
const NY = 'BEGIN:VTIMEZONE\r\nTZID:America/New_York\r\nBEGIN:DAYLIGHT\r\nDTSTART:19700308T020000\r\nRRULE:FREQ=YEARLY;BYMONTH=3;BYDAY=2SU\r\nTZOFFSETFROM:-0500\r\nTZOFFSETTO:-0400\r\nEND:DAYLIGHT\r\nBEGIN:STANDARD\r\nDTSTART:19701101T020000\r\nRRULE:FREQ=YEARLY;BYMONTH=11;BYDAY=1SU\r\nTZOFFSETFROM:-0400\r\nTZOFFSETTO:-0500\r\nEND:STANDARD\r\nEND:VTIMEZONE';
const cal = (...parts) => ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Synthetic//EN', ...parts, 'END:VCALENDAR'].join('\r\n') + '\r\n';
const vevent = (...lines) => ['BEGIN:VEVENT', ...lines, 'END:VEVENT'].join('\r\n');
const DENTIST = vevent('UID:dentist@example.com', 'DTSTAMP:20261001T000000Z', 'DTSTART:20261102T150000Z', 'DTEND:20261102T160000Z', 'SUMMARY:Dentist', 'LOCATION:Main Street', 'ORGANIZER:mailto:clinic@example.com', 'ATTENDEE:mailto:owner@example.com');
const LUNCH = vevent('UID:lunch@example.com', 'DTSTAMP:20261001T000000Z', 'DTSTART:20261103T170000Z', 'DTEND:20261103T180000Z', 'SUMMARY:Lunch');
const WINDOW = {from: '2026-10-25T00:00:00Z', to: '2026-12-01T00:00:00Z'};
const unfold = text => text.replace(/\r?\n[ \t]/g, '');
const feedUrl = id => `https://calendar.proton.me/api/calendar/v1/url/${id}/calendar.ics?CacheKey=synthetic-${id}&PassphraseKey=secret-${id}`;

async function workspace(t, {writeEnabled = true, agent = {}, feeds = [], files = [], mail} = {}) {
  const root = await mkdtemp(join(await realpath(tmpdir()), 'waypost-agentcal-'));
  t.after(() => rm(root, {recursive: true, force: true}));
  const feedConfigs = [];
  for (const feed of feeds) {
    const urlFile = join(root, `${feed.id}.url`);
    await writeFile(urlFile, feedUrl(feed.id), {mode: 0o600});
    feedConfigs.push({name: feed.name, urlFile, ...(feed.readOnly ? {readOnly: true} : {})});
  }
  const config = {
    version: 1, artifactsDir: join(root, 'artifacts'), timeoutMs: 2000,
    agentCalendar: {dir: join(root, 'cal'), name: 'Agents', writeEnabled, syncMinutes: 30, owner: 'owner@example.com', organizer: 'agent@example.com', ...agent},
    ...(feedConfigs.length || files.length ? {calendar: {files, feeds: feedConfigs}} : {}),
    ...(mail ? {mail} : {}),
  };
  return {root, config, dir: config.agentCalendar.dir};
}
/** Stub the Proton share-link server. Each feed has a body and an optional ETag; matching If-None-Match gets a 304. */
function protonServer(t) {
  clearCalendarFeedCache();
  t.after(clearCalendarFeedCache);
  const feeds = new Map(), requests = [];
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    const id = /\/url\/([^/]+)\/calendar\.ics/.exec(String(url))?.[1];
    const feed = feeds.get(id);
    requests.push({id, headers: {...init?.headers}});
    if (!feed) return new Response('', {status: 404});
    if (feed.etag && init?.headers?.['If-None-Match'] === feed.etag) return new Response(null, {status: 304});
    return new Response(feed.body, {headers: feed.etag ? {etag: feed.etag} : {}});
  });
  return {requests, set: (id, body, etag) => feeds.set(id, {body, etag})};
}
const mirrorOf = async dir => JSON.parse(await readFile(join(dir, (await readdir(dir)).find(name => /^mirror-.*\.json$/.test(name))), 'utf8'));
const merged = (config, extra = {}) => ac.mergedEvents(config, {...WINDOW, ...extra});
const confirmed = {confirm: true};
async function emlOf(draft) {
  const parsed = await simpleParser(await readFile(draft.path));
  const calendar = parsed.attachments.find(part => /calendar/i.test(part.contentType));
  return {parsed, ics: calendar ? unfold(calendar.content.toString('utf8')) : ''};
}
const sequenceOf = (ics, uid) => Number(new RegExp(`UID:${uid.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[\\s\\S]*?SEQUENCE:(\\d+)`).exec(unfold(ics))?.[1]);

// ---------- write gating ----------
test('every agent write fails closed: disabled first, then confirmation', async t => {
  const calls = {
    calendar_create: config => ac.calendarCreate(config, {summary: 'x', start: '2026-11-02T10:00:00Z', ...confirmed}),
    calendar_update: config => ac.calendarUpdate(config, {uid: 'u@waypost', changes: {summary: 'y'}, ...confirmed}),
    calendar_delete: config => ac.calendarDelete(config, {uid: 'u@waypost', ...confirmed}),
    calendar_propose: config => ac.calendarPropose(config, {source: 'proton/personal', uid: 'u', ...confirmed}),
    calendar_cancel_invite: config => ac.calendarCancelInvite(config, {uid: 'u@waypost', ...confirmed}),
  };
  const off = await workspace(t, {writeEnabled: false});
  for (const [name, call] of Object.entries(calls)) await assert.rejects(call(off.config), {code: 'CALENDAR_WRITE_DISABLED'}, name);
  const on = await workspace(t);
  const noConfirm = {
    calendar_create: config => ac.calendarCreate(config, {summary: 'x', start: '2026-11-02T10:00:00Z'}),
    calendar_update: config => ac.calendarUpdate(config, {uid: 'u@waypost', changes: {summary: 'y'}}),
    calendar_delete: config => ac.calendarDelete(config, {uid: 'u@waypost'}),
    calendar_propose: config => ac.calendarPropose(config, {source: 'proton/personal', uid: 'u'}),
    calendar_cancel_invite: config => ac.calendarCancelInvite(config, {uid: 'u@waypost'}),
  };
  for (const [name, call] of Object.entries(noConfirm)) await assert.rejects(call(on.config), {code: 'CONFIRMATION_REQUIRED'}, name);
  // Nothing was written by any refused call.
  await assert.rejects(stat(join(on.dir, 'store.json')), {code: 'ENOENT'});
  await assert.rejects(stat(join(on.dir, 'audit.jsonl')), {code: 'ENOENT'});
  await assert.rejects(ac.mergedEvents({version: 1, artifactsDir: '/tmp', timeoutMs: 1000}, WINDOW), {code: 'AGENT_CALENDAR_UNCONFIGURED'});
});

// ---------- lifecycle, audit, sequence ----------
test('create, update text, update timing, delete: feed, SEQUENCE and the append-only audit trail', async t => {
  const {config, dir} = await workspace(t);
  const created = await ac.calendarCreate(config, {summary: 'Planning', start: '2026-11-02T10:00:00Z', end: '2026-11-02T11:00:00Z', description: 'Agenda, items; more', location: 'Room 1', ...confirmed});
  const uid = created.uid;
  assert.match(uid, /@waypost$/);
  assert.equal(created.editable, true);
  assert.equal(created.start, '2026-11-02T10:00:00Z');
  let store = await ac.loadStore(config);
  assert.equal(sequenceOf(ac.agentIcs(config, store), uid), 0);
  assert.equal(store.events[uid].origin, 'agent');

  const auditLines = async () => (await readFile(join(dir, 'audit.jsonl'), 'utf8')).split('\n').filter(Boolean);
  const afterCreate = await auditLines();
  assert.equal(afterCreate.length, 1);
  assert.equal(JSON.parse(afterCreate[0]).action, 'create');

  // Text change edits in place and bumps SEQUENCE.
  const text = await ac.calendarUpdate(config, {uid, changes: {summary: 'Planning v2', location: 'Room 2'}, ...confirmed});
  assert.equal(text.sequence, 1);
  assert.equal(text.droppedOverrides, undefined);
  store = await ac.loadStore(config);
  assert.equal(sequenceOf(ac.agentIcs(config, store), uid), 1);
  const view = (await merged(config)).events.find(event => event.uid === uid);
  assert.equal(view.summary, 'Planning v2');
  assert.equal(view.location, 'Room 2');
  assert.equal(view.description, 'Agenda, items; more');
  assert.equal(view.start, '2026-11-02T10:00:00Z');

  // A series with a moved occurrence: a timing change replaces the whole timing and reports the dropped override.
  const weekly = await ac.calendarCreate(config, {summary: 'Weekly sync', start: '2026-11-02T09:00:00', timezone: 'America/New_York', rrule: 'FREQ=WEEKLY;COUNT=4', ...confirmed});
  await ac.mutateStore(config, next => {
    next.events[weekly.uid].ics += '\r\n' + vevent(`UID:${weekly.uid}`, 'DTSTAMP:20261001T000000Z', 'RECURRENCE-ID;TZID=America/New_York:20261109T090000', 'DTSTART;TZID=America/New_York:20261110T100000', 'DURATION:PT1H', 'SUMMARY:Weekly sync (moved)');
  });
  const before = (await merged(config)).events.filter(event => event.uid === weekly.uid);
  assert.deepEqual(before.map(event => event.start), ['2026-11-02T14:00:00Z', '2026-11-10T15:00:00Z', '2026-11-16T14:00:00Z', '2026-11-23T14:00:00Z']);
  const textOnly = await ac.calendarUpdate(config, {uid: weekly.uid, changes: {description: 'Bring notes'}, ...confirmed});
  assert.equal(textOnly.dropped, undefined);
  assert.equal((await merged(config)).events.filter(event => event.uid === weekly.uid).length, 4);
  const timing = await ac.calendarUpdate(config, {uid: weekly.uid, changes: {start: '2026-11-03T08:00:00', timezone: 'America/New_York', rrule: 'FREQ=WEEKLY;COUNT=2'}, ...confirmed});
  assert.deepEqual(timing.dropped, {overrides: 1, exceptionDates: 0});
  assert.match(timing.note, /removed/);
  assert.equal(timing.sequence, 2);
  const after = (await merged(config)).events.filter(event => event.uid === weekly.uid);
  assert.deepEqual(after.map(event => event.start), ['2026-11-03T13:00:00Z', '2026-11-10T13:00:00Z']);
  assert.equal(after[0].summary, 'Weekly sync', 'the summary survives a timing-only rebuild');
  assert.equal(after[0].description, 'Bring notes');
  assert.ok(!ac.agentIcs(config, await ac.loadStore(config)).includes('RECURRENCE-ID'));

  // Timing changes need a start; unknown and repeated deletes are refused.
  await assert.rejects(ac.calendarUpdate(config, {uid, changes: {end: '2026-11-02T12:00:00Z'}, ...confirmed}), {name: 'ZodError'});
  await assert.rejects(ac.calendarUpdate(config, {uid: 'missing@waypost', changes: {summary: 'x'}, ...confirmed}), {code: 'CALENDAR_NOT_AGENT_OWNED'});

  const beforeDelete = await auditLines();
  const deleted = await ac.calendarDelete(config, {uid, ...confirmed});
  assert.equal(deleted.deleted, true);
  store = await ac.loadStore(config);
  assert.ok(store.events[uid].deleted, 'kept in the store, marked deleted');
  const feed = ac.agentIcs(config, store);
  assert.ok(!feed.includes(uid) && feed.includes(weekly.uid));
  assert.ok(!(await merged(config)).events.some(event => event.uid === uid));
  await assert.rejects(ac.calendarDelete(config, {uid, ...confirmed}), {code: 'CALENDAR_NOT_AGENT_OWNED'});
  await assert.rejects(ac.calendarUpdate(config, {uid, changes: {summary: 'zombie'}, ...confirmed}), {code: 'CALENDAR_NOT_AGENT_OWNED'});

  // One line per successful write, in order, and earlier lines never change.
  const finalLines = await auditLines();
  assert.deepEqual(finalLines.map(line => JSON.parse(line).action), ['create', 'update', 'create', 'update', 'update', 'delete']);
  assert.deepEqual(finalLines.slice(0, afterCreate.length), afterCreate);
  assert.deepEqual(finalLines.slice(0, beforeDelete.length), beforeDelete);
  for (const line of finalLines) assert.match(JSON.parse(line).at, /^\d{4}-\d\d-\d\dT.*Z$/);
  assert.equal((await stat(join(dir, 'audit.jsonl'))).mode & 0o777, 0o600);
  assert.equal((await stat(join(dir, 'store.json'))).mode & 0o777, 0o600);
  assert.deepEqual((await readdir(dir)).filter(name => name.endsWith('.tmp') || name === 'store.lock'), [], 'no temp or lock files left behind');
});

// ---------- recurrence edge cases through the merged view ----------
test('merged view: EXDATE, moved override, multi-day all-day and TZID across the November DST change', async t => {
  const root0 = await workspace(t);
  const file = join(root0.root, 'export.ics');
  await writeFile(file, cal(NY,
    vevent('UID:ex@example.com', 'DTSTAMP:20261001T000000Z', 'DTSTART:20261102T100000Z', 'DTEND:20261102T110000Z', 'RRULE:FREQ=WEEKLY;COUNT=4', 'EXDATE:20261109T100000Z', 'SUMMARY:Weekly with a skipped week'),
    vevent('UID:daily@example.com', 'DTSTAMP:20261001T000000Z', 'DTSTART:20261103T120000Z', 'DTEND:20261103T130000Z', 'RRULE:FREQ=DAILY;COUNT=3', 'SUMMARY:Daily'),
    vevent('UID:daily@example.com', 'DTSTAMP:20261001T000000Z', 'RECURRENCE-ID:20261104T120000Z', 'DTSTART:20261106T150000Z', 'DTEND:20261106T160000Z', 'SUMMARY:Daily (moved to Friday)'),
    vevent('UID:trip@example.com', 'DTSTAMP:20261001T000000Z', 'DTSTART;VALUE=DATE:20261110', 'DTEND;VALUE=DATE:20261113', 'SUMMARY:Conference'),
    vevent('UID:dst@example.com', 'DTSTAMP:20261001T000000Z', 'DTSTART;TZID=America/New_York:20261030T090000', 'DTEND;TZID=America/New_York:20261030T100000', 'RRULE:FREQ=DAILY;COUNT=5', 'SUMMARY:Nine local'),
  ), {mode: 0o600});
  const {config} = await workspace(t, {files: [file]});
  const result = await merged(config, {timezone: 'America/New_York'});
  const of = uid => result.events.filter(event => event.uid === uid + '@example.com');
  assert.equal(result.partial, false);
  assert.deepEqual(of('ex').map(event => event.start), ['2026-11-02T10:00:00Z', '2026-11-16T10:00:00Z', '2026-11-23T10:00:00Z']);
  assert.deepEqual(of('daily').map(event => [event.start, event.summary]), [
    ['2026-11-03T12:00:00Z', 'Daily'], ['2026-11-05T12:00:00Z', 'Daily'], ['2026-11-06T15:00:00Z', 'Daily (moved to Friday)']]);
  assert.equal(of('daily').filter(event => event.start.startsWith('2026-11-04')).length, 0, 'the original slot of the moved occurrence is gone');
  const [trip] = of('trip');
  assert.equal(trip.allDay, true);
  assert.equal(trip.start, '2026-11-10');
  assert.equal(trip.end, '2026-11-13', 'all-day end is exclusive: three days');
  // 9:00 local before and after clocks fall back on Sunday 2026-11-01 at 02:00.
  assert.deepEqual(of('dst').map(event => event.start), ['2026-10-30T13:00:00Z', '2026-10-31T13:00:00Z', '2026-11-01T14:00:00Z', '2026-11-02T14:00:00Z', '2026-11-03T14:00:00Z']);
  assert.ok(of('dst').every(event => /T09:00:00/.test(event.startLocal)), 'each occurrence reads 09:00 local');
  assert.ok(result.events.every(event => event.provenance === 'file' && event.editable === false));
});

test('a weekly event created in the agent store keeps 9:00 local across the DST change and publishes its VTIMEZONE', async t => {
  const {config} = await workspace(t);
  const {uid} = await ac.calendarCreate(config, {summary: 'Standup', start: '2026-10-26T09:00:00', timezone: 'America/New_York', rrule: 'FREQ=WEEKLY;COUNT=4', ...confirmed});
  const result = await merged(config, {timezone: 'America/New_York'});
  const mine = result.events.filter(event => event.uid === uid);
  assert.deepEqual(mine.map(event => event.start), ['2026-10-26T13:00:00Z', '2026-11-02T14:00:00Z', '2026-11-09T14:00:00Z', '2026-11-16T14:00:00Z']);
  assert.ok(mine.every(event => /T09:00:00/.test(event.startLocal) && event.editable && event.provenance === 'agent'));
  const feed = ac.agentIcs(config, await ac.loadStore(config));
  const lines = unfold(feed).split(/\r\n/);
  assert.ok(lines.includes('TZID:America/New_York') && lines.includes('DTSTART;TZID=America/New_York:20261026T090000'));
  assert.ok(lines.includes('RDATE:20261101T020000'), 'the published zone carries this year\'s fall-back transition');
  assert.ok(feed.split('\r\n').every(line => line.length <= 75), 'lines are folded');
});

// ---------- sync ----------
test('sync is idempotent: identical bodies keep changedAt, and a validator earns a 304', async t => {
  const server = protonServer(t);
  const {config, dir} = await workspace(t, {feeds: [{id: 'personal', name: 'Personal'}]});
  server.set('personal', cal(DENTIST), '"v1"');

  const first = await ac.syncCalendars(config);
  assert.deepEqual(first.feeds, [{source: 'proton/personal', ok: true, changed: true}]);
  const mirror1 = await mirrorOf(dir);
  assert.equal(mirror1.etag, '"v1"');
  assert.deepEqual(server.requests[0].headers, {Accept: 'text/calendar'}, 'no validators on the first fetch');

  await new Promise(resolve => setTimeout(resolve, 15));
  const second = await ac.syncCalendars(config);
  assert.equal(second.feeds[0].changed, false);
  assert.equal(server.requests.length, 2);
  assert.equal(server.requests[1].headers['If-None-Match'], '"v1"', 'the stored ETag was sent back');
  const mirror2 = await mirrorOf(dir);
  assert.equal(mirror2.changedAt, mirror1.changedAt);
  assert.equal(mirror2.sha256, mirror1.sha256);
  assert.equal(mirror2.content, mirror1.content);
  assert.ok(Date.parse(mirror2.checkedAt) > Date.parse(mirror1.checkedAt), 'a 304 still records that the link was checked');

  // The server changes the body and ETag: changed again, new changedAt.
  await new Promise(resolve => setTimeout(resolve, 15));
  server.set('personal', cal(DENTIST, LUNCH), '"v2"');
  const third = await ac.syncCalendars(config);
  assert.equal(third.feeds[0].changed, true);
  assert.equal(server.requests[2].headers['If-None-Match'], '"v1"');
  const mirror3 = await mirrorOf(dir);
  assert.notEqual(mirror3.changedAt, mirror1.changedAt);
  assert.equal(mirror3.etag, '"v2"');
  assert.ok(!JSON.stringify(mirror3).includes('secret-personal'), 'the share link secret is never stored in the mirror');
});

test('a server without validators returns the same body twice: changed:false, changedAt unchanged', async t => {
  const server = protonServer(t);
  const {config, dir} = await workspace(t, {feeds: [{id: 'personal', name: 'Personal'}]});
  server.set('personal', cal(DENTIST));
  assert.equal((await ac.mirrorFeed(config, config.calendar.feeds[0])).changed, true);
  const first = await mirrorOf(dir);
  await new Promise(resolve => setTimeout(resolve, 15));
  const again = await ac.mirrorFeed(config, config.calendar.feeds[0]);
  assert.equal(again.changed, false);
  assert.equal((await mirrorOf(dir)).changedAt, first.changedAt);
  assert.equal(server.requests[1].headers['If-None-Match'], undefined);
});

test('one failing feed does not stop the others, and a mirror that is not iCalendar is refused', async t => {
  const server = protonServer(t);
  const {config} = await workspace(t, {feeds: [{id: 'personal', name: 'Personal'}, {id: 'broken', name: 'Broken'}]});
  server.set('personal', cal(DENTIST));
  server.set('broken', 'BEGIN:VCALENDAR\r\nthis is not valid\r\nEND:VCALENDAR\r\n');
  const result = await ac.syncCalendars(config);
  assert.deepEqual(result.feeds.map(feed => [feed.source, feed.ok]), [['proton/personal', true], ['proton/broken', false]]);
  assert.ok(result.feeds[1].code, 'a stable error code is reported');
});

// ---------- adoption and duplicate suppression ----------
test('adopt: the agent copy replaces the original in the merged view until the original leaves the share link', async t => {
  const server = protonServer(t);
  const {config} = await workspace(t, {feeds: [{id: 'personal', name: 'Personal'}]});
  server.set('personal', cal(DENTIST, LUNCH));
  const before = await merged(config);
  assert.deepEqual(before.events.map(event => [event.summary, event.provenance, event.editable]), [['Dentist', 'proton/personal', false], ['Lunch', 'proton/personal', false]]);
  assert.equal(before.duplicatesSuppressed, 0);

  const adopted = await ac.calendarPropose(config, {source: 'proton/personal', uid: 'dentist@example.com', mode: 'adopt', changes: {summary: 'Dentist (agent)'}, ...confirmed});
  assert.equal(adopted.editable, true);
  assert.equal(adopted.changedInProton, false);
  assert.equal(adopted.noteDraft.to, 'owner@example.com');
  assert.equal(adopted.noteDraft.sent, false);
  assert.match(adopted.agentUid, /@waypost$/);
  const note = (await simpleParser(await readFile(adopted.noteDraft.path)));
  assert.match(note.subject, /moved to your Agents calendar/);
  assert.equal(note.to.value[0].address, 'owner@example.com');
  assert.equal(note.from.value[0].address, 'agent@example.com');

  const during = await merged(config);
  assert.deepEqual(during.events.map(event => [event.summary, event.provenance, event.editable]), [['Dentist (agent)', 'agent', true], ['Lunch', 'proton/personal', false]]);
  assert.equal(during.duplicatesSuppressed, 1);
  assert.ok(!during.events.some(event => event.uid === 'dentist@example.com'));
  const store = await ac.loadStore(config);
  const copy = store.events[adopted.agentUid];
  assert.equal(copy.origin, 'adopted');
  assert.deepEqual(copy.adoptedFrom, {source: 'proton/personal', uid: 'dentist@example.com'});
  assert.ok(!/ATTENDEE|ORGANIZER/.test(copy.ics), 'the copy drops invitation roles it cannot honor');
  assert.equal(sequenceOf(ac.agentIcs(config, store), adopted.agentUid), 0);
  // The adopted copy is editable like any agent event.
  const edited = await ac.calendarUpdate(config, {uid: adopted.agentUid, changes: {location: 'Side Street'}, ...confirmed});
  assert.equal(edited.sequence, 1);
  assert.equal((await merged(config)).events.find(event => event.uid === adopted.agentUid).location, 'Side Street');
  // Adopting the same original twice would publish two copies; it is refused while the first copy lives.
  await assert.rejects(ac.calendarPropose(config, {source: 'proton/personal', uid: 'dentist@example.com', mode: 'adopt', ...confirmed}), {code: 'CALENDAR_ALREADY_ADOPTED', details: {agentUid: adopted.agentUid}});
  assert.equal(Object.keys((await ac.loadStore(config)).events).length, 1);
  assert.equal((await ac.loadStore(config)).adoptions.filter(item => item.status === 'pending').length, 1);
  // After the user (via the agent) deletes the copy, the original can be adopted again.
  await ac.calendarDelete(config, {uid: adopted.agentUid, ...confirmed});
  const again = await ac.calendarPropose(config, {source: 'proton/personal', uid: 'dentist@example.com', mode: 'adopt', ...confirmed});
  assert.notEqual(again.agentUid, adopted.agentUid);
  assert.equal((await ac.loadStore(config)).adoptions.filter(item => item.status === 'pending').length, 1);
  assert.equal((await merged(config)).events.filter(event => event.provenance === 'agent').length, 1);

  // While the original is still in the link, sync keeps the adoption pending.
  assert.equal((await ac.syncCalendars(config)).adoptionsRetired, 0);
  // The user deletes the original in Proton: the next sync retires the adoption.
  server.set('personal', cal(LUNCH));
  const retired = await ac.syncCalendars(config);
  assert.equal(retired.adoptionsRetired, 1);
  assert.equal((await ac.syncCalendars(config)).adoptionsRetired, 0);
  const finalStore = await ac.loadStore(config);
  // One retired when the first agent copy was deleted, one when the original left the link.
  assert.equal(finalStore.adoptions.filter(item => item.status === 'retired').length, 2);
  assert.ok(finalStore.adoptions.find(item => item.status === 'retired').retiredAt);
  const last = await merged(config);
  assert.equal(last.duplicatesSuppressed, 0);
  assert.deepEqual(last.events.map(event => event.provenance).sort(), ['agent', 'proton/personal']);
  const audits = (await readFile(join(config.agentCalendar.dir, 'audit.jsonl'), 'utf8')).split('\n').filter(Boolean).map(line => JSON.parse(line));
  assert.ok(audits.some(entry => entry.action === 'adoptions_retired' && entry.count === 1 && entry.via === 'sync'));
});

test('a failed feed never retires an adoption', async t => {
  const server = protonServer(t);
  const {config} = await workspace(t, {feeds: [{id: 'personal', name: 'Personal'}]});
  server.set('personal', cal(DENTIST));
  await ac.calendarPropose(config, {source: 'proton/personal', uid: 'dentist@example.com', mode: 'adopt', ...confirmed});
  server.set('personal', 'nope');
  const result = await ac.syncCalendars(config);
  assert.equal(result.feeds[0].ok, false);
  assert.equal(result.adoptionsRetired, 0);
  assert.equal((await ac.loadStore(config)).adoptions[0].status, 'pending');
});

test('propose delete keeps the original visible, flagged pendingRetirement, and prepares a note to the owner', async t => {
  const server = protonServer(t);
  const {config} = await workspace(t, {feeds: [{id: 'personal', name: 'Personal'}]});
  server.set('personal', cal(DENTIST));
  const proposal = await ac.calendarPropose(config, {source: 'proton/personal', uid: 'dentist@example.com', mode: 'delete', ...confirmed});
  assert.equal(proposal.pendingRetirement, true);
  assert.equal(proposal.changedInProton, false);
  assert.equal(proposal.noteDraft.to, 'owner@example.com');
  const {parsed} = await emlOf(proposal.noteDraft);
  assert.match(parsed.subject, /Please delete "Dentist" from Personal/);
  assert.match(parsed.text, /cannot delete Proton events/);
  const view = await merged(config);
  assert.equal(view.duplicatesSuppressed, 0);
  assert.equal(view.events.length, 1);
  assert.equal(view.events[0].pendingRetirement, true);
  assert.equal(view.events[0].uid, 'dentist@example.com');
  assert.equal(Object.keys((await ac.loadStore(config)).events).length, 0, 'nothing was copied into the agent calendar');
  server.set('personal', cal(LUNCH));
  assert.equal((await ac.syncCalendars(config)).adoptionsRetired, 1);
  assert.equal((await merged(config)).events.every(event => !event.pendingRetirement), true);
});

test('without agentCalendar.owner notes are skipped and say why; unknown sources and UIDs are refused', async t => {
  const server = protonServer(t);
  const {config} = await workspace(t, {feeds: [{id: 'personal', name: 'Personal'}], agent: {owner: undefined}});
  server.set('personal', cal(DENTIST));
  const adopted = await ac.calendarPropose(config, {source: 'proton/personal', uid: 'dentist@example.com', ...confirmed});
  assert.equal(adopted.noteDraft, null);
  assert.match(adopted.noteReason, /agentCalendar\.owner/);
  await assert.rejects(ac.calendarPropose(config, {source: 'proton/nope', uid: 'x', ...confirmed}), {code: 'CALENDAR_SOURCE_UNKNOWN'});
  await assert.rejects(ac.calendarPropose(config, {source: 'proton/personal', uid: 'missing@example.com', ...confirmed}), {code: 'CALENDAR_EVENT_NOT_FOUND'});
});

test('read-only calendars refuse adopt, invite, delete and migration', async t => {
  const server = protonServer(t);
  const {config, root, dir} = await workspace(t, {feeds: [{id: 'family', name: 'Family', readOnly: true}]});
  server.set('family', cal(DENTIST));
  for (const mode of ['adopt', 'invite', 'delete']) await assert.rejects(ac.calendarPropose(config, {source: 'proton/family', uid: 'dentist@example.com', mode, ...confirmed}), {code: 'CALENDAR_READ_ONLY'}, mode);
  const file = join(root, 'family.ics');
  await writeFile(file, cal(DENTIST));
  for (const confirm of [false, true]) await assert.rejects(ac.migrateCalendar(config, file, {confirm, source: 'proton/family'}), {code: 'CALENDAR_READ_ONLY'});
  await assert.rejects(stat(join(dir, 'store.json')), {code: 'ENOENT'});
  assert.equal(server.requests.length, 0, 'refused before any network or store access');
  // The merged view still reads it.
  assert.equal((await merged(config)).events[0].provenance, 'proton/family');
});

// ---------- invitations ----------
test('invite proposal prepares an iTIP REQUEST; cancel prepares CANCEL with SEQUENCE 1; mail_send accepts the structure', async t => {
  const server = protonServer(t);
  const {config} = await workspace(t, {feeds: [{id: 'personal', name: 'Personal'}], mail: {host: '127.0.0.1', imapPort: 1, smtpPort: 1, usernameEnv: 'WAYPOST_MAIL_USERNAME', passwordEnv: 'WAYPOST_MAIL_PASSWORD', certificate: '/nonexistent/bridge-cert.pem', sendEnabled: true}});
  server.set('personal', cal(DENTIST));
  const proposal = await ac.calendarPropose(config, {source: 'proton/personal', uid: 'dentist@example.com', mode: 'invite', changes: {summary: 'Dentist (new time)'}, ...confirmed});
  assert.equal(proposal.mode, 'invite');
  assert.equal(proposal.changedInProton, false);
  assert.equal(proposal.noteDraft.to, 'owner@example.com');
  assert.equal(proposal.noteDraft.sent, false);
  const request = await emlOf(proposal.noteDraft);
  assert.equal(request.parsed.headers.get('x-waypost-itip'), 'REQUEST');
  assert.equal(request.parsed.headers.get('x-waypost-prepared'), '1');
  assert.match(request.ics, /METHOD:REQUEST/);
  assert.match(request.ics, /ORGANIZER:mailto:agent@example\.com/);
  assert.match(request.ics, /ATTENDEE;[^\r\n]*mailto:owner@example\.com/);
  assert.match(request.ics, /ATTENDEE;[^\r\n]*PARTSTAT=NEEDS-ACTION/);
  assert.ok(request.ics.includes(`UID:${proposal.inviteUid}`));
  assert.ok(!request.ics.includes('clinic@example.com'), 'the original organizer is replaced');
  assert.match(request.ics, /SUMMARY:Dentist \(new time\)/);
  assert.equal((await ac.loadStore(config)).invites[proposal.inviteUid].sequence, 0);
  assert.equal(Object.keys((await ac.loadStore(config)).events).length, 0, 'an invite is not an agent event');

  const cancel = await ac.calendarCancelInvite(config, {uid: proposal.inviteUid, ...confirmed});
  assert.equal(cancel.cancelled, true);
  const cancelled = await emlOf(cancel.noteDraft);
  assert.equal(cancelled.parsed.headers.get('x-waypost-itip'), 'CANCEL');
  assert.match(cancelled.ics, /METHOD:CANCEL/);
  assert.match(cancelled.ics, /SEQUENCE:1/);
  assert.match(cancelled.ics, /STATUS:CANCELLED/);
  assert.match(cancelled.ics, /ORGANIZER:mailto:agent@example\.com/);
  await assert.rejects(ac.calendarCancelInvite(config, {uid: proposal.inviteUid, ...confirmed}), {code: 'CALENDAR_INVITE_NOT_FOUND'});
  await assert.rejects(ac.calendarCancelInvite(config, {uid: 'never@waypost', ...confirmed}), {code: 'CALENDAR_INVITE_NOT_FOUND'});

  // mail_send: the iTIP draft passes the structure check and only fails at the Bridge steps.
  const hashOf = async draft => createHash('sha256').update(await readFile(draft.path)).digest('hex');
  const send = draft => mailSend(config, {path: draft.path, sha256: draft.sha256, confirm: true});
  assert.equal(await hashOf(proposal.noteDraft), proposal.noteDraft.sha256);
  const saved = {user: process.env.WAYPOST_MAIL_USERNAME, pass: process.env.WAYPOST_MAIL_PASSWORD};
  t.after(() => { for (const [name, value] of [['WAYPOST_MAIL_USERNAME', saved.user], ['WAYPOST_MAIL_PASSWORD', saved.pass]]) { if (value === undefined) delete process.env[name]; else process.env[name] = value; } });
  delete process.env.WAYPOST_MAIL_USERNAME; delete process.env.WAYPOST_MAIL_PASSWORD;
  await assert.rejects(send(proposal.noteDraft), {code: 'MAIL_CREDENTIALS'});
  await assert.rejects(send(cancel.noteDraft), {code: 'MAIL_CREDENTIALS'});
  process.env.WAYPOST_MAIL_USERNAME = 'synthetic'; process.env.WAYPOST_MAIL_PASSWORD = 'synthetic-not-a-secret';
  await assert.rejects(send(proposal.noteDraft), {code: 'MAIL_CERTIFICATE'});
  await assert.rejects(send(cancel.noteDraft), {code: 'MAIL_CERTIFICATE'});
  // A plain note (no calendar part) also passes.
  const note = await ac.calendarPropose(config, {source: 'proton/personal', uid: 'dentist@example.com', mode: 'delete', ...confirmed});
  await assert.rejects(send(note.noteDraft), {code: 'MAIL_CERTIFICATE'});

  // Anything else riding along is rejected before SMTP: extra attachments, or a calendar part without the iTIP marker.
  const forged = async (name, headers, parts) => {
    const eml = Buffer.from(['From: agent@example.com', 'To: owner@example.com', 'Subject: forged', 'X-Waypost-Prepared: 1', ...headers, 'MIME-Version: 1.0', 'Content-Type: multipart/mixed; boundary="b"', '', '--b', 'Content-Type: text/plain', '', 'hello', ...parts, '--b--', ''].join('\r\n'));
    const path = join(config.artifactsDir, `draft-${name}.eml`);
    await writeFile(path, eml, {mode: 0o600});
    return {path, sha256: createHash('sha256').update(eml).digest('hex')};
  };
  const pdf = ['--b', 'Content-Type: application/pdf; name="a.pdf"', 'Content-Disposition: attachment; filename="a.pdf"', 'Content-Transfer-Encoding: base64', '', 'JVBERi0=', ''];
  const ics = ['--b', 'Content-Type: text/calendar; method=REQUEST', 'Content-Disposition: attachment; filename="invite.ics"', '', 'BEGIN:VCALENDAR', 'END:VCALENDAR', ''];
  await assert.rejects(send(await forged('aaaa-1', [], pdf)), {code: 'MAIL_DRAFT'});
  await assert.rejects(send(await forged('aaaa-2', ['X-Waypost-Itip: REQUEST'], [...ics, ...pdf])), {code: 'MAIL_DRAFT'});
  await assert.rejects(send(await forged('aaaa-3', [], ics)), {code: 'MAIL_DRAFT'});
  await assert.rejects(send(await forged('aaaa-4', ['X-Waypost-Itip: PUBLISH'], ics)), {code: 'MAIL_DRAFT'});
  await assert.rejects(send(await forged('aaaa-5', ['X-Waypost-Itip: REQUEST'], [...ics, ...ics, ...ics])), {code: 'MAIL_DRAFT'});
  // The control: the same forged shape with exactly one calendar part and the marker clears the structure check.
  await assert.rejects(send(await forged('aaaa-6', ['X-Waypost-Itip: REQUEST'], ics)), {code: 'MAIL_CERTIFICATE'});
  // A tampered draft fails the digest check first.
  await assert.rejects(mailSend(config, {path: proposal.noteDraft.path, sha256: '0'.repeat(64), confirm: true}), {code: 'MAIL_DIGEST'});
});

test('invitations need distinct organizer and owner addresses', async t => {
  const server = protonServer(t);
  for (const agent of [{organizer: undefined}, {organizer: 'owner@example.com'}, {owner: undefined}]) {
    const {config} = await workspace(t, {feeds: [{id: 'personal', name: 'Personal'}], agent});
    server.set('personal', cal(DENTIST));
    await assert.rejects(ac.calendarPropose(config, {source: 'proton/personal', uid: 'dentist@example.com', mode: 'invite', ...confirmed}), {code: 'CALENDAR_INVITE_UNCONFIGURED'});
    await assert.rejects(ac.calendarCancelInvite(config, {uid: 'x@waypost', ...confirmed}), agent.organizer === 'owner@example.com' ? {code: 'CALENDAR_INVITE_NOT_FOUND'} : {code: 'CALENDAR_INVITE_UNCONFIGURED'});
  }
});

// ---------- migration ----------
test('migration: dry run writes nothing, --confirm imports, rerun is unchanged, an edited event is changed', async t => {
  const {config, root, dir} = await workspace(t);
  const file = join(root, 'export.ics');
  const body = (lunchSummary = 'Lunch') => cal(NY,
    vevent('UID:a@example.com', 'DTSTAMP:20261001T000000Z', 'DTSTART;TZID=America/New_York:20261105T090000', 'DTEND;TZID=America/New_York:20261105T100000', 'RRULE:FREQ=WEEKLY;COUNT=3', 'SUMMARY:Gym', 'ATTENDEE:mailto:friend@example.com', 'ORGANIZER:mailto:friend@example.com'),
    vevent('UID:b@example.com', 'DTSTAMP:20261001T000000Z', 'DTSTART:20261106T170000Z', 'DTEND:20261106T180000Z', `SUMMARY:${lunchSummary}`),
    vevent('UID:c@example.com', 'DTSTAMP:20261001T000000Z', 'DTSTART;VALUE=DATE:20261110', 'DTEND;VALUE=DATE:20261111', 'SUMMARY:Holiday'));
  await writeFile(file, body());
  const options = {source: 'proton/personal'};

  const dry = await ac.migrateCalendar(config, file, {...options, confirm: false});
  assert.equal(dry.dryRun, true);
  assert.deepEqual(dry.counts, {new: 3, changed: 0, unchanged: 0, skipped: 0, deleted: 0});
  assert.deepEqual(dry.preview.map(item => item.summary).sort(), ['Gym', 'Holiday', 'Lunch']);
  assert.deepEqual((await readdir(dir)).filter(name => name !== 'store.lock'), [], 'a dry run writes nothing, not even a store file or audit line');
  await assert.rejects(ac.migrateCalendar(config, file, {source: 'personal', confirm: false}), {code: 'INPUT_INVALID'});

  const imported = await ac.migrateCalendar(config, file, {...options, confirm: true});
  assert.equal(imported.dryRun, false);
  assert.equal(imported.imported, 3);
  assert.deepEqual(imported.counts, {new: 3, changed: 0, unchanged: 0, skipped: 0, deleted: 0});
  assert.equal(imported.retireSteps.length, 4);
  let store = await ac.loadStore(config);
  const events = Object.values(store.events);
  assert.equal(events.length, 3);
  assert.ok(events.every(event => event.origin === 'migrated' && event.importHash && event.adoptedFrom.source === 'proton/personal'));
  assert.ok(events.every(event => event.uid.endsWith('@waypost')), 'migrated events get fresh agent UIDs');
  assert.ok(!events.some(event => /ATTENDEE|ORGANIZER/.test(event.ics)));
  assert.deepEqual(Object.keys(store.timezones), ['America/New_York']);
  assert.equal(store.adoptions.filter(item => item.status === 'pending').length, 3);
  const view = await merged(config, {timezone: 'America/New_York'});
  assert.equal(view.events.filter(event => event.summary === 'Gym').length, 3);
  assert.ok(view.events.filter(event => event.summary === 'Gym').every(event => /T09:00:00/.test(event.startLocal)));

  const rerun = await ac.migrateCalendar(config, file, {...options, confirm: true});
  assert.deepEqual(rerun.counts, {new: 0, changed: 0, unchanged: 3, skipped: 0, deleted: 0});
  assert.equal(rerun.imported, 0);
  assert.equal((await ac.loadStore(config)).adoptions.length, 3);
  assert.deepEqual((await ac.migrateCalendar(config, file, {...options, confirm: false})).preview, []);

  await writeFile(file, body('Lunch with Sam'));
  const changed = await ac.migrateCalendar(config, file, {...options, confirm: false});
  assert.deepEqual(changed.counts, {new: 0, changed: 1, unchanged: 2, skipped: 0, deleted: 0});
  assert.deepEqual(changed.preview.map(item => [item.status, item.summary]), [['changed', 'Lunch with Sam']]);
  const before = (await ac.loadStore(config)).events;
  const applied = await ac.migrateCalendar(config, file, {...options, confirm: true});
  assert.equal(applied.imported, 1);
  store = await ac.loadStore(config);
  assert.equal(Object.keys(store.events).length, 3, 'the changed event updated in place, no duplicate');
  const lunch = Object.values(store.events).find(event => /Lunch with Sam/.test(event.ics));
  assert.equal(lunch.sequence, 1);
  assert.equal(lunch.created, Object.values(before).find(event => event.uid === lunch.uid).created);
  assert.equal(store.adoptions.length, 3);
  const actions = (await readFile(join(dir, 'audit.jsonl'), 'utf8')).split('\n').filter(Boolean).map(line => JSON.parse(line));
  assert.deepEqual(actions.map(entry => entry.action), ['migrate', 'migrate', 'migrate']);
  assert.equal(actions[0].new, 3);
});

test('migration reports events the expander cannot read as skipped and does not import them', async t => {
  const {config, root} = await workspace(t);
  const file = join(root, 'export.ics');
  await writeFile(file, cal(
    vevent('UID:ok@example.com', 'DTSTAMP:20261001T000000Z', 'DTSTART:20261106T170000Z', 'DTEND:20261106T180000Z', 'SUMMARY:Fine'),
    vevent('UID:floating@example.com', 'DTSTAMP:20261001T000000Z', 'DTSTART:20261106T090000', 'DTEND:20261106T100000', 'SUMMARY:Floating time')));
  const dry = await ac.migrateCalendar(config, file, {source: 'proton/personal', confirm: false});
  assert.deepEqual(dry.counts, {new: 1, changed: 0, unchanged: 0, skipped: 1, deleted: 0});
  assert.ok(dry.skippedReasons.length >= 1);
  await ac.migrateCalendar(config, file, {source: 'proton/personal', confirm: true});
  const store = await ac.loadStore(config);
  assert.deepEqual(Object.values(store.events).map(event => /SUMMARY:(.*)\r?\n/.exec(unfold(event.ics))[1]), ['Fine']);
  await assert.rejects(ac.migrateCalendar(config, join(root, 'missing.ics'), {source: 'proton/personal', confirm: false}));
  await writeFile(join(root, 'bad.ics'), 'not a calendar');
  await assert.rejects(ac.migrateCalendar(config, join(root, 'bad.ics'), {source: 'proton/personal', confirm: false}), {code: 'CALENDAR_INVALID'});
});

// ---------- feed tokens ----------
test('feed tokens: only the hash is stored; revoked and malformed tokens get nothing', async t => {
  const {config, dir} = await workspace(t);
  await ac.calendarCreate(config, {summary: 'Visible', start: '2026-11-02T10:00:00Z', ...confirmed});
  const created = await ac.createFeedToken(config, 'Phone');
  const token = /^\/feeds\/([^/]+)\/agents\.ics$/.exec(created.path)[1];
  assert.match(token, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(created.shownOnce, true);
  assert.equal(created.url, null, 'no http config means no absolute URL');

  const body = await ac.feedForToken(config, token);
  assert.match(body, /^BEGIN:VCALENDAR\r\n/);
  assert.match(body, /SUMMARY:Visible/);
  assert.match(body, /X-WR-CALNAME:Agents/);

  const stored = await readFile(join(dir, 'store.json'), 'utf8');
  assert.ok(!stored.includes(token), 'the token itself is never written');
  assert.ok(stored.includes(createHash('sha256').update(token).digest('hex')));
  const audits = await readFile(join(dir, 'audit.jsonl'), 'utf8');
  assert.ok(!audits.includes(token));
  assert.deepEqual(Object.keys((await ac.listFeedTokens(config)).tokens[0]).sort(), ['createdAt', 'id', 'label']);

  for (const bad of ['', 'short', token.slice(1), token + 'A', token.slice(0, 42) + '!', '../' + token.slice(3), token.toLowerCase() === token ? token.toUpperCase() : token.toLowerCase()]) assert.equal(await ac.feedForToken(config, bad), null, bad);

  assert.equal((await ac.revokeFeedToken(config, created.id)).revoked, true);
  assert.equal(await ac.feedForToken(config, token), null);
  await assert.rejects(ac.revokeFeedToken(config, created.id), {code: 'FEED_TOKEN_NOT_FOUND'});
  await assert.rejects(ac.revokeFeedToken(config, 'nope'), {code: 'FEED_TOKEN_NOT_FOUND'});
  await assert.rejects(ac.createFeedToken(config, 'bad\nlabel'), {code: 'INPUT_INVALID'});
  const second = await ac.createFeedToken({...config, http: {host: '127.0.0.1', port: 8787, publicUrl: 'https://waypost.example.com', stateDir: dir, redirectOrigins: []}}, 'Laptop');
  assert.match(second.url, /^https:\/\/waypost\.example\.com\/feeds\/[A-Za-z0-9_-]{43}\/agents\.ics$/);
  assert.notEqual(second.path, created.path);
});

// ---------- free/busy ----------
test('freebusy merges overlapping events into one busy block and reports one conflict', async t => {
  const {config} = await workspace(t);
  const a = await ac.calendarCreate(config, {summary: 'Design review', start: '2026-11-02T10:00:00Z', end: '2026-11-02T11:00:00Z', ...confirmed});
  assert.deepEqual(a.conflicts, []);
  const b = await ac.calendarCreate(config, {summary: 'Vendor call', start: '2026-11-02T10:30:00Z', end: '2026-11-02T11:30:00Z', ...confirmed});
  assert.deepEqual(b.conflicts.map(item => item.uid), [a.uid], 'create reports the overlap');
  await ac.calendarCreate(config, {summary: 'Focus', start: '2026-11-02T13:00:00Z', end: '2026-11-02T14:00:00Z', ...confirmed});
  await ac.calendarCreate(config, {summary: 'Holiday', start: '2026-11-02', allDay: true, ...confirmed});

  const result = await ac.calendarFreeBusy(config, {from: '2026-11-02T00:00:00Z', to: '2026-11-03T00:00:00Z'});
  assert.deepEqual(result.busy, [{start: '2026-11-02T10:00:00Z', end: '2026-11-02T11:30:00Z'}, {start: '2026-11-02T13:00:00Z', end: '2026-11-02T14:00:00Z'}]);
  assert.equal(result.conflicts.length, 1);
  assert.deepEqual([result.conflicts[0].a.summary, result.conflicts[0].b.summary], ['Design review', 'Vendor call']);
  assert.equal(result.conflicts[0].overlapStart, '2026-11-02T10:30:00Z');
  assert.equal(result.conflicts[0].overlapEnd, '2026-11-02T11:00:00Z');
  assert.equal(result.allDayCounted, false);

  const withAllDay = await ac.calendarFreeBusy(config, {from: '2026-11-02T00:00:00Z', to: '2026-11-03T00:00:00Z', includeAllDay: true});
  assert.deepEqual(withAllDay.busy, [{start: '2026-11-02T00:00:00Z', end: '2026-11-03T00:00:00Z'}]);
  assert.equal(withAllDay.conflicts.length, 4, 'the all-day event overlaps each timed one');
  const clipped = await ac.calendarFreeBusy(config, {from: '2026-11-02T10:45:00Z', to: '2026-11-02T13:30:00Z'});
  assert.deepEqual(clipped.busy, [{start: '2026-11-02T10:45:00Z', end: '2026-11-02T11:30:00Z'}, {start: '2026-11-02T13:00:00Z', end: '2026-11-02T13:30:00Z'}]);
  await assert.rejects(ac.calendarFreeBusy(config, {from: '2026-11-03T00:00:00Z', to: '2026-11-02T00:00:00Z'}), {name: 'ZodError'});
  await assert.rejects(ac.calendarFreeBusy(config, {from: '2026-01-01T00:00:00Z', to: '2026-06-01T00:00:00Z'}), {name: 'ZodError'});
});

// ---------- backup and restore ----------
test('backup refuses to overwrite; restore dry-runs, backs up the current store, then replaces it', async t => {
  const {config, root, dir} = await workspace(t);
  const one = await ac.calendarCreate(config, {summary: 'One', start: '2026-11-02T10:00:00Z', ...confirmed});
  await ac.calendarCreate(config, {summary: 'Two', start: '2026-11-03T10:00:00Z', ...confirmed});
  const out = join(root, 'backup.json');
  const backup = await ac.backupStore(config, out);
  assert.equal(backup.events, 2);
  assert.equal(backup.sha256, createHash('sha256').update(await readFile(out)).digest('hex'));
  assert.equal((await stat(out)).mode & 0o777, 0o600);
  await assert.rejects(ac.backupStore(config, out), {code: 'BACKUP_PATH'});
  await assert.rejects(ac.backupStore(config, join(root, 'missing-dir', 'b.json')), {code: 'BACKUP_PATH'});

  await ac.calendarCreate(config, {summary: 'Three', start: '2026-11-04T10:00:00Z', ...confirmed});
  await ac.calendarDelete(config, {uid: one.uid, ...confirmed});
  assert.equal((await ac.loadStore(config)).events[one.uid].deleted !== undefined, true);

  const dry = await ac.restoreStore(config, out, false);
  assert.deepEqual(dry, {dryRun: true, events: 2, next: dry.next});
  assert.equal(Object.keys((await ac.loadStore(config)).events).length, 3, 'a dry run changes nothing');
  assert.deepEqual((await readdir(dir)).filter(name => name.startsWith('store.before-restore')), []);

  const restored = await ac.restoreStore(config, out, true);
  assert.deepEqual(restored, {restored: true, events: 2});
  const store = await ac.loadStore(config);
  assert.deepEqual(Object.values(store.events).map(event => /SUMMARY:(\w+)/.exec(event.ics)[1]).sort(), ['One', 'Two']);
  assert.equal(store.events[one.uid].deleted, undefined, 'the deleted flag came back with the backup');
  const safety = (await readdir(dir)).filter(name => name.startsWith('store.before-restore'));
  assert.equal(safety.length, 1);
  assert.equal(Object.keys(JSON.parse(await readFile(join(dir, safety[0]), 'utf8')).events).length, 3, 'the pre-restore store was saved');
  const lastAudit = JSON.parse((await readFile(join(dir, 'audit.jsonl'), 'utf8')).trim().split('\n').pop());
  assert.deepEqual([lastAudit.action, lastAudit.events], ['restore', 2]);

  await writeFile(join(root, 'wrong.json'), JSON.stringify({events: {}}));
  await writeFile(join(root, 'garbage.json'), 'nope');
  for (const bad of ['wrong.json', 'garbage.json', 'absent.json']) await assert.rejects(ac.restoreStore(config, join(root, bad), true), {code: 'BACKUP_INVALID'}, bad);
});

// ---------- store integrity and locking ----------
test('a lock older than 30 seconds is cleared; a fresh lock makes writers wait', async t => {
  const {config, dir} = await workspace(t);
  await ac.loadStore(config);
  const lock = join(dir, 'store.lock');
  await writeFile(lock, '', {mode: 0o600});
  const old = new Date(Date.now() - 60000);
  await utimes(lock, old, old);
  const created = await ac.calendarCreate(config, {summary: 'After a crash', start: '2026-11-02T10:00:00Z', ...confirmed});
  assert.ok(created.uid);
  await assert.rejects(stat(lock), {code: 'ENOENT'}, 'released after the write');

  // A fresh lock belongs to a live writer: the next writer waits for it instead of stealing it.
  await writeFile(lock, '', {mode: 0o600});
  const started = Date.now();
  const waiting = ac.calendarCreate(config, {summary: 'Waits', start: '2026-11-03T10:00:00Z', ...confirmed});
  await new Promise(resolve => setTimeout(resolve, 400));
  assert.equal(Object.keys((await ac.loadStore(config)).events).length, 1, 'still blocked');
  await rm(lock);
  await waiting;
  assert.ok(Date.now() - started >= 350);
  assert.equal(Object.keys((await ac.loadStore(config)).events).length, 2);
});

test('concurrent writers serialize through the lock without losing events', async t => {
  const {config} = await workspace(t);
  await Promise.all(Array.from({length: 8}, (_, index) => ac.calendarCreate(config, {summary: `Parallel ${index}`, start: `2026-11-0${index + 1}T10:00:00Z`, ...confirmed})));
  const store = await ac.loadStore(config);
  assert.equal(Object.keys(store.events).length, 8);
  assert.equal((await readFile(join(config.agentCalendar.dir, 'audit.jsonl'), 'utf8')).trim().split('\n').length, 8);
});

test('store files must be private and valid: group-readable, corrupt and wrong-shape files are refused', async t => {
  const {config, dir, root} = await workspace(t);
  await ac.calendarCreate(config, {summary: 'x', start: '2026-11-02T10:00:00Z', ...confirmed});
  const path = join(dir, 'store.json');
  const good = await readFile(path, 'utf8');
  await chmod(path, 0o644);
  await assert.rejects(ac.loadStore(config), {code: 'STORE_PERMISSIONS'});
  await chmod(path, 0o600);
  await writeFile(path, '{not json');
  await assert.rejects(ac.loadStore(config), {code: 'STORE_CORRUPT'});
  await writeFile(path, JSON.stringify({version: 2}));
  await assert.rejects(ac.loadStore(config), {code: 'STORE_CORRUPT'});
  await writeFile(path, good);
  assert.equal(Object.keys((await ac.loadStore(config)).events).length, 1);
  // A directory other users can write to is refused outright.
  const loose = join(root, 'loose');
  await mkdir(loose, {mode: 0o777});
  await chmod(loose, 0o777);
  await assert.rejects(ac.loadStore({...config, agentCalendar: {...config.agentCalendar, dir: loose}}), {code: 'ARTIFACT_PERMISSIONS'});
});
