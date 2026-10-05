import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { passLookup } from '../dist/pass.js';

async function fake(t, body) {
  const root = await mkdtemp(join(tmpdir(), 'waypost-pass-'));
  t.after(() => rm(root, {recursive:true, force:true}));
  const executable = join(root, 'pass-cli');
  await writeFile(executable, `#!/usr/bin/env node\nif (process.argv.includes('--show-secrets')) process.exit(3);\nprocess.stdout.write(${JSON.stringify(body)});\n`, {mode:0o700});
  return {version:1, artifactsDir:join(root,'artifacts'), timeoutMs:2000, pass:{executable}};
}

test('pass lookup returns names and urls and drops secrets', async t => {
  const secret = 'super-secret-value';
  const config = await fake(t, JSON.stringify([{name:'Bank Login', urls:['https://bank.example/login'], password:secret, username:'ada@example.com'}, {name:'Other', urls:['https://other.example']}]));
  const result = await passLookup(config, {query:'bank'});
  assert.deepEqual(result.items, [{name:'Bank Login', urls:['https://bank.example/login']}]);
  assert.equal(result.secretsReturned, false);
  assert.equal(JSON.stringify(result).includes(secret), false);
  assert.equal(JSON.stringify(result).includes('ada@example.com'), false);
});

test('pass lookup refuses a missing executable setting', async () => {
  await assert.rejects(passLookup({version:1, artifactsDir:'/tmp', timeoutMs:2000}, {query:'bank'}), {code:'PASS_UNCONFIGURED'});
});
