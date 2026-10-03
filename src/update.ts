import { z } from 'zod';
import { VERSION } from './version.js';
import { WaypostError } from './errors.js';

const releaseSchema=z.object({tag_name:z.string().regex(/^v\d+\.\d+\.\d+$/),draft:z.literal(false),prerelease:z.boolean(),html_url:z.string().url(),assets:z.array(z.object({name:z.string(),digest:z.string().nullable().optional()}))});
export async function checkUpdate():Promise<unknown> {
  const response=await fetch('https://api.github.com/repos/baney75/waypost/releases/latest',{headers:{Accept:'application/vnd.github+json','User-Agent':'waypost/'+VERSION},signal:AbortSignal.timeout(10000),redirect:'error'});
  if(response.status===404)return {current:VERSION,latest:null,status:'no_stable_release',installed:false};
  if(!response.ok)throw new WaypostError('UPDATE_UNAVAILABLE','Release metadata is unavailable. Try again later or view the repository releases.');
  const release=releaseSchema.parse(await response.json());
  if(release.html_url!==`https://github.com/baney75/waypost/releases/tag/${release.tag_name}`)throw new WaypostError('UPDATE_INVALID','Unexpected release metadata.');
  const latest=release.tag_name.slice(1);const a=latest.split('.').map(Number);const b=VERSION.split('.').map(Number);const different=a.findIndex((n,i)=>n!==b[i]);
  return {current:VERSION,latest,updateAvailable:different>=0 && (a[different]??0)>(b[different]??0),url:release.html_url,installed:false,installation:'Download the release, verify SHA256SUMS and provenance, then install its pinned package. See docs/updates.md.'};
}
