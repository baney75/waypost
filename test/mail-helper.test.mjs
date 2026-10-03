import test from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { mailDoctor, mailList, mailRead, mailDraft, mailSend } from '../dist/mail.js';
import { helperMailDoctor } from '../dist/mail-helper.js';

const header = {uid:'42',date:'Fri, 6 Mar 2026 09:00:00 +0000',from:'Synthetic Sender <sender@example.com>',subject:'Synthetic subject',message_id:'<synthetic@example.com>'};
const ready = {state:'ready',scope:'local_bridge_imap',read_only:true};
const recent = {mailbox:'INBOX',messages:[header],read_only:true};
const message = {...header,body:'Synthetic body',body_format:'plain',partial_fetch:false,attachments_included:false,flags_changed:false};

async function fixture(t, responses={check:ready,recent,read:message}, behavior='') {
  const root = await mkdtemp(join(tmpdir(),'waypost-mail-helper-'));
  t.after(() => rm(root,{recursive:true,force:true}));
  const executable = join(root,'helper.mjs'), calls = join(root,'calls.jsonl');
  await writeFile(executable,`#!/usr/bin/env node
import {appendFileSync} from 'node:fs';
const args=process.argv.slice(2);
appendFileSync(${JSON.stringify(calls)},JSON.stringify(args)+'\\n');
${behavior || `const responses=${JSON.stringify(responses)};
if (!(args[0] in responses)) process.exit(2);
process.stdout.write(JSON.stringify(responses[args[0]]));`}
`,{mode:0o700});
  const config = {version:1,artifactsDir:join(root,'artifacts'),timeoutMs:2000,mailHelper:{executable}};
  return {root,executable,config,async calls(){try{return (await readFile(calls,'utf8')).trim().split('\n').map(JSON.parse);}catch(error){if(error.code==='ENOENT')return [];throw error;}}};
}

test('helper doctor checks authentication without reading or claiming local TLS pins', async t => {
  const f=await fixture(t);
  const result=await mailDoctor(f.config,{});
  assert.equal(result.imapAuthenticated,true);
  assert.equal(result.smtpAuthenticated,null);
  assert.equal(result.mailboxRead,false);
  assert.equal(result.localBridge,false);
  assert.equal(result.helper,true);
  assert.equal(result.readOnly,true);
  assert.ok(!result.tls.includes('pinned leaf'));
  assert.deepEqual(await f.calls(),[['check']]);
});

test('setup can reuse the validated helper doctor handshake before saving config', async t => {
  const valid=await fixture(t);
  assert.equal((await helperMailDoctor(valid.config)).imapAuthenticated,true);
  const invalid=await fixture(t,{check:{...ready,read_only:false}});
  await assert.rejects(helperMailDoctor(invalid.config),{code:'MAIL_HELPER_RESPONSE'});
});

test('helper SMTP checks and send fail explicitly; local draft and digest remain useful', async t => {
  const f=await fixture(t);
  await assert.rejects(mailDoctor(f.config,{smtp:true}),{code:'MAIL_HELPER_READ_ONLY'});
  const draft=await mailDraft(f.config,{from:'sender@example.com',to:['recipient@example.com'],subject:'Synthetic draft',text:'Local synthetic body'});
  assert.equal(draft.sent,false);
  assert.equal(draft.storedInMailbox,false);
  assert.equal(draft.sha256,createHash('sha256').update(await readFile(draft.path)).digest('hex'));
  await assert.rejects(mailSend(f.config,{path:draft.path,sha256:draft.sha256}),{code:'MAIL_HELPER_READ_ONLY'});
  assert.deepEqual(await f.calls(),[]);
});

test('list maps the existing helper header contract and marks unknown fields null', async t => {
  const f=await fixture(t);
  const result=await mailList(f.config,{limit:1});
  assert.deepEqual(await f.calls(),[['recent','--mailbox=INBOX','--limit=1']]);
  assert.deepEqual(result.messages,[{uid:42,subject:header.subject,from:[{name:'Synthetic Sender',address:'sender@example.com'}],to:null,date:'2026-03-06T09:00:00.000Z',messageId:header.message_id,bytes:null,seen:null}]);
  assert.equal(result.readOnly,true);
  assert.equal(result.bodyFetched,false);
  const empty=await fixture(t,{recent:{mailbox:'INBOX',messages:[],read_only:true}});
  assert.deepEqual((await mailList(empty.config,{})).messages,[]);
});

