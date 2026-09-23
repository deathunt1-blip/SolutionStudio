import { afterAll, describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { acquireDatabaseLock } from '../packages/knowledge/src/database-lock.js';
import { openDatabase } from '../packages/knowledge/src/database.js';

describe('one PGlite process per data directory',()=>{
 const directories:string[]=[];
 async function directory(){const value=await mkdtemp(path.join(tmpdir(),'solution-db-lock-'));directories.push(value);return value;}
 afterAll(async()=>{for(const value of directories){if(!path.resolve(value).startsWith(path.join(tmpdir(),'solution-db-lock-')))throw new Error('Unexpected cleanup path');await rm(value,{recursive:true,force:true});}});
 it('rejects the same canonical directory and permits a different database',async()=>{
  const root=await directory();const other=await directory();await mkdir(path.join(root,'nested'));
  const release=await acquireDatabaseLock(root),releaseOther=await acquireDatabaseLock(other);
  try{await expect(acquireDatabaseLock(path.join(root,'nested','..'))).rejects.toThrow('already open');}finally{await release();await releaseOther();}
  const next=await acquireDatabaseLock(root);await next();await next();
 });
 it('releases the OS lock when its owning process exits abruptly',async()=>{
  const root=await directory();
  const child=spawn(process.execPath,['--import','tsx','--input-type=module','-e',"import{acquireDatabaseLock}from'./packages/knowledge/src/database-lock.ts';await acquireDatabaseLock(process.env.STUDIO_LOCK_TEST_DIR);process.send('ready');process.on('message',()=>{});"],{cwd:process.cwd(),env:{...process.env,STUDIO_LOCK_TEST_DIR:root},stdio:['ignore','pipe','pipe','ipc']});
  try {
   const ready=await Promise.race([once(child,'message').then(([message])=>message),once(child,'exit').then(()=>{throw new Error('Lock helper exited before ready');})]);expect(ready).toBe('ready');
   await expect(acquireDatabaseLock(root)).rejects.toThrow('already open');
   const stopped=once(child,'close');child.kill('SIGKILL');await stopped;
   const release=await acquireDatabaseLock(root);await release();
  } finally {if(child.exitCode===null&&child.signalCode===null)child.kill('SIGKILL');}
 },15000);
 it('blocks a second database before initialization and preserves the first connection',async()=>{
  const root=await directory(),first=await openDatabase(root);
  try{await expect(openDatabase(root)).rejects.toThrow('already open');expect((await first.query('SELECT 42 AS value'))[0].value).toBe(42);}finally{await first.close();}
  const reopened=await openDatabase(root);try{expect((await reopened.query('SELECT count(*)::int AS count FROM schema_migrations'))[0].count).toBe(11);}finally{await reopened.close();}
 },30000);
});
