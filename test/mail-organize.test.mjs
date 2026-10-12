import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,realpath,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {ImapFlow} from 'imapflow';
import {mailFlag,mailMark,mailMove,mailLabel,mailTriage} from '../dist/mail-organize.js';
import {mailList} from '../dist/mail.js';
import {imapServerAvailable,startImapServer,seed,day,plain} from './fixtures/imap-server.mjs';

const available=imapServerAvailable();
if(!available&&process.env.WAYPOST_REQUIRE_E2E)throw new Error('WAYPOST_REQUIRE_E2E is set but pymap or openssl is missing.');
const skip=!available&&'pymap (or uvx) and openssl are needed; install with: pipx install pymap==0.36.7';
const mailConfig=(overrides={},mail={})=>({version:1,artifactsDir:'/nonexistent/artifacts',timeoutMs:5000,mail:{host:'127.0.0.1',imapPort:1,smtpPort:1,usernameEnv:'WAYPOST_MAIL_USERNAME',passwordEnv:'WAYPOST_MAIL_PASSWORD',certificate:'/nonexistent/cert.pem',sendEnabled:false,organizeEnabled:true,...mail},...overrides});
const enabled=mailConfig();

// ---------- refusals that run before any connection ----------
test('organizing is off unless enabled, and unavailable on the read-only helper or without Bridge',async()=>{
  const input={mailbox:'INBOX',uids:[1]};
  const calls=[
    config=>mailFlag(config,{...input,starred:true}),
    config=>mailMark(config,{...input,read:true}),
    config=>mailMove(config,{...input,to:'Archive'}),
    config=>mailLabel(config,{...input,label:'Receipts'}),
  ];
  for(const call of calls){
    await assert.rejects(call(mailConfig({},{organizeEnabled:false})),{code:'MAIL_ORGANIZE_DISABLED'});
    await assert.rejects(call(mailConfig({},{organizeEnabled:undefined})),{code:'MAIL_ORGANIZE_DISABLED'});
    await assert.rejects(call({version:1,artifactsDir:'/tmp',timeoutMs:1000}),{code:'MAIL_UNCONFIGURED'});
    await assert.rejects(call({version:1,artifactsDir:'/tmp',timeoutMs:1000,mailHelper:{executable:'/nonexistent/helper'}}),{code:'MAIL_HELPER_READ_ONLY'});
  }
});

test('every organize call needs confirm: true, even for one message',async()=>{
  const input={mailbox:'INBOX',uids:[1,2]};
  await assert.rejects(mailFlag(enabled,{...input,starred:true}),{code:'CONFIRMATION_REQUIRED'});
  await assert.rejects(mailMark(enabled,{...input,read:false}),{code:'CONFIRMATION_REQUIRED'});
  await assert.rejects(mailMove(enabled,{...input,to:'Archive'}),{code:'CONFIRMATION_REQUIRED'});
  await assert.rejects(mailLabel(enabled,{...input,label:'Receipts'}),{code:'CONFIRMATION_REQUIRED'});
  // One message from an injected email must not move without approval either.
  await assert.rejects(mailFlag(enabled,{mailbox:'INBOX',uids:[1],starred:true}),{code:'CONFIRMATION_REQUIRED'});
  // With confirm it passes the gate and reaches the (unreachable) connection instead.
  await assert.rejects(mailFlag(enabled,{mailbox:'INBOX',uids:[1],starred:true,confirm:true}),error=>error.code!=='CONFIRMATION_REQUIRED'&&error.code!=='MAIL_ORGANIZE_DISABLED');
});