test('read maps plain and converted HTML body while preserving unknown source metadata', async t => {
  const f=await fixture(t);
  const result=await mailRead(f.config,{uid:42});
  assert.deepEqual(await f.calls(),[['read','42','--mailbox=INBOX']]);
  assert.equal(result.text,'Synthetic body');
  assert.equal(result.uid,42);
  assert.equal(result.partial,false);
  assert.equal(result.htmlOnly,null);
  assert.equal(result.attachments,null);
  assert.equal(result.attachmentsReturned,false);
  assert.equal(result.fetchedBytes,null);
  assert.equal(result.bodyFormat,'plain');
  assert.equal('html' in result,false);
  const html=await fixture(t,{read:{...message,body:'Visible synthetic text',body_format:'html_to_text'}});
  assert.equal((await mailRead(html.config,{uid:42})).bodyFormat,'html_to_text');
});

test('read discloses source, text-boundary and unavailable-body incompleteness', async t => {
  for(const [changes,reason] of [
    [{partial_fetch:true},/256 KiB/],
    [{body:'x'.repeat(12000)},/12,000-character/],
    [{body:null,body_format:'unavailable'},/could not extract/],
  ]) {
    const f=await fixture(t,{read:{...message,...changes}});
    const result=await mailRead(f.config,{uid:42});
    assert.equal(result.partial,true);
    assert.match(result.reason,reason);
  }
});

test('Python codepoint bounds accept supplementary characters and trim safely to Waypost limits', async t => {
  const emoji='\u{1F600}';
  const astral={...message,subject:emoji.repeat(500),from:`${emoji.repeat(280)} <sender@example.com>`,body:emoji.repeat(12000)};
  // Match Python json.dumps ensure_ascii output, including its surrogate-pair
  // escapes. This valid maximum body exceeds the previous 128 KiB byte cap.
  const encoded=JSON.stringify(astral).replace(/[\u007f-\uffff]/g,char=>'\\u'+char.charCodeAt(0).toString(16).padStart(4,'0'));
  assert.ok(Buffer.byteLength(encoded)>128*1024);
  const f=await fixture(t,{},`process.stdout.write(${JSON.stringify(encoded)});`);
  const result=await mailRead(f.config,{uid:42});
  assert.equal(result.subject,emoji.repeat(500));
  assert.equal(result.text,emoji.repeat(6000));
  assert.ok(result.from[0].name.length<=300);
  assert.ok(!/[\uD800-\uDBFF]$/.test(result.from[0].name));
  assert.equal(result.partial,true);
  const split=await fixture(t,{read:{...message,body:'a'.repeat(11999)+emoji}});
  assert.equal((await mailRead(split.config,{uid:42})).text,'a'.repeat(11999));
  const complete=await fixture(t,{read:{...message,body:emoji.repeat(6000)}});
  assert.equal((await mailRead(complete.config,{uid:42})).partial,false);
  const tooLong=await fixture(t,{read:{...message,body:emoji.repeat(12001)}});
  await assert.rejects(mailRead(tooLong.config,{uid:42}),{code:'MAIL_HELPER_RESPONSE'});
  const badHeader=await fixture(t,{recent:{...recent,messages:[{...header,subject:emoji.repeat(501)}]}});
  await assert.rejects(mailList(badHeader.config,{}),{code:'MAIL_HELPER_RESPONSE'});
});

test('helper arguments stay literal and validated before process execution', async t => {
  const mailbox='--help; $(touch ignored) "quoted"';
  const f=await fixture(t,{recent:{...recent,mailbox},read:message});
  await mailList(f.config,{mailbox,limit:1});
  await mailRead(f.config,{mailbox,uid:42});
  assert.deepEqual(await f.calls(),[['recent',`--mailbox=${mailbox}`,'--limit=1'],['read','42',`--mailbox=${mailbox}`]]);
  const g=await fixture(t);
  for(const input of [{limit:21},{limit:0},{mailbox:'INBOX\r\nFETCH 1 BODY[]'},{mailbox:'x'.repeat(257)},{mailbox:'INBOX',extra:'ignored'}]) await assert.rejects(mailList(g.config,input));
  for(const input of [{uid:0},{uid:4294967296},{uid:'42; echo injected'},{uid:42,mailbox:'INBOX\0'}]) await assert.rejects(mailRead(g.config,input));
  assert.deepEqual(await g.calls(),[]);
});

