import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,readFile,mkdir,symlink,chmod,stat,realpath} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawnSync} from 'node:child_process';
import {initConfig,loadConfig,saveArtifact} from '../dist/config.js';
import {driveList,driveUpload,remotePath} from '../dist/drive.js';
import {runExecutable} from '../dist/process.js';

const workspace=()=>mkdtemp(join(tmpdir(),'waypost-test-'));
const config=(root)=>({version:1,artifactsDir:join(root,'artifacts'),timeoutMs:1000});
test('init preserves an existing configuration and creates private files',async()=>{
  const root=await workspace();const file=join(root,'config.json');await initConfig(file);const before=await readFile(file,'utf8');
  await assert.rejects(initConfig(file),{code:'EEXIST'});assert.equal(await readFile(file,'utf8'),before);assert.equal((await stat(file)).mode&0o777,0o600);assert.equal((await loadConfig(file)).version,1);
});
test('artifact writes cannot escape their directory or overwrite a file',async()=>{
  const root=await workspace();const conf=config(root);await assert.rejects(saveArtifact(conf,'../secret','bad'));const file=await saveArtifact(conf,'event.ics','a');await assert.rejects(saveArtifact(conf,'event.ics','b'),{code:'EEXIST'});assert.equal(await readFile(file,'utf8'),'a');assert.equal((await stat(file)).mode&0o777,0o600);
});
test('Drive enforces exact root and traversal boundaries before execution',async()=>{
  const root=await workspace();const conf={...config(root),drive:{executable:'/unused',root:'/my-files/Work',writeEnabled:false}};
  assert.equal(remotePath(conf,'/my-files/Work/one.txt'),'/my-files/Work/one.txt');
  for(const path of ['/my-files/Workshop/one','/my-files/Work/../secret','/my-files2/Work','/my-files/Work\\/one','/my-files/Work\n--help'])assert.throws(()=>remotePath(conf,path));
  await assert.rejects(driveUpload(conf,{file:'/unused',parent:'/my-files/Work'}),{code:'WRITE_DISABLED'});
});
test('Drive CLI gets an argv array, never a shell; error output stays private',async()=>{
  const root=await workspace();const executable=join(root,'drive');await writeFile(executable,'#!/usr/bin/env node\nprocess.stdout.write(JSON.stringify({args:process.argv.slice(2)}));\n',{mode:0o700});
  const conf={...config(root),drive:{executable,root:'/my-files',writeEnabled:false}};const item='/my-files/report; $(touch /tmp/waypost-should-not-exist)';
  assert.deepEqual((await driveList(conf,{path:item})).args,['filesystem','list',item,'--json']);
  await writeFile(executable,'#!/usr/bin/env node\nconsole.error("PRIVATE_PASSWORD=not-a-real-secret");process.exit(1);\n');
  await assert.rejects(driveList(conf,{path:'/my-files'}),error=>!error.message.includes('PRIVATE_PASSWORD')&&error.code==='SERVICE_FAILED');
});
test('Drive upload rejects a symlink outside the configured artifacts directory',async()=>{
  const root=await workspace();const conf={...config(root),drive:{executable:'/unused',root:'/my-files',writeEnabled:true}};await mkdir(conf.artifactsDir);const outside=join(root,'outside');await writeFile(outside,'private');const file=join(conf.artifactsDir,'link');await symlink(outside,file);await assert.rejects(driveUpload(conf,{file,parent:'/my-files'}),{code:'CONFIRMATION_REQUIRED'});await assert.rejects(driveUpload(conf,{file,parent:'/my-files',confirm:true}),{code:'PATH_DENIED'});
});
test('executable output and duration are bounded',async()=>{
  const root=await workspace();const executable=join(root,'script');await writeFile(executable,'#!/usr/bin/env node\nprocess.stdout.write("x".repeat(10000));\n',{mode:0o700});await assert.rejects(runExecutable(executable,[],1000,1024),{code:'OUTPUT_LIMIT'});
  await writeFile(executable,'#!/usr/bin/env node\nsetTimeout(()=>{},10000);\n');await assert.rejects(runExecutable(executable,[],100),{code:'TIMEOUT'});await chmod(executable,0o722);await assert.rejects(runExecutable(executable,[],100),{code:'EXECUTABLE_UNAVAILABLE'});
});
test('CLI invalid inputs fail without leaking implementation exception details',()=>{
  const result=spawnSync(process.execPath,['dist/cli.js','call','drive_list','--input','{'],{encoding:'utf8'});assert.equal(result.status,1);assert.equal(result.stdout,'');assert.equal(JSON.parse(result.stderr).error.code,'INPUT_INVALID');
});

test('service setup preserves existing policy and scopes without storing secrets',async()=>{
  const {connectCalendar,connectDrive}=await import('../dist/connect.js');const root=await workspace();const file=join(root,'config.json');await initConfig(file);const snapshot=join(root,'calendar.ics');await writeFile(snapshot,'BEGIN:VCALENDAR\r\nVERSION:2.0\r\nEND:VCALENDAR\r\n');await connectCalendar(file,snapshot);const executable=join(root,'drive');await writeFile(executable,'#!/usr/bin/env node\n',{mode:0o700});await connectDrive(file,executable,false);const saved=await loadConfig(file);assert.deepEqual(saved.calendar.files,[await realpath(snapshot)]);assert.equal(saved.drive.writeEnabled,false);assert.equal((await stat(file)).mode&0o777,0o600);assert.ok(!(await readFile(file,'utf8')).includes('password'));
});