test('mail_move refuses Trash, Spam, Sent, Drafts, Starred, All Mail and labels before connecting',async()=>{
  for(const to of ['Trash','trash','SPAM','Spam','All Mail','Drafts','Sent','Starred','Labels/Receipts'])
    await assert.rejects(mailMove(enabled,{mailbox:'INBOX',uids:[1],to}),{code:'MAIL_MOVE_REFUSED'},to);
  await assert.rejects(mailMove(enabled,{mailbox:'INBOX',uids:[1],to:'INBOX'}),{code:'INPUT_INVALID'});
  // Refusal does not depend on confirm: a confirmed batch into Trash is still refused.
  await assert.rejects(mailMove(enabled,{mailbox:'INBOX',uids:[1,2,3],to:'Trash',confirm:true}),{code:'MAIL_MOVE_REFUSED'});
});

test('inputs are bounded: 1-100 integer UIDs, no control characters',async()=>{
  const bad=[
    {mailbox:'INBOX',uids:[],starred:true},
    {mailbox:'INBOX',uids:Array.from({length:101},(_,index)=>index+1),starred:true,confirm:true},
    {mailbox:'INBOX',uids:[0],starred:true},
    {mailbox:'INBOX',uids:[1.5],starred:true},
    {mailbox:'INBOX',uids:[4294967296],starred:true},
    {mailbox:'IN\nBOX',uids:[1],starred:true},
    {mailbox:'INBOX',uids:[1],starred:'yes'},
    {mailbox:'INBOX',uids:[1],starred:true,extra:1},
  ];
  for(const input of bad)await assert.rejects(mailFlag(enabled,input),{name:'ZodError'},JSON.stringify(input));
});

test('mail_triage needs a saved Sieve file and direct Bridge',async t=>{
  await assert.rejects(mailTriage(enabled,{mailbox:'INBOX',uid:1}),{code:'SIEVE_UNCONFIGURED'});
  const root=await mkdtemp(join(await realpath(tmpdir()),'waypost-triage-'));
  t.after(()=>rm(root,{recursive:true,force:true}));
  await assert.rejects(mailTriage(mailConfig({},{triageSieve:join(root,'missing.sieve')}),{mailbox:'INBOX',uid:1}),{code:'SIEVE_UNCONFIGURED'});
  await assert.rejects(mailTriage(mailConfig({},{triageSieve:root}),{mailbox:'INBOX',uid:1}),{code:'SIEVE_UNCONFIGURED'});
  const big=join(root,'big.sieve');await writeFile(big,'#'.repeat(65*1024));
  await assert.rejects(mailTriage(mailConfig({},{triageSieve:big}),{mailbox:'INBOX',uid:1}),{code:'SIEVE_UNCONFIGURED'});
  const script=join(root,'ok.sieve');await writeFile(script,'keep;');
  await assert.rejects(mailTriage({version:1,artifactsDir:'/tmp',timeoutMs:1000,mailHelper:{executable:'/nonexistent/helper'},mail:undefined},{mailbox:'INBOX',uid:1}),{code:'SIEVE_UNCONFIGURED'});
});

// ---------- real IMAP (pymap) ----------
async function imapOf(server){
  const client=new ImapFlow({host:'127.0.0.1',port:server.port,secure:false,doSTARTTLS:true,tls:{ca:[server.certificatePem]},auth:{user:server.user,pass:server.secret},logger:false});
  await client.connect();
  return client;
}
/** Test-only reader that sees flags and folder contents independently of Waypost. */
async function snapshot(server,mailbox='INBOX'){
  const client=await imapOf(server);
  try{
    const lock=await client.getMailboxLock(mailbox);
    try{
      const rows=[];
      if(client.mailbox.exists)for await(const message of client.fetch('1:*',{uid:true,flags:true,envelope:true}))rows.push({uid:message.uid,subject:message.envelope.subject,flags:[...message.flags].sort()});
      return rows;
    }finally{lock.release();}
  }finally{await client.logout();}
}
async function mkdirs(server,...names){
  const client=await imapOf(server);
  try{for(const name of names)await client.mailboxCreate(name);}finally{await client.logout();}
}
const message=(n,subject,extra='',from='sender@example.test')=>plain({from:`Sender ${n} <${from}>`,subject,date:day(n),id:`organize-${n}@example.test`,body:`Body ${n}`,extra});

