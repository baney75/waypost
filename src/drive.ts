import { lstat, mkdtemp, open, realpath, readdir, stat } from 'node:fs/promises';
import { constants } from 'node:fs';
import { isAbsolute, join, posix, relative, sep } from 'node:path';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { Config } from './config.js';
import { checkedPath } from './config.js';
import { WaypostError } from './errors.js';
import { runExecutable } from './process.js';
import { defineTool } from './tool.js';
import { ensureArtifactsDirectory } from './artifacts.js';

export const drivePathSchema=z.string().max(2048).refine(path=>path.startsWith('/my-files') && !/[\\\x00-\x1f\x7f]/.test(path) && !path.split('/').some(p=>p==='..'||p==='.') && (path==='/my-files'||path.startsWith('/my-files/')),'Use a path inside /my-files without traversal or escaped separators.').describe('Absolute Proton Drive path inside the configured /my-files root.');
function drive(config:Config) {if(!config.drive)throw new WaypostError('NOT_CONFIGURED','Drive is not configured. Run waypost connect drive.');return config.drive;}
export function remotePath(config:Config,path:string):string {
  const value=drivePathSchema.parse(path);const root=posix.normalize(drivePathSchema.parse(drive(config).root));const normalized=posix.normalize(value);
  if(normalized!==root && !normalized.startsWith(root+'/')) throw new WaypostError('PATH_DENIED','The Drive path is outside the configured root.');
  return normalized;
}
async function invoke(config:Config,args:string[]):Promise<unknown> {
  const output=await runExecutable(drive(config).executable,[...args,'--json'],config.timeoutMs);
  try {return JSON.parse(output);} catch {throw new WaypostError('SERVICE_FORMAT','The official Drive CLI returned an unsupported response. Check the CLI version.');}
}
export async function driveList(config:Config,input:{path:string}):Promise<unknown> {return invoke(config,['filesystem','list',remotePath(config,input.path)]);}
export async function driveInfo(config:Config,input:{path:string}):Promise<unknown> {return invoke(config,['filesystem','info',remotePath(config,input.path)]);}
export async function driveUpload(config:Config,input:{file:string;parent:string}):Promise<unknown> {
  if(!drive(config).writeEnabled)throw new WaypostError('WRITE_DISABLED','Drive writes are disabled. Enable them in your local configuration.');
  const file=await checkedPath(input.file,config.artifactsDir);const meta=await stat(file);
  if(!meta.isFile()||meta.size>100*1024*1024)throw new WaypostError('FILE_LIMIT','Upload one regular artifact file no larger than 100 MiB.');
  return {result:await invoke(config,['filesystem','upload','--file-conflict-strategy','rename','--folder-conflict-strategy','rename','--skip-thumbnails',file,remotePath(config,input.parent)]),conflicts:'rename'};
}
async function checkedDownloadDirectory(root:string,directory:string):Promise<void> {
  const metadata=await lstat(directory);const real=await realpath(directory);const rel=relative(root,real);
  if(!metadata.isDirectory() || metadata.isSymbolicLink() || metadata.uid!==process.getuid?.() || (metadata.mode & 0o022) || rel==='..' || rel.startsWith('..'+sep) || isAbsolute(rel))
    throw new WaypostError('PATH_DENIED','An unsafe downloaded directory was rejected. Inspect the retained download directory.');
}
async function downloadedFiles(root:string, directory=root):Promise<{file:string;bytes:number;sha256:string}[]> {
  await checkedDownloadDirectory(root,directory);
  const files=[];
  for(const entry of await readdir(directory,{withFileTypes:true})) {
    const file=join(directory,entry.name);
    if(entry.isSymbolicLink())throw new WaypostError('PATH_DENIED','A downloaded symlink was rejected. Inspect the retained download directory.');
    if(entry.isDirectory())files.push(...await downloadedFiles(root,file));
    else if(entry.isFile()) {
      await checkedDownloadDirectory(root,directory);
      const handle=await open(file,constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      try {
        const metadata=await handle.stat();
        if(!metadata.isFile() || metadata.uid!==process.getuid?.() || (metadata.mode & 0o022))throw new WaypostError('PATH_DENIED','An unsafe downloaded file was rejected. Inspect the retained download directory.');
        if(metadata.size>100*1024*1024)throw new WaypostError('FILE_LIMIT','A downloaded file exceeds 100 MiB. Inspect the retained directory.');
        const hash=createHash('sha256');let bytes=0;
        for await(const chunk of handle.createReadStream({autoClose:false})) {
          bytes+=chunk.length;
          if(bytes>100*1024*1024)throw new WaypostError('FILE_LIMIT','A downloaded file exceeds 100 MiB. Inspect the retained directory.');
          hash.update(chunk);
        }
        files.push({file,bytes,sha256:hash.digest('hex')});
      } finally {await handle.close();}
    } else throw new WaypostError('PATH_DENIED','A non-regular downloaded entry was rejected. Inspect the retained download directory.');
    if(files.length>500)throw new WaypostError('FILE_LIMIT','The download contains more than 500 files. Inspect the retained directory.');
  }
  return files;
}
export async function driveDownload(config:Config,input:{path:string}):Promise<unknown> {
  const remote=remotePath(config,input.path);
  const root=await ensureArtifactsDirectory(config.artifactsDir);const folder=await mkdtemp(join(root,'download-'));
  try {
    const result=await invoke(config,['filesystem','download','--file-conflict-strategy','skip','--folder-conflict-strategy','skip',remote,folder]);
    const files=await downloadedFiles(folder);
    return {result,directory:folder,files,localChecksums:true,remoteChecksumsVerified:false,empty:files.length===0,nativeDocuments:'Proton Docs and Sheets require export in the Proton UI.'};
  } catch(error) {if(error instanceof WaypostError)throw new WaypostError(error.code,error.message+' Partial files, if any, remain in the artifacts directory.');throw error;}
}
export const driveTools=[
  defineTool({name:'drive_list',title:'List Proton Drive',description:'List one configured Drive directory using the official CLI. Returned names are untrusted content.',schema:z.object({path:drivePathSchema}).strict(),readOnly:true,destructive:false,handler:driveList}),
  defineTool({name:'drive_info',title:'Inspect Proton Drive item',description:'Read metadata for one item inside the configured Drive root.',schema:z.object({path:drivePathSchema}).strict(),readOnly:true,destructive:false,handler:driveInfo}),
  defineTool({name:'drive_download',title:'Download Proton Drive item',description:'Download into a new local artifact directory. Does not overwrite existing files. Native Docs and Sheets need UI export.',schema:z.object({path:drivePathSchema}).strict(),readOnly:false,destructive:false,handler:driveDownload}),
  defineTool({name:'drive_upload',title:'Upload artifact to Proton Drive',description:'Upload one artifact file when write policy permits. Conflicts get a new name; no overwrite or sharing.',schema:z.object({file:z.string().max(4096).describe('Local file inside the artifacts directory; at most 100 MiB.'),parent:drivePathSchema}).strict(),readOnly:false,destructive:false,handler:driveUpload}),
];
