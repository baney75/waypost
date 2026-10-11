// Regression tests for the adversarial review of PR #8 (S1–S6, C1–C8). Synthetic data only.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,readFile,stat} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {spawn,execFileSync} from 'node:child_process';
import * as otp from '../dist/otp.js';
import {calendarPrepare,calendarEvents} from '../dist/calendar.js';
import {attachmentsOf,mailList} from '../dist/mail.js';
import {configSchema} from '../dist/config.js';
import {latestVerificationCode} from '../dist/codes.js';
import {encode,decodeFrames} from '../dist/native-host.js';
import {imapServerAvailable,startImapServer,seed,codeMail,plain,day} from './fixtures/imap-server.mjs';

const imap=imapServerAvailable();
const workspace=()=>mkdtemp(join(tmpdir(),'waypost-review-'));

test('S1/S2: registrable domains use the Public Suffix List, including private suffixes',()=>{
  for (const [host,expected] of [['shop.com.vn','shop.com.vn'],['a.co.th','a.co.th'],['b.co.id','b.co.id'],['evil.s3.amazonaws.com','evil.s3.amazonaws.com'],['victim.github.io','victim.github.io'],['login.bank.co.uk','bank.co.uk'],['accounts.google.com','google.com']]) assert.equal(otp.registrableDomain(host),expected,host);
});
test('S1/S2: free-mail, shared-hosting and lookalike senders never authorize a code',()=>{
  const match=(address,site,options)=>otp.senderMatchesSite(address,site,options);
  for (const [address,site] of [
    ['attacker@gmail.com','accounts.google.com'],['attacker@gmail.com','mail.google.com'],['attacker@outlook.com','login.live.com'],['attacker@outlook.com','login.microsoftonline.com'],
    ['attacker@icloud.com','appleid.apple.com'],['attacker@pm.me','account.proton.me'],['attacker@proton.me','account.proton.me'],
    ['x@evil.s3.amazonaws.com','aws.amazon.com'],['no-reply@accounts.google.com','sites.google.com'],['x@shop.com.vn','other.com.vn'],['x@a.co.th','b.co.th'],['x@github.io','victim.github.io'],
  ]) assert.equal(match(address,site),false,`${address} for ${site}`);
  for (const [address,site] of [
    ['noreply@github.com','github.com'],['no-reply@accounts.google.com','accounts.google.com'],['no-reply@accounts.google.com','www.youtube.com'],
    ['account-security-noreply@accountprotection.microsoft.com','login.live.com'],['noreply@verify.proton.me','account.proton.me'],
  ]) assert.equal(match(address,site),true,`${address} for ${site}`);
  assert.equal(match('codes@proton.me','account.proton.me',{verifiedSenders:{'proton.me':['codes@proton.me']}}),true,'a configured verified sender at a free-mail domain is allowed');
});

test('S3: automatic fill requires a Proton-verified sender; unknown never fills automatically',async()=>{
  const {autoFillAllowed}=await import('../extension/policy.js');
  const base={found:true,code:'734021',confidence:'high',senderMatchesSite:true,knownSender:true,notification:false};
  assert.equal(autoFillAllowed({...base,senderVerified:true}),true);
  assert.equal(autoFillAllowed({...base,senderVerified:null}),false);
  assert.equal(autoFillAllowed({...base,senderVerified:false}),false);
  assert.equal(autoFillAllowed({...base,senderVerified:true,knownSender:false}),false,'heuristic senders never auto-fill');
});

test('S4: a code planted in notification mail from the right domain is not returned',{skip:!imap&&'needs pymap',timeout:120000},async t=>{
  const server=await startImapServer(t);
  process.env.WAYPOST_MAIL_USERNAME=server.user;process.env.WAYPOST_MAIL_PASSWORD=server.secret;
  await seed(server,[codeMail({from:'octo <notifications@github.com>',subject:'[org/repo] Login help (#12)',body:'@victim Your GitHub verification code is ABCD-1234. Enter it to continue.\n\nReply to this email directly or view it on GitHub.',minutes:1,headers:'Authentication-Results: mailin.protonmail.ch; dmarc=pass header.from=github.com\nList-Id: org/repo <repo.org.github.com>\nList-Unsubscribe: <mailto:unsub@reply.github.com>\nX-GitHub-Reason: mention\nPrecedence: list\n'})]);
  const root=await workspace();
  const config=configSchema.parse({version:1,artifactsDir:join(root,'a'),timeoutMs:10000,mail:{host:'127.0.0.1',imapPort:server.port,smtpPort:1,certificate:server.certificate},verificationCodes:{agents:true,browser:true}});
  const result=await latestVerificationCode(config,{site:'github.com'},'browser');
  assert.equal(result.found,false,JSON.stringify(result));
  assert.ok(!JSON.stringify(result).includes('ABCD'));
});

