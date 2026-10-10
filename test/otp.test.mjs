import test from 'node:test';
import assert from 'node:assert/strict';
import { extractCode, registrableDomain, senderDomainsFor, protonDmarc, originBoundCode } from '../dist/otp.js';
import { htmlText } from '../dist/mail.js';

// Synthetic messages modeled on common sender layouts. No real account data.
const positives = [
  ['Google', 'G-482913 is your Google verification code', 'Google\n\nVerify your email address\n\nG-482913\n\nUse this code to finish signing in. This code will expire in 24 hours.', '482913'],
  ['Google body only', 'Google Verification Code', 'Use this code to verify that this email address is yours.\n\n731904\n\nThe code expires in 24 hours. Google LLC, 1600 Amphitheatre Parkway, Mountain View, CA 94043', '731904'],
  ['Microsoft', 'Microsoft account security code', 'Please use the following security code for the Microsoft account me*****@example.test.\n\nSecurity code: 6234617\n\nIf you don\'t recognize the Microsoft account me*****@example.test, you can click here to remove your email address from that account.\n\nThanks,\nThe Microsoft account team', '6234617'],
  ['Apple', 'Verify your Apple Account email address', 'Apple Account\n\nVerify your email address\n\nYou have selected this email address as your new Apple Account. To verify this email address belongs to you, enter the code below on the email verification page:\n\n594018\n\nThis code will expire three hours after this email was sent.', '594018'],
  ['GitHub device', '[GitHub] Please verify your device', 'Hey octo!\n\nA sign in attempt requires further verification because we did not recognize your device. To complete the sign in, enter the verification code on the unrecognized device.\n\nDevice: Firefox on Linux\nVerification code: 734021\n\nIf you did not attempt to sign in to your account, your password may be compromised. Visit https://github.com/settings/security to create a new, strong password for your GitHub account.', '734021'],
  ['Proton', 'Proton Verification Code', 'Your Proton verification code is: 285719\n\nIf you didn\'t ask for this code, ignore this email.', '285719'],
  ['Bank', 'Your one-time passcode', 'Your one-time passcode is 593017. It expires in 10 minutes. Never share this code. We will never call you to ask for it.\nReference: 88231402\nQuestions? Call 1-800-555-0199.\nMember FDIC. © 2026 Example Bank', '593017'],
  ['Spaced', 'Your login code', 'Your code\n\n482-193\n\nEnter it in the app.', '482193'],
  ['Alphanumeric', 'Slack confirmation code: ABC-12D', 'Confirm your email address\n\nYour confirmation code is below — enter it in your open browser window.\n\nABC-12D\n\nIf you didn\'t request this email, there\'s nothing to worry about.', 'ABC12D'],
  ['Subject only', '839201 is your Example sign-in code', 'Thanks for signing in to Example. Contact support@example.test if you need help.', '839201'],
  ['Eight digits', 'Your verification code', 'Use verification code 41837265 to sign in. The code is valid for 15 minutes.', '41837265'],
];
for (const [name, subject, body, expected] of positives) test(`finds the code: ${name}`, () => {
  const result = extractCode(subject, body);
  assert.ok(result, 'no code found');
  assert.equal(result.code, expected);
  assert.notEqual(result.confidence, 'low');
});

test('HTML-only mail with a styled code cell and spaced digits', () => {
  const html = `<html><body><table><tr><td><img src="https://cdn.example.test/logo.png" alt="Example"></td></tr><tr><td style="font-size:14px">Your verification code is:</td></tr><tr><td style="font-size:32px;letter-spacing:8px;color:#123456">8 4 2 9 1 7</td></tr><tr><td>This code expires in 10 minutes. © 2026 Example Inc.</td></tr></table></body></html>`;
  assert.deepEqual(extractCode('Your Example code', htmlText(html)), {code:'842917', confidence:'high'});
});

const negatives = [
  ['Order confirmation', 'Order #482913 confirmed', 'Thanks for your order! Order number: 482913\nTotal: $123.45\nArriving by October 12, 2026\nTrack package: 1Z999AA10123456784'],
  ['Newsletter', 'October 2026 update', 'Join us on October 21, 2026 at 10:30 AM. Call (555) 012-3456 or +1 555 012 3456. Over 25000 members. Room 4012.'],
  ['Receipt', 'Your receipt from Example', 'Invoice 20261009 paid. Card ending in 4242. Amount 1,299.00 USD. Customer ID: 7781234.'],
  ['Shipping', 'Your package shipped', 'Tracking number: 940011189922385. Zip 60614. Account 99887766.'],
];
for (const [name, subject, body] of negatives) test(`no code in: ${name}`, () => {
  const result = extractCode(subject, body);
  assert.ok(result === null || result.confidence === 'low', JSON.stringify(result));
});

test('two different strong codes in one message give low confidence', () => {
  assert.equal(extractCode('Codes', 'Your verification code is 111234. Your backup code is 998877.').confidence, 'low');
});

test('domains: registrable domains, built-in aliases and user aliases', () => {
  assert.equal(registrableDomain('accounts.google.com'), 'google.com');
  assert.equal(registrableDomain('login.bank.co.uk'), 'bank.co.uk');
  assert.equal(registrableDomain('127.0.0.1'), null);
  assert.ok(senderDomainsFor('https://www.youtube.com'.replace(/^https:\/\//,'')).has('google.com'));
  assert.ok(senderDomainsFor('login.live.com').has('microsoft.com'));
  assert.ok(!senderDomainsFor('evil-google.com').has('google.com'));
  assert.ok(senderDomainsFor('app.example.test',{'example.test':['examplemail.test']}).has('examplemail.test'));
});

test('Proton DMARC result: topmost Proton header decides; spoofed or missing headers do not verify', () => {
  const pass = 'Authentication-Results: mailin.protonmail.ch; dmarc=pass (p=reject dis=none)\r\n header.from=github.com; spf=pass\r\nAuthentication-Results: evil.test; dmarc=fail header.from=github.com\r\n';
  assert.equal(protonDmarc(pass,'noreply@github.com'.split('@')[1]), true);
  assert.equal(protonDmarc('Authentication-Results: mailin.protonmail.ch; dmarc=fail header.from=github.com\r\n','github.com'), false);
  assert.equal(protonDmarc('Authentication-Results: mail.evil.test; dmarc=pass header.from=github.com\r\n','github.com'), null);
  assert.equal(protonDmarc('Authentication-Results: mailin.protonmail.ch; dmarc=pass header.from=evil.test\r\n','github.com'), false);
  assert.equal(protonDmarc('Subject: none\r\n','github.com'), null);
});

test('origin-bound SMS format names the site', () => {
  assert.deepEqual(originBoundCode('Your Example code is 123456.\n\n@example.test #123456'), {domain:'example.test', code:'123456'});
  assert.equal(originBoundCode('Your code is 123456'), null);
});