test('operation-specific response validation fails closed without echoing helper content', async t => {
  const badResponses=[
    ['check',{...ready,state:'signed_out'}],['check',{...ready,read_only:false}],['check',message],
    ['recent',{...recent,mailbox:'Other'}],['recent',{...recent,read_only:false}],
    ['recent',{...recent,messages:[header,{...header,uid:'43'}]}],
    ['recent',{...recent,messages:[{...header,uid:'4294967296'}]}],
    ['recent',{...recent,messages:[{...header,subject:'Synthetic\nInjected: value'}]}],
    ['read',{...message,uid:'43'}],['read',{...message,flags_changed:true}],
    ['read',{...message,attachments_included:true}],['read',{...message,body:'x'.repeat(12001)}],
    ['read',{...message,body_format:'unavailable'}],['read',{...message,body:null}],
    ['read',{...message,html:'synthetic private markup'}],['read',ready],
  ];
  for(const [operation,response] of badResponses) {
    const f=await fixture(t,{[operation]:response});
    const invoke=operation==='check'?()=>mailDoctor(f.config,{}):operation==='recent'?()=>mailList(f.config,{limit:1}):()=>mailRead(f.config,{uid:42});
    await assert.rejects(invoke(),error=>error.code==='MAIL_HELPER_RESPONSE' && !error.message.includes('synthetic private'));
  }
  const duplicates=await fixture(t,{recent:{...recent,messages:[header,header]}});
  await assert.rejects(mailList(duplicates.config,{limit:2}),{code:'MAIL_HELPER_RESPONSE'});
});

test('malformed JSON, excessive output and helper failures use bounded public errors', async t => {
  const malformed=await fixture(t,{},`process.stdout.write('synthetic private non-JSON');`);
  await assert.rejects(mailDoctor(malformed.config,{}),error=>error.code==='MAIL_HELPER_RESPONSE' && !error.message.includes('private non-JSON'));
  const excessive=await fixture(t,{},`process.stdout.write('x'.repeat(256*1024+1));`);
  await assert.rejects(mailRead(excessive.config,{uid:42}),{code:'OUTPUT_LIMIT'});
  const failed=await fixture(t,{},`process.stderr.write('synthetic private error');process.exit(1);`);
  await assert.rejects(mailDoctor(failed.config,{}),error=>error.code==='SERVICE_FAILED' && !error.message.includes('private error'));
  const stalled=await fixture(t,{},`setTimeout(()=>process.stdout.write('{}'),10000);`);
  await assert.rejects(mailDoctor({...stalled.config,timeoutMs:1000},{}),{code:'TIMEOUT'});
});

test('helper requires an absolute owner executable with safe permissions', async t => {
  const f=await fixture(t);
  await assert.rejects(mailDoctor({...f.config,mailHelper:{executable:'relative-helper'}},{}),{code:'MAIL_HELPER_EXECUTABLE'});
  await assert.rejects(mailDoctor({...f.config,mailHelper:{executable:join(f.root,'missing')}},{}),{code:'MAIL_HELPER_EXECUTABLE'});
  await assert.rejects(mailDoctor({...f.config,mailHelper:{executable:f.root}},{}),{code:'MAIL_HELPER_EXECUTABLE'});
  await chmod(f.executable,0o720);
  await assert.rejects(mailDoctor(f.config,{}),{code:'EXECUTABLE_UNAVAILABLE'});
  assert.deepEqual(await f.calls(),[]);
});

test('helper rejects a shared writable parent before any code executes',async()=>{
  const {mkdtemp,writeFile,chmod,stat,mkdir}=await import('node:fs/promises');
  const {join}=await import('node:path');const {tmpdir}=await import('node:os');
  const root=await mkdtemp(join(tmpdir(),'waypost-helper-parent-'));const shared=join(root,'shared');await mkdir(shared);await chmod(shared,0o777);
  const marker=join(root,'executed');const executable=join(shared,'helper');
  await writeFile(executable,`#!/usr/bin/env node\nrequire('node:fs').writeFileSync(${JSON.stringify(marker)},'executed');console.log(JSON.stringify({state:'ready',scope:'local_bridge_imap',read_only:true}));`,{mode:0o700});
  const conf={version:1,artifactsDir:join(root,'artifacts'),timeoutMs:1000,mailHelper:{executable}};
  await assert.rejects(helperMailDoctor(conf),{code:'MAIL_HELPER_EXECUTABLE'});
  await assert.rejects(stat(marker),{code:'ENOENT'});
});
