import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import type { Config } from './config.js';
import { WaypostError } from './errors.js';
import { runExecutable } from './process.js';

const MAX_BYTES=10*1024*1024;
export function calendarFeedUrl(value:string):string {
  try {
    const url=new URL(value.trim());
    if(url.origin!=='https://calendar.proton.me'||url.username||url.password||url.hash||!/^\/api\/calendar\/v1\/url\/[^/]+\/calendar\.ics$/.test(url.pathname))throw new Error();
    if(!url.searchParams.get('CacheKey')||[...url.searchParams.keys()].some(key=>!['CacheKey','PassphraseKey'].includes(key))||url.searchParams.getAll('CacheKey').length!==1||url.searchParams.getAll('PassphraseKey').length>1)throw new Error();
    if(value.length>8192)throw new Error();
    return url.href;
  }catch{throw new WaypostError('CALENDAR_FEED_URL','Use the HTTPS ICS link from Proton Calendar’s Share via link settings.');}
}
export async function readFeedUrl(path:string):Promise<string> {
  let file;
  try {
    file=await open(path,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);
    const metadata=await file.stat();
    if(!metadata.isFile()||metadata.size>8192||(process.platform!=='win32'&&((metadata.mode&0o077)!==0||metadata.uid!==process.getuid?.())))throw new Error();
    const bytes=Buffer.alloc(8193);const {bytesRead}=await file.read(bytes,0,bytes.length,0);
    if(bytesRead>8192)throw new Error();
    return calendarFeedUrl(bytes.subarray(0,bytesRead).toString('utf8'));
  }catch(error){
    if(error instanceof WaypostError)throw error;
    throw new WaypostError('CALENDAR_FEED_FILE','The calendar link file must be an owner-only regular file (chmod 600), no larger than 8 KiB.');
  }finally{await file?.close();}
}
export async function fetchCalendarFeed(url:string,timeoutMs:number):Promise<{content:string;fetchedAt:string}> {
  const approved=calendarFeedUrl(url);
  try {
    const response=await fetch(approved,{redirect:'error',signal:AbortSignal.timeout(timeoutMs),headers:{Accept:'text/calendar'}});
    if(!response.ok||!response.body)throw new Error();
    const declared=Number(response.headers.get('content-length'));
    if(declared>MAX_BYTES){await response.body.cancel();throw new WaypostError('CALENDAR_SIZE','Calendar feed exceeds 10 MiB.');}
    const reader=response.body.getReader();const chunks:Uint8Array[]=[];let length=0;
    try {
      while(true){const {done,value}=await reader.read();if(done)break;length+=value.length;if(length>MAX_BYTES)throw new WaypostError('CALENDAR_SIZE','Calendar feed exceeds 10 MiB.');chunks.push(value);}
    }finally{await reader.cancel().catch(()=>undefined);reader.releaseLock();}
    const content=Buffer.concat(chunks).toString('utf8').replace(/^\uFEFF/,'');
    if(!content.startsWith('BEGIN:VCALENDAR'))throw new WaypostError('CALENDAR_INVALID','Proton returned an invalid calendar feed. Check that the share link is still active.');
    return {content,fetchedAt:new Date().toISOString()};
  }catch(error){
    if(error instanceof WaypostError)throw error;
    throw new WaypostError('CALENDAR_FEED_FAILED','Could not refresh the Proton calendar link. Check connectivity and whether the link was revoked. No stale fallback was used.');
  }
}
export const FEED_CACHE_MS=10*60*1000;
type FeedCacheEntry={content:string;fetchedAt:string;expires:number};
const feedCache=new Map<string,FeedCacheEntry>();
let feedClock=():number=>Date.now();
export function clearCalendarFeedCache(){feedCache.clear();feedClock=()=>Date.now();}
export function setCalendarFeedClock(clock:()=>number){feedClock=clock;}
function collectFeedUrls(value:unknown,found:string[]){
  if(typeof value==='string'){try{found.push(calendarFeedUrl(value));}catch{/* Other item fields are not share links. */}return;}
  if(Array.isArray(value)){for(const item of value)collectFeedUrls(item,found);return;}
  if(value&&typeof value==='object'){for(const nested of Object.values(value))collectFeedUrls(nested,found);}
}
export async function readPassCalendarUrl(config:Config,feed:{passItem:string;vault:string}):Promise<string>{
  const executable=config.pass?.executable;
  if(!executable)throw new WaypostError('PASS_UNCONFIGURED','Set pass.executable to the official pass-cli before reading a calendar item.');
  const output=await runExecutable(executable,['item','view','--vault-name',feed.vault,'--item-title',feed.passItem,'--output','json'],config.timeoutMs,256*1024);
  let parsed:unknown;
  try{parsed=JSON.parse(output);}catch{throw new WaypostError('CALENDAR_PASS_ITEM','Proton Pass did not return the calendar item as JSON. The response was not logged.');}
  const found:string[]=[];
  collectFeedUrls(parsed,found);
  const unique=[...new Set(found)];
  const link=unique.length===1?unique[0]:undefined;
  if(!link)throw new WaypostError('CALENDAR_PASS_ITEM',unique.length?'The Proton Pass item contains more than one calendar share link. The links were not logged.':'The Proton Pass item has no Proton calendar share link. Add the full-view link as a URL on that item.');
  return link;
}
export async function loadCalendarFeed(key:string,load:()=>Promise<{content:string;fetchedAt:string}>):Promise<{content:string;fetchedAt:string;cached:boolean}>{
  const now=feedClock();
  const hit=feedCache.get(key);
  if(hit&&hit.expires>now)return{content:hit.content,fetchedAt:hit.fetchedAt,cached:true};
  const fresh=await load();
  feedCache.set(key,{content:fresh.content,fetchedAt:fresh.fetchedAt,expires:now+FEED_CACHE_MS});
  return{...fresh,cached:false};
}
export function passFeedKey(feed:{vault:string;passItem:string}){return`pass:${feed.vault}:${feed.passItem}`;}
export async function* calendarFeedSnapshots(config:Config) {
  for(const feed of config.calendar?.feeds??[]) {
    const key='urlFile' in feed?`file:${feed.urlFile}`:passFeedKey(feed);
    const result=await loadCalendarFeed(key,async()=>fetchCalendarFeed('urlFile' in feed?await readFeedUrl(feed.urlFile):await readPassCalendarUrl(config,feed),config.timeoutMs));
    yield {path:`feed:${feed.name}`,content:result.content,mtime:result.fetchedAt,fetchedAt:result.fetchedAt,cached:result.cached,kind:'proton_link' as const,upstreamDelay:'Proton share links can lag calendar changes by up to 8 hours. Waypost reuses a successful fetch for 10 minutes and does not keep a failed fetch.'};
  }
}
