import { StringDecoder } from 'node:string_decoder';
import { spawn } from 'node:child_process';
import { access, stat } from 'node:fs/promises';
import { constants } from 'node:fs';
import { WaypostError } from './errors.js';

export class ServiceFailure extends WaypostError {
  constructor(readonly stderr:string) { super('SERVICE_FAILED','The official CLI reported a failure. Check its connection and permissions directly.'); }
}
// stderr is kept in memory only and handed to callers that opt in to show a bounded first line.
export function firstLine(text:string, max=300):string {
  return (text.split(/\r?\n/).map(line => line.trim()).find(Boolean) ?? '').replace(/[\x00-\x1f\x7f]/g,' ').slice(0,max);
}
export async function runExecutable(executable:string, args:string[], timeoutMs:number, maxBytes=2097152):Promise<string> {
  try {
    await access(executable,constants.X_OK);
    const file=await stat(executable);
    if(!file.isFile() || (process.platform!=='win32' && (file.mode & 0o022))) throw new Error('permissions');
  } catch {throw new WaypostError('EXECUTABLE_UNAVAILABLE','The configured executable is missing or writable by other users. Check its path and permissions.');}
  if(process.env.PROTON_DRIVE_CREDENTIALS_STORE==='unsafe_file') throw new WaypostError('UNSAFE_CREDENTIAL_STORE','Use the official Drive CLI protected credential store. Plaintext session storage is not supported.');
  const env=Object.fromEntries(Object.entries(process.env).filter(([key])=>!key.startsWith('WAYPOST_MAIL_')));
  return new Promise((resolve,reject)=>{
    const child=spawn(executable,args,{shell:false,stdio:['ignore','pipe','pipe'],env});
    let output='';let errors='';let bytes=0;let failed=false;const decoder=new StringDecoder('utf8');let killTimer:ReturnType<typeof setTimeout>|undefined;
    const stop=(error:WaypostError)=>{if(failed)return;failed=true;child.kill('SIGTERM');killTimer=setTimeout(()=>child.kill('SIGKILL'),1000);killTimer.unref();reject(error);};
    const timer=setTimeout(()=>stop(new WaypostError('TIMEOUT','The operation timed out. Its outcome may be uncertain; inspect the service before retrying a write.')),timeoutMs);
    child.stdout.on('data',(data:Buffer)=>{bytes+=data.length;if(bytes>maxBytes)stop(new WaypostError('OUTPUT_LIMIT','The service returned too much data. Narrow the request.'));else output+=decoder.write(data);});
    child.stderr.on('data',(data:Buffer)=>{bytes+=data.length;if(bytes>maxBytes)stop(new WaypostError('OUTPUT_LIMIT','The service returned too much data. Narrow the request.'));else if(errors.length<4096)errors+=data.toString('utf8');});
    child.once('error',()=>stop(new WaypostError('EXECUTABLE_FAILED','The configured service executable could not start.')));
    child.once('close',code=>{clearTimeout(timer);if(killTimer)clearTimeout(killTimer);output+=decoder.end();if(failed)return;if(code===0)resolve(output);else reject(new ServiceFailure(errors));});
  });
}
