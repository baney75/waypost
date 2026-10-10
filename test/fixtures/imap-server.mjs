// Starts a real IMAP server (pymap, in-memory backend) with STARTTLS for integration tests.
// Use WAYPOST_PYMAP to name a pymap executable; otherwise pymap on PATH or uvx is used.
import {spawn,spawnSync,execFileSync} from 'node:child_process';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import net from 'node:net';
import {randomBytes} from 'node:crypto';
import {ImapFlow} from 'imapflow';

const PYMAP='pymap==0.36.7';
function launcher() {
  if (process.env.WAYPOST_PYMAP) return [process.env.WAYPOST_PYMAP,[]];
  if (spawnSync('pymap',['--version']).status===0) return ['pymap',[]];
  if (spawnSync('uvx',['--version']).status===0) return ['uvx',['--quiet','--from',PYMAP,'pymap']];
  return null;
}
export const imapServerAvailable=()=>launcher()!==null && spawnSync('openssl',['version']).status===0;
async function freePort() {
  return new Promise((resolve,reject)=>{const server=net.createServer();server.listen(0,'127.0.0.1',()=>{const {port}=server.address();server.close(()=>resolve(port));});server.on('error',reject);});
}
async function waitForGreeting(port,deadline) {
  while (Date.now()<deadline) {
    const ok=await new Promise(resolve=>{const socket=net.connect(port,'127.0.0.1');socket.once('data',data=>{socket.destroy();resolve(/^\* OK/.test(String(data)));});socket.once('error',()=>resolve(false));});
    if (ok) return;
    await new Promise(resolve=>setTimeout(resolve,250));
  }
  throw new Error('pymap did not start');
}
// Credentials are random per run and exist only for this throwaway server.
export async function startImapServer(t) {
  const user='synthetic',secret=randomBytes(12).toString('hex');
  const [command,prefix]=launcher();
  const root=await mkdtemp(join(tmpdir(),'waypost-imap-'));
  const key=join(root,'key.pem'),certificate=join(root,'cert.pem');
  execFileSync('openssl',['req','-x509','-newkey','rsa:2048','-nodes','-keyout',key,'-out',certificate,'-days','2','-subj','/CN=127.0.0.1','-addext','subjectAltName=IP:127.0.0.1'],{stdio:'ignore'});
  const port=await freePort();
  // FQDN skips pymap's reverse DNS lookup for its greeting, which takes ~30 s per connection on macOS runners.
  const child=spawn(command,[...prefix,'--host','127.0.0.1','--port',String(port),'--cert',certificate,'--key',key,'dict','--demo-user',user,'--demo-password',secret],{stdio:['ignore','ignore','pipe'],env:{...process.env,FQDN:'localhost'}});
  let stderr='';child.stderr.on('data',data=>{stderr+=data;});
  t.after(async()=>{child.kill('SIGTERM');await rm(root,{recursive:true,force:true});});
  try {await waitForGreeting(port,Date.now()+120000);}
  catch(error){throw new Error(`${error.message}: ${stderr.slice(-500)}`);}
  return {port,user,secret,certificate,root,certificatePem:await readFile(certificate)};
}
// Test-only client for seeding; Waypost itself never disables certificate checks.
export async function seed(server,messages,mailbox='INBOX') {
  const client=new ImapFlow({host:'127.0.0.1',port:server.port,secure:false,doSTARTTLS:true,tls:{ca:[server.certificatePem]},auth:{user:server.user,pass:server.secret},logger:false});
  await client.connect();
  try {
    if (mailbox!=='INBOX') await client.mailboxCreate(mailbox).catch(()=>undefined);
    for (const message of messages) {
      // Use the Date header as the received (internal) date, as a delivered message would have.
      const date=/^Date: (.+)$/m.exec(message)?.[1];
      await client.append(mailbox,Buffer.from(message.replace(/\r?\n/g,'\r\n')),[],date?new Date(date):undefined);
    }
  } finally {await client.logout();}
}
export const day=n=>new Date(Date.UTC(2026,8,1+n,9,0,0)).toUTCString().replace('GMT','+0000');
export const plain=({from,to='me@example.test',subject,date,id,body,extra=''})=>`From: ${from}\nTo: ${to}\nSubject: ${subject}\nDate: ${date}\nMessage-ID: <${id}>\n${extra}Content-Type: text/plain; charset=utf-8\n\n${body}\n`;
