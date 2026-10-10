// End to end: the bundled runtime runs as an MCP server over stdio and talks to a real
// IMAP server (pymap) through STARTTLS with a pinned certificate. Synthetic data only.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {writeFile,readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {join,resolve} from 'node:path';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';
import {imapServerAvailable,startImapServer,seed,day,plain} from './fixtures/imap-server.mjs';

const available=imapServerAvailable();
if(!available&&process.env.WAYPOST_REQUIRE_E2E)throw new Error('WAYPOST_REQUIRE_E2E is set but pymap or openssl is missing.');
async function connect(t,server,{wrong=false,extra={}}={}) {
  const config=join(server.root,`config-${Math.random().toString(16).slice(2)}.json`);
  await writeFile(config,JSON.stringify({version:1,artifactsDir:join(server.root,'artifacts'),timeoutMs:10000,mail:{host:'127.0.0.1',imapPort:server.port,smtpPort:1,certificate:server.certificate},...extra}),{mode:0o600});
  const client=new Client({name:'waypost-e2e',version:'1.0.0'});
  const transport=new StdioClientTransport({command:process.execPath,args:[resolve('runtime/waypost.mjs'),'--config',config,'mcp'],env:{...process.env,WAYPOST_MAIL_USERNAME:server.user,WAYPOST_MAIL_PASSWORD:wrong?[...server.secret].reverse().join(''):server.secret},stderr:'pipe'});
  let stderr='';transport.stderr?.on('data',data=>{stderr+=data;});
  await client.connect(transport);
  t.after(()=>client.close());
  const call=async(name,args={})=>{const result=await client.callTool({name,arguments:args});return {error:!!result.isError,...result.structuredContent};};
  return {client,call,stderr:()=>stderr};
}
const attachmentMessage=`From: Planner <planner@example.test>
To: me@example.test
Subject: Re: Project kickoff
Date: ${day(29)}
Message-ID: <thread-reply2@example.test>
In-Reply-To: <thread-reply@example.test>
References: <thread-root@example.test> <thread-reply@example.test>
MIME-Version: 1.0
Content-Type: multipart/mixed; boundary="b1"

--b1
Content-Type: multipart/alternative; boundary="b2"

--b2
Content-Type: text/plain; charset=utf-8

Agenda attached.
--b2
Content-Type: text/html; charset=utf-8

<p>Agenda <b>attached</b>.</p>
--b2--
--b1
Content-Type: application/pdf; name="agenda.pdf"
Content-Disposition: attachment; filename="agenda.pdf"
Content-Transfer-Encoding: base64

JVBERi0xLjQKJSVFT0YK
--b1--
`;
test('MCP over stdio reads a real IMAP server: mailboxes, paging, search, encodings, threads, attachments',{skip:!available&&'pymap (or uvx) and openssl are needed; install with: pipx install pymap==0.36.7',timeout:180000},async t=>{
  const server=await startImapServer(t);
  const filler=Array.from({length:25},(_,index)=>plain({from:`Filler ${index+1} <filler${index+1}@example.test>`,subject:`Filler ${index+1}`,date:day(index+1),id:`filler-${index+1}@example.test`,body:`Filler body ${index+1}`}));
  await seed(server,[
    ...filler,
    `From: =?UTF-8?B?SsO8cmdlbiBNw7xsbGVy?= <juergen@example.test>\nTo: me@example.test\nSubject: =?UTF-8?Q?Gr=C3=BC=C3=9Fe_aus_M=C3=BCnchen?=\nDate: ${day(26)}\nMessage-ID: <encoded@example.test>\nMIME-Version: 1.0\nContent-Type: text/plain; charset=iso-8859-1\nContent-Transfer-Encoding: quoted-printable\n\nSch=F6ne Gr=FC=DFe, caf=E9.\n`,
    plain({from:'Planner <planner@example.test>',subject:'Project kickoff',date:day(27),id:'thread-root@example.test',body:'Can we meet Tuesday?'}),
    plain({from:'Me <me@example.test>',to:'planner@example.test',subject:'Re: Project kickoff',date:day(28),id:'thread-reply@example.test',extra:'In-Reply-To: <thread-root@example.test>\nReferences: <thread-root@example.test>\n',body:'Tuesday works.'}),
    attachmentMessage,
    `From: News <news@example.test>\nTo: me@example.test\nSubject: HTML only\nDate: ${day(30)}\nMessage-ID: <html-only@example.test>\nMIME-Version: 1.0\nContent-Type: text/html; charset=utf-8\n\n<html><head><style>p{color:red}</style><script>alert(1)</script></head><body><h1>Weekly &amp; news</h1><p>Read <a href="https://example.test/x">this</a>.</p><img src="https://tracker.example.test/p.gif"></body></html>\n`,
  ]);
  await seed(server,[plain({from:'Boss <boss@example.test>',subject:'Work item',date:day(31),id:'work@example.test',body:'Work body'})],'Folders/Work');
  const {client,call,stderr}=await connect(t,server);

  const names=(await client.listTools()).tools.map(tool=>tool.name);
  for (const name of ['mail_mailboxes','mail_list','mail_read','mail_thread','mail_attachment']) assert.ok(names.includes(name),name);
  assert.equal((await call('mail_doctor')).data.imapAuthenticated,true);

  const boxes=(await call('mail_mailboxes',{counts:true})).data.mailboxes;
  assert.deepEqual(boxes.find(box=>box.path==='Folders/Work'),{path:'Folders/Work',name:'Work',specialUse:null,selectable:true,messages:1,unseen:1});

  // Paging walks the whole mailbox newest first with no gaps or repeats.
  const seen=[];let cursor;
  do {
    const page=(await call('mail_list',{limit:7,...(cursor?{beforeUid:cursor}:{})})).data;
    assert.equal(page.total,cursor?page.total:30);
    seen.push(...page.messages.map(message=>message.messageId));cursor=page.nextBeforeUid;
  } while (cursor);
  assert.equal(seen.length,30);assert.equal(new Set(seen).size,30);
  assert.equal(seen[0],'<html-only@example.test>');assert.equal(seen.at(-1),'<filler-1@example.test>');

  const search=(await call('mail_list',{subject:'kickoff'})).data;
  assert.deepEqual(search.messages.map(message=>message.messageId),['<thread-reply2@example.test>','<thread-reply@example.test>','<thread-root@example.test>']);
  assert.equal(search.messages[0].attachments,1);
  assert.deepEqual((await call('mail_list',{text:'Tuesday',from:'planner@example.test'})).data.messages.map(message=>message.subject),['Project kickoff']);
  assert.equal((await call('mail_list',{since:'2026-09-30'})).data.total,2);

  const uidOf=subject=>search.messages.find(message=>message.subject===subject)?.uid;
  const all=(await call('mail_list',{limit:50})).data.messages;
  const encoded=(await call('mail_read',{uid:all.find(message=>message.messageId==='<encoded@example.test>').uid})).data;
  assert.equal(encoded.subject,'Grüße aus München');assert.equal(encoded.from[0].name,'Jürgen Müller');assert.equal(encoded.text.trim(),'Schöne Grüße, café.');

  const html=(await call('mail_read',{uid:all[0].uid})).data;
  assert.equal(html.htmlOnly,true);
  assert.equal(html.text,'Weekly & news\n\nRead this [https://example.test/x].');
  assert.doesNotMatch(html.text,/alert|color|tracker/);

  const reply=(await call('mail_read',{uid:uidOf('Re: Project kickoff')})).data;
  assert.equal(reply.text,'Agenda attached.');
  assert.equal(reply.inReplyTo,'<thread-reply@example.test>');
  assert.deepEqual(reply.attachments,[{part:'2',filename:'agenda.pdf',contentType:'application/pdf',bytes:reply.attachments[0].bytes,inline:false}]);

  const thread=(await call('mail_thread',{uid:all.find(message=>message.messageId==='<thread-root@example.test>').uid})).data;
  assert.deepEqual(thread.messages.map(message=>message.messageId),['<thread-root@example.test>','<thread-reply@example.test>','<thread-reply2@example.test>']);

  const saved=(await call('mail_attachment',{uid:reply.uid,part:'2'})).data;
  const bytes=await readFile(saved.path);
  assert.equal(bytes.toString('latin1'),'%PDF-1.4\n%%EOF\n');
  assert.equal(saved.sha256,createHash('sha256').update(bytes).digest('hex'));
  assert.equal((await call('mail_attachment',{uid:reply.uid,part:'1.1'})).error.code,'MAIL_ATTACHMENT_NOT_FOUND');

  // Reads used BODY.PEEK and EXAMINE: nothing was marked read.
  assert.ok((await call('mail_list',{limit:50})).data.messages.every(message=>message.seen===false));

  assert.equal((await call('mail_list',{mailbox:'Folders/Missing'})).error.code,'MAIL_MAILBOX_NOT_FOUND');
  assert.equal((await call('mail_read',{uid:999999})).error.code,'MAIL_NOT_FOUND');
  assert.equal((await call('mail_send',{path:'/x',sha256:'0'.repeat(64),confirm:true})).error.code,'MAIL_SEND_DISABLED');
  const wrong=await connect(t,server,{wrong:true});
  assert.equal((await wrong.call('mail_doctor')).error.code,'MAIL_AUTH');
  assert.equal(stderr(),'');
});
