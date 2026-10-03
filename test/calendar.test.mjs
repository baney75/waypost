import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import ICAL from 'ical.js';
import { calendarEvents, calendarPrepare } from '../dist/calendar.js';

const zone = `BEGIN:VTIMEZONE\nTZID:America/New_York\nBEGIN:DAYLIGHT\nDTSTART:19700308T020000\nRRULE:FREQ=YEARLY;BYMONTH=3;BYDAY=2SU\nTZOFFSETFROM:-0500\nTZOFFSETTO:-0400\nEND:DAYLIGHT\nBEGIN:STANDARD\nDTSTART:19701101T020000\nRRULE:FREQ=YEARLY;BYMONTH=11;BYDAY=1SU\nTZOFFSETFROM:-0400\nTZOFFSETTO:-0500\nEND:STANDARD\nEND:VTIMEZONE`;
const wrap = content => `BEGIN:VCALENDAR\nVERSION:2.0\nPRODID:-//Synthetic tests//EN\n${content}\nEND:VCALENDAR\n`.replace(/\n/g,'\r\n');
async function fixture(t,content) {
  const root = await mkdtemp(join(tmpdir(),'waypost-calendar-'));
  t.after(() => rm(root,{recursive:true,force:true}));
  const file = join(root,'snapshot.ics');
  await writeFile(file,wrap(content));
  return {version:1, artifactsDir:join(root,'artifacts'), calendar:{files:[file]}, timeoutMs:1000};
}
const query = {from:'2026-03-06T00:00:00Z',to:'2026-03-12T00:00:00Z'};

test('snapshot recurrence stays at 9am local across DST and excludes EXDATE', async t => {
  const config = await fixture(t,`${zone}\nBEGIN:VEVENT\nUID:dst-synthetic\nDTSTART;TZID=America/New_York:20260306T090000\nDTEND;TZID=America/New_York:20260306T100000\nRRULE:FREQ=DAILY;COUNT=5\nEXDATE;TZID=America/New_York:20260307T090000\nSUMMARY:Synthetic daily event\nEND:VEVENT`);
  const result = await calendarEvents(config,query);
  assert.deepEqual(result.events.map(event => event.start),['2026-03-06T14:00:00Z','2026-03-08T13:00:00Z','2026-03-09T13:00:00Z','2026-03-10T13:00:00Z']);
  assert.equal(result.events[1].end,'2026-03-08T14:00:00Z');
  assert.equal(result.snapshot,true);
  assert.equal(result.imported,false);
  assert.equal(result.partial,false);
  assert.match(result.sources[0].mtime,/Z$/);
});

test('spring-gap recurrence fails explicitly instead of shifting a nonexistent occurrence or consuming COUNT', async t => {
  const config=await fixture(t,`${zone}\nBEGIN:VEVENT\nUID:spring-gap\nDTSTART;TZID=America/New_York:20260306T023000\nDURATION:PT1H\nRRULE:FREQ=DAILY;COUNT=5\nSUMMARY:Gap recurrence\nEND:VEVENT`);
  // RFC 5545 §3.3.10 requires March 8 to be ignored without consuming COUNT.
  // Until the recurrence engine supports that accounting, the adapter must reject the series.
  await assert.rejects(calendarEvents(config,query),error => error.code==='CALENDAR_RECURRENCE' && /nonexistent local time/i.test(error.message));
});

test('timezone recurrence expansion fails fast in a heap-limited child before hostile subdaily rules can run', async t => {
  for (const rule of ['FREQ=SECONDLY;COUNT=1000000000','FREQ=YEARLY;COUNT=1000000000','FREQ=YEARLY;BYMONTH=1,2,3,4,5,6,7,8,9,10,11,12']) {
    const config=await fixture(t,`BEGIN:VTIMEZONE\nTZID:SyntheticZone\nBEGIN:STANDARD\nDTSTART:20260306T000000\nRRULE:${rule}\nTZOFFSETFROM:+0000\nTZOFFSETTO:+0100\nEND:STANDARD\nEND:VTIMEZONE\nBEGIN:VEVENT\nUID:hostile-zone\nDTSTART;TZID=SyntheticZone:20260307T090000\nDURATION:PT1H\nEND:VEVENT`);
    const script=`import {calendarEvents} from ${JSON.stringify(new URL('../dist/calendar.js',import.meta.url).href)};try {await calendarEvents(JSON.parse(process.env.WAYPOST_TEST_CALENDAR),${JSON.stringify(query)});console.log(JSON.stringify({unexpectedSuccess:true}));}catch(error){console.log(JSON.stringify({code:error.code}));}`;
    const output=execFileSync(process.execPath,['--max-old-space-size=64','--input-type=module','-e',script],{encoding:'utf8',timeout:2500,maxBuffer:8192,env:{WAYPOST_TEST_CALENDAR:JSON.stringify(config)}});
    assert.equal(JSON.parse(output).code,'CALENDAR_TIMEZONE');
  }
});

