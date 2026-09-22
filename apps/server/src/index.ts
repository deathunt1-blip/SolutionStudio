import 'dotenv/config';
import { createApp } from './app.js';
export { createApp } from './app.js';

const port=Number(process.env.PORT||4310);
const host=process.env.HOST||'127.0.0.1';
let app:Awaited<ReturnType<typeof createApp>>|undefined;
try {
 app=await createApp();await app.listen({port,host});console.log(`Solution Studio: http://${host}:${port}`);
 let closing=false;
 const shutdown=async()=>{if(closing)return;closing=true;try{await app!.close();}finally{process.exit(0);}};
 for(const signal of ['SIGINT','SIGTERM','SIGHUP',...(process.platform==='win32'?['SIGBREAK']:[])])process.on(signal,shutdown);
} catch {
 console.error('Solution Studio could not start. Check for another running server, an occupied port, or a database error. Your existing data has been kept.');
 await app?.close();process.exitCode=1;
}
