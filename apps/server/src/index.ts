import 'dotenv/config';
import { createApp } from './app.js';
export { createApp } from './app.js';

const app=await createApp();
const port=Number(process.env.PORT||4310);
const host=process.env.HOST||'127.0.0.1';
try {await app.listen({port,host});console.log(`Solution Studio: http://${host}:${port}`);}
catch {console.error('Server startup failed. Check PORT, DATABASE_URL and DATA_DIR.');await app.close();process.exitCode=1;}
for(const signal of ['SIGINT','SIGTERM'] as const) process.on(signal,async()=>{await app.close();process.exit(0);});
