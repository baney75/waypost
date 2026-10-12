import test from 'node:test';
import assert from 'node:assert/strict';
import {fetchCalendarFeed,feedProvenance,feedKey,clearCalendarFeedCache} from '../dist/calendar-feed.js';

const url='https://calendar.proton.me/api/calendar/v1/url/synthetic/calendar.ics?CacheKey=synthetic-key&PassphraseKey=synthetic-secret';
const ics='BEGIN:VCALENDAR\r\nVERSION:2.0\r\nEND:VCALENDAR\r\n';
function stub(t,respond){
  clearCalendarFeedCache();t.after(clearCalendarFeedCache);
  const calls=[];
  t.mock.method(globalThis,'fetch',async(target,init)=>{calls.push({target,init});return respond(init,calls.length);});
  return calls;
}

test('a first fetch sends no validators and records the ETag and Last-Modified the server returns',async t=>{
  const calls=stub(t,()=>new Response(ics,{headers:{etag:'"abc"','last-modified':'Mon, 02 Nov 2026 10:00:00 GMT'}}));
  const result=await fetchCalendarFeed(url,1000);
  assert.deepEqual(calls[0].init.headers,{Accept:'text/calendar'});
  assert.equal(calls[0].init.redirect,'error');
  assert.deepEqual([result.content,result.etag,result.lastModified,result.notModified],[ics,'"abc"','Mon, 02 Nov 2026 10:00:00 GMT',undefined]);
  assert.match(result.fetchedAt,/^\d{4}-\d\d-\d\dT.*Z$/);
});

test('validators are sent as conditional headers and a 304 returns no body and echoes them',async t=>{
  const calls=stub(t,()=>new Response(null,{status:304}));
  const both=await fetchCalendarFeed(url,1000,{etag:'"abc"',lastModified:'Mon, 02 Nov 2026 10:00:00 GMT'});
  assert.deepEqual(calls[0].init.headers,{Accept:'text/calendar','If-None-Match':'"abc"','If-Modified-Since':'Mon, 02 Nov 2026 10:00:00 GMT'});
  assert.deepEqual([both.notModified,both.content,both.etag,both.lastModified],[true,'','"abc"','Mon, 02 Nov 2026 10:00:00 GMT']);
  const etagOnly=await fetchCalendarFeed(url,1000,{etag:'"abc"'});
  assert.deepEqual(calls[1].init.headers,{Accept:'text/calendar','If-None-Match':'"abc"'});
  assert.equal(etagOnly.lastModified,undefined);
  const dateOnly=await fetchCalendarFeed(url,1000,{lastModified:'Mon, 02 Nov 2026 10:00:00 GMT'});
  assert.equal(calls[2].init.headers['If-None-Match'],undefined);
  assert.equal(dateOnly.etag,undefined);
});

test('a 304 nobody asked for is an error, not an empty calendar',async t=>{
  stub(t,()=>new Response(null,{status:304}));
  await assert.rejects(fetchCalendarFeed(url,1000),{code:'CALENDAR_FEED_FAILED'});
  await assert.rejects(fetchCalendarFeed(url,1000,{etag:undefined,lastModified:undefined}),{code:'CALENDAR_FEED_FAILED'});
});

test('unsafe or oversized validators are neither sent nor stored',async t=>{
  const calls=stub(t,()=>new Response(ics,{headers:{etag:'x'.repeat(300),'last-modified':'bad\u00e9value'}}));
  const result=await fetchCalendarFeed(url,1000,{etag:'x'.repeat(257),lastModified:'line\nbreak'});
  assert.deepEqual(calls[0].init.headers,{Accept:'text/calendar'});
  assert.equal(result.etag,undefined);
  assert.equal(result.lastModified,undefined);
});

test('a 200 that follows a conditional request replaces the validators; BOM is stripped; 5xx and non-calendar bodies fail',async t=>{
  stub(t,(init,n)=>n===1?new Response('\uFEFF'+ics,{headers:{etag:'"v2"'}}):n===2?new Response('oops',{status:503}):new Response('<html></html>'));
  const fresh=await fetchCalendarFeed(url,1000,{etag:'"v1"'});
  assert.deepEqual([fresh.etag,fresh.notModified,fresh.content.startsWith('BEGIN:VCALENDAR')],['"v2"',undefined,true]);
  await assert.rejects(fetchCalendarFeed(url,1000,{etag:'"v2"'}),{code:'CALENDAR_FEED_FAILED'});
  await assert.rejects(fetchCalendarFeed(url,1000,{etag:'"v2"'}),{code:'CALENDAR_INVALID'});
});

test('only the official share-link route is ever fetched, even with validators',async t=>{
  const calls=stub(t,()=>new Response(ics));
  await assert.rejects(fetchCalendarFeed('https://evil.example/calendar.ics?CacheKey=x',1000,{etag:'"abc"'}),{code:'CALENDAR_FEED_URL'});
  assert.equal(calls.length,0);
});

test('provenance slugs come from the name unless a source is given, and are stable',()=>{
  const feed=(name,extra={})=>({name,urlFile:'/x/link',...extra});
  assert.equal(feedProvenance(feed('Personal')),'proton/personal');
  assert.equal(feedProvenance(feed('Family & Friends')),'proton/family-friends');
  assert.equal(feedProvenance(feed('  --School 2026--  ')),'proton/school-2026');
  assert.equal(feedProvenance(feed('Personal',{source:'me'})),'proton/me');
  assert.equal(feedProvenance(feed('\u65e5\u672c')),'proton/calendar','a name with no ASCII letters falls back');
  assert.equal(feedProvenance(feed('a'.repeat(80))),'proton/'+'a'.repeat(40));
  assert.equal(feedProvenance(feed('Caf\u00e9 Club')),'proton/cafe-club');
  assert.match(feedProvenance(feed('Anything')),/^proton\/[a-z0-9][a-z0-9-]{0,39}$/);
});

test('feed keys identify the secret source without containing a secret',()=>{
  assert.equal(feedKey({name:'A',urlFile:'/x/link'}),'file:/x/link');
  assert.equal(feedKey({name:'A',keychainService:'svc',keychainAccount:'acct'}),'keychain:svc:acct');
  assert.equal(feedKey({name:'A',passItem:'Calendar',vault:'Personal'}),'pass:Personal:Calendar');
});
