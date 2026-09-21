import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../apps/server/src/app.js';
let app:Awaited<ReturnType<typeof createApp>>;
let directory:string;
async function upload(filename:string,text:string,fields:Record<string,string>={},keep=false) {
 const form=new FormData();for(const [key,value] of Object.entries(fields))form.append(key,value);form.append('files',new Blob([text]),filename);
 const request=new Request('http://localhost/api/upload',{method:'POST',body:form});
 const response=await app.inject({method:'POST',url:`/api/upload${keep?'?duplicate=keep':''}`,headers:{'content-type':request.headers.get('content-type')!},payload:Buffer.from(await request.arrayBuffer())});
 expect(response.statusCode).toBe(202);return response.json().results[0];
}
async function done(id:string) {
 for(let i=0;i<150;i++) {
  const response=await app.inject(`/api/documents/${id}`);expect(response.statusCode).toBe(200);
  const body=response.json();if(['active','needs_review','failed','archived'].includes(body.document.status))return body;
  await new Promise(resolve=>setTimeout(resolve,50));
 }
 throw new Error('Background job did not complete');
}
beforeAll(async()=>{directory=await mkdtemp(join(tmpdir(),'studio-workflow-'));app=await createApp({dataDir:directory,databaseUrl:'',llmDisabled:true});},30000);
afterAll(async()=>{await app?.close();if(directory)await rm(directory,{recursive:true,force:true});});
describe('knowledge ingestion and provenance workflow',()=>{
 it('reviews unknown, stores corrections/examples, indexes Chinese, deduplicates, versions and preserves originals',async()=>{
  const original='# 临时记录\n\n机器人现场相机部署涉及设备 QX72。这里记录采集过程。\n\n## 同步\nPTP 时间同步需要在网络配置中验证。';
  const queued=await upload('现场记录.md',original);expect(queued.status).toBe('queued');
  const first=await done(queued.documentId);expect(first.document.status).toBe('needs_review');
  expect(first.document.parseStatus).toBe('success');expect(first.chunks.length).toBeGreaterThan(0);
  expect((await app.inject('/api/search?q=机器人')).json().total).toBe(0);
  const edit=await app.inject({method:'PATCH',url:`/api/documents/${queued.documentId}`,payload:{documentType:'solution',authority:'reference',products:['QX72'],topics:['deployment','synchronization'],applications:['robotics']}});
  expect(edit.statusCode).toBe(200);expect(edit.json().document.status).toBe('active');
  expect(edit.json().document.classification.authority).toMatchObject({value:'reference',source:'user',confidence:1});
  const results=(await app.inject('/api/search?q='+encodeURIComponent('机器人 相机 部署')+'&product=QX72')).json();expect(results.total).toBeGreaterThan(0);
  expect(results.items[0].chunk.versionId).toBe(first.document.activeVersionId);
  expect((await app.inject('/api/stats')).json().confirmedExamples).toBe(1);
  const duplicate=await upload('重命名.md',original);expect(duplicate.status).toBe('duplicate');
  const independent=await upload('重命名.md',original,{},true);expect(independent.documentId).not.toBe(queued.documentId);await done(independent.documentId);
  const updated=await upload('现场记录.md',original+'\n\n新版增加标定流程。',{documentId:queued.documentId});
  expect(updated.documentId).toBe(queued.documentId);const second=await done(updated.documentId);
  expect(second.versions).toHaveLength(2);expect(second.document.status).toBe('needs_review');expect(second.document.classification.documentType.source).not.toBe('user');
  expect((await app.inject({method:'PATCH',url:`/api/documents/${queued.documentId}`,payload:{documentType:'solution',authority:'reference',products:['QX72']}})).statusCode).toBe(200);
  expect((await app.inject(`/api/documents/${queued.documentId}/original?versionId=${first.document.activeVersionId}`)).body).toBe(original);
  expect(second.audit.some((event:{action:string})=>event.action==='user_edit')).toBe(true);
  const beforeRebuild=second.document.activeVersionId;
  expect((await app.inject({method:'POST',url:`/api/documents/${queued.documentId}/rebuild`})).statusCode).toBe(200);
  const rebuilt=await done(queued.documentId);expect(rebuilt.document.activeVersionId).toBe(beforeRebuild);expect(rebuilt.document.classification.products.source).toBe('user');
  expect((await app.inject({method:'POST',url:`/api/documents/${queued.documentId}/archive`})).statusCode).toBe(200);
  expect((await app.inject('/api/search?product=QX72')).json().total).toBe(0);
  expect((await app.inject(`/api/documents/${queued.documentId}/original`)).statusCode).toBe(200);
 },30000);
 it('retains failed PDF originals and survives restart without a model key',async()=>{
  const failed=await upload('damaged.pdf','this is not a pdf');const record=await done(failed.documentId);
  expect(record.document.status).toBe('failed');expect(record.document.parseStatus).toBe('failed');
  expect((await app.inject(`/api/documents/${failed.documentId}/original`)).body).toBe('this is not a pdf');
  await app.close();app=await createApp({dataDir:directory,databaseUrl:'',llmDisabled:true});
  expect((await app.inject(`/api/documents/${failed.documentId}`)).json().document.status).toBe('failed');
  expect((await app.inject('/api/settings')).json().llm).not.toHaveProperty('apiKey');
 },30000);
 it('rejects cross-origin mutations and invalid thresholds, protects required registry values',async()=>{
  expect((await app.inject({method:'PATCH',url:'/api/settings',headers:{origin:'https://untrusted.example'},payload:{reviewThreshold:0.5}})).statusCode).toBe(403);
  expect((await app.inject({method:'PATCH',url:'/api/settings',payload:{reviewThreshold:0.95,autoAcceptThreshold:0.8}})).statusCode).toBe(400);
  expect((await app.inject({method:'DELETE',url:'/api/registries/documentTypes/unknown'})).statusCode).toBe(400);
  expect((await app.inject({method:'POST',url:'/api/registries/topics',payload:{key:'custom_topic',label:'自定义主题',aliases:['自定义同义词']}})).statusCode).toBe(200);
 });
});
