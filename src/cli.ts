#!/usr/bin/env node
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { Command } from 'commander';
import { z } from 'zod';
import { initConfig, loadConfig, defaultConfigPath } from './config.js';
import { WaypostError, publicError } from './errors.js';
import { callTool, tools, capabilities } from './registry.js';
import { serve } from './mcp.js';
import { VERSION } from './version.js';
import { runExecutable } from './process.js';
import { connectDrive, connectMail, connectMailHelper, connectCalendar, connectCalendarFeed } from './connect.js';
import { checkUpdate } from './update.js';

const program=new Command().name('waypost').description('Proton Mail, Calendar and Drive for your terminal and agents.').version(VERSION).option('--config <path>','Configuration file',defaultConfigPath()).showHelpAfterError();
const configPath=()=>resolve(program.opts<{config:string}>().config);
const output=(value:unknown):void=>{process.stdout.write(JSON.stringify({ok:true,data:value},null,2)+'\n');};
const parseInput=(value:string):unknown=>{try{if(Buffer.byteLength(value)>65536)throw new Error();return JSON.parse(value);}catch{throw new WaypostError('INPUT_INVALID','Supply a JSON object no larger than 64 KiB.');}};
const invoke=async(name:string,input:unknown)=>output(await callTool(await loadConfig(configPath()),name,input));
async function stdinLink():Promise<string> {
  if(process.stdin.isTTY)throw new WaypostError('INPUT_INVALID','Pipe the share link on standard input, or use --url-file with an owner-only file. Do not place the link in command arguments.');
  const chunks:Buffer[]=[];let bytes=0;
  for await(const chunk of process.stdin){const buffer=Buffer.from(chunk);bytes+=buffer.length;if(bytes>8192)throw new WaypostError('INPUT_INVALID','Calendar link exceeds 8 KiB.');chunks.push(buffer);}
  return Buffer.concat(chunks).toString('utf8');
}
program.command('init').description('Create a private configuration; preserve existing files.').action(async()=>output({config:await initConfig(configPath()),next:'Run waypost connect --help to connect a service.'}));
program.command('status').description('Show connection settings and available routes.').action(async()=>output(capabilities(await loadConfig(configPath()))));
const connect=program.command('connect').description('Connect official service routes. Run a subcommand with --help for options.');
connect.command('drive').description('Find the official Drive CLI and open Proton browser sign-in.').option('--executable <path>','Official CLI path').option('--no-signin','Reuse an existing official session').action(async(options:{executable?:string;signin:boolean})=>output(await connectDrive(configPath(),options.executable,options.signin)));
connect.command('calendar [file]').description('Connect an ICS export or a refreshable Proton share link.').option('--url-file <path>','Owner-only file containing a Proton share URL').option('--url-stdin','Read a Proton share URL from standard input').option('--name <name>','Name for a linked calendar','Calendar').action(async(file:string|undefined,options:{urlFile?:string;urlStdin?:boolean;name:string})=>{
  if(Number(!!file)+Number(!!options.urlFile)+Number(!!options.urlStdin)!==1)throw new WaypostError('INPUT_INVALID','Supply an ICS file, --url-file, or --url-stdin. Use exactly one source.');
  output(file?await connectCalendar(configPath(),file):await connectCalendarFeed(configPath(),options.name,options.urlFile?{file:options.urlFile}:{url:await stdinLink()}));
});
connect.command('mail').description('Connect local Bridge or an authenticated read-only Mail helper.').option('--certificate <path>','Bridge public PEM; also inject WAYPOST_MAIL_USERNAME and WAYPOST_MAIL_PASSWORD').option('--helper <path>','Authenticated read-only helper executable').option('--imap-port <port>','IMAP STARTTLS port','1143').option('--smtp-port <port>','SMTP STARTTLS port','1025').action(async(options:{certificate?:string;helper?:string;imapPort:string;smtpPort:string})=>{
  if(Number(!!options.certificate)+Number(!!options.helper)!==1)throw new WaypostError('INPUT_INVALID','Choose --certificate for local Bridge or --helper for an existing authenticated helper.');
  output(options.helper?await connectMailHelper(configPath(),options.helper):await connectMail(configPath(),options.certificate!,Number(options.imapPort),Number(options.smtpPort)));
});
program.command('tools').description('List all CLI/MCP tools and JSON input schemas.').action(()=>output(tools.map(t=>({name:t.name,description:t.description,input:z.toJSONSchema(t.schema,{io:'input'}),readOnly:t.readOnly,destructive:t.destructive}))));
program.command('call <tool>').description('Run the same tool exposed through MCP.').option('--input <json>','Input object','{}').action(async(name:string,options:{input:string})=>invoke(name,parseInput(options.input)));
for(const service of ['mail','drive','calendar']) {
  const group=program.command(service).description(`Use ${service} tools.`);
  if(service==='calendar')group.command('agenda').description('Read the upcoming calendar window (seven days by default).').option('--days <count>','Days from now','7').option('--limit <count>','Maximum events','50').action(async(options:{days:string;limit:string})=>{
    const days=Number(options.days);if(!Number.isInteger(days)||days<1||days>366)throw new WaypostError('INPUT_INVALID','Choose 1–366 days.');
    const from=new Date();const utc=(d:Date)=>d.toISOString().replace(/\.\d{3}Z$/,'Z');
    await invoke('calendar_events',{from:utc(from),to:utc(new Date(from.getTime()+days*86400000)),limit:Number(options.limit)});
  });
  for(const tool of tools.filter(t=>t.name.startsWith(service+'_'))) {
    const command=group.command(tool.name.slice(service.length+1)).description(tool.description).option('--input <json>','JSON arguments, as an alternative to flags');
    const properties=z.toJSONSchema(tool.schema,{io:'input'}).properties??{};
    for(const [key,schema] of Object.entries(properties)) {
      if(typeof schema!=='object'||schema===null)continue;
      const flag=key.replace(/[A-Z]/g,letter=>'-'+letter.toLowerCase());
      const description=schema.description??`${key}${schema.default!==undefined?` (default: ${JSON.stringify(schema.default)})`:''}`;
      if(schema.type==='boolean')command.option(`--${flag}`,description);
      else if(schema.type==='array')command.option(`--${flag} <value>`,`${description.replace(/[.;]$/,'')}; repeat for multiple values`,(value:string,previous:string[]=[])=>[...previous,value]);
      else command.option(`--${flag} <value>`,description);
    }
    command.action(async(options:Record<string,unknown>)=>{
      const {input,...flags}=options;
      if(typeof input==='string'&&Object.keys(flags).length)throw new WaypostError('INPUT_INVALID','Use either --input JSON or argument flags, not both.');
      for(const [key,value] of Object.entries(flags)) {
        const schema=properties[key];
        if(typeof schema==='object'&&schema!==null&&(schema.type==='integer'||schema.type==='number'))flags[key]=typeof value==='string'&&value.trim()!==''?Number(value):NaN;
      }
      await invoke(tool.name,typeof input==='string'?parseInput(input):flags);
    });
  }
}
program.command('doctor').description('Verify configured services through bounded read-only operations.').action(async()=>{
  const config=await loadConfig(configPath());const checks=[];
  for(const service of ['mail','drive','calendar']) {
    const configured=service==='mail'?!!(config.mail||config.mailHelper):service==='drive'?!!config.drive:!!(config.calendar?.files.length||config.calendar?.feeds?.length);
    if(!configured){checks.push({service,status:'not_configured',next:`Run waypost connect ${service} --help.`});continue;}
    try {
      if(service==='drive')await callTool(config,'drive_list',{path:config.drive?.root});
      else if(service==='mail')await callTool(config,'mail_doctor',{});
      else await callTool(config,'calendar_events',{from:new Date().toISOString().replace(/\.\d{3}Z$/,'Z'),to:new Date(Date.now()+86400000).toISOString().replace(/\.\d{3}Z$/,'Z'),limit:1});
      checks.push({service,status:'ready',verified:service==='calendar'?(config.calendar?.feeds?.length?'feed_fetch_and_snapshot_parse':'snapshot_parse'):service==='mail'?'authentication':'directory_read'});
    }catch(error){checks.push({service,status:'failed',error:publicError(error)});}
  }
  output({checks,routes:capabilities(config)});if(checks.some(c=>c.status==='failed'))process.exitCode=1;
});
program.command('login <service>').description('Sign into the official Drive CLI. Mail and Calendar use their connection routes.').action(async(service:string)=>{
  if(service!=='drive')throw new WaypostError('OFFICIAL_SIGNIN',`Run waypost connect ${service==='mail'?'mail':'calendar'} --help. Sign-in stays in Proton’s official tools.`);
  const config=await loadConfig(configPath());if(!config.drive)throw new WaypostError('NOT_CONFIGURED','Run waypost connect drive first.');
  await runExecutable(config.drive.executable,['auth','login'],120000);output({service:'drive',status:'signin_command_completed',next:'Run waypost doctor to verify a Drive read.'});
});
program.command('agent-config [client]').description('Print a working MCP connection for codex, cursor, claude or generic clients.').action(async(client='generic')=>{
  const entry=fileURLToPath(new URL('../runtime/waypost.mjs',import.meta.url));
  const args=[entry,'--config',configPath(),'mcp'];
  if(client==='codex') {
    const config=await loadConfig(configPath());
    const env=config.mail?[config.mail.usernameEnv,config.mail.passwordEnv]:[];
    process.stdout.write(`[mcp_servers.waypost]\ncommand = ${JSON.stringify(process.execPath)}\nargs = ${JSON.stringify(args)}\n${env.length?`env_vars = ${JSON.stringify(env)}\n`:''}`);
  } else if(['generic','cursor','claude'].includes(client))process.stdout.write(JSON.stringify({mcpServers:{waypost:{command:process.execPath,args}}},null,2)+'\n');
  else throw new WaypostError('CLIENT_INVALID','Choose codex, generic, cursor or claude.');
});
program.command('update').description('Check releases; never install silently.').action(async()=>output(await checkUpdate()));
program.command('mcp').description('Start the MCP server over standard input/output.').action(async()=>serve(configPath()));
try {await program.parseAsync();}catch(error){process.stderr.write(JSON.stringify({ok:false,error:publicError(error)})+'\n');process.exitCode=1;}
