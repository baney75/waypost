#!/usr/bin/env node
import { fileURLToPath } from 'node:url';
import { Command } from 'commander';
import { z } from 'zod';
import { initConfig, loadConfig, defaultConfigPath } from './config.js';
import { WaypostError, publicError } from './errors.js';
import { callTool, tools, capabilities } from './registry.js';
import { serve } from './mcp.js';
import { VERSION } from './version.js';
import { runExecutable } from './process.js';
import { connectDrive, connectMail, connectCalendar } from './connect.js';
import { checkUpdate } from './update.js';

const program=new Command().name('waypost').description('Local Proton tools for agents.').version(VERSION).option('--config <path>','Configuration file',defaultConfigPath()).showHelpAfterError();
const output=(value:unknown):void=>{process.stdout.write(JSON.stringify({ok:true,data:value},null,2)+'\n');};
program.command('init').description('Create a private configuration file; preserve existing files.').action(async()=>output({config:await initConfig(program.opts<{config:string}>().config),next:'Edit service paths, then run waypost doctor.'}));
const connect=program.command('connect').description('Connect official service routes without storing account passwords.');
connect.command('drive').description('Find the official Drive CLI and open Proton browser sign-in.').option('--executable <path>','Official CLI path').option('--no-signin','Reuse an existing official session').action(async(options:{executable?:string;signin:boolean})=>output(await connectDrive(program.opts<{config:string}>().config,options.executable,options.signin)));
connect.command('calendar <file>').description('Approve a local Proton ICS snapshot.').action(async(file:string)=>output(await connectCalendar(program.opts<{config:string}>().config,file)));
connect.command('mail').description('Configure local Bridge ports and its public certificate.').requiredOption('--certificate <path>','Bridge public PEM certificate').option('--imap-port <port>','IMAP STARTTLS port','1143').option('--smtp-port <port>','SMTP STARTTLS port','1025').action(async(options:{certificate:string;imapPort:string;smtpPort:string})=>output(await connectMail(program.opts<{config:string}>().config,options.certificate,Number(options.imapPort),Number(options.smtpPort))));
program.command('tools').description('List tool names and their JSON input schemas.').action(()=>output(tools.map(t=>({name:t.name,description:t.description,input:z.toJSONSchema(t.schema,{io:'input'}),readOnly:t.readOnly,destructive:t.destructive}))));
program.command('call <tool>').description('Run a tool with JSON input.').option('--input <json>','Input object','{}').action(async(name:string,options:{input:string})=>{let input:unknown;try {if(Buffer.byteLength(options.input)>65536)throw new Error();input=JSON.parse(options.input);}catch{throw new WaypostError('INPUT_INVALID','Supply a JSON object no larger than 64 KiB.');}output(await callTool(await loadConfig(program.opts<{config:string}>().config),name,input));});
for(const service of ['mail','drive','calendar']) {
  const group=program.command(service).description(`Use ${service} tools.`);
  for(const tool of tools.filter(t=>t.name.startsWith(service+'_'))) group.command(tool.name.slice(service.length+1)).description(tool.description).option('--input <json>','Tool arguments as JSON','{}').action(async(options:{input:string})=>{let input:unknown;try{if(Buffer.byteLength(options.input)>65536)throw new Error();input=JSON.parse(options.input);}catch{throw new WaypostError('INPUT_INVALID','Supply a JSON object no larger than 64 KiB.');}output(await callTool(await loadConfig(program.opts<{config:string}>().config),tool.name,input));});
}
program.command('doctor').description('Check configured services with bounded, read-only operations.').action(async()=>{
  const config=await loadConfig(program.opts<{config:string}>().config);const checks=[];
  for(const service of ['mail','drive','calendar']) {
    const configured=service==='mail'?!!config.mail:service==='drive'?!!config.drive:!!config.calendar?.files.length;
    if(!configured){checks.push({service,status:'not_configured'});continue;}
    try {
      if(service==='drive')await callTool(config,'drive_list',{path:config.drive?.root});
      else if(service==='mail')await callTool(config,'mail_doctor',{});
      else await callTool(config,'calendar_events',{from:new Date().toISOString().replace(/\.\d{3}Z$/,'Z'),to:new Date(Date.now()+86400000).toISOString().replace(/\.\d{3}Z$/,'Z'),limit:1});
      checks.push({service,status:'ready',verified:service==='calendar'?'snapshot_parse':service==='mail'?'authentication':'directory_read'});
    }catch(error){checks.push({service,status:'failed',error:publicError(error)});}
  }
  output({checks,routes:capabilities(config)});if(checks.some(c=>c.status==='failed'))process.exitCode=1;
});
program.command('login <service>').description('Sign in through Proton’s own tools. Currently: drive.').action(async(service:string)=>{
  if(service!=='drive')throw new WaypostError('OFFICIAL_SIGNIN','Sign into Mail Bridge or Proton Calendar directly. Waypost does not collect your Proton account password. See docs/setup.md.');
  const config=await loadConfig(program.opts<{config:string}>().config);if(!config.drive)throw new WaypostError('NOT_CONFIGURED','Configure the official Drive CLI executable first.');
  await runExecutable(config.drive.executable,['auth','login'],120000);output({service:'drive',status:'signin_command_completed',next:'Run waypost doctor to verify a Drive read.'});
});
program.command('agent-config [client]').description('Print MCP connection configuration for codex or generic clients.').action((client='generic')=>{
  const entry=fileURLToPath(new URL('../runtime/waypost.mjs',import.meta.url));
  const args=[entry,'--config',program.opts<{config:string}>().config,'mcp'];
  if(client==='codex')process.stdout.write(`[mcp_servers.waypost]\ncommand = ${JSON.stringify(process.execPath)}\nargs = ${JSON.stringify(args)}\n`);
  else if(client==='generic'||client==='cursor'||client==='claude')process.stdout.write(JSON.stringify({mcpServers:{waypost:{command:process.execPath,args}}},null,2)+'\n');
  else throw new WaypostError('CLIENT_INVALID','Choose codex, generic, cursor or claude.');
});
program.command('update').description('Check official GitHub release metadata; never install silently.').action(async()=>output(await checkUpdate()));
program.command('mcp').description('Start the local MCP server over standard input/output.').action(async()=>serve(program.opts<{config:string}>().config));
try {await program.parseAsync();}catch(error){process.stderr.write(JSON.stringify({ok:false,error:publicError(error)})+'\n');process.exitCode=1;}
