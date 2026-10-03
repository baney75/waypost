import { access, chmod, open, readFile, rename, unlink, realpath } from 'node:fs/promises';
import { constants } from 'node:fs';
import { delimiter, join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { configSchema, loadConfig } from './config.js';
import type { Config } from './config.js';
import { WaypostError } from './errors.js';
import { runExecutable } from './process.js';

export async function amendConfig(path:string,change:(config:Config)=>Config):Promise<Config> {
  const lock=path+'.lock';let handle;
  try{handle=await open(lock,'wx',0o600);}catch{throw new WaypostError('CONFIG_BUSY','Configuration is locked or inaccessible. Check another Waypost setup process before retrying.');}
  const temp=path+'.'+randomUUID()+'.tmp';
  try {
    const config=configSchema.parse(change(await loadConfig(path)));const file=await open(temp,'wx',0o600);
    try {await file.writeFile(JSON.stringify(config,null,2)+'\n');await file.sync();}finally{await file.close();}
    await rename(temp,path);return config;
  }finally{await handle.close();await unlink(lock);await unlink(temp).catch(()=>undefined);}
}
async function findDrive(explicit?:string):Promise<string> {
  const candidates=explicit?[resolve(explicit)]:(process.env.PATH??'').split(delimiter).filter(Boolean).map(p=>join(p,process.platform==='win32'?'proton-drive.exe':'proton-drive'));
  for(const path of candidates){try{await access(path,constants.X_OK);return await realpath(path);}catch{/* Try the next PATH entry. */}}
  throw new WaypostError('DRIVE_CLI_MISSING','Install the official Proton Drive CLI, or pass --executable with its absolute path.');
}
export async function connectDrive(path:string,executable?:string,signin=true):Promise<unknown> {
  const found=await findDrive(executable);await amendConfig(path,c=>({...c,drive:{executable:found,root:c.drive?.root??'/my-files',writeEnabled:c.drive?.writeEnabled??false}}));
  if(signin)await runExecutable(found,['auth','login'],120000);
  return {service:'drive',configured:true,signedIn:signin?'command_completed':'not_checked',next:'Run waypost doctor to verify a directory read.'};
}
export async function connectCalendar(path:string,file:string):Promise<unknown> {
  const resolved=await realpath(resolve(file));const content=await readFile(resolved,'utf8');
  if(Buffer.byteLength(content)>10*1024*1024||!content.startsWith('BEGIN:VCALENDAR'))throw new WaypostError('CALENDAR_INVALID','Use a Calendar ICS export no larger than 10 MiB.');
  await amendConfig(path,c=>({...c,calendar:{files:[...new Set([...(c.calendar?.files??[]),resolved])]}}));
  await chmod(path,0o600);return {service:'calendar',configured:true,snapshot:true,next:'Run calendar events for the desired date range. Re-export when your calendar changes.'};
}
export async function connectMail(path:string,certificate:string,imapPort=1143,smtpPort=1025):Promise<unknown> {
  const resolved=await realpath(resolve(certificate));const content=await readFile(resolved,'utf8');
  if(content.includes('PRIVATE KEY')||!content.includes('BEGIN CERTIFICATE'))throw new WaypostError('CERTIFICATE_INVALID','Use only Bridge’s exported public PEM certificate.');
  await amendConfig(path,c=>({...c,mail:{host:'127.0.0.1',imapPort,smtpPort,usernameEnv:c.mail?.usernameEnv??'WAYPOST_MAIL_USERNAME',passwordEnv:c.mail?.passwordEnv??'WAYPOST_MAIL_PASSWORD',certificate:resolved,sendEnabled:c.mail?.sendEnabled??false}}));
  return {service:'mail',configured:true,next:'Inject Bridge-generated credentials through your protected secret manager, then run waypost mail doctor.'};
}
