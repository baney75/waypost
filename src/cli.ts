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
import { connectDrive, connectMail, connectMailHelper, connectCalendar, connectCalendarFeed, connectCalendarPass, connectCalendarKeychain } from './connect.js';
import { checkUpdate } from './update.js';
import { runNativeHost } from './native-host.js';
import { connectBrowser } from './browser.js';
import { serveHttp } from './http.js';
import { setupCalendar, setupRemote, setupQuick, doctorChecks, remoteDoctor } from './setup.js';
import { setupCloudflare, API_TOKEN_PERMISSIONS } from './cloudflare.js';
import { backupStore, createFeedToken, listFeedTokens, migrateCalendar, restoreStore, revokeFeedToken, syncCalendars } from './agent-calendar.js';
import { createBearer, listAuth, revokeAuth, setPasscode } from './oauth.js';

const program=new Command().name('waypost').description('Proton Mail, Calendar and Drive for your terminal and agents.').version(VERSION).option('--config <path>','Configuration file',defaultConfigPath()).showHelpAfterError();
const configPath=()=>resolve(program.opts<{config:string}>().config);
const output=(value:unknown):void=>{process.stdout.write(JSON.stringify({ok:true,data:value},null,2)+'\n');};
const parseInput=(value:string):unknown=>{try{if(Buffer.byteLength(value)>65536)throw new Error();return JSON.parse(value);}catch{throw new WaypostError('INPUT_INVALID','Supply a JSON object no larger than 64 KiB.');}};
// Check arguments before reading configuration, so input mistakes are reported first.
const invoke=async(name:string,input:unknown)=>{tools.find(tool=>tool.name===name)?.schema.parse(input);output(await callTool(await loadConfig(configPath()),name,input));};
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
connect.command('calendar [file]').description('Connect an ICS export or a refreshable Proton share link.').option('--url-file <path>','Owner-only file containing a Proton share URL').option('--url-stdin','Read a Proton share URL from standard input').option('--pass-item <title>','Proton Pass item title whose URL is the share link').option('--vault <name>','Proton Pass vault that holds --pass-item').option('--keychain-service <service>','macOS login keychain service whose password is the share link').option('--keychain-account <account>','Keychain account for --keychain-service','proton-calendar-feed').option('--name <name>','Name for a linked calendar','Calendar').option('--source <slug>','Short provenance name, such as personal (events show as proton/personal)').option('--read-only','Agents may read this calendar but never propose changes to it').action(async(file:string|undefined,options:{urlFile?:string;urlStdin?:boolean;passItem?:string;vault?:string;keychainService?:string;keychainAccount:string;name:string;source?:string;readOnly?:boolean})=>{
  const tags={...(options.source?{source:options.source}:{}),...(options.readOnly?{readOnly:true}:{})};
  if(Number(!!file)+Number(!!options.urlFile)+Number(!!options.urlStdin)+Number(!!options.passItem)+Number(!!options.keychainService)!==1)throw new WaypostError('INPUT_INVALID','Supply an ICS file, --url-file, --url-stdin, --pass-item or --keychain-service. Use exactly one source.');
  const explicit=(key:string)=>connect.commands.find(c=>c.name()==='calendar')?.getOptionValueSource(key)==='cli';
  if(explicit('keychainAccount')&&!options.keychainService)throw new WaypostError('INPUT_INVALID','--keychain-account needs --keychain-service.');
  if(options.vault&&!options.passItem)throw new WaypostError('INPUT_INVALID','--vault applies only with --pass-item.');
  if(file&&(options.source||options.readOnly))throw new WaypostError('INPUT_INVALID','--source and --read-only apply to linked calendars.');
  if(options.keychainService){output(await connectCalendarKeychain(configPath(),options.name,{keychainService:options.keychainService,keychainAccount:options.keychainAccount},tags));return;}
  if(options.passItem){
    if(!options.vault)throw new WaypostError('INPUT_INVALID','Name the Proton Pass vault with --vault. Do not put the share link on the command line.');
    output(await connectCalendarPass(configPath(),options.name,{passItem:options.passItem,vault:options.vault},tags));
    return;
  }
  output(file?await connectCalendar(configPath(),file):await connectCalendarFeed(configPath(),options.name,options.urlFile?{file:options.urlFile}:{url:await stdinLink()},tags));
});
connect.command('browser').description('Pair the Waypost browser extension so it can fill verification codes. Off until you run this.').option('--extension-id <id>','Extension ID shown on chrome://extensions (defaults to the ID pinned in extension/manifest.json)').option('--browser <name>','chrome, chromium, brave, edge, or helium','chrome').option('--hosts-dir <path>','NativeMessagingHosts directory for another Chromium browser').action(async(options:{extensionId?:string;browser:string;hostsDir?:string})=>output(await connectBrowser(configPath(),options)));
connect.command('mail').description('Connect local Bridge or an authenticated read-only Mail helper.').option('--certificate <path>','Bridge public PEM; also inject WAYPOST_MAIL_USERNAME and WAYPOST_MAIL_PASSWORD').option('--helper <path>','Authenticated read-only helper executable').option('--imap-port <port>','IMAP STARTTLS port','1143').option('--smtp-port <port>','SMTP STARTTLS port','1025').action(async(options:{certificate?:string;helper?:string;imapPort:string;smtpPort:string})=>{
  if(Number(!!options.certificate)+Number(!!options.helper)!==1)throw new WaypostError('INPUT_INVALID','Choose --certificate for local Bridge or --helper for an existing authenticated helper.');
  output(options.helper?await connectMailHelper(configPath(),options.helper):await connectMail(configPath(),options.certificate!,Number(options.imapPort),Number(options.smtpPort)));
});
program.command('tools').description('List all CLI/MCP tools and JSON input schemas.').action(()=>output(tools.map(t=>({name:t.name,description:t.description,input:z.toJSONSchema(t.schema,{io:'input'}),readOnly:t.readOnly,destructive:t.destructive}))));
program.command('call <tool>').description('Run the same tool exposed through MCP.').option('--input <json>','Input object','{}').action(async(name:string,options:{input:string})=>invoke(name,parseInput(options.input)));
for(const service of ['mail','drive','calendar']) {
  const group=program.command(service).description(`Use ${service} tools.`);
  if(service==='calendar')group.command('agenda').description('Read the upcoming calendar window (seven days by default) with local times.').option('--days <count>','Days from now','7').option('--limit <count>','Maximum events','50').option('--timezone <zone>','IANA timezone for local times',Intl.DateTimeFormat().resolvedOptions().timeZone).action(async(options:{days:string;limit:string;timezone:string})=>{
    const days=Number(options.days);if(!Number.isInteger(days)||days<1||days>366)throw new WaypostError('INPUT_INVALID','Choose 1–366 days.');
    const from=new Date();const utc=(d:Date)=>d.toISOString().replace(/\.\d{3}Z$/,'Z');
    await invoke('calendar_events',{from:utc(from),to:utc(new Date(from.getTime()+days*86400000)),limit:Number(options.limit),...(options.timezone&&options.timezone!=='UTC'?{timezone:options.timezone}:{})});
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
        else if(typeof schema==='object'&&schema!==null&&schema.type==='array'&&typeof schema.items==='object'&&schema.items!==null&&['integer','number'].includes(String((schema.items as {type?:unknown}).type))&&Array.isArray(value))flags[key]=value.map(item=>String(item).trim()!==''?Number(item):NaN);
      }
      await invoke(tool.name,typeof input==='string'?parseInput(input):flags);
    });
  }
}
program.command('doctor').description('Verify configured services through bounded read-only operations.').option('--remote <url>','Also check a deployed Waypost over HTTPS (health, OAuth metadata, MCP auth challenge)').action(async(options:{remote?:string})=>{
  const config=await loadConfig(configPath());
  const checks=await doctorChecks(config);
  if(options.remote)checks.push(...await remoteDoctor(options.remote));
  output({checks,routes:capabilities(config)});if(checks.some(c=>c.status==='failed'))process.exitCode=1;
});
program.command('login <service>').description('Sign into the official Drive CLI. Mail and Calendar use their connection routes.').action(async(service:string)=>{
  if(service!=='drive')throw new WaypostError('OFFICIAL_SIGNIN',`Run waypost connect ${service==='mail'?'mail':'calendar'} --help. Sign-in stays in Proton’s official tools.`);
  const config=await loadConfig(configPath());if(!config.drive)throw new WaypostError('NOT_CONFIGURED','Run waypost connect drive first.');
  await runExecutable(config.drive.executable,['auth','login'],120000);output({service:'drive',status:'signin_command_completed',next:'Run waypost doctor to verify a Drive read.'});
});
program.command('agent-config [client]').description('Print a working MCP connection: claude-code (a claude mcp add command), codex, claude (Claude Desktop JSON), cursor or generic.').action(async(client='generic')=>{
  const entry=fileURLToPath(new URL('../runtime/waypost.mjs',import.meta.url));
  const args=[entry,'--config',configPath(),'mcp'];
  if(client==='codex') {
    const config=await loadConfig(configPath());
    const env=config.mail?[config.mail.usernameEnv,config.mail.passwordEnv]:[];
    process.stdout.write(`[mcp_servers.waypost]\ncommand = ${JSON.stringify(process.execPath)}\nargs = ${JSON.stringify(args)}\n${env.length?`env_vars = ${JSON.stringify(env)}\n`:''}`);
  } else if(client==='claude-code') {
    const quote=(value:string)=>/^[\w@%+=:,./-]+$/.test(value)?value:`'${value.replace(/'/g,`'\\''`)}'`;
    process.stdout.write(`claude mcp add waypost --scope user -- ${[process.execPath,...args].map(quote).join(' ')}\n`);
  } else if(['generic','cursor','claude'].includes(client))process.stdout.write(JSON.stringify({mcpServers:{waypost:{command:process.execPath,args}}},null,2)+'\n');
  else throw new WaypostError('CLIENT_INVALID','Choose claude-code, codex, claude, cursor or generic.');
});
program.command('update').description('Check releases; never install silently.').action(async()=>output(await checkUpdate()));
// Started by the browser through native messaging; Chrome passes the extension origin as the first argument.
program.command('native-host [origin]',{hidden:true}).allowUnknownOption().description('Native messaging host for the browser extension.').action(async(origin?:string)=>runNativeHost(configPath(),origin));
program.command('mcp').description('Start the MCP server over standard input/output.').action(async()=>serve(configPath()));
program.command('serve').description('Start the remote MCP endpoint (Streamable HTTP with OAuth), the agent calendar feed and the Proton mirror sync. Needs waypost setup remote.').action(async()=>serveHttp(configPath()));
const setup=program.command('setup').description('Guided setup for the agent calendar and remote access.');
setup.command('quick').description('One step for a server: agent calendar, remote access, passcode and a Proton feed link, all under one data directory.').requiredOption('--public-url <url>','Public HTTPS origin, such as https://waypost.example.com').requiredOption('--data <dir>','Absolute private directory for Waypost state').option('--owner <email>','Your Proton address, for notes and invitations').option('--port <port>','Listen port (default 8787, or the stored value)').option('--host <host>','Listen address, 0.0.0.0 inside a container (default 127.0.0.1, or the stored value)').option('--enable-writes','Let agents create and change agent calendar events (each still needs confirm: true)').action(async(options:{publicUrl:string;data:string;owner?:string;port?:string;host?:string;enableWrites?:boolean})=>output(await setupQuick(configPath(),{...options,port:options.port===undefined?undefined:Number(options.port),enableWrites:options.enableWrites})));
setup.command('calendar').description('Create the agent calendar store.').requiredOption('--dir <dir>','Absolute private directory for the store').option('--name <name>','Calendar name shown in Proton (default Agents, or the stored value)').option('--owner <email>','Your Proton address, for notes and invitations').option('--organizer <email>','A sending address you own, different from --owner, for invitations').option('--enable-writes','Let agents write (each call still needs confirm: true)').action(async(options:{dir:string;name:string;owner?:string;organizer?:string;enableWrites?:boolean})=>output(await setupCalendar(configPath(),options)));
setup.command('remote').description('Configure the remote MCP endpoint and print a passcode.').requiredOption('--public-url <url>','Public HTTPS origin').requiredOption('--state-dir <dir>','Absolute private directory for OAuth state').option('--port <port>','Listen port (default 8787, or the stored value)').option('--host <host>','Listen address (default 127.0.0.1, or the stored value)').action(async(options:{publicUrl:string;stateDir:string;port?:string;host?:string})=>output(await setupRemote(configPath(),{...options,port:options.port===undefined?undefined:Number(options.port)})));
setup.command('cloudflare').description(`Make your own free public address on your Cloudflare account: a tunnel, a Workers VPC service and a workers.dev front door. Reads an API token from CLOUDFLARE_API_TOKEN with ${API_TOKEN_PERMISSIONS.join(', ')}.`).requiredOption('--tunnel-token-file <path>','Absolute path for the tunnel token, such as /secrets/tunnel_token (written owner-only, never printed)').option('--account-id <id>','Cloudflare account id (needed only when the token sees several accounts)').option('--name <name>','Name for the tunnel, VPC service and Worker','waypost').option('--workers-subdomain <name>','Register this workers.dev subdomain if the account has none yet').option('--hostname <host>','Serve a domain you already have on Cloudflare instead of workers.dev').option('--replace','Overwrite a same-named Worker that is not Waypost\'s, take a domain another Worker serves, or swap in a new tunnel over the token file\'s old one').option('--reuse','Pick up a same-named tunnel that never connected and has no VPC service yet, such as one left by a run that stopped partway').action(async(options:{tunnelTokenFile:string;accountId?:string;name:string;workersSubdomain?:string;hostname?:string;replace?:boolean;reuse?:boolean})=>{
  const apiToken=process.env.CLOUDFLARE_API_TOKEN?.trim();
  if(!apiToken)throw new WaypostError('INPUT_INVALID',`Set CLOUDFLARE_API_TOKEN to a Cloudflare API token with ${API_TOKEN_PERMISSIONS.join(', ')}. Do not put the token in command arguments.`);
  output(await setupCloudflare({...options,accountId:options.accountId||process.env.CLOUDFLARE_ACCOUNT_ID||undefined,apiToken}));
});
const calendarGroup=program.commands.find(command=>command.name()==='calendar')!;
const feedGroup=calendarGroup.command('feed').description('Private ICS links that publish the agent calendar to Proton.');
feedGroup.command('create').description('Create a feed link (shown once).').option('--label <label>','Where it is used','Proton').action(async(options:{label:string})=>output(await createFeedToken(await loadConfig(configPath()),options.label)));
feedGroup.command('list').description('List feed links without their secrets.').action(async()=>output(await listFeedTokens(await loadConfig(configPath()))));
feedGroup.command('revoke <id>').description('Stop a feed link from working.').action(async(id:string)=>output(await revokeFeedToken(await loadConfig(configPath()),id)));
calendarGroup.command('sync').description('Mirror every Proton share link now and retire finished adoptions.').action(async()=>output(await syncCalendars(await loadConfig(configPath()))));
calendarGroup.command('migrate <file>').description('Import a Proton ICS export into the agent calendar. Dry run with a diff unless --confirm.').option('--source <provenance>','The calendar the export came from','proton/personal').option('--confirm','Write the import').action(async(file:string,options:{source:string;confirm?:boolean})=>output(await migrateCalendar(await loadConfig(configPath()),resolve(file),{source:options.source,confirm:!!options.confirm})));
const auth=program.command('auth').description('Remote access: owner passcode, bearer tokens and OAuth clients.');
auth.command('passcode').description('Set a new owner passcode for the approval page (shown once).').action(async()=>output(await setPasscode(await loadConfig(configPath()))));
auth.command('token').description('Create a static bearer token for a CLI client (shown once), or register the SHA-256 of a token the client made.').option('--label <label>','Client name','cli').option('--sha256 <hex>','Register a client-generated token by its SHA-256; the token never reaches the server').action(async(options:{label:string;sha256?:string})=>output(await createBearer(await loadConfig(configPath()),options.label,options.sha256)));
auth.command('list').description('List bearer tokens and OAuth clients without secrets.').action(async()=>output(await listAuth(await loadConfig(configPath()))));
auth.command('revoke <id>').description('Revoke a bearer token id, an OAuth client id, or all.').action(async(id:string)=>output(await revokeAuth(await loadConfig(configPath()),id)));
const storeGroup=program.command('store').description('Back up and restore the agent calendar store.');
storeGroup.command('backup').description('Write the store to a new file (never overwrites).').requiredOption('--out <file>','New backup file path').action(async(options:{out:string})=>output(await backupStore(await loadConfig(configPath()),resolve(options.out))));
storeGroup.command('restore').description('Replace the store from a backup. Dry run unless --confirm; the current store is kept.').requiredOption('--in <file>','Backup file').option('--confirm','Replace the store').action(async(options:{in:string;confirm?:boolean})=>output(await restoreStore(await loadConfig(configPath()),resolve(options.in),!!options.confirm)));
try {await program.parseAsync();}catch(error){process.stderr.write(JSON.stringify({ok:false,error:publicError(error)})+'\n');process.exitCode=1;}
