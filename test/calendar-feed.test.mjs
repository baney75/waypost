import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,chmod,readFile,symlink} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {calendarFeedUrl,readFeedUrl,fetchCalendarFeed} from '../dist/calendar-feed.js';
import {calendarEvents} from '../dist/calendar.js';
import {connectCalendarFeed} from '../dist/connect.js';
import {initConfig,loadConfig} from '../dist/config.js';
const url='https://calendar.proton.me/api/calendar/v1/url/synthetic/calendar.ics?CacheKey=synthetic-key&PassphraseKey=synthetic-secret';
const ics='BEGIN:VCALENDAR\r\nVERSION:2.0\r\nBEGIN:VEVENT\r\nUID:feed-event\r\nDTSTART:20261005T140000Z\r\nDTEND:20261005T150000Z\r\nSUMMARY:Feed event\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n';
test('feed URL accepts only the official HTTPS share route',()=>{
  assert.equal(calendarFeedUrl(url),url);
  for(const invalid of [url.replace('https:','http:'),url.replace('calendar.proton.me','localhost'),url.replace('calendar.proton.me','calendar.proton.me.evil.test'),url.replace('calendar.proton.me','calendar.proton.me:444'),url+'#secret',url+'&CacheKey=duplicate',url+'&next=bad',url.replace('https://','https://user:password@'),url.replace('/url/synthetic/','/url/../'),url.replace('?CacheKey=synthetic-key&PassphraseKey=synthetic-secret','')])assert.throws(()=>calendarFeedUrl(invalid),{code:'CALENDAR_FEED_URL'});
});
test('feed secrets require a bounded owner-only file without symlinks',async()=>{
  const root=await mkdtemp(join(tmpdir(),'waypost-feed-'));const file=join(root,'link');await writeFile(file,url,{mode:0o600});assert.equal(await readFeedUrl(file),url);
  await chmod(file,0o644);await assert.rejects(readFeedUrl(file),{code:'CALENDAR_FEED_FILE'});await chmod(file,0o600);
  const link=join(root,'alias');await symlink(file,link);await assert.rejects(readFeedUrl(link),{code:'CALENDAR_FEED_FILE'});
  await writeFile(file,'x'.repeat(8193));await assert.rejects(readFeedUrl(file),{code:'CALENDAR_FEED_FILE'});
});
test('configured feeds refresh per query and never return their secret URL',async(t)=>{
  const root=await mkdtemp(join(tmpdir(),'waypost-feed-'));const path=join(root,'config.json');await initConfig(path);
  let calls=0;t.mock.method(globalThis,'fetch',async(target,options)=>{assert.equal(target,url);assert.equal(options.redirect,'error');assert.deepEqual(options.headers,{Accept:'text/calendar'});calls++;return new Response(ics);});
  const connected=await connectCalendarFeed(path,'Personal',{url});assert.equal(connected.route,'proton_link');const config=await loadConfig(path);
  assert.ok(!(await readFile(path,'utf8')).includes('synthetic-secret'));
  for(let i=0;i<2;i++){
    const result=await calendarEvents(config,{from:'2026-10-05T00:00:00Z',to:'2026-10-06T00:00:00Z'});
    assert.equal(result.events[0].summary,'Feed event');assert.equal(result.sources[0].kind,'proton_link');assert.ok(result.sources[0].fetchedAt);assert.match(result.sources[0].upstreamDelay,/8 hours/);
    assert.ok(!JSON.stringify(result).includes('synthetic-secret'));assert.equal(result.events[0].source,'feed:Personal');
  }
  assert.equal(calls,3);
});
test('feed failures expose no URL and no stale success; responses are bounded',async(t)=>{
  t.mock.method(globalThis,'fetch',async()=>{throw new Error(url);});
  await assert.rejects(fetchCalendarFeed(url,1000),e=>e.code==='CALENDAR_FEED_FAILED'&&!e.message.includes('synthetic-secret'));
  globalThis.fetch=async()=>new Response('<html>login</html>');await assert.rejects(fetchCalendarFeed(url,1000),{code:'CALENDAR_INVALID'});
  globalThis.fetch=async()=>new Response('x',{headers:{'content-length':String(10*1024*1024+1)}});await assert.rejects(fetchCalendarFeed(url,1000),{code:'CALENDAR_SIZE'});
  globalThis.fetch=async()=>new Response('x'.repeat(10*1024*1024+1));await assert.rejects(fetchCalendarFeed(url,1000),{code:'CALENDAR_SIZE'});
  globalThis.fetch=async()=>new Response('',{status:403});await assert.rejects(fetchCalendarFeed(url,1000),{code:'CALENDAR_FEED_FAILED'});
});
