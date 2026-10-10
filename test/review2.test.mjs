// Regression tests for the second review of PR #8 (R1–R3). Synthetic data only.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {protonDmarc,senderMatchesSite} from '../dist/otp.js';
import {configSchema} from '../dist/config.js';
import {latestVerificationCode} from '../dist/codes.js';
import {imapServerAvailable,startImapServer,seed,codeMail} from './fixtures/imap-server.mjs';

test('R1: DMARC parsing ignores comments and other fields, needs header.from, and trusts only the topmost Proton header',()=>{
  const verified=headers=>protonDmarc(headers,'github.com');
  // dmarc=pass hidden in a comment, while the real dmarc clause failed.
  assert.notEqual(verified('Authentication-Results: mailin.protonmail.ch; dkim=pass (comment dmarc=pass) header.d=evil.com; dmarc=fail header.from=github.com\r\n'),true);
  // dmarc=pass inside another property value, and no dmarc clause at all.
  assert.notEqual(verified('Authentication-Results: mailin.protonmail.ch; spf=pass smtp.mailfrom=dmarc=pass@evil.com\r\n'),true);
  // No header.from: unknown, not verified.
  assert.equal(verified('Authentication-Results: mailin.protonmail.ch; dmarc=pass (p=reject)\r\n'),null);
  // Nested comments are stripped safely.
  assert.notEqual(verified('Authentication-Results: mailin.protonmail.ch; dkim=pass (a (nested) dmarc=pass header.from=github.com); spf=pass\r\n'),true);
  // Two dmarc clauses: ambiguous.
  assert.equal(verified('Authentication-Results: mailin.protonmail.ch; dmarc=pass header.from=github.com; dmarc=fail header.from=github.com\r\n'),null);
  // An attacker-inserted Proton-looking header lower in the list cannot override the topmost one.
  assert.equal(verified('Authentication-Results: mailin.protonmail.ch; dmarc=fail (p=reject) header.from=github.com\r\nReceived: from evil\r\nAuthentication-Results: mailin.protonmail.ch; dmarc=pass header.from=github.com\r\n'),false);
  // A Proton header that is not the topmost Authentication-Results is not used.
  assert.equal(verified('Authentication-Results: mx.evil.test; dmarc=none\r\nAuthentication-Results: mailin.protonmail.ch; dmarc=pass header.from=github.com\r\n'),null);
  // header.from must equal the From domain.
  assert.equal(verified('Authentication-Results: mailin.protonmail.ch; dmarc=pass header.from=evil.com\r\n'),false);
  // A genuine pass, case-insensitive.
  assert.equal(verified('Authentication-Results: mailin.protonmail.ch; dkim=pass header.d=github.com; DMARC=Pass (p=REJECT sp=REJECT) Header.From=GitHub.com\r\n'),true);
});

test('R2: a site-matching sender that is not a known code sender is reported untrusted, with a warning',{skip:!imapServerAvailable()&&'needs pymap',timeout:120000},async t=>{
  const server=await startImapServer(t);
  process.env.WAYPOST_MAIL_USERNAME=server.user;process.env.WAYPOST_MAIL_PASSWORD=server.secret;
  const dmarc=domain=>`Authentication-Results: mailin.protonmail.ch; dmarc=pass header.from=${domain}\n`;
  await seed(server,[
    codeMail({from:'Docs <comments-noreply@docs.google.com>',subject:'Sign-in code shared with you',body:'Your Google verification code is 482913.',minutes:2,headers:dmarc('docs.google.com')}),
    codeMail({from:'Teams <noreply@email.teams.microsoft.com>',subject:'Your sign-in code',body:'Your Microsoft verification code is 551920.',minutes:1,headers:dmarc('email.teams.microsoft.com')}),
  ]);
  const root=await mkdtemp(join(tmpdir(),'waypost-review2-'));
  const config=configSchema.parse({version:1,artifactsDir:join(root,'a'),timeoutMs:10000,mail:{host:'127.0.0.1',imapPort:server.port,smtpPort:1,certificate:server.certificate},verificationCodes:{agents:true,browser:true}});
  for (const [site,code] of [['accounts.google.com','482913'],['login.microsoftonline.com','551920']]) {
    const result=await latestVerificationCode(config,{site});
    assert.equal(result.code,code);
    assert.equal(result.trusted,false,`${site}: ${JSON.stringify(result)}`);
    assert.match(result.warning??'',/not a known/i);
  }
});

test('R3: big-brand domains allow only listed sign-in hosts',()=>{
  const google='no-reply@accounts.google.com';
  for (const site of ['calendar.google.com','lookerstudio.google.com','photos.google.com','mail.google.com']) assert.equal(senderMatchesSite(google,site),false,site);
  assert.equal(senderMatchesSite(google,'accounts.google.com'),true);
  assert.equal(senderMatchesSite('noreply@github.com','gist.github.com'),false);
  assert.equal(senderMatchesSite('noreply@github.com','docs.github.com'),false);
  assert.equal(senderMatchesSite('noreply@github.com','github.com'),true);
  const microsoft='account-security-noreply@accountprotection.microsoft.com';
  assert.equal(senderMatchesSite(microsoft,'teams.microsoft.com'),false);
  assert.equal(senderMatchesSite(microsoft,'forms.microsoft.com'),false);
  assert.equal(senderMatchesSite(microsoft,'login.microsoftonline.com'),true);
  assert.equal(senderMatchesSite(microsoft,'login.live.com'),true);
  assert.equal(senderMatchesSite('appleid@id.apple.com','developer.apple.com'),false);
  assert.equal(senderMatchesSite('appleid@id.apple.com','appleid.apple.com'),true);
});
