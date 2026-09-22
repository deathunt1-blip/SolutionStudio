import {afterAll,beforeAll,describe,expect,it} from 'vitest';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {createApp} from '../apps/server/src/app.js';
import type {KnowledgeService} from '../packages/knowledge/src/service.js';
describe('Canonical title provenance and existing user priorities',()=>{
 let app:Awaited<ReturnType<typeof createApp>>,directory:string,knowledge:KnowledgeService;
 beforeAll(async()=>{directory=await mkdtemp(join(tmpdir(),'studio-title-'));app=await createApp({dataDir:directory,llmDisabled:true});knowledge=(app as any).knowledge;},30000);
 afterAll(async()=>{await app?.close();await rm(directory,{recursive:true,force:true});});
 async function upload(filename:string,text:string,id?:string){const buffer=Buffer.from(text);const result=await knowledge.upload({buffer,contentHash:createHash('sha256').update(buffer).digest('hex'),meta:{filename,sourceId:'manual',sourceType:'manual'}},{duplicate:id?'keep':'skip',documentId:id});return result.documentId;}
 async function done(id:string){for(let i=0;i<200;i++){const data=(await app.inject(`/api/documents/${id}`)).json();if(['active','needs_review','failed'].includes(data.document.status))return data;await new Promise(r=>setTimeout(r,25));}throw new Error('Ingestion timed out');}
 it('keeps generic parsed headings separate, preserves filename bytes and uses the filename for canonical display',async()=>{
  const id=await upload('机器人控制平台建设方案(1)(1).md','# 概述\n\n机器人平台的技术方案包括网络同步与相机部署。');
  const {document}=await done(id);
  expect(document.title).toBe('机器人控制平台建设方案');expect(document.canonicalTitle).toBe(document.title);
  expect(document.parsedTitle).toBe('概述');expect(document.originalFilename).toBe('机器人控制平台建设方案(1)(1).md');
  expect(document.titleSource).toBe('filename');expect(document.extractiveSummary).toBeTruthy();expect(document.aiSummary).toBeNull();
 });
 it('rebuild retains AI metadata, manual title locks survive rebuild and a later version',async()=>{
  const id=await upload('资料.md','# 一、项目背景\n\n历史机器人技术方案，包含光学相机安装。');
  let detail=await done(id);
  await knowledge.db.query("UPDATE documents SET title='机器人部署规范标题',canonical_title='机器人部署规范标题',title_source='ai' WHERE id=$1",[id]);
  await knowledge.db.query("UPDATE document_versions SET ai_summary='机器人平台的部署说明。',summary_source='ai' WHERE id=$1",[detail.document.activeVersionId]);
  await knowledge.rebuild(id);detail=await done(id);expect(detail.document.title).toBe('机器人部署规范标题');expect(detail.document.summary).toBe('机器人平台的部署说明。');
  await knowledge.edit(id,{title:'人工确认的机器人安装资料'});
  await knowledge.db.query("UPDATE document_versions SET summary='人工确认的部署摘要。',ai_summary='人工确认的部署摘要。',summary_source='user' WHERE id=$1",[detail.document.activeVersionId]);
  await knowledge.rebuild(id);detail=await done(id);
  expect(detail.document.summary).toBe('人工确认的部署摘要。');expect(detail.document.summarySource).toBe('user');
  const stored=(await knowledge.db.query('SELECT summary,extractive_summary FROM document_versions WHERE id=$1',[detail.document.activeVersionId]))[0];
  expect(stored.summary).toBe('人工确认的部署摘要。');expect(stored.extractive_summary).toContain('历史机器人');
  expect(detail.document.titleSource).toBe('user');expect(detail.document.titleLocked).toBe(true);expect(detail.document.title).toBe('人工确认的机器人安装资料');
  const oldVersion=detail.document.activeVersionId;
  await upload('新版本资料.md','# 概述\n\n新的机器人技术方案，包含相机同步和定位。',id);detail=await done(id);
  expect(detail.document.title).toBe('人工确认的机器人安装资料');expect(detail.document.aiSummary).toBeNull();expect(detail.document.originalFilename).toBe('新版本资料.md');
  const old=(await app.inject(`/api/documents/${id}/original?versionId=${oldVersion}`)).body;expect(old).toContain('一、项目背景');
 },20000);
 it('metadata migrations are idempotent and preserve accepted values after restart',async()=>{
  const id=await upload('重启方案.md','# 概述\n\n机器人现场部署技术方案。');await done(id);await knowledge.edit(id,{title:'人工命名重启持久化测试'});
  await app.close();app=await createApp({dataDir:directory,llmDisabled:true});knowledge=(app as any).knowledge;
  const doc=(await app.inject(`/api/documents/${id}`)).json().document;expect(doc.canonicalTitle).toBe('人工命名重启持久化测试');expect(doc.titleSource).toBe('user');
  expect((await knowledge.db.query('SELECT version FROM schema_migrations ORDER BY version')).map(r=>r.version)).toEqual([1,2,3]);
 },20000);
});