test('S6: the native host requires the pairing secret, not just the origin argument',async()=>{
  const root=await workspace();const config=join(root,'config.json');
  const {connectBrowser}=await import('../dist/browser.js');
  await writeFile(config,JSON.stringify({version:1,artifactsDir:join(root,'a')}),{mode:0o600});
  const paired=await connectBrowser(config,{browser:'chromium',hostsDir:join(root,'hosts')});
  assert.match(paired.pairingCode??'',/^[A-Za-z0-9_-]{32,}$/,'pairing creates a secret to paste into the extension');
  const saved=await readFile(config,'utf8');
  assert.ok(!saved.includes(paired.pairingCode),'config stores a hash, not the secret');
  assert.equal((await stat(config)).mode&0o077,0);
  const ask=message=>new Promise((done,fail)=>{
    const child=spawn(process.execPath,[resolve('runtime/waypost.mjs'),'--config',config,'native-host','chrome-extension://bahfokgcpebehdnidclkpdeafnaehdpo/'],{stdio:['pipe','pipe','ignore']});
    let output=Buffer.alloc(0);child.stdout.on('data',data=>{output=Buffer.concat([output,data]);});
    child.on('close',()=>{try{done(decodeFrames(output).messages[0]);}catch(error){fail(error);}});
    child.stdin.end(encode(message));
  });
  assert.equal((await ask({type:'verification_code',site:'github.com'})).error.code,'PAIRING_REQUIRED');
  assert.equal((await ask({type:'verification_code',site:'github.com',pairing:'x'.repeat(43)})).error.code,'PAIRING_INVALID');
  assert.equal((await ask({type:'verification_code',site:'github.com',pairing:paired.pairingCode})).error.code,'MAIL_UNCONFIGURED','a correct secret reaches the lookup');
});

test('C1: a rule with no possible occurrence is rejected by prepare and skipped quickly by the reader',async()=>{
  const root=await workspace();const config={version:1,artifactsDir:join(root,'a')};
  for (const rrule of ['FREQ=DAILY;BYMONTHDAY=31;BYMONTH=2','FREQ=MONTHLY;BYMONTHDAY=30;BYMONTH=2','FREQ=WEEKLY;BYMONTHDAY=31']) await assert.rejects(calendarPrepare(config,{summary:'Never',start:'2026-03-09T13:00:00Z',rrule}),error=>error.code==='INPUT_INVALID',rrule);
  const file=join(root,'never.ics');
  await writeFile(file,'BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:-//t//EN\r\nBEGIN:VEVENT\r\nUID:never\r\nDTSTART:20260309T130000Z\r\nDURATION:PT1H\r\nRRULE:FREQ=DAILY;BYMONTHDAY=31;BYMONTH=2\r\nEND:VEVENT\r\nBEGIN:VEVENT\r\nUID:fine\r\nDTSTART:20260309T130000Z\r\nDURATION:PT1H\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n');
  const script=`import {calendarEvents} from ${JSON.stringify(new URL('../dist/calendar.js',import.meta.url).href)};const r=await calendarEvents({version:1,artifactsDir:'/tmp',calendar:{files:[${JSON.stringify(file)}]}},{from:'2026-03-01T00:00:00Z',to:'2026-04-01T00:00:00Z'});console.log(JSON.stringify({events:r.events.map(e=>e.uid),skipped:r.skipped?.map(s=>s.code)}));`;
  const output=execFileSync(process.execPath,['--input-type=module','-e',script],{encoding:'utf8',timeout:15000});
  assert.deepEqual(JSON.parse(output),{events:['fine'],skipped:['CALENDAR_RECURRENCE']});
});