test('timezone observances and explicit transition dates are bounded before timezone hydration', async t => {
  const observance=`BEGIN:STANDARD\nDTSTART:20260306T000000\nTZOFFSETFROM:+0000\nTZOFFSETTO:+0100\nEND:STANDARD`;
  const values=Array.from({length:513},()=> '20260306T000000').join(',');
  const contents=[
    `BEGIN:VTIMEZONE\nTZID:TooManyObservances\n${Array.from({length:17},()=>observance).join('\n')}\nEND:VTIMEZONE`,
    `BEGIN:VTIMEZONE\nTZID:TooManyDates\nBEGIN:STANDARD\nDTSTART:20260306T000000\nRDATE:${values}\nTZOFFSETFROM:+0000\nTZOFFSETTO:+0100\nEND:STANDARD\nEND:VTIMEZONE`,
    Array.from({length:65},(_,index)=> `BEGIN:VTIMEZONE\nTZID:Zone${index}\n${observance}\nEND:VTIMEZONE`).join('\n'),
  ];
  for(const content of contents) await assert.rejects(calendarEvents(await fixture(t,content),query),{code:'CALENDAR_TIMEZONE'});
});

test('unknown timezone child cannot bypass recurrence bounds or reach expansion', async t => {
  const config=await fixture(t,`BEGIN:VTIMEZONE\nTZID:SyntheticZone\nBEGIN:STANDARD\nDTSTART:20260306T000000\nTZOFFSETFROM:+0000\nTZOFFSETTO:+0100\nEND:STANDARD\nBEGIN:X-UNVALIDATED\nDTSTART:20260306T000000\nRRULE:FREQ=SECONDLY;COUNT=1000000000\nTZOFFSETFROM:+0000\nTZOFFSETTO:+0100\nEND:X-UNVALIDATED\nEND:VTIMEZONE\nBEGIN:VEVENT\nUID:hidden-observance\nDTSTART;TZID=SyntheticZone:20260307T090000\nDURATION:PT1H\nEND:VEVENT`);
  const script=`import {calendarEvents} from ${JSON.stringify(new URL('../dist/calendar.js',import.meta.url).href)};try {await calendarEvents(JSON.parse(process.env.WAYPOST_TEST_CALENDAR),${JSON.stringify(query)});console.log(JSON.stringify({unexpectedSuccess:true}));}catch(error){console.log(JSON.stringify({code:error.code}));}`;
  const output=execFileSync(process.execPath,['--max-old-space-size=64','--input-type=module','-e',script],{encoding:'utf8',timeout:2500,maxBuffer:8192,env:{WAYPOST_TEST_CALENDAR:JSON.stringify(config)}});
  assert.equal(JSON.parse(output).code,'CALENDAR_TIMEZONE');
});

test('impossible UNTIL is rejected before recurrence normalization; valid inclusive UNTIL remains supported', async t => {
  const window={from:'2026-02-27T00:00:00Z',to:'2026-03-04T00:00:00Z'};
  const content=until => `BEGIN:VEVENT\nUID:until-validation\nDTSTART:20260227T090000Z\nDURATION:PT1H\nRRULE:FREQ=DAILY;UNTIL=${until}\nSUMMARY:UNTIL validation\nEND:VEVENT`;
  const invalid=await fixture(t,content('20260230T090000Z'));
  await assert.rejects(calendarEvents(invalid,window),{code:'CALENDAR_DATE'});
  const valid=await fixture(t,content('20260228T090000Z'));
  const result=await calendarEvents(valid,window);
  assert.deepEqual(result.events.map(event => event.start),['2026-02-27T09:00:00Z','2026-02-28T09:00:00Z']);
  assert.equal(result.partial,false);
});

