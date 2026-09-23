import {afterAll,beforeAll,describe,expect,test,vi} from 'vitest';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createApp} from '../apps/server/src/app.js';
import type {DocumentEngine} from '../packages/document-engine/src/service.js';
import type {ProjectService} from '../packages/projects/src/service.js';
import type {GeneratedDocument} from '../packages/document-engine/src/types.js';

describe('two-document generation scheduling and graceful recovery',()=>{
 let directory:string,app:Awaited<ReturnType<typeof createApp>>,engine:DocumentEngine,projects:ProjectService;
 let active=0,peak=0,passAll=false,failTitle='';
 const started:string[]=[],pending:{title:string;release:()=>void}[]=[],perDocument=new Map<string,number>(),peaks=new Map<string,number>(),passing=new Set<string>();
 beforeAll(async()=>{
  directory=await mkdtemp(join(tmpdir(),'studio-doc-concurrency-'));
  app=await createApp({dataDir:directory,providerFactory:()=>({generate:async request=>{
   const title=JSON.parse(request.prompt).sectionTitle as string,key=title.split(' · ')[0];started.push(title);active++;peak=Math.max(peak,active);perDocument.set(key,(perDocument.get(key)??0)+1);peaks.set(key,Math.max(peaks.get(key)??0,perDocument.get(key)!));
   try{if(!passAll&&!passing.has(key))await new Promise<void>(release=>pending.push({title,release}));if(title===failTitle)throw Error('synthetic provider failure');return {content:JSON.stringify({content:[{type:'paragraph',text:`${key}的采集与数据处理流程。`}],used_fact_ids:[],used_knowledge_refs:[],used_asset_refs:[],claims:[]}),usage:{inputTokens:100,outputTokens:40}};}
   finally{active--;perDocument.set(key,perDocument.get(key)!-1);}
  }})});engine=(app as any).documentEngine;projects=(app as any).projects;
  await (app as any).knowledge.settings.patch({llm:{apiKey:'synthetic-test-key',baseUrl:'https://api.moonshot.cn/v1',model:'kimi-k3'}});
 },30000);
 afterAll(async()=>{releaseAll();await app?.close();await rm(directory,{recursive:true,force:true});},30000);
 const pause=(ms:number)=>new Promise(resolve=>setTimeout(resolve,ms));
 async function until(check:()=>boolean|Promise<boolean>){for(let i=0;i<400;i++){if(await check())return;await pause(10);}throw Error('Timed out waiting for controlled generation state');}
 function reset(){active=0;peak=0;passAll=false;failTitle='';started.length=0;pending.length=0;perDocument.clear();peaks.clear();passing.clear();}
 function release(key:string){passing.add(key);for(const entry of pending.filter(p=>p.title.startsWith(key+' · ')))entry.release();}
 function releaseAll(){passAll=true;for(const entry of pending)entry.release();}
 async function project(){const p=await projects.create({name:'并行方案测试项目',description:'建设目标：组织运动数据采集与分析。'});await projects.confirmContext(p.id,(await projects.getContext(p.id)).revision);return p;}
 async function document(projectId:string,key:string,count=4){const doc=await engine.create(projectId);return engine.plan(doc.id,{revision:doc.revision,sections:Array.from({length:count},(_,index)=>({title:`${key} · ${index+1}`,level:1}))});}
 async function enqueue(doc:GeneratedDocument){return engine.generate(doc.id,{expectedRevision:doc.revision,sectionIds:doc.sections.map(s=>s.id),config:{model:'kimi-k3',reasoningEffort:'max',limitsEnabled:false}});}
 async function job(doc:GeneratedDocument){return (await engine.jobs(doc.id))[0];}
 async function terminal(doc:GeneratedDocument){await until(async()=>!['queued','running'].includes((await job(doc)).status));}

 test('runs at most two documents and three chapters each, retaining document isolation and shared project status',async()=>{
  reset();const p=await project(),a=await document(p.id,'甲方案'),b=await document(p.id,'乙方案'),c=await document((await project()).id,'丙方案');
  try{
   await enqueue(a);await until(()=>started.length===3);await enqueue(b);await until(()=>started.length===6);await enqueue(c);
   expect(active).toBe(6);expect(peak).toBe(6);expect((await job(c)).status).toBe('queued');
   await expect(enqueue(a)).rejects.toMatchObject({statusCode:409});
   await expect(engine.edit(a.id,a.sections[0].id,{revision:a.sections[0].revision,blocks:[]})).rejects.toMatchObject({statusCode:409});
   release('甲方案');await terminal(a);await until(()=>started.some(t=>t.startsWith('丙方案')));
   expect((await projects.get(p.id)).status).toBe('generating');expect((await job(b)).status).toBe('running');expect(peak).toBe(6);
  }finally{releaseAll();}
  await Promise.all([terminal(a),terminal(b),terminal(c)]);
  for(const [key,doc] of [['甲方案',a],['乙方案',b],['丙方案',c]] as const){expect(peaks.get(key)).toBe(3);expect((await job(doc))).toMatchObject({status:'completed',processed:4,inputTokens:400,outputTokens:160});const result=await engine.get(doc.id);expect(result.sections.every(s=>s.blocks.some(block=>block.type==='paragraph'&&block.text===`${key}的采集与数据处理流程。`))).toBe(true);}
  await until(async()=>(await projects.get(p.id)).status==='generated');expect(peak).toBe(6);
 },20000);

 test('close waits for every in-flight chapter, preserves responses, and leaves queued documents for restart',async()=>{
  reset();const p=await project(),a=await document(p.id,'停机甲'),b=await document(p.id,'停机乙'),c=await document(p.id,'停机丙',1);let closing:Promise<void>|undefined;
  try{
   await enqueue(a);await until(()=>started.length===3);await enqueue(b);await until(()=>started.length===6);await enqueue(c);
   let closed=false;closing=engine.close().then(()=>{closed=true;});await pause(25);expect(closed).toBe(false);
   pending[0].release();await until(()=>active===5);expect(closed).toBe(false);expect(started).toHaveLength(6);
   releaseAll();await closing;
   for(const doc of [a,b]){expect(await job(doc)).toMatchObject({status:'interrupted',processed:3});expect((await engine.get(doc.id)).sections.filter(s=>s.blocks.length)).toHaveLength(3);expect((await job(doc)).reservedCny).toBeGreaterThan(0);}
   expect((await job(c)).status).toBe('queued');expect(started).toHaveLength(6);
  }finally{releaseAll();await closing;await engine.start();}
  await terminal(c);expect(started.filter(t=>t.startsWith('停机丙'))).toHaveLength(1);expect(started.filter(t=>t.startsWith('停机甲'))).toHaveLength(3);expect(started.filter(t=>t.startsWith('停机乙'))).toHaveLength(3);
 },20000);

 test('a chapter persistence-error path cannot release its document slot while sibling responses are pending',async()=>{
  reset();const p=await project(),a=await document(p.id,'异常甲',3),b=await document(p.id,'异常乙',3),c=await document(p.id,'异常丙',3);let closing:Promise<void>|undefined;const query=engine.db.query.bind(engine.db);let injected=false;
  const spy=vi.spyOn(engine.db,'query').mockImplementation((async(sql:string,values?:unknown[])=>{if(!injected&&sql.startsWith("UPDATE document_sections SET status='failed',error=$2")&&values?.[0]===a.sections[0].id){injected=true;throw Error('synthetic error persistence failure');}return query(sql,values);}) as typeof engine.db.query);
  try{
   failTitle=a.sections[0].title;await enqueue(a);await until(()=>started.length===3);await enqueue(b);await until(()=>started.length===6);await enqueue(c);
   pending.find(entry=>entry.title===failTitle)!.release();await until(()=>injected);await pause(80);
   expect((await job(a)).status).toBe('running');expect((await job(c)).status).toBe('queued');expect(started).toHaveLength(6);expect(active).toBe(5);
   let closed=false;closing=engine.close().then(()=>{closed=true;});await pause(25);expect(closed).toBe(false);
   spy.mockRestore();releaseAll();await closing;
   expect((await job(a)).status).toBe('failed');expect((await engine.get(a.id)).sections.filter(s=>s.blocks.length)).toHaveLength(2);
   expect((await job(b)).status).toBe('interrupted');expect((await job(c)).status).toBe('queued');expect(peak).toBe(6);
  }finally{spy.mockRestore();releaseAll();await closing;await engine.start();}
  await terminal(c);expect(started.filter(t=>t.startsWith('异常丙'))).toHaveLength(3);expect(peak).toBe(6);
 },20000);

 test('keeps the document locked through validation and makes the next batch safe immediately after completion',async()=>{
  reset();const doc=await document((await project()).id,'连续生成',3),validate=engine.validate.bind(engine);let entered=false,unblock:()=>void=()=>{};
  const barrier=new Promise<void>(resolve=>{unblock=resolve;});
  const spy=vi.spyOn(engine,'validate').mockImplementation(async id=>{if(id===doc.id&&!entered){entered=true;await barrier;}return validate(id);});
  try{
   releaseAll();await enqueue(doc);await until(()=>entered);
   expect((await job(doc)).status).toBe('running');const current=await engine.get(doc.id);
   await expect(enqueue(current)).rejects.toMatchObject({statusCode:409});
   await expect(engine.edit(current.id,current.sections[0].id,{revision:current.sections[0].revision,blocks:[]})).rejects.toMatchObject({statusCode:409});
   unblock();await terminal(doc);const fresh=await engine.get(doc.id);await enqueue(fresh);await terminal(doc);
   expect(started).toHaveLength(6);expect((await job(doc))).toMatchObject({status:'completed',processed:3,failed:0});
   expect((await engine.get(doc.id)).sections.every(section=>['generated','validated'].includes(section.status)&&section.blocks.length>0)).toBe(true);
  }finally{unblock();spy.mockRestore();releaseAll();}
 },20000);
});