test('C2: a local time in the repeated fall-back hour is rejected; writer and reader agree otherwise',async()=>{
  const root=await workspace();const config={version:1,artifactsDir:join(root,'a')};
  await assert.rejects(calendarPrepare(config,{summary:'Ambiguous',start:'2026-11-01T01:30:00',timezone:'America/Chicago'}),error=>error.code==='INPUT_INVALID'&&/twice|repeat/i.test(error.message));
  const before=await calendarPrepare(config,{summary:'Just before',start:'2026-11-01T00:30:00',timezone:'America/Chicago'});
  const read=await calendarEvents({...config,calendar:{files:[before.path]}},{from:'2026-10-31T00:00:00Z',to:'2026-11-02T00:00:00Z'});
  assert.deepEqual([read.events[0].start,read.events[0].end],[before.start,before.end]);
  assert.notEqual(before.start,before.end);
});

test('C3/C4: promo codes are not OTPs; Steam Guard and lowercase codes are found',()=>{
  for (const [subject,body] of [['Sale','Use promo code 2026 at checkout.'],['Shipped','Your order 482913 has shipped. Use code SAVE20 for 20% off your next order.'],['Gift','Your gift card code is GIFT4821.'],['Discount','Discount code: SPRING25']]) {
    const result=otp.extractCode(subject,body);assert.ok(result===null||result.confidence==='low',`${body} -> ${JSON.stringify(result)}`);
  }
  assert.equal(otp.extractCode('Your Steam account: Access from new computer','Here is the Steam Guard code you need to login to account examplename:\n\nF4K9Q\n\nThis email was generated because of a login attempt.')?.code,'F4K9Q');
  assert.equal(otp.extractCode('Sign in','Your one-time sign-in code: abc123')?.code,'abc123');
});

test('C5: a forwarded message (message/rfc822) is listed as one attachment',()=>{
  const structure={type:'multipart/mixed',childNodes:[{part:'1',type:'text/plain'},{part:'2',type:'message/rfc822',disposition:'attachment',size:2048,childNodes:[{part:'2.1',type:'multipart/alternative',childNodes:[{part:'2.1.1',type:'text/plain'},{part:'2.1.2',type:'text/html'}]}]}]};
  assert.deepEqual(attachmentsOf(structure).map(item=>[item.part,item.contentType]),[['2','message/rfc822']]);
});

test('C6: UNTIL before the start of a timed event is rejected',async()=>{
  const root=await workspace();const config={version:1,artifactsDir:join(root,'a')};
  await assert.rejects(calendarPrepare(config,{summary:'Backwards',start:'2026-03-09T13:00:00Z',rrule:'FREQ=DAILY;UNTIL=20260309T010000Z'}),error=>error.code==='INPUT_INVALID'&&/UNTIL/.test(error.message));
  const ok=await calendarPrepare(config,{summary:'Same moment',start:'2026-03-09T13:00:00Z',rrule:'FREQ=DAILY;UNTIL=20260309T130000Z'});assert.equal(ok.rrule,'FREQ=DAILY;UNTIL=20260309T130000Z');
});

test('C7: the update notes list every 0.5 output change',async()=>{
  const notes=await readFile('docs/updates.md','utf8');
  for (const term of ['partial: true','calendar_prepare','endDefaulted','nextBeforeUid','uidValidity','attachments: null']) assert.ok(notes.includes(term),term);
});

test('C8: pages carry uidValidity, stale cursors are rejected, and total means the same on both paths',{skip:!imap&&'needs pymap',timeout:120000},async t=>{
  const server=await startImapServer(t);
  process.env.WAYPOST_MAIL_USERNAME=server.user;process.env.WAYPOST_MAIL_PASSWORD=server.secret;
  await seed(server,Array.from({length:6},(_,i)=>plain({from:`f${i}@example.test`,subject:`M${i}`,date:day(i+1),id:`m${i}@example.test`,body:'x'})));
  const root=await workspace();
  const config=configSchema.parse({version:1,artifactsDir:join(root,'a'),timeoutMs:10000,mail:{host:'127.0.0.1',imapPort:server.port,smtpPort:1,certificate:server.certificate}});
  const first=await mailList(config,{limit:2});
  assert.match(String(first.uidValidity),/^\d+$/);
  const second=await mailList(config,{limit:2,beforeUid:first.nextBeforeUid,uidValidity:first.uidValidity});
  assert.equal(second.total,first.total,'total counts the whole mailbox on the fast path and the cursor path');
  await assert.rejects(mailList(config,{limit:2,beforeUid:first.nextBeforeUid,uidValidity:String(BigInt(first.uidValidity)+1n)}),{code:'MAIL_CURSOR_STALE'});
});