test('organizing against a real IMAP server: star, read, batch, move, label, audit and triage',{skip,timeout:180000},async t=>{
  const server=await startImapServer(t);
  const root=await mkdtemp(join(await realpath(tmpdir()),'waypost-organize-'));
  t.after(()=>rm(root,{recursive:true,force:true}));
  const env={user:process.env.WAYPOST_MAIL_USERNAME,pass:process.env.WAYPOST_MAIL_PASSWORD};
  t.after(()=>{for(const [name,value] of [['WAYPOST_MAIL_USERNAME',env.user],['WAYPOST_MAIL_PASSWORD',env.pass]]){if(value===undefined)delete process.env[name];else process.env[name]=value;}});
  process.env.WAYPOST_MAIL_USERNAME=server.user;process.env.WAYPOST_MAIL_PASSWORD=server.secret;
  const sieve=join(root,'filter.sieve');
  await writeFile(sieve,'require ["fileinto","imap4flags"];\nif header :contains "subject" "urgent" { addflag "\\\\Flagged"; }\nif address :domain :is "from" "school.example" { addflag "\\\\Seen"; fileinto "Archive"; }\n');
  const config=mailConfig({artifactsDir:join(root,'artifacts')},{imapPort:server.port,certificate:server.certificate,triageSieve:sieve});
  await seed(server,[
    message(1,'Urgent: sign this'),
    message(2,'Lunch plans'),
    message(3,'Term dates',"",'registrar@school.example'),
    message(4,'Receipt 4471'),
  ]);
  await mkdirs(server,'Archive','Folders/Receipts','Labels/Receipts');
  const uidOf=async subject=>(await snapshot(server)).find(row=>row.subject===subject).uid;
  const [urgent,lunch,term,receipt]=[await uidOf('Urgent: sign this'),await uidOf('Lunch plans'),await uidOf('Term dates'),await uidOf('Receipt 4471')];
  const flagsOf=async uid=>(await snapshot(server)).find(row=>row.uid===uid)?.flags;

  // Star and unstar one message; nothing else changes.
  const starred=await mailFlag(config,{mailbox:'INBOX',uids:[urgent],starred:true,confirm:true});
  assert.deepEqual([starred.changed,starred.missing,starred.starred,starred.permanentDelete],[[urgent],[],true,false]);
  assert.ok((await flagsOf(urgent)).includes('\\Flagged'));
  assert.ok(!(await flagsOf(lunch)).includes('\\Flagged'));
  await mailFlag(config,{mailbox:'INBOX',uids:[urgent],starred:false,confirm:true});
  assert.ok(!(await flagsOf(urgent)).includes('\\Flagged'));

  // Read state is visible through mail_list.
  const readResult=await mailMark(config,{mailbox:'INBOX',uids:[lunch],read:true,confirm:true});
  assert.equal(readResult.read,true);
  const listed=(await mailList(config,{mailbox:'INBOX',limit:10})).messages;
  assert.deepEqual(Object.fromEntries(listed.map(row=>[row.subject,row.seen])),{'Urgent: sign this':false,'Lunch plans':true,'Term dates':false,'Receipt 4471':false});
  await mailMark(config,{mailbox:'INBOX',uids:[lunch],read:false,confirm:true});
  assert.equal((await mailList(config,{mailbox:'INBOX',limit:10})).messages.every(row=>!row.seen),true);

  // A batch with confirm changes every present UID and reports the missing one.
  await assert.rejects(mailFlag(config,{mailbox:'INBOX',uids:[urgent,lunch],starred:true}),{code:'CONFIRMATION_REQUIRED'});
  assert.ok(!(await flagsOf(urgent)).includes('\\Flagged'),'a refused batch changed nothing');
  const batch=await mailFlag(config,{mailbox:'INBOX',uids:[urgent,lunch,99999],starred:true,confirm:true});
  assert.deepEqual([batch.changed,batch.missing],[[urgent,lunch],[99999]]);
  assert.ok((await flagsOf(lunch)).includes('\\Flagged'));
  await assert.rejects(mailFlag(config,{mailbox:'INBOX',uids:[99998,99999],starred:true,confirm:true}),{code:'MAIL_NOT_FOUND'});
  await assert.rejects(mailFlag(config,{mailbox:'Folders/Nope',uids:[1],starred:true,confirm:true}),{code:'MAIL_MAILBOX_NOT_FOUND'});

  // Moves into protected folders are refused even though the folders may exist; a normal move relocates the message.
  await assert.rejects(mailMove(config,{mailbox:'INBOX',uids:[receipt],to:'Trash',confirm:true}),{code:'MAIL_MOVE_REFUSED'});
  assert.ok(await flagsOf(receipt),'the message is still in the inbox');
  await assert.rejects(mailMove(config,{mailbox:'INBOX',uids:[receipt],to:'Folders/Missing',confirm:true}),{code:'MAIL_MAILBOX_NOT_FOUND'});
  const moved=await mailMove(config,{mailbox:'INBOX',uids:[receipt],to:'Folders/Receipts',confirm:true});
  assert.deepEqual([moved.moved,moved.missing,moved.to],[[receipt],[],'Folders/Receipts']);
  assert.equal(await flagsOf(receipt),undefined,'gone from the inbox');
  assert.deepEqual((await snapshot(server,'Folders/Receipts')).map(row=>row.subject),['Receipt 4471']);
  assert.equal((await snapshot(server)).length,3);

  // A label is a copy into Labels/<name>: the original stays.
  const labeled=await mailLabel(config,{mailbox:'INBOX',uids:[term],label:'Receipts',confirm:true});
  assert.deepEqual([labeled.labeled,labeled.label],[[term],'Labels/Receipts']);
  assert.deepEqual((await snapshot(server,'Labels/Receipts')).map(row=>row.subject),['Term dates']);
  assert.ok(await flagsOf(term),'the original stays in the inbox');
  await mailLabel(config,{mailbox:'INBOX',uids:[lunch],label:'Labels/Receipts',confirm:true});
  assert.equal((await snapshot(server,'Labels/Receipts')).length,2);
  await assert.rejects(mailLabel(config,{mailbox:'INBOX',uids:[term],label:'Nonexistent',confirm:true}),{code:'MAIL_MAILBOX_NOT_FOUND'});

  // Triage explains the saved filter against the real message headers and changes nothing.
  const before=JSON.stringify(await snapshot(server));
  const urgentTriage=await mailTriage(config,{mailbox:'INBOX',uid:urgent});
  assert.equal(urgentTriage.wouldStar,true);
  assert.deepEqual([urgentTriage.fileInto,urgentTriage.keep,urgentTriage.changedMail,urgentTriage.evaluatedLocally],[[],true,false,true]);
  assert.equal(urgentTriage.matchedRules.length,1);
  const schoolTriage=await mailTriage(config,{mailbox:'INBOX',uid:term});
  assert.deepEqual([schoolTriage.wouldStar,schoolTriage.wouldMarkRead,schoolTriage.fileInto,schoolTriage.keep],[false,true,['Archive'],false]);
  assert.match(schoolTriage.explanation,/filed into Archive/);
  await assert.rejects(mailTriage(config,{mailbox:'INBOX',uid:99999}),{code:'MAIL_NOT_FOUND'});
  assert.equal(JSON.stringify(await snapshot(server)),before);

  // Every successful write left an audit line with no message content.
  const audits=(await readFile(join(root,'artifacts','audit.jsonl'),'utf8')).trim().split('\n').map(line=>JSON.parse(line));
  assert.deepEqual(audits.map(entry=>entry.action),['mail_flag','mail_flag','mail_mark','mail_mark','mail_flag','mail_move','mail_label','mail_label']);
  assert.ok(audits.every(entry=>entry.service==='mail'));
  assert.ok(!JSON.stringify(audits).includes('Body'));
});
