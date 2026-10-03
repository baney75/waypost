import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import net from 'node:net';
import tls from 'node:tls';
import { createHash } from 'node:crypto';
import { simpleParser } from 'mailparser';
import { mailDoctor, mailList, mailRead, mailDraft, mailSend } from '../dist/mail.js';

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(),'waypost-mail-'));
  t.after(() => rm(root,{recursive:true,force:true}));
  const key = join(root,'synthetic.key'), certificate = join(root,'synthetic.pem');
  execFileSync('openssl',['req','-x509','-newkey','rsa:2048','-nodes','-keyout',key,'-out',certificate,'-days','2','-subj','/CN=Synthetic Bridge'],{stdio:'ignore'});
  const usernameEnv = 'WAYPOST_TEST_USER_' + Math.random().toString(16).slice(2).toUpperCase();
  const passwordEnv = 'WAYPOST_TEST_PASS_' + Math.random().toString(16).slice(2).toUpperCase();
  process.env[usernameEnv] = 'synthetic-client'; process.env[passwordEnv] = 'synthetic-password';
  t.after(() => { delete process.env[usernameEnv]; delete process.env[passwordEnv]; });
  return {root, key:await readFile(key), certificate:await readFile(certificate), config:{version:1, artifactsDir:join(root,'artifacts'), timeoutMs:1000, mail:{host:'127.0.0.1',imapPort:1143,smtpPort:1025,usernameEnv,passwordEnv,certificate,sendEnabled:false}}};
}
async function listener(t, fixture, protocol, {starttls=true, certificate=fixture.certificate, key=fixture.key, source=Buffer.from('From: sender@example.com\r\nTo: recipient@example.com\r\nSubject: Synthetic\r\nDate: Fri, 6 Mar 2026 09:00:00 +0000\r\nContent-Type: text/plain; charset=utf-8\r\n\r\nSynthetic body'), size=source.length, imapAuth=true, smtpAuth=true, smtpDrop=false}={}) {
  const commands = [], sockets = new Set(); let submissions = 0;
  const context = tls.createSecureContext({key,cert:certificate});
  const server = net.createServer(socket => {
    sockets.add(socket); socket.on('close',()=>sockets.delete(socket)); socket.on('error',()=>{});
    socket.write(protocol==='imap' ? '* OK synthetic IMAP\r\n' : '220 synthetic SMTP\r\n');
    function attach(connection, encrypted) {
      let pending = '', waitingAuth = false, dataMode = false;
      const consume = chunk => {
        pending += chunk.toString();
        let index;
        while ((index=pending.indexOf('\r\n')) >= 0) {
          const line = pending.slice(0,index); pending=pending.slice(index+2);
          if (dataMode) {
            if (line==='.') { dataMode=false; submissions++; if(smtpDrop) connection.destroy(); else connection.write('250 queued synthetic\r\n'); }
            continue;
          }
          if(waitingAuth) { waitingAuth=false; connection.write(`${authTag} ${imapAuth?'OK':'NO'} authentication\r\n`); continue; }
          commands.push(line.replace(/(AUTH(?:ENTICATE)?|LOGIN).*/i,'$1 [synthetic credentials redacted]'));
          if (protocol==='imap') {
            const [tag,command,...rest] = line.split(' '); const args=rest.join(' ');
            if(command==='CAPABILITY') connection.write(`* CAPABILITY IMAP4rev1 ${encrypted?'AUTH=PLAIN SASL-IR':starttls?'STARTTLS':''}\r\n${tag} OK capability\r\n`);
            else if(command==='STARTTLS') {
              connection.removeListener('data',consume); connection.write(`${tag} OK upgrade\r\n`);
              const secured = new tls.TLSSocket(connection,{isServer:true,secureContext:context});
              secured.on('error',()=>{}); attach(secured,true); return;
            } else if(command==='AUTHENTICATE') {
              if (!encrypted) { connection.write(`${tag} NO TLS required\r\n`); continue; }
              if(rest.length>1) connection.write(`${tag} ${imapAuth?'OK':'NO'} authentication\r\n`);
              else { authTag=tag; waitingAuth=true; connection.write('+ \r\n'); }
            } else if(command==='EXAMINE') connection.write(`* FLAGS (\\Seen)\r\n* 30 EXISTS\r\n* OK [UIDVALIDITY 1]\r\n* OK [UIDNEXT 43]\r\n${tag} OK [READ-ONLY] examine\r\n`);
            else if(command==='FETCH') {
              const range=rest[0].split(':').map(Number);
              for(let sequence=range[0];sequence<=range[1];sequence++) connection.write(`* ${sequence} FETCH (UID ${sequence} FLAGS () RFC822.SIZE 160 ENVELOPE ("Fri, 6 Mar 2026 09:00:00 +0000" "Synthetic ${sequence}" (("Sender" NIL "sender" "example.com")) NIL NIL (("Recipient" NIL "recipient" "example.com")) NIL NIL NIL "<synthetic-${sequence}@example.com>"))\r\n`);
              connection.write(`${tag} OK fetch\r\n`);
            } else if(command==='UID' && /^FETCH /.test(args)) {
              connection.write(`* 1 FETCH (UID 42 RFC822.SIZE ${size} BODY[]<0> {${source.length}}\r\n`);
              connection.write(source); connection.write(`)\r\n${tag} OK fetch\r\n`);
            } else if(command==='LIST') connection.write(`* LIST (\\HasNoChildren) "/" "INBOX"\r\n${tag} OK list\r\n`);
            else connection.write(`${tag} OK synthetic\r\n`);
          } else {
            const command = line.split(' ')[0];
            if(command==='EHLO') connection.write(`250-synthetic\r\n${encrypted?(smtpAuth?'250-AUTH PLAIN\r\n':''):starttls?'250-STARTTLS\r\n':''}250 SIZE 1048576\r\n`);
            else if(command==='STARTTLS') {
              if(!starttls) { connection.write('502 unavailable\r\n'); continue; }
              connection.removeListener('data',consume); connection.write('220 upgrade\r\n');
              const secured = new tls.TLSSocket(connection,{isServer:true,secureContext:context});
              secured.on('error',()=>{}); attach(secured,true); return;
            } else if(command==='AUTH') connection.write(encrypted && smtpAuth?'235 authenticated\r\n':'535 authentication unavailable\r\n');
            else if(command==='DATA') { dataMode=true; connection.write('354 continue\r\n'); }
            else if(command==='QUIT') connection.end('221 goodbye\r\n');
            else connection.write('250 accepted\r\n');
          }
        }
      };
      let authTag;
      connection.on('data',consume);
    }
    attach(socket,false);
  });
  await new Promise(resolve => server.listen(0,'127.0.0.1',resolve));
  t.after(async () => { for(const socket of sockets) socket.destroy(); await new Promise(resolve => server.close(resolve)); });
  fixture.config.mail[protocol==='imap'?'imapPort':'smtpPort'] = server.address().port;
  return {commands, get submissions(){return submissions;}};
}

