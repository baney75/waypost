import {mkdir,readFile,cp,mkdtemp,readdir,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {execFileSync} from 'node:child_process';
const {version}=JSON.parse(await readFile('package.json','utf8'));
const temp=await mkdtemp(join(tmpdir(),'waypost-package-'));const root=join(temp,'waypost');await mkdir(root);
try {
  for(const name of ['.codex-plugin','.mcp.json','skills','runtime','assets','docs','README.md','LICENSE','SECURITY.md'])await cp(name,join(root,name),{recursive:true});
  await rm(join(root,'docs','plan.html'),{force:true});
  const files=[];async function walk(dir){for(const item of await readdir(dir,{withFileTypes:true})){const path=join(dir,item.name);if(item.isDirectory())await walk(path);else if(item.isFile())files.push(path.slice(temp.length+1));else throw Error('Unexpected archive entry');}}
  await walk(root);
  // Python's standard zipfile keeps packaging independent of platform zip commands.
  const target=join(process.cwd(),`waypost-plugin-${version}.zip`);
  const manifest=join(temp,'files.json');await writeFile(manifest,JSON.stringify(files));
  const python=process.env.WAYPOST_PACKAGE_PYTHON??'python3';
  execFileSync(python,['-c','import json,sys,zipfile,pathlib; base=pathlib.Path(sys.argv[1]); files=json.load(open(sys.argv[2])); archive=zipfile.ZipFile(sys.argv[3],"w",zipfile.ZIP_DEFLATED); [archive.write(base/f,f) for f in files]; archive.close()',temp,manifest,target],{stdio:'inherit'});
  console.log(target);
}finally{await rm(temp,{recursive:true,force:true});}