test('DTSTART and DTEND must use matching DATE or DATE-TIME types, including exception events', async t => {
  for (const pair of [
    'DTSTART;VALUE=DATE:20260306\nDTEND:20260307T090000Z',
    'DTSTART:20260306T090000Z\nDTEND;VALUE=DATE:20260307',
    'DTSTART;VALUE=DATE:20260306\nDTEND:20260307T090000Z\nRRULE:FREQ=DAILY;COUNT=2',
  ]) {
    const config=await fixture(t,`BEGIN:VEVENT\nUID:date-type-mismatch\n${pair}\nSUMMARY:Invalid date types\nEND:VEVENT`);
    await assert.rejects(calendarEvents(config,query),{code:'CALENDAR_DATE'});
  }
  const exception=await fixture(t,`BEGIN:VEVENT\nUID:mismatched-exception\nDTSTART:20260306T090000Z\nDURATION:PT1H\nRRULE:FREQ=DAILY;COUNT=2\nEND:VEVENT\nBEGIN:VEVENT\nUID:mismatched-exception\nRECURRENCE-ID:20260307T090000Z\nDTSTART;VALUE=DATE:20260307\nDTEND:20260308T090000Z\nEND:VEVENT`);
  await assert.rejects(calendarEvents(exception,query),{code:'CALENDAR_DATE'});
});

test('recurrence overrides replace occurrences; cancelled override is omitted', async t => {
  const config = await fixture(t,`BEGIN:VEVENT\nUID:exception-synthetic\nDTSTART:20260306T090000Z\nDTEND:20260306T100000Z\nRRULE:FREQ=DAILY;COUNT=3\nSUMMARY:Original\nEND:VEVENT\nBEGIN:VEVENT\nUID:exception-synthetic\nRECURRENCE-ID:20260307T090000Z\nDTSTART:20260307T110000Z\nDTEND:20260307T120000Z\nSUMMARY:Moved\nEND:VEVENT\nBEGIN:VEVENT\nUID:exception-synthetic\nRECURRENCE-ID:20260308T090000Z\nDTSTART:20260308T090000Z\nDTEND:20260308T100000Z\nSTATUS:CANCELLED\nSUMMARY:Cancelled\nEND:VEVENT`);
  const result = await calendarEvents(config,query);
  assert.deepEqual(result.events.map(event => [event.start,event.summary]),[['2026-03-06T09:00:00Z','Original'],['2026-03-07T11:00:00Z','Moved']]);
});

test('floating and undeclared timezones fail without host timezone assumptions', async t => {
  for (const date of ['DTSTART:20260306T090000','DTSTART;TZID=America/New_York:20260306T090000']) {
    const config = await fixture(t,`BEGIN:VEVENT\nUID:floating-synthetic\n${date}\nDURATION:PT1H\nSUMMARY:Unsupported\nEND:VEVENT`);
    await assert.rejects(calendarEvents(config,query),{code:'CALENDAR_TIMEZONE'});
  }
});

test('malformed dates and incomplete declared zones fail rather than inventing dates', async t => {
  for (const content of [
    'BEGIN:VEVENT\nUID:invalid-date\nDTSTART:20260230T090000Z\nDURATION:PT1H\nEND:VEVENT',
    'BEGIN:VTIMEZONE\nTZID:EmptyZone\nEND:VTIMEZONE\nBEGIN:VEVENT\nUID:empty-zone\nDTSTART;TZID=EmptyZone:20260306T090000\nDURATION:PT1H\nEND:VEVENT',
  ]) {
    const config=await fixture(t,content);
    await assert.rejects(calendarEvents(config,query),error => ['CALENDAR_DATE','CALENDAR_TIMEZONE'].includes(error.code));
  }
});

test('exceptions are scoped to UID and moved occurrences beyond the query are still included', async t => {
  const config=await fixture(t,`BEGIN:VEVENT\nUID:first\nDTSTART:20260306T090000Z\nDURATION:PT1H\nRRULE:FREQ=DAILY;COUNT=10\nSUMMARY:First\nEND:VEVENT\nBEGIN:VEVENT\nUID:second\nDTSTART:20260306T090000Z\nDURATION:PT1H\nRRULE:FREQ=DAILY;COUNT=2\nSUMMARY:Second\nEND:VEVENT\nBEGIN:VEVENT\nUID:first\nRECURRENCE-ID:20260313T090000Z\nDTSTART:20260308T120000Z\nDURATION:PT1H\nSUMMARY:Moved back\nEND:VEVENT\nBEGIN:VEVENT\nUID:second\nRECURRENCE-ID:20260306T090000Z\nDTSTART:20260306T110000Z\nDURATION:PT1H\nSUMMARY:Only second moved\nEND:VEVENT`);
  const result=await calendarEvents(config,query);
  assert.ok(result.events.some(event => event.uid==='first' && event.start==='2026-03-06T09:00:00Z' && event.summary==='First'));
  assert.ok(result.events.some(event => event.uid==='second' && event.start==='2026-03-06T11:00:00Z' && event.summary==='Only second moved'));
  assert.ok(result.events.some(event => event.uid==='first' && event.start==='2026-03-08T12:00:00Z' && event.summary==='Moved back'));
});

