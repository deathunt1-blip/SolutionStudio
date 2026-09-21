import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createApp } from '../apps/server/src/app.js';

describe('Knowledge lifecycle with real PostgreSQL engine and local originals',()=>{
 let app:Awaited<ReturnType<typeof createApp>>;let directory:string;
 beforeAll(async()=>{directory=await mkdtemp(path.join(tmpdir(),'solution-studio-backend-'));app=await createApp({dataDir:directory,llmDisabled:true});},30000);
 afterAll(async()=>{await app?.close();await rm(directory,{recursive:true,force:true});},30000);
 async function upload(name:string,text:string,extra:Record<string,string>={},duplicate='skip') {
  const form=new FormData();for(const[k,v]of Object.entries(extra))form.set(k,v);form.append('files',new Blob([text]),name);
  const req=new Request('http://localhost/api/upload',{method:'POST',body:form});
  const response=await app.inject({method:'POST',url:`/api/upload?duplicate=${duplicate}`,headers:{'content-type':req.headers.get('content-type')!},payload:Buffer.from(await req.arrayBuffer())});
  expect(response.statusCode).toBe(202);return response.json().results[0];
 }
 async function done(id:string){for(let i=0;i<150;i++){const r=await app.inject(`/api/documents/${id}`);const body=r.json();if(['active','needs_review','failed'].includes(body.document?.status))return body;await new Promise(resolve=>setTimeout(resolve,50));}throw new Error('Job did not finish');}
 test('upload, confirmation feedback, Chinese retrieval, version history, rebuild and archive',async()=>{
  const original='# 未命名资料\n\n机器人项目的相机部署需要使用 K18 相机进行标定。\n\n部署现场需要网络同步。';
  const first=await upload('notes.md',original);expect(first.status).toBe('queued');
  let detail=await done(first.documentId);expect(detail.document.status).toBe('needs_review');expect(detail.chunks.length).toBeGreaterThan(0);
  const duplicate=await upload('same.md',original);expect(duplicate.status).toBe('duplicate');expect(duplicate.documentId).toBe(first.documentId);
  const malformed=await app.inject({method:'PATCH',url:`/api/documents/${first.documentId}`,payload:{authority:['reference']}});expect(malformed.statusCode).toBe(400);
  const edit=await app.inject({method:'PATCH',url:`/api/documents/${first.documentId}`,payload:{title:'机器人相机部署',documentType:'solution',authority:'reference',topics:['部署','camera','PTP'],applications:['robotics'],products:['K18']}});
  expect(edit.statusCode).toBe(200);expect(edit.json().document.status).toBe('active');expect(edit.json().document.classification.authority.source).toBe('user');
  expect(edit.json().document.classification.topics.value).toEqual(['deployment','camera','synchronization']);
  const search=await app.inject('/api/search?q='+encodeURIComponent('机器人 相机 K18'));expect(search.statusCode).toBe(200);expect(search.json().items[0].document.id).toBe(first.documentId);
  const stats=(await app.inject('/api/stats')).json();expect(stats.confirmedExamples).toBe(1);
  const originalDownload=await app.inject(`/api/documents/${first.documentId}/original`);expect(originalDownload.body).toBe(original);
  await (app as any).knowledge.db.query("INSERT INTO classification_results(version_id,field,value,confidence,source) VALUES($1,'documentDate','\"2000-01-01\"',0.9,'ai')",[detail.document.activeVersionId]);
  const rebuilt=await app.inject({method:'POST',url:`/api/documents/${first.documentId}/rebuild`});expect(rebuilt.statusCode).toBe(200);
  detail=await done(first.documentId);expect(detail.document.title).toBe('机器人相机部署');expect(detail.document.classification.documentType.source).toBe('user');
  expect(detail.document.classification.documentDate).toBeUndefined();
  const update=await upload('notes.md',original+'\n新增版本：相机需要重新安装。');expect(update.documentId).toBe(first.documentId);
  detail=await done(first.documentId);expect(detail.versions).toHaveLength(2);expect(detail.versions[1].status).toBe('superseded');expect(detail.document.classification.authority.source).not.toBe('user');
  const old=await app.inject(`/api/documents/${first.documentId}/original?versionId=${detail.versions[1].id}`);expect(old.body).toBe(original);
  await app.inject({method:'POST',url:`/api/documents/${first.documentId}/archive`});
  expect((await app.inject('/api/search?q=K18')).json().total).toBe(0);
  expect((await app.inject(`/api/documents/${first.documentId}/original`)).statusCode).toBe(200);
 },30000);
 test('secrets stay private; source and scope boundaries and invalid settings are enforced',async()=>{
  const denied=await app.inject({method:'PATCH',url:'/api/settings',headers:{origin:'https://evil.example'},payload:{reviewThreshold:0.1}});expect(denied.statusCode).toBe(403);
  const invalid=await app.inject({method:'PATCH',url:'/api/settings',payload:{reviewThreshold:0.95}});expect(invalid.statusCode).toBe(400);
  const key='test-only-private-credential';const changed=await app.inject({method:'PATCH',url:'/api/settings',payload:{llm:{apiKey:key}}});expect(changed.statusCode).toBe(200);expect(changed.body).not.toContain(key);
  const svc=(app as any).knowledge;const stored=await svc.db.query('SELECT value FROM settings');expect(JSON.stringify(stored)).not.toContain(key);
  const item=await upload('技术方案.md','# 技术方案\n机器人相机部署项目，型号 K18。',{sourceId:'local-import',sourcePath:'project/技术方案.md'});await done(item.documentId);
  expect((await app.inject('/api/documents?source=local-import')).json().total).toBe(1);
  await svc.db.query("UPDATE documents SET scope='project',project_id='private-project' WHERE id=$1",[item.documentId]);
  expect((await app.inject(`/api/documents/${item.documentId}`)).statusCode).toBe(404);
  expect((await app.inject(`/api/documents/${item.documentId}/original`)).statusCode).toBe(404);
  expect((await app.inject('/api/search?q=K18')).json().total).toBe(0);
 });
 test('a running job is recovered from durable state after restart',async()=>{
  const service=(app as any).knowledge;
  service.stopping=true;
  const item=await upload('recovered.md','# 技术方案\n\n这是需要在重启后恢复入库的机器人同步方案。');
  await service.db.query("UPDATE ingestion_jobs SET status='running' WHERE document_id=$1",[item.documentId]);
  await app.close();
  app=await createApp({dataDir:directory,llmDisabled:true});
  const detail=await done(item.documentId);
  expect(detail.document.status).toBe('active');
  const jobs=(await app.inject('/api/jobs')).json().items;
  expect(jobs.find((job:any)=>job.documentId===item.documentId).status).toBe('completed');
 },30000);
});
