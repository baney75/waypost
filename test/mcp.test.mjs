import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';

test('bundled MCP negotiates, lists tools, reports config and rejects a forbidden write',async()=>{
  const root=await mkdtemp(join(tmpdir(),'waypost-mcp-'));const config=join(root,'config.json');await writeFile(config,JSON.stringify({version:1,artifactsDir:join(root,'artifacts'),drive:{executable:'/unused',root:'/my-files',writeEnabled:false}}),{mode:0o600});
  const client=new Client({name:'waypost-check',version:'1.0.0'});
  const transport=new StdioClientTransport({command:process.execPath,args:[resolve('runtime/waypost.mjs'),'--config',config,'mcp'],stderr:'pipe'});
  let stderr='';transport.stderr?.on('data',data=>stderr+=String(data));
  try {
    await client.connect(transport);const listed=await client.listTools();assert.ok(listed.tools.length>=10);assert.equal(listed.tools.find(t=>t.name==='drive_upload').annotations.readOnlyHint,false);
    const status=await client.callTool({name:'waypost_status',arguments:{}});assert.equal(status.structuredContent.data.services.drive.configured,true);assert.equal(status.structuredContent.data.services.calendar.liveAPI,false);
    const denied=await client.callTool({name:'drive_upload',arguments:{file:'/tmp/private',parent:'/my-files'}});assert.equal(denied.isError,true);assert.equal(denied.structuredContent.error.code,'WRITE_DISABLED');
    const upload=listed.tools.find(t=>t.name==='drive_upload');assert.equal(upload.inputSchema.properties.confirm.type,'boolean');
    const send=listed.tools.find(t=>t.name==='mail_send');assert.equal(send.annotations.destructiveHint,true);assert.equal(send.inputSchema.properties.confirm.type,'boolean');
    const resources=await client.listResources();assert.ok(resources.resources.some(r=>r.uri==='waypost://capabilities'));
    const prompts=await client.listPrompts();assert.equal(prompts.prompts[0].name,'proton-triage');assert.equal(stderr,'');
  }finally{await client.close();}
});

test('MCP status works before setup and errors name the fix',async()=>{
  const root=await mkdtemp(join(tmpdir(),'waypost-mcp-empty-'));const config=join(root,'missing.json');
  const client=new Client({name:'waypost-check',version:'1.0.0'});
  await client.connect(new StdioClientTransport({command:process.execPath,args:[resolve('runtime/waypost.mjs'),'--config',config,'mcp'],stderr:'pipe'}));
  try {
    const status=await client.callTool({name:'waypost_status',arguments:{}});
    assert.equal(status.isError,undefined);assert.equal(status.structuredContent.data.configured,false);assert.match(status.structuredContent.data.next,/waypost init/);
    const list=await client.callTool({name:'mail_list',arguments:{}});
    assert.equal(list.structuredContent.error.code,'CONFIG_MISSING');assert.match(list.structuredContent.error.message,/waypost init/);
  }finally{await client.close();}
});

test('MCP calendar tools prepare a local-time event and read it back with local times',async()=>{
  const root=await mkdtemp(join(tmpdir(),'waypost-mcp-cal-'));const config=join(root,'config.json');
  await writeFile(config,JSON.stringify({version:1,artifactsDir:join(root,'artifacts')}),{mode:0o600});
  const client=new Client({name:'waypost-check',version:'1.0.0'});
  await client.connect(new StdioClientTransport({command:process.execPath,args:[resolve('runtime/waypost.mjs'),'--config',config,'mcp'],stderr:'pipe'}));
  try {
    const prepared=await client.callTool({name:'calendar_prepare',arguments:{summary:'Dentist',start:'2026-11-02T08:30:00',end:'2026-11-02T09:15:00',timezone:'America/New_York'}});
    assert.equal(prepared.structuredContent.data.start,'2026-11-02T13:30:00Z');
    const bad=await client.callTool({name:'calendar_prepare',arguments:{summary:'Bad',start:'2026-11-02T08:30:00'}});
    assert.equal(bad.structuredContent.error.code,'INPUT_INVALID');assert.match(bad.structuredContent.error.message,/timezone/);
    await writeFile(config,JSON.stringify({version:1,artifactsDir:join(root,'artifacts'),calendar:{files:[prepared.structuredContent.data.path]}}),{mode:0o600});
    const events=await client.callTool({name:'calendar_events',arguments:{from:'2026-11-01T00:00:00Z',to:'2026-11-03T00:00:00Z',timezone:'America/New_York'}});
    assert.deepEqual(events.structuredContent.data.events.map(event=>[event.summary,event.startLocal]),[['Dentist','2026-11-02T08:30:00-05:00']]);
  }finally{await client.close();}
});
