// Verification-code lookup against a real IMAP server, a fixture Messages database,
// and the native messaging host. Synthetic data only.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {writeFile,mkdtemp} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {spawn} from 'node:child_process';
import {DatabaseSync} from 'node:sqlite';
import {latestVerificationCode,attributedBodyText} from '../dist/codes.js';
import {configSchema} from '../dist/config.js';
import {encode,decodeFrames} from '../dist/native-host.js';
import {imapServerAvailable,startImapServer,seed,codeMail} from './fixtures/imap-server.mjs';

const available=imapServerAvailable();
// Parsed like a real config file, so defaults (such as the credential variable names) apply.
const configFor=(server,root,codes)=>configSchema.parse({version:1,artifactsDir:join(root,'artifacts'),timeoutMs:10000,mail:{host:'127.0.0.1',imapPort:server.port,smtpPort:1,certificate:server.certificate},verificationCodes:{agents:true,browser:true,maxAgeMinutes:10,mailboxes:['INBOX'],siteAliases:{},extensionIds:['bahfokgcpebehdnidclkpdeafnaehdpo'],...codes}});

test('latest code: site matching, time window, DMARC, HTML, and no body returned',{skip:!available&&'needs pymap and openssl',timeout:180000},async t=>{
  const server=await startImapServer(t);
  process.env.WAYPOST_MAIL_USERNAME=server.user;process.env.WAYPOST_MAIL_PASSWORD=server.secret;
  await seed(server,[
    codeMail({from:'GitHub <noreply@github.com>',subject:'[GitHub] Please verify your device',body:'Verification code: 111222',minutes:30}),
    codeMail({from:'GitHub <noreply@github.com>',subject:'[GitHub] Please verify your device',body:'Device: Firefox on Linux\nVerification code: 734021\n\nIf you did not attempt to sign in, change your password.',minutes:2,headers:'Authentication-Results: mailin.protonmail.ch; dmarc=pass (p=reject dis=none) header.from=github.com\n'}),
    codeMail({from:'Example Bank <alerts@bank.example>',subject:'Your one-time passcode',body:'Your one-time passcode is 593017. Never share it.',minutes:1}),
    codeMail({from:'Shop <orders@shop.example>',subject:'Order #482913 confirmed',body:'Order number: 482913. Total $12.00.',minutes:1}),
    codeMail({from:'Microsoft account team <account-security-noreply@accountprotection.microsoft.com>',subject:'Microsoft account security code',body:'<table><tr><td>Security code:</td></tr><tr><td style="font-size:30px">6 2 3 4 6 1 7</td></tr></table>',minutes:3,html:true}),
  ]);
  const root=await mkdtemp(join(tmpdir(),'waypost-codes-'));const config=configFor(server,root);

  const github=await latestVerificationCode(config,{site:'https://github.com/sessions/verified-device'},'browser');
  assert.equal(github.code,'734021');assert.equal(github.senderMatchesSite,true);assert.equal(github.senderVerified,true);
  assert.equal(github.confidence,'high');assert.equal(github.bodyReturned,false);
  assert.ok(!JSON.stringify(github).includes('Firefox'),'message body must not be returned');

  // A phishing page cannot pull the bank's code: the sender does not belong to the site.
  const phish=await latestVerificationCode(config,{site:'login-bank.example.net'},'browser');
  assert.equal(phish.found,false);assert.match(phish.reason,/not belong/);
  assert.ok(!JSON.stringify(phish).includes('593017'));

  // Alias: live.com sign-in accepts codes from microsoft.com senders, including HTML-only mail.
  const microsoft=await latestVerificationCode(config,{site:'login.live.com'},'browser');
  assert.equal(microsoft.code,'6234617');assert.equal(microsoft.senderVerified,null);

  // Without a site, agents get the newest code; the order number is not a code.
  const newest=await latestVerificationCode(config,{});
  assert.equal(newest.code,'593017');
  assert.equal((await latestVerificationCode(config,{from:'shop.example'})).found,false);
  // Older than the window: the 30-minute-old GitHub code is never returned.
  assert.equal((await latestVerificationCode(config,{site:'github.com',maxAgeMinutes:1})).found,false);
  assert.equal((await latestVerificationCode(config,{site:'github.com',notBefore:new Date().toISOString()})).found,false);

  await assert.rejects(latestVerificationCode({...config,verificationCodes:{...config.verificationCodes,agents:false}},{}),{code:'VERIFICATION_CODES_DISABLED'});
  await assert.rejects(latestVerificationCode({...config,verificationCodes:undefined},{},'browser'),{code:'VERIFICATION_CODES_DISABLED'});
  await assert.rejects(latestVerificationCode(config,{},'browser'),{code:'INPUT_INVALID'});
});