test('all-day dates remain dates and retain exclusive end', async t => {
  const config = await fixture(t,`BEGIN:VEVENT\nUID:date-synthetic\nDTSTART;VALUE=DATE:20260306\nDTEND;VALUE=DATE:20260308\nSUMMARY:Two days\nEND:VEVENT`);
  const result = await calendarEvents(config,query);
  assert.equal(result.events[0].allDay,true);
  assert.equal(result.events[0].start,'2026-03-06');
  assert.equal(result.events[0].end,'2026-03-08');
});

test('bounded query rejects invalid ranges, dates and subdaily recurrence', async t => {
  const config = await fixture(t,`BEGIN:VEVENT\nUID:bounded-synthetic\nDTSTART:20260306T090000Z\nDURATION:PT1H\nRRULE:FREQ=SECONDLY\nSUMMARY:Unsupported\nEND:VEVENT`);
  await assert.rejects(calendarEvents(config,query),{code:'CALENDAR_RECURRENCE'});
  for (const input of [{...query,limit:201},{from:'2026-02-30T00:00:00Z',to:query.to},{from:'2025-01-01T00:00:00Z',to:'2027-01-01T00:00:00Z'},{from:query.to,to:query.from}]) await assert.rejects(calendarEvents(config,input));
});

test('result limit is disclosed and dates ordered', async t => {
  const config = await fixture(t,`BEGIN:VEVENT\nUID:limit-synthetic\nDTSTART:20260306T090000Z\nDURATION:PT1H\nRRULE:FREQ=DAILY;COUNT=4\nSUMMARY:Bounded\nEND:VEVENT`);
  const result = await calendarEvents(config,{...query,limit:2});
  assert.equal(result.events.length,2);
  assert.equal(result.partial,true);
  assert.equal(result.reason,'Result limit reached.');
});

test('historic unbounded recurrence discloses its safety cutoff', async t => {
  const config=await fixture(t,`BEGIN:VEVENT\nUID:old-recurring\nDTSTART:19500101T090000Z\nDURATION:PT1H\nRRULE:FREQ=DAILY\nSUMMARY:Historic recurring fixture\nEND:VEVENT`);
  const result=await calendarEvents(config,query);
  assert.equal(result.partial,true);
  assert.equal(result.events.length,0);
  assert.match(result.reason,/20,000/);
});

test('oversized files and non-regular snapshots fail before reading', async t => {
  const config=await fixture(t,'');
  const file=config.calendar.files[0];
  await writeFile(file,Buffer.alloc(10*1024*1024+1,'x'));
  await assert.rejects(calendarEvents(config,query),{code:'CALENDAR_SIZE'});
  if(process.platform==='win32') return;
  const fifo=join(config.artifactsDir,'..','snapshot.fifo');
  execFileSync('mkfifo',[fifo]);
  await assert.rejects(calendarEvents({...config,calendar:{files:[fifo]}},query),{code:'CALENDAR_SIZE'});
});

test('prepare saves round-trippable UTC ICS, escaping text and folding UTF8 octets', async t => {
  const config = await fixture(t,'');
  const summary = 'é🦊'.repeat(40) + '\nATTENDEE:mailto:synthetic@example.com';
  const result = await calendarPrepare(config,{start:'2026-03-09T13:00:00Z',end:'2026-03-09T14:00:00Z',summary,description:'Comma, semicolon; slash\\\nSecond line',location:'Synthetic'});
  const bytes = await readFile(result.path);
  assert.equal(result.sha256,createHash('sha256').update(bytes).digest('hex'));
  const content = bytes.toString('utf8');
  for (const line of content.split('\r\n')) assert.ok(Buffer.byteLength(line) <=75,'Each physical line is at most 75 octets');
  const event = new ICAL.Event(new ICAL.Component(ICAL.parse(content)).getFirstSubcomponent('vevent'));
  assert.equal(event.summary,summary);
  assert.equal(event.startDate.toString(),'2026-03-09T13:00:00Z');
  assert.equal(event.description,'Comma, semicolon; slash\\\nSecond line');
  assert.equal(event.component.hasProperty('attendee'),false);
  assert.equal(event.component.getAllSubcomponents('valarm').length,0);
  assert.equal(result.imported,false);
});

test('prepare rejects invitations and invalid event duration', async t => {
  const config = await fixture(t,'');
  const valid = {start:'2026-03-09T13:00:00Z',end:'2026-03-09T14:00:00Z',summary:'Synthetic'};
  for (const input of [{...valid,end:valid.start},{...valid,start:'2026-02-30T13:00:00Z'},{...valid,attendees:['synthetic@example.com']},{...valid,summary:'NUL\0'}]) await assert.rejects(calendarPrepare(config,input));
});
