import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,realpath,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {passLookup} from '../dist/pass.js';

/** A fake pass-cli that logs its argv and answers vault and item listings from fixtures. */
async function fake(t,{vaults='{"vaults":[{"name":"Personal"}]}',items='[]',exit=0}={}){
  const root=await mkdtemp(join(await realpath(tmpdir()),'waypost-pass-'));
  t.after(()=>rm(root,{recursive:true,force:true}));
  const log=join(root,'argv.log');
  const executable=join(root,'pass-cli');
  await writeFile(executable,`#!/usr/bin/env node\nrequire('node:fs').appendFileSync(${JSON.stringify(log)},JSON.stringify(process.argv.slice(2))+'\\n');\nif(${exit})process.exit(${exit});\nconst fixtures=${JSON.stringify({vaults,items})};\nprocess.stdout.write(process.argv[2]==='vault'?fixtures.vaults:fixtures.items);\n`,{mode:0o700});
  const calls=async()=>(await readFile(log,'utf8').catch(()=>'')).trim().split('\n').filter(Boolean).map(line=>JSON.parse(line));
  return {config:{version:1,artifactsDir:join(root,'artifacts'),timeoutMs:3000,pass:{executable}},calls};
}

test('a named vault is listed directly with fixed arguments and never with --show-secrets',async t=>{
  const {config,calls}=await fake(t,{items:JSON.stringify([{title:'Mail Login',urls:['https://mail.example/login']}])});
  const result=await passLookup(config,{query:'MAIL',vault:'Family Vault'});
  assert.deepEqual(result.items,[{name:'Mail Login',vault:'Family Vault',urls:['https://mail.example/login']}]);
  assert.deepEqual([result.vault,result.vaultsSearched,result.secretsReturned],['Family Vault',1,false]);
  assert.deepEqual(await calls(),[['item','list','--vault-name','Family Vault','--output','json']]);
});

test('only http(s) values under url-named keys survive; secret-named branches are skipped entirely',async t=>{
  const secret='https://leak.example/?token=abc';
  const {config}=await fake(t,{items:JSON.stringify({items:[{title:'Bank',
    urls:['https://bank.example/login','ftp://bank.example','javascript:alert(1)'],
    content:{urls:['https://bank.example/alt'],website:'https://bank.example/not-a-url-key'},
    password:secret,totp:{url:secret},note:{url:secret},username:{urls:[secret]},email:secret,private_key:{url:secret},
  }]})});
  const result=await passLookup(config,{query:'bank'});
  assert.deepEqual(result.items[0].urls,['https://bank.example/login','https://bank.example/alt']);
  assert.ok(!JSON.stringify(result).includes('leak.example'));
});

test('results are capped: 8 URLs per item, 20 items overall, duplicates collapsed',async t=>{
  const urls=Array.from({length:12},(_,index)=>`https://site${index}.example/`);
  const items=Array.from({length:30},(_,index)=>({title:`Site ${index}`,urls:index===0?[...urls,...urls]:[]}));
  const {config}=await fake(t,{items:JSON.stringify(items)});
  const result=await passLookup(config,{query:'site'});
  assert.equal(result.items.length,20);
  assert.equal(result.items[0].urls.length,8);
  assert.equal(new Set(result.items[0].urls).size,8);
});

test('unusable CLI output is a typed error that carries no item content',async t=>{
  for(const items of ['not json','"just a string"','{"vaults":[]}','null']){
    const {config}=await fake(t,{items});
    await assert.rejects(passLookup(config,{query:'x',vault:'Personal'}),error=>error.code==='PASS_RESPONSE'&&!error.message.includes('just a string'),items);
  }
  const {config:badVaults}=await fake(t,{vaults:'not json'});
  await assert.rejects(passLookup(badVaults,{query:'x'}),{code:'PASS_RESPONSE'});
  const {config:failing}=await fake(t,{exit:2});
  await assert.rejects(passLookup(failing,{query:'x',vault:'Personal'}));
  const {config:noVaults}=await fake(t,{vaults:'{"vaults":[]}'});
  const none=await passLookup(noVaults,{query:'x'});
  assert.deepEqual([none.items,none.vaultsSearched],[[],0]);
});

test('query and vault are validated before the CLI runs',async t=>{
  const {config,calls}=await fake(t);
  for(const input of [{query:''},{query:'a;b'},{query:'$(id)'},{query:'x'.repeat(81)},{query:'ok',vault:'bad|vault'},{query:'ok',vault:''},{query:'ok',extra:true},{}])
    await assert.rejects(passLookup(config,input),{name:'ZodError'},JSON.stringify(input));
  assert.deepEqual(await calls(),[]);
  await assert.rejects(passLookup({version:1,artifactsDir:'/tmp',timeoutMs:1000},{query:'ok'}),{code:'PASS_UNCONFIGURED'});
});