// Minimal typedstream body as macOS Messages writes it: ... NSString, record header, '+', length, UTF-8.
function attributedBody(text) {
  const bytes=Buffer.from(text,'utf8');
  const length=bytes.length<0x80?Buffer.from([bytes.length]):Buffer.concat([Buffer.from([0x81]),Buffer.from([bytes.length&0xff,bytes.length>>8])]);
  return Buffer.concat([Buffer.from([0x04,0x0b]),Buffer.from('streamtyped'),Buffer.from([0x81,0xe8,0x03,0x84,0x01,0x40,0x84,0x84,0x84]),Buffer.from('NSAttributedString'),Buffer.from([0x00,0x84,0x84]),Buffer.from('NSObject'),Buffer.from([0x00,0x85,0x92,0x84,0x84,0x84]),Buffer.from('NSString'),Buffer.from([0x01,0x94,0x84,0x01,0x2b]),length,bytes,Buffer.from([0x86,0x84])]);
}
test('Messages database (forwarded SMS): text and attributedBody, origin-bound site matching',async()=>{
  const root=await mkdtemp(join(tmpdir(),'waypost-sms-'));const path=join(root,'chat.db');
  const database=new DatabaseSync(path);
  database.exec('CREATE TABLE handle (ROWID INTEGER PRIMARY KEY, id TEXT); CREATE TABLE message (ROWID INTEGER PRIMARY KEY, guid TEXT, text TEXT, attributedBody BLOB, handle_id INTEGER, date INTEGER, is_from_me INTEGER, service TEXT);');
  database.prepare('INSERT INTO handle (ROWID,id) VALUES (1,?),(2,?)').run('+15550100','22000');
  const appleNs=ms=>Math.round((ms/1000-978307200)*1e9);
  const insert=database.prepare('INSERT INTO message (text,attributedBody,handle_id,date,is_from_me,service) VALUES (?,?,?,?,?,?)');
  insert.run(null,attributedBody('Your Example code is 482913. Don\'t share it.\n\n@example.test #482913'),2,appleNs(Date.now()-60000),0,'SMS');
  insert.run('Your bank verification code is 771204',null,1,appleNs(Date.now()-30000),0,'SMS');
  insert.run('Your code is 999999',null,1,appleNs(Date.now()-10000),1,'SMS');
  insert.run('Old code 123987 is your verification code',null,1,appleNs(Date.now()-3600000),0,'SMS');
  database.close();
  assert.equal(attributedBodyText(attributedBody('héllo 123')),'héllo 123');
  const config={version:1,artifactsDir:join(root,'artifacts'),timeoutMs:5000,verificationCodes:{agents:true,browser:true,maxAgeMinutes:10,mailboxes:['INBOX'],siteAliases:{},extensionIds:[],messagesDatabase:path}};
  const newest=await latestVerificationCode(config,{});
  assert.deepEqual([newest.code,newest.source,newest.sender.address],['771204','sms','+15550100']);
  const site=await latestVerificationCode(config,{site:'www.example.test'},'browser');
  assert.deepEqual([site.code,site.senderMatchesSite],['482913',true]);
  // A text without the origin-bound line cannot be tied to a site, so it is never offered for one.
  const other=await latestVerificationCode(config,{site:'bank.example'},'browser');
  assert.equal(other.found,false);
});

test('native host serves only paired extensions over framed stdin/stdout',async()=>{
  const root=await mkdtemp(join(tmpdir(),'waypost-native-'));const config=join(root,'config.json');
  await writeFile(config,JSON.stringify({version:1,artifactsDir:join(root,'artifacts'),verificationCodes:{browser:true,extensionIds:['bahfokgcpebehdnidclkpdeafnaehdpo']}}),{mode:0o600});
  const ask=(origin,message)=>new Promise((done,fail)=>{
    const child=spawn(process.execPath,[resolve('runtime/waypost.mjs'),'--config',config,'native-host',origin],{stdio:['pipe','pipe','pipe']});
    let output=Buffer.alloc(0);child.stdout.on('data',data=>{output=Buffer.concat([output,data]);});
    child.on('close',()=>{try{done(decodeFrames(output).messages[0]);}catch(error){fail(error);}});
    child.stdin.end(encode(message));
  });
  const stranger=await ask('chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/',{type:'verification_code',site:'github.com'});
  assert.equal(stranger.error.code,'EXTENSION_NOT_ALLOWED');
  const paired=await ask('chrome-extension://bahfokgcpebehdnidclkpdeafnaehdpo/',{type:'verification_code',site:'github.com'});
  assert.equal(paired.error.code,'MAIL_UNCONFIGURED');
  const malformed=await ask('chrome-extension://bahfokgcpebehdnidclkpdeafnaehdpo/',{type:'read_mail',mailbox:'INBOX'});
  assert.equal(malformed.error.code,'INPUT_INVALID');
});
