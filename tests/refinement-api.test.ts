import {afterAll,beforeAll,describe,expect,it} from 'vitest';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {createApp} from '../apps/server/src/app.js';
describe('Refinement HTTP scope and review workflow',()=>{
 let app:Awaited<ReturnType<typeof createApp>>,directory:string;
 const docs:string[]=[];
 beforeAll(async()=>{
  directory=await mkdtemp(join(tmpdir(),'studio-refinement-api-'));
  app=await createApp({dataDir:directory,providerFactory:()=>({generate:async()=>({content:JSON.stringify({canonical_title:{value:'机器人平台相机安装方案',confidence:0.95,evidence:['机器人平台相机安装方案']},summary:{value:'机器人平台相机安装方案，说明相机与网络同步。',confidence:0.9,evidence:['机器人平台相机安装方案']}}),usage:{inputTokens:100,outputTokens:80}})})});
  await (app as any).knowledge.settings.patch({llm:{apiKey:'synthetic-no-network-key'}});
  for(let i=0;i<3;i++){
   const buffer=Buffer.from(`# 概述\n机器人平台相机安装方案，说明相机与网络同步。场景${i}`);
   const result=await(app as any).knowledge.upload({buffer,contentHash:createHash('sha256').update(buffer).digest('hex'),meta:{sourceId:'manual',sourceType:'manual',filename:`机器人方案${i}.md`}},{duplicate:'skip'});docs.push(result.documentId);
  }
  for(let i=0;i<200;i++){if((await app.inject('/api/stats')).json().processing===0)break;await new Promise(r=>setTimeout(r,30));}
 },30000);
 afterAll(async()=>{await app?.close();await rm(directory,{recursive:true,force:true});});
 async function done(id:string){for(let i=0;i<150;i++){const response=await app.inject(`/api/refinement/batches/${id}`);const data=response.json();if(!['queued','running'].includes(data.batch.status))return data;await new Promise(r=>setTimeout(r,30));}throw Error('Batch did not finish');}
 it('snapshots a filtered document selection and creates proposals without changing metadata',async()=>{
  const old=(await app.inject(`/api/documents/${docs[1]}`)).json().document;
  const created=await app.inject({method:'POST',url:'/api/refinement/batches',payload:{selection:{mode:'filtered',filters:{q:'机器人方案1'}},operations:['title','summary'],budgetCny:2}});
  expect(created.statusCode).toBe(202);expect(created.json().batch.documentIds).toEqual([docs[1]]);
  const detail=await done(created.json().batch.id);expect(detail.batch.status).toBe('completed');expect(detail.proposals.map((p:any)=>p.field).sort()).toEqual(['summary','title']);
  expect((await app.inject(`/api/documents/${docs[1]}`)).json().document).toEqual(old);
  const accepted=await app.inject({method:'POST',url:`/api/refinement/batches/${detail.batch.id}/apply`,payload:{fields:['title']}});
  expect(accepted.statusCode).toBe(200);expect(accepted.json().applied).toBe(1);
  const changed=(await app.inject(`/api/documents/${docs[1]}`)).json().document;expect(changed.title).toBe('机器人平台相机安装方案');expect(changed.summary).toBe(old.summary);
  expect((await app.inject({method:'POST',url:`/api/refinement/batches/${detail.batch.id}/rollback`,payload:{}})).statusCode).toBe(200);
  expect((await app.inject(`/api/documents/${docs[1]}`)).json().document.title).toBe(old.title);
 },20000);
 it('requires valid explicit scope and supports groups as filters without changing the type registry',async()=>{
  expect((await app.inject({method:'POST',url:'/api/refinement/batches',payload:{operations:['title'],budgetCny:2}})).statusCode).toBe(400);
  expect((await app.inject({method:'POST',url:'/api/refinement/batches',payload:{documentIds:docs,selection:{mode:'all'},operations:['title'],budgetCny:2}})).statusCode).toBe(400);
  const registry=(await app.inject('/api/registries')).json();
  const group=await app.inject({method:'POST',url:'/api/groups',payload:{name:'机器人验证分组',selection:{mode:'filtered',filters:{q:'机器人方案1'}}}});
  expect(group.statusCode).toBe(200);expect(group.json().documentCount).toBe(1);
  const matches=(await app.inject(`/api/documents?group=${group.json().id}`)).json();expect(matches.total).toBe(1);expect(matches.items[0].id).toBe(docs[1]);
  expect((await app.inject('/api/registries')).json()).toEqual(registry);
  const corpus=(await app.inject('/api/corpus/proposals')).json();expect(corpus.items).toEqual([]);expect(corpus.analyses).toEqual([]);
 });
});
