import { lstat, mkdir, realpath } from 'node:fs/promises';
import type { Stats } from 'node:fs';
import { isAbsolute, join, parse, relative, resolve, sep } from 'node:path';
import { WaypostError } from './errors.js';

function denied(): never {
  throw new WaypostError('ARTIFACT_PERMISSIONS', 'Use an artifacts directory owned by your user with mode 700, beneath directories other users cannot replace. Symlink artifact roots are not allowed.');
}
function trustedOwner(metadata:Stats):boolean {
  const uid=process.getuid?.();
  return uid!==undefined && (metadata.uid===uid || metadata.uid===0);
}
function checkDirectory(metadata:Stats, privateRoot=false):void {
  if(!metadata.isDirectory() || !trustedOwner(metadata)) denied();
  if(privateRoot) {
    if(metadata.uid!==process.getuid?.() || (metadata.mode & 0o077)) denied();
  } else if((metadata.mode & 0o022) && !(metadata.uid===0 && (metadata.mode & 0o1000))) denied();
}
async function checkParents(directory:string):Promise<void> {
  const root=parse(directory).root;
  let current=root;
  checkDirectory(await lstat(current));
  for(const part of relative(root,directory).split(sep).filter(Boolean)) {
    current=join(current,part);
    checkDirectory(await lstat(current));
  }
}

// Validate each parent before creating its child. A private root alone is not
// sufficient when another user can rename it through a writable parent.
async function walkDirectories(path:string,create:boolean,privateRoot:boolean):Promise<string> {
  if(!isAbsolute(path)) denied();
  const absolute=resolve(path);const root=parse(absolute).root;
  const parts=relative(root,absolute).split(sep).filter(Boolean);
  if(parts.length===0) denied();
  let current=root;
  checkDirectory(await lstat(current));
  for(let index=0;index<parts.length;index++) {
    const part=parts[index];if(part===undefined) denied();
    current=join(current,part);
    let metadata:Stats;
    try {metadata=await lstat(current);}
    catch(error) {
      if(!create || !(error instanceof Error) || !('code' in error) || error.code!=='ENOENT') throw error;
      try {await mkdir(current,{mode:0o700});}
      catch(createError) {
        if(!(createError instanceof Error) || !('code' in createError) || createError.code!=='EEXIST') throw createError;
      }
      metadata=await lstat(current);
    }
    const final=index===parts.length-1;
    if(metadata.isSymbolicLink()) {
      if((final && privateRoot) || !trustedOwner(metadata)) denied();
      // System aliases such as macOS /var are safe only after checking the
      // resolved path's parents as well as the already checked link parent.
      current=await realpath(current);
      await checkParents(current);
    } else checkDirectory(metadata,final && privateRoot);
  }
  return current;
}

export const ensureArtifactsDirectory=(path:string):Promise<string>=>walkDirectories(path,true,true);
export const trustedExistingDirectory=(path:string):Promise<string>=>walkDirectories(path,false,false);
