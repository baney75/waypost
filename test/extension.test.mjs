// The real extension in real Chromium, through native messaging, to Waypost, to a real
// IMAP server. Runs when Chromium and pymap are present (set WAYPOST_CHROMIUM to choose a binary).
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {cp,mkdtemp,readFile,writeFile} from 'node:fs/promises';
import {existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {connectBrowser,PINNED_EXTENSION_ID} from '../dist/browser.js';
import {imapServerAvailable,startImapServer,seed,codeMail} from './fixtures/imap-server.mjs';

// Hosted CI images ship branded Chrome, which ignores --load-extension; run there only when WAYPOST_CHROMIUM is set.
const chromium=[process.env.WAYPOST_CHROMIUM,...(process.env.CI?[]:['/usr/bin/chromium'])].find(path=>path&&existsSync(path));
let playwright;try{playwright=await import('playwright-core');}catch{}
const skip=!chromium?'needs Chromium (set WAYPOST_CHROMIUM)':!playwright?'needs playwright-core':!imapServerAvailable()?'needs pymap and openssl':false;

const page=body=>`<!doctype html><html><body><h1>Verify</h1><form>${body}<button>Continue</button></form></body></html>`;
test('extension fills a code from Proton Mail through native messaging; site matching blocks other senders',{skip,timeout:240000},async t=>{
  const server=await startImapServer(t);
  await seed(server,[codeMail({from:'GitHub <noreply@github.com>',subject:'[GitHub] Please verify your device',body:'Verification code: 734021',minutes:1,headers:'Authentication-Results: mailin.protonmail.ch; dmarc=pass header.from=github.com\n'}),codeMail({from:'Bank <alerts@bank.example>',subject:'Your passcode',body:'Your one-time passcode is 593017.',minutes:1})]);
  const root=await mkdtemp(join(tmpdir(),'waypost-ext-'));const userData=join(root,'profile');const configPath=join(root,'config.json');
  await writeFile(configPath,JSON.stringify({version:1,artifactsDir:join(root,'artifacts'),timeoutMs:10000,mail:{host:'127.0.0.1',imapPort:server.port,smtpPort:1,certificate:server.certificate}}),{mode:0o600});
  const paired=await connectBrowser(configPath,{browser:'chromium',hostsDir:join(userData,'NativeMessagingHosts')});
  assert.equal(paired.extensionId,PINNED_EXTENSION_ID);
  // Test copy of the extension: identical code, plus host permission so a headless run can
  // inject without clicking the toolbar button or the browser's permission prompt.
  const extension=join(root,'extension');await cp(resolve('extension'),extension,{recursive:true});
  const manifest=JSON.parse(await readFile(join(extension,'manifest.json'),'utf8'));
  manifest.host_permissions=['https://github.com/*','https://login-github.example.com/*'];await writeFile(join(extension,'manifest.json'),JSON.stringify(manifest));

  const context=await playwright.chromium.launchPersistentContext(userData,{executablePath:chromium,headless:false,args:['--headless=new',`--disable-extensions-except=${extension}`,`--load-extension=${extension}`,'--no-first-run'],env:{...process.env,WAYPOST_MAIL_USERNAME:server.user,WAYPOST_MAIL_PASSWORD:server.secret}});
  t.after(()=>context.close());
  await context.route('https://github.com/**',route=>route.fulfill({contentType:'text/html',body:route.request().url().includes('split')?page(Array.from({length:6},(_,i)=>`<input maxlength="1" inputmode="numeric" aria-label="Digit ${i+1}">`).join('')):page('<label>Verification code <input name="otp" autocomplete="one-time-code" inputmode="numeric" maxlength="6"></label>')}));
  await context.route('https://login-github.example.com/**',route=>route.fulfill({contentType:'text/html',body:page('<input autocomplete="one-time-code">')}));
  const worker=context.serviceWorkers()[0]??await context.waitForEvent('serviceworker');
  assert.equal(new URL(worker.url()).host,PINNED_EXTENSION_ID);

  const login=await context.newPage();await login.goto('https://github.com/sessions/two-factor');
  // control: an extension page for sending messages; ui: the popup rendered for one tab (it closes itself after filling).
  const control=await context.newPage();await control.goto(`chrome-extension://${PINNED_EXTENSION_ID}/popup.html`);
  const ui=await context.newPage();
  const tabId=async prefix=>control.evaluate(async prefix=>(await chrome.tabs.query({})).find(tab=>tab.url?.startsWith(prefix)).id,prefix);
  const send=message=>control.evaluate(message=>chrome.runtime.sendMessage(message),message);
  await ui.setViewportSize({width:300,height:260});await ui.goto(`chrome-extension://${PINNED_EXTENSION_ID}/popup.html?tab=${await tabId('https://github.com/sessions')}`);
  await ui.locator('#code').waitFor({state:'visible',timeout:30000});
  assert.equal(await ui.locator('#code').textContent(),'734021');
  assert.match(await ui.locator('#trust').textContent(),/DMARC pass/);
  if(process.env.WAYPOST_SCREENSHOTS)await ui.screenshot({path:join(process.env.WAYPOST_SCREENSHOTS,'popup.png')});
  await ui.locator('#fill').click();
  await login.waitForFunction(()=>document.querySelector('input[name=otp]').value==='734021',null,{timeout:10000});

  const split=await context.newPage();await split.goto('https://github.com/split');
  const answer=await send({type:'popup-code',tabId:await tabId('https://github.com/split')});
  assert.equal((await send({type:'popup-fill',tabId:await tabId('https://github.com/split'),code:answer.data.code})).result.filled,true);
  assert.equal(await split.evaluate(()=>Array.from(document.querySelectorAll('input'),input=>input.value).join('')),'734021');

  // Phishing page: GitHub's and the bank's codes are in the mailbox, but neither sender belongs to this site.
  const phish=await context.newPage();await phish.goto('https://login-github.example.com/verify');
  const denied=await send({type:'popup-code',tabId:await tabId('https://login-github.example.com/')});
  assert.equal(denied.ok,true);assert.equal(denied.data.found,false);assert.ok(!JSON.stringify(denied).match(/734021|593017/));

  // Automatic fill after per-site opt-in: a code that arrives after the field appears is filled with no click.
  await send({type:'set-auto',origin:'https://github.com',enabled:true});
  const auto=await context.newPage();await auto.goto('https://github.com/sessions/two-factor?auto');
  await new Promise(done=>setTimeout(done,1500));
  await seed(server,[codeMail({from:'GitHub <noreply@github.com>',subject:'[GitHub] Sign-in code',body:'Verification code: 408115',minutes:0})]);
  await auto.waitForFunction(()=>document.querySelector('input[name=otp]').value==='408115',null,{timeout:30000});
  await send({type:'set-auto',origin:'https://github.com',enabled:false});
});
