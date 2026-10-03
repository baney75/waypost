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
    const resources=await client.listResources();assert.ok(resources.resources.some(r=>r.uri==='waypost://capabilities'));
    const prompts=await client.listPrompts();assert.equal(prompts.prompts[0].name,'proton-triage');assert.equal(stderr,'');
  }finally{await client.close();}
});
