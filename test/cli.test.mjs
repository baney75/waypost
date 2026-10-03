import {test} from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {mkdtemp,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
const call=(config,args)=>spawnSync(process.execPath,[resolve('runtime/waypost.mjs'),'--config',config,...args],{encoding:'utf8'});
test('packaged CLI flags and JSON share schemas; agenda has a useful default window',async()=>{
  const root=await mkdtemp(join(tmpdir(),'waypost-cli-'));const file=join(root,'config.json');await writeFile(file,JSON.stringify({version:1,artifactsDir:join(root,'artifacts')}),{mode:0o600});
  const created=call(file,['calendar','prepare','--summary','Release review','--start','2026-10-05T14:00:00Z','--end','2026-10-05T15:00:00Z']);assert.equal(created.status,0,created.stderr);const artifact=JSON.parse(created.stdout).data;assert.equal(artifact.imported,false);
  const connected=call(file,['connect','calendar',artifact.path]);assert.equal(connected.status,0,connected.stderr);
  const flags=call(file,['calendar','events','--from','2026-10-05T00:00:00Z','--to','2026-10-06T00:00:00Z','--limit','1']);assert.equal(flags.status,0,flags.stderr);assert.equal(JSON.parse(flags.stdout).data.events[0].summary,'Release review');
  const json=call(file,['calendar','events','--input','{"from":"2026-10-05T00:00:00Z","to":"2026-10-06T00:00:00Z","limit":1}']);assert.deepEqual(JSON.parse(flags.stdout),JSON.parse(json.stdout));
  assert.equal(call(file,['calendar','agenda','--days','7']).status,0);
  for(const args of [['calendar','agenda','--days','0'],['calendar','events','--limit','wat'],['mail','list','--limit','2','--input','{}']]){const result=call(file,args);assert.equal(result.status,1);assert.equal(JSON.parse(result.stderr).error.code,'INPUT_INVALID');}
  const draft=call(file,['mail','draft','--from','me@example.test','--to','one@example.test','--to','two@example.test','--subject','Test','--text','Body']);assert.equal(draft.status,0,draft.stderr);assert.equal(JSON.parse(draft.stdout).data.sent,false);
});
test('Codex configuration forwards custom credential names only for direct Bridge',async()=>{
  const root=await mkdtemp(join(tmpdir(),'waypost-agent-config-'));const file=join(root,'config.json');const config={version:1,artifactsDir:join(root,'artifacts'),mail:{certificate:'/public.pem',usernameEnv:'CUSTOM_USERNAME',passwordEnv:'CUSTOM_PASSWORD'}};
  await writeFile(file,JSON.stringify(config),{mode:0o600});const direct=call(file,['agent-config','codex']);assert.equal(direct.status,0,direct.stderr);assert.match(direct.stdout,/CUSTOM_USERNAME/);assert.match(direct.stdout,/CUSTOM_PASSWORD/);
  delete config.mail;config.mailHelper={executable:'/helper'};await writeFile(file,JSON.stringify(config));const helper=call(file,['agent-config','codex']);assert.equal(helper.status,0);assert.doesNotMatch(helper.stdout,/env_vars|PASSWORD/);
});
