import {test} from 'node:test';
import assert from 'node:assert/strict';
import {chmod,lstat,mkdir,mkdtemp,readFile,realpath,rm,symlink,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {ensureArtifactsDirectory} from '../dist/artifacts.js';
import {driveDownload} from '../dist/drive.js';
import {saveArtifact} from '../dist/config.js';

async function workspace(t) {
  const root=await mkdtemp(join(await realpath(tmpdir()),'waypost-artifacts-'));
  t.after(()=>rm(root,{recursive:true,force:true}));
  return root;
}
async function fakeDrive(root,body) {
  const executable=join(root,'fake-drive');
  await writeFile(executable,'#!/usr/bin/env node\nconst fs=require("node:fs");const path=require("node:path");const target=process.argv.at(-2);\nif(process.argv.includes("info")){process.stdout.write(JSON.stringify({type:"folder",name:{ok:true,value:"item"}}));process.exit(0);}\n'+body+'\nprocess.stdout.write("{}");\n',{mode:0o700});
  return {version:1,artifactsDir:join(root,'artifacts'),timeoutMs:2000,drive:{executable,root:'/my-files',writeEnabled:false}};
}

test('artifact roots are created privately beneath validated parents',async t=>{
  const root=await workspace(t);const path=join(root,'new','artifacts');
  const [first,second]=await Promise.all([ensureArtifactsDirectory(path),ensureArtifactsDirectory(path)]);
  assert.equal(first,path);assert.equal(second,path);
  for(const directory of [join(root,'new'),path]) {
    const metadata=await lstat(directory);
    assert.equal(metadata.uid,process.getuid());assert.equal(metadata.mode&0o777,0o700);
  }
});
test('artifact helper rejects shared roots and writable parents without changing their permissions',async t=>{
  const root=await workspace(t);const shared=join(root,'shared');await mkdir(shared);await chmod(shared,0o770);
  await assert.rejects(ensureArtifactsDirectory(shared),{code:'ARTIFACT_PERMISSIONS'});
  await assert.rejects(ensureArtifactsDirectory(join(shared,'private','artifacts')),{code:'ARTIFACT_PERMISSIONS'});
  assert.equal((await lstat(shared)).mode&0o777,0o770);
  await assert.rejects(lstat(join(shared,'private')),{code:'ENOENT'});
});
test('artifact helper rejects symlink roots without creating anything in their destination',async t=>{
  const root=await workspace(t);const outside=join(root,'outside');await mkdir(outside,{mode:0o700});
  const link=join(root,'artifacts');await symlink(outside,link);
  await assert.rejects(ensureArtifactsDirectory(link),{code:'ARTIFACT_PERMISSIONS'});
  await assert.rejects(saveArtifact({version:1,artifactsDir:link,timeoutMs:1000},'event.ics','synthetic'),{code:'ARTIFACT_PERMISSIONS'});
  await assert.rejects(lstat(join(outside,'event.ics')),{code:'ENOENT'});
});
test('trusted ancestor aliases resolve to a checked canonical artifact directory',async t=>{
  const root=await workspace(t);const parent=join(root,'parent');await mkdir(parent,{mode:0o700});
  const alias=join(root,'alias');await symlink(parent,alias);
  assert.equal(await ensureArtifactsDirectory(join(alias,'artifacts')),join(parent,'artifacts'));
});
test('Drive rejects a writable artifact root before invoking the CLI',async t=>{
  const root=await workspace(t);const marker=join(root,'invoked');
  const config=await fakeDrive(root,'fs.writeFileSync('+JSON.stringify(marker)+',"invoked");');
  await mkdir(config.artifactsDir);await chmod(config.artifactsDir,0o777);
  await assert.rejects(driveDownload(config,{path:'/my-files/item'}),{code:'ARTIFACT_PERMISSIONS'});
  await assert.rejects(lstat(marker),{code:'ENOENT'});
});
test('Drive refuses a replaced download root instead of hashing outside content',async t=>{
  const root=await workspace(t);const outside=join(root,'outside');await mkdir(outside,{mode:0o700});await writeFile(join(outside,'outside.txt'),'synthetic outside content');
  const config=await fakeDrive(root,'fs.rmSync(target,{recursive:true});fs.symlinkSync('+JSON.stringify(outside)+',target);');
  await assert.rejects(driveDownload(config,{path:'/my-files/item'}),{code:'PATH_DENIED'});
  assert.equal(await readFile(join(outside,'outside.txt'),'utf8'),'synthetic outside content');
});
test('Drive rejects downloaded directory and file symlinks',async t=>{
  const root=await workspace(t);const outside=join(root,'outside');await mkdir(outside,{mode:0o700});await writeFile(join(outside,'item.txt'),'outside');
  for(const target of [outside,join(outside,'item.txt')]) {
    const config=await fakeDrive(root,'fs.symlinkSync('+JSON.stringify(target)+',path.join(target,"link"));');
    await assert.rejects(driveDownload(config,{path:'/my-files/item'}),{code:'PATH_DENIED'});
  }
});
test('Drive rejects writable downloaded children',async t=>{
  const root=await workspace(t);
  for(const body of ['fs.mkdirSync(path.join(target,"shared"),{mode:0o777});fs.chmodSync(path.join(target,"shared"),0o777);','fs.writeFileSync(path.join(target,"shared.txt"),"synthetic");fs.chmodSync(path.join(target,"shared.txt"),0o666);']) {
    const config=await fakeDrive(root,body);
    await assert.rejects(driveDownload(config,{path:'/my-files/item'}),{code:'PATH_DENIED'});
  }
});
test('Drive checksums nested regular files and preserves private download storage',async t=>{
  const root=await workspace(t);const content='synthetic downloaded content\n';
  const config=await fakeDrive(root,'fs.mkdirSync(path.join(target,"nested"));fs.writeFileSync(path.join(target,"nested","item.txt"),'+JSON.stringify(content)+');');
  const result=await driveDownload(config,{path:'/my-files/item'});
  assert.equal((await lstat(config.artifactsDir)).mode&0o777,0o700);
  assert.equal((await lstat(result.directory)).mode&0o777,0o700);
  assert.deepEqual(result.files,[{file:join(result.directory,'nested','item.txt'),bytes:Buffer.byteLength(content),sha256:createHash('sha256').update(content).digest('hex')}]);
  assert.equal(result.claimedSha1Match,null);assert.equal(result.empty,false);
});
