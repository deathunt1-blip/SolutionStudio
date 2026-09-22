import { createHash } from 'node:crypto';
import { createServer, createConnection } from 'node:net';
import { realpath, stat, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

/** OS-owned lock: a second PGlite process must never touch the same data files. */
export async function acquireDatabaseLock(dataDir:string):Promise<()=>Promise<void>> {
 const canonical=await realpath(dataDir);
 const key=createHash('sha256').update(process.platform==='win32'?canonical.toLowerCase():canonical).digest('hex').slice(0,40);
 const address=process.platform==='win32'?`\\\\.\\pipe\\solution-studio-${key}`:process.platform==='linux'?`\0solution-studio-${key}`:path.join(tmpdir(),`solution-studio-${key}.sock`);
 const server=createServer(socket=>socket.destroy());server.unref();
 const listen=()=>new Promise<void>((resolve,reject)=>{
  const failed=(error:Error)=>{server.off('listening',ready);reject(error);};
  const ready=()=>{server.off('error',failed);resolve();};
  server.once('error',failed);server.once('listening',ready);server.listen(address);
 });
 try {await listen();}
 catch(error) {
  // macOS filesystem sockets can survive a killed process. Only unlink an
  // unchanged socket after the OS explicitly reports no listener.
  if(process.platform==='darwin'&&(error as NodeJS.ErrnoException).code==='EADDRINUSE') {
   const before=await stat(address);
   const stale=await new Promise<boolean>(resolve=>{const socket=createConnection(address);socket.once('connect',()=>{socket.destroy();resolve(false);});socket.once('error',e=>resolve((e as NodeJS.ErrnoException).code==='ECONNREFUSED'));socket.setTimeout(1000,()=>{socket.destroy();resolve(false);});});
   const after=await stat(address);
   if(stale&&before.ino===after.ino&&before.mtimeMs===after.mtimeMs){await unlink(address);await listen();}
   else throw new Error('This Solution Studio database is already open in another process. Open the existing application instead.');
  } else throw new Error('This Solution Studio database is already open or its local lock is unavailable. Close the other server before starting again.');
 }
 let released=false;
 return async()=>{if(released)return;released=true;await new Promise<void>((resolve,reject)=>server.close(error=>error?reject(error):resolve()));};
}