test('doctor proves TLS and authentication separately from mailbox read; auth failure is explicit', async t => {
  const f = await fixture(t);
  const imap = await listener(t,f,'imap');
  const smtp = await listener(t,f,'smtp');
  const result = await mailDoctor(f.config,{smtp:true});
  assert.deepEqual({imap:result.imapAuthenticated,smtp:result.smtpAuthenticated,read:result.mailboxRead},{imap:true,smtp:true,read:false});
  assert.ok(imap.commands.some(line => line.includes('STARTTLS')));
  assert.ok(!imap.commands.some(line => /EXAMINE|SELECT|FETCH/.test(line)));
  assert.equal(smtp.submissions,0);
  await listener(t,f,'imap',{imapAuth:false});
  await assert.rejects(mailDoctor(f.config,{}),{code:'MAIL_CONNECTION'});
  await listener(t,f,'imap');
  await listener(t,f,'smtp',{smtpAuth:false});
  await assert.rejects(mailDoctor(f.config,{smtp:true}),{code:'MAIL_SMTP'});
});

test('list reads at most 20 headers in EXAMINE without fetching message bodies or updating flags', async t => {
  const f=await fixture(t), server=await listener(t,f,'imap');
  const result=await mailList(f.config,{limit:20});
  assert.equal(result.messages.length,20);
  assert.equal(result.messages[0].uid,30);
  assert.equal(result.messages[19].uid,11);
  assert.ok(server.commands.some(line => /EXAMINE "?INBOX/.test(line)));
  assert.ok(server.commands.some(line => /FETCH 11:30 /.test(line)));
  assert.ok(!server.commands.some(line => /SELECT|STORE|BODY/.test(line)));
  await assert.rejects(mailList(f.config,{limit:21}));
});

test('read uses UID BODY.PEEK, bounded source, and discloses truncation', async t => {
  const f=await fixture(t);
  const source=Buffer.concat([Buffer.from('From: sender@example.com\r\nSubject: Synthetic large\r\nContent-Type: text/plain\r\n\r\n'),Buffer.alloc(262144,'x')]).subarray(0,262144);
  const server=await listener(t,f,'imap',{source,size:300000});
  const result=await mailRead(f.config,{uid:42});
  assert.equal(result.uid,42);
  assert.equal(result.text.length,12000);
  assert.equal(result.fetchedBytes,262144);
  assert.equal(result.partial,true);
  assert.ok(server.commands.some(line => /UID FETCH 42 .*BODY\.PEEK\[\]<0\.262144>/.test(line)));
  assert.ok(!server.commands.some(line => /STORE|SELECT/.test(line)));
});

test('HTML-only mail is inert and attachment bytes are not returned', async t => {
  const f=await fixture(t);
  await listener(t,f,'imap',{source:Buffer.from('Subject: HTML synthetic\r\nContent-Type: text/html\r\n\r\n<p>Hello</p><script>malicious()</script><img src="https://example.invalid/tracker"><p>World</p>')});
  const result=await mailRead(f.config,{uid:42});
  assert.equal(result.htmlOnly,true);
  assert.equal(result.text,'Hello World');
  assert.equal(result.attachmentsReturned,false);
  assert.equal('html' in result,false);
});

test('missing credentials/certificate and non-loopback host fail closed before connecting', async t => {
  const f=await fixture(t);
  await assert.rejects(mailDoctor({...f.config,mail:{...f.config.mail,host:'mail.example.com'}},{}),{code:'MAIL_HOST'});
  await assert.rejects(mailDoctor({...f.config,mail:{...f.config.mail,certificate:join(f.root,'missing.pem')}},{}),{code:'MAIL_CERTIFICATE'});
  delete process.env[f.config.mail.passwordEnv];
  await assert.rejects(mailDoctor(f.config,{}),{code:'MAIL_CREDENTIALS'});
});

test('IMAP and SMTP refuse unencrypted listeners', async t => {
  const f=await fixture(t);
  const imap=await listener(t,f,'imap',{starttls:false});
  await assert.rejects(mailDoctor(f.config,{}),{code:'MAIL_CONNECTION'});
  assert.ok(!imap.commands.some(line => /AUTH|LOGIN/.test(line)));
  await listener(t,f,'imap');
  const smtp=await listener(t,f,'smtp',{starttls:false});
  await assert.rejects(mailDoctor(f.config,{smtp:true}),{code:'MAIL_SMTP'});
  assert.equal(smtp.submissions,0);
  assert.ok(!smtp.commands.some(line => /AUTH/.test(line)));
});

test('leaf pin rejects another certificate signed by the approved certificate', async t => {
  const f=await fixture(t), alternateKey=join(f.root,'alternate.key'), csr=join(f.root,'alternate.csr'), cert=join(f.root,'alternate.pem');
  execFileSync('openssl',['req','-new','-newkey','rsa:2048','-nodes','-keyout',alternateKey,'-out',csr,'-subj','/CN=Alternate synthetic'],{stdio:'ignore'});
  execFileSync('openssl',['x509','-req','-in',csr,'-CA',f.config.mail.certificate,'-CAkey',join(f.root,'synthetic.key'),'-CAcreateserial','-out',cert,'-days','1'],{stdio:'ignore'});
  const alternate={certificate:await readFile(cert),key:await readFile(alternateKey)};
  const server=await listener(t,f,'imap',alternate);
  await assert.rejects(mailDoctor(f.config,{}),{code:'MAIL_CONNECTION'});
  assert.ok(!server.commands.some(line => /AUTH|LOGIN/.test(line)));
  await listener(t,f,'imap');
  const smtp=await listener(t,f,'smtp',alternate);
  await assert.rejects(mailDoctor(f.config,{smtp:true}),{code:'MAIL_SMTP'});
  assert.equal(smtp.submissions,0);
  assert.ok(!smtp.commands.some(line => /AUTH/.test(line)));
});

test('draft is a local round-trippable EML with exact digest; inputs reject header injection', async t => {
  const f=await fixture(t);
  const message={from:'sender@example.com',to:['recipient@example.com'],subject:'Synthetic subject é',text:'Synthetic body\nSecond line'};
  const result=await mailDraft(f.config,message), bytes=await readFile(result.path), parsed=await simpleParser(bytes);
  assert.equal(result.sha256,createHash('sha256').update(bytes).digest('hex'));
  assert.equal(parsed.subject,message.subject);
  assert.equal(parsed.text.trim(),message.text);
  assert.equal(parsed.to.value[0].address,'recipient@example.com');
  assert.equal(result.sent,false); assert.equal(result.storedInMailbox,false);
  for(const invalid of [{...message,from:'sender@example.com\r\nBcc: victim@example.com'},{...message,subject:'Subject\nBcc: victim@example.com'},{...message,to:['not-an-address']},{...message,attachments:[{path:'/etc/passwd'}]}]) await assert.rejects(mailDraft(f.config,invalid));
  await assert.rejects(mailSend(f.config,{path:result.path,sha256:result.sha256}),{code:'MAIL_SEND_DISABLED'});
});

test('send requires exact prepared digest, submits once and prevents a repeated attempt', async t => {
  const f=await fixture(t), smtp=await listener(t,f,'smtp'); f.config.mail.sendEnabled=true;
  const draft=await mailDraft(f.config,{from:'sender@example.com',to:['recipient@example.com'],subject:'Synthetic send',text:'Synthetic only'});
  await assert.rejects(mailSend(f.config,{path:draft.path,sha256:'0'.repeat(64)}),{code:'MAIL_DIGEST'});
  assert.equal(smtp.submissions,0);
  const result=await mailSend(f.config,{path:draft.path,sha256:draft.sha256});
  assert.equal(result.submitted,true); assert.equal(result.delivered,false);
  assert.deepEqual(result.accepted,['recipient@example.com']); assert.equal(smtp.submissions,1);
  await assert.rejects(mailSend(f.config,{path:draft.path,sha256:draft.sha256}),{code:'MAIL_ALREADY_ATTEMPTED'});
  assert.equal(smtp.submissions,1);
  await writeFile(draft.path,'tampered');
  await assert.rejects(mailSend(f.config,{path:draft.path,sha256:draft.sha256}),{code:'MAIL_DIGEST'});
});

test('uncertain SMTP outcome reserves the attempt and never retries', async t => {
  const f=await fixture(t), smtp=await listener(t,f,'smtp',{smtpDrop:true}); f.config.mail.sendEnabled=true;
  const draft=await mailDraft(f.config,{from:'sender@example.com',to:['recipient@example.com'],subject:'Synthetic uncertain',text:'Synthetic only'});
  await assert.rejects(mailSend(f.config,{path:draft.path,sha256:draft.sha256}),{code:'MAIL_SEND_UNCERTAIN'});
  assert.equal(smtp.submissions,1);
  await assert.rejects(mailSend(f.config,{path:draft.path,sha256:draft.sha256}),{code:'MAIL_ALREADY_ATTEMPTED'});
  assert.equal(smtp.submissions,1);
});
