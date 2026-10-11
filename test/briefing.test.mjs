import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,utimes} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {briefing} from '../dist/briefing.js';
import {readKeychainCalendarUrl,clearCalendarFeedCache,feedKey} from '../dist/calendar-feed.js';
import {calendarEvents} from '../dist/calendar.js';
const url='https://calendar.proton.me/api/calendar/v1/url/synthetic/calendar.ics?CacheKey=synthetic-key&PassphraseKey=synthetic-secret';
const stamp=ms=>new Date(ms).toISOString().replace(/[-:]/g,'').replace(/\.\d{3}/,'');
const ics=(start)=>`BEGIN:VCALENDAR\r\nVERSION:2.0\r\nBEGIN:VEVENT\r\nUID:b1\r\nDTSTART:${stamp(start)}\r\nDTEND:${stamp(start+3600000)}\r\nSUMMARY:Synthetic lab\r\nLOCATION:Room 1\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n`;
const base={version:1,timeoutMs:5000,artifactsDir:'/tmp'};

test('briefing reports events, marks an old export stale, and keeps services independent',async()=>{
  const root=await mkdtemp(join(tmpdir(),'waypost-brief-'));const file=join(root,'cal.ics');
  await writeFile(file,ics(Date.now()+2*86400000));
  const old=(Date.now()-3*86400000)/1000;await utimes(file,old,old);
  const out=await briefing({...base,calendar:{files:[file],feeds:[]}},{days:7,mail:5});
  assert.equal(out.calendar.ok,true);
  assert.equal(out.calendar.events[0].summary,'Synthetic lab');
  assert.equal(out.calendar.sources[0].stale,true);
  assert.equal(out.calendar.live,false);
  assert.match(out.calendar.note,/not a live link/);
  assert.equal(out.mail.ok,false);assert.equal(out.mail.code,'MAIL_UNCONFIGURED');
  const none=await briefing({...base},{mail:0});
  assert.equal(none.calendar.code,'CALENDAR_UNCONFIGURED');assert.equal(none.mail.code,'SKIPPED');
});
test('a keychain feed reads the link at runtime and never echoes it',async(t)=>{
  clearCalendarFeedCache();t.after(clearCalendarFeedCache);
  const root=await mkdtemp(join(tmpdir(),'waypost-keychain-'));const tool=join(root,'security');
  await writeFile(tool,`#!/usr/bin/env node\nconst a=process.argv.slice(2);if(a.join(' ')!=='find-generic-password -s svc.test -a acct -w')process.exit(44);process.stdout.write(${JSON.stringify(url)}+'\\n');\n`,{mode:0o700});
  assert.equal(await readKeychainCalendarUrl({keychainService:'svc.test',keychainAccount:'acct'},5000,tool),url);
  await assert.rejects(readKeychainCalendarUrl({keychainService:'other',keychainAccount:'acct'},5000,tool),e=>e.code==='CALENDAR_KEYCHAIN'&&!e.message.includes('synthetic'));
  const locked=join(root,'locked');await writeFile(locked,`#!/usr/bin/env node\nprocess.stderr.write('locked');process.exit(36);\n`,{mode:0o700});
  await assert.rejects(readKeychainCalendarUrl({keychainService:'svc.test',keychainAccount:'acct'},5000,locked),e=>e.code==='KEYCHAIN_LOCKED'&&!e.message.includes('locked\''));
  const bad=join(root,'bad');await writeFile(bad,`#!/usr/bin/env node\nprocess.stdout.write('https://evil.test/x.ics');\n`,{mode:0o700});
  await assert.rejects(readKeychainCalendarUrl({keychainService:'svc.test',keychainAccount:'acct'},5000,bad),{code:'CALENDAR_FEED_URL'});
});

test('feed cache keys stay the same for file and Pass feeds',()=>{
  assert.equal(feedKey({name:'A',urlFile:'/x/link.url'}),'file:/x/link.url');
  assert.equal(feedKey({name:'B',passItem:'Item',vault:'V'}),'pass:V:Item');
  assert.equal(feedKey({name:'C',keychainService:'s',keychainAccount:'a'}),'keychain:s:a');
});
test('a live feed plus an old export says both, and every event names its source',async(t)=>{
  clearCalendarFeedCache();t.after(clearCalendarFeedCache);
  const root=await mkdtemp(join(tmpdir(),'waypost-live-'));const file=join(root,'family.ics');const link=join(root,'link');
  await writeFile(file,ics(Date.now()+86400000));const old=(Date.now()-5*86400000)/1000;await utimes(file,old,old);
  await writeFile(link,url,{mode:0o600});
  t.mock.method(globalThis,'fetch',async()=>new Response(ics(Date.now()+2*86400000).replace('Synthetic lab','Live event')));
  const out=await briefing({...base,calendar:{files:[file],feeds:[{name:'Personal',urlFile:link}]}},{days:7,mail:0});
  assert.equal(out.calendar.live,true);
  assert.match(out.calendar.note,/old exports: family.ics/);
  assert.deepEqual(out.calendar.events.map(e=>e.source).sort(),['Personal','family.ics']);
  assert.ok(!JSON.stringify(out).includes('synthetic-secret'));
});
