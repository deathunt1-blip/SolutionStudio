import {afterAll,beforeAll,describe,expect,it,vi} from 'vitest';
import {createHash} from 'node:crypto';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve,sep} from 'node:path';
import {createApp} from '../apps/server/src/app.js';
import type {KnowledgeService} from '../packages/knowledge/src/service.js';
import type {DeduplicationService} from '../packages/deduplication/src/service.js';
import type {SourceFile} from '../packages/core/src/types.js';

describe('Canonical ingestion, source changes and retrieval',()=>{
 let app:Awaited<ReturnType<typeof createApp>>,directory:string,knowledge:KnowledgeService,dedup:DeduplicationService;
 const generate=vi.fn(async()=>({content:'{}'}));
 const file=(text:string,name='机器人部署说明.md',source='manual',origin=name):SourceFile=>({buffer:Buffer.from(text),contentHash:createHash('sha256').update(text).digest('hex'),meta:{sourceId:source,sourceType:source==='manual'?'manual':'feishu_wiki',filename:name,sourcePath:origin,sourceUri:source==='manual'?undefined:'https://example.feishu.cn/file/'+origin,version:'v1'}});
 beforeAll(async()=>{
  directory=await mkdtemp(join(tmpdir(),'studio-dedup-ingestion-'));
  app=await createApp({dataDir:directory,providerFactory:()=>({generate})});knowledge=(app as any).knowledge;dedup=(app as any).duplicates;
  await knowledge.settings.patch({llm:{apiKey:'test-only-dedup-key'}});
  await knowledge.db.query("INSERT INTO knowledge_sources(id,organization_id,workspace_id,type,name,mode,source_of_truth) VALUES('remote-dedup','default','default','feishu_wiki','Test remote','mirror','remote')");
 },30000);
 afterAll(async()=>{await app?.close();if(directory){if(!resolve(directory).startsWith(resolve(tmpdir())+sep+'studio-dedup-ingestion-'))throw Error('Unsafe cleanup target');await rm(directory,{recursive:true,force:true});}},30000);
 async function done(id:string){for(let i=0;i<300;i++){const d=(await app.inject('/api/documents/'+id)).json();if(['active','needs_review','failed'].includes(d.document?.status))return d;await new Promise(r=>setTimeout(r,30));}throw Error('Ingestion timeout');}
 async function counts(id:string){return (await knowledge.db.query(`SELECT (SELECT count(*)::int FROM documents WHERE id=$1) AS documents,
  (SELECT count(*)::int FROM document_versions WHERE document_id=$1) AS versions,
  (SELECT count(*)::int FROM ingestion_jobs WHERE document_id=$1) AS jobs,
  (SELECT count(*)::int FROM knowledge_chunks WHERE document_id=$1) AS chunks`,[id]))[0];}
 it('links exact cross-source copies without parsing/classification, retains names and original downloads',async()=>{
  const text='# 跨来源相机说明\n\n这是同一份光学相机与网络同步资料，用于验证跨来源精确去重。';
  const first=await knowledge.upload(file(text,'原说明.md'),{duplicate:'skip'});await done(first.documentId);
  const before=await counts(first.documentId),calls=generate.mock.calls.length;
  const duplicate=await knowledge.upload(file(text,'飞书另一个名称.md','remote-dedup','resource-cross'),{duplicate:'skip',sourceId:'remote-dedup',sourceDocumentId:'resource-cross'});
  expect(duplicate.status).toBe('duplicate');expect(duplicate.documentId).toBe(first.documentId);expect(await counts(first.documentId)).toEqual(before);expect(generate.mock.calls.length).toBe(calls);
  const references=(await app.inject(`/api/documents/${first.documentId}/sources`)).json();expect(references.items.filter((r:any)=>!r.removed)).toHaveLength(2);
  const remote=references.items.find((r:any)=>r.sourceId==='remote-dedup');expect(remote.filename).toBe('飞书另一个名称.md');
  const download=await app.inject(`/api/documents/${first.documentId}/sources/${remote.id}/original`);expect(download.body).toBe(text);
  expect((await app.inject('/api/documents?source=remote-dedup')).json().items.some((d:any)=>d.id===first.documentId)).toBe(true);
  await knowledge.refreshSource('remote-dedup','resource-cross',first.documentId,'v2',null,'https://example.feishu.cn/file/renamed');
  expect((await app.inject(`/api/documents/${first.documentId}`)).json().document.remoteVersion).toBe('v1');
  await knowledge.detachSource('remote-dedup','resource-cross',first.documentId);
  expect((await app.inject(`/api/documents/${first.documentId}`)).json().document.status).not.toBe('archived');
  const restored=await knowledge.upload(file(text,'飞书另一个名称.md','remote-dedup','resource-cross'),{duplicate:'skip',sourceId:'remote-dedup',sourceDocumentId:'resource-cross',documentId:first.documentId});
  expect(restored).toMatchObject({status:'duplicate',documentId:first.documentId});expect(await counts(first.documentId)).toEqual(before);expect(generate.mock.calls.length).toBe(calls);
 });
 it('forks a changed remote origin without replacing the manual canonical or its human confirmations',async()=>{
  const text='# 共享来源原版\n\n相机网络参数是 120 帧，保留人工确认的资料。';
  const first=await knowledge.upload(file(text,'共享原版.md'),{duplicate:'skip'});await done(first.documentId);
  await knowledge.edit(first.documentId,{documentType:'manual',authority:'authoritative',title:'已确认的人工原版'});
  const before=(await app.inject('/api/documents/'+first.documentId)).json().document;
  await knowledge.upload(file(text,'远端原版.md','remote-dedup','fork-origin'),{duplicate:'skip',sourceId:'remote-dedup',sourceDocumentId:'fork-origin'});
  const changed=await knowledge.upload(file(text+'\n远端新增配置：升级为 240 帧。','远端新版.md','remote-dedup','fork-origin'),{duplicate:'skip',sourceId:'remote-dedup',sourceDocumentId:'fork-origin',documentId:first.documentId});
  expect(changed.documentId).not.toBe(first.documentId);await done(changed.documentId);
  const original=(await app.inject('/api/documents/'+first.documentId)).json().document;
  expect(original.title).toBe(before.title);expect(original.activeVersionId).toBe(before.activeVersionId);expect(original.classification).toEqual(before.classification);
  await knowledge.detachSource('remote-dedup','fork-origin',changed.documentId);
  expect((await app.inject('/api/documents/'+changed.documentId)).json().document.status).toBe('archived');
  expect((await app.inject('/api/documents/'+first.documentId)).json().document.status).toBe('active');
 });
 it('does not treat an obsolete historical hash as a match for different current content',async()=>{
  const first=await knowledge.upload(file('# 历史匹配\n\n旧版内容与当前版本不同。','历史.md'),{duplicate:'skip'});await done(first.documentId);
  await knowledge.upload(file('# 历史匹配\n\n新版内容已经变更。','历史.md'),{duplicate:'skip',documentId:first.documentId});await done(first.documentId);
  const oldAgain=await knowledge.upload(file('# 历史匹配\n\n旧版内容与当前版本不同。','独立旧版.md'),{duplicate:'skip'});
  expect(oldAgain.documentId).not.toBe(first.documentId);await done(oldAgain.documentId);
 });
 it('protects merged child sources from canonical remote edits, and archives only after the last source disappears',async()=>{
  const text='# 合并组来源保护\n\n网络同步与相机标定的操作说明，保留两个真实来源。';
  const a=await knowledge.upload(file(text,'主来源.md','remote-dedup','merged-root'),{duplicate:'skip',sourceId:'remote-dedup',sourceDocumentId:'merged-root'});await done(a.documentId);
  const b=await knowledge.upload(file(text,'旧副本.md','local-import','merged-child'),{duplicate:'keep',sourceId:'local-import'});await done(b.documentId);
  await dedup.scan({documentIds:[a.documentId,b.documentId]});const group=(await dedup.list({documentId:a.documentId})).items.find((g:any)=>g.members.some((m:any)=>m.documentId===b.documentId))!;
  await dedup.merge(group.id,a.documentId);
  const changed=await knowledge.upload(file(text+'\n新版增加了一个接口。','主来源新版.md','remote-dedup','merged-root'),{duplicate:'skip',sourceId:'remote-dedup',sourceDocumentId:'merged-root',documentId:a.documentId});
  expect(changed.documentId).not.toBe(a.documentId);await done(changed.documentId);
  const original=(await app.inject('/api/documents/'+a.documentId)).json();expect(original.versions).toHaveLength(1);expect(original.document.status).not.toBe('archived');
  expect((await app.inject('/api/documents/'+a.documentId+'/original')).body).toBe(text);
  await knowledge.detachSource('local-import','merged-child',b.documentId);
  expect((await app.inject('/api/documents/'+a.documentId)).json().document.status).toBe('archived');
  expect((await app.inject('/api/documents/'+b.documentId)).json().document.status).toBe('archived');
  expect((await app.inject('/api/documents/'+changed.documentId)).json().document.status).not.toBe('archived');
 });
 it('does not let an in-flight classification reactivate a source already moved to another canonical',async()=>{
  const targetText='# 已有迁移目标\n\n完整相机安装资料，为重复来源迁移提供目标。';
  const target=await knowledge.upload(file(targetText,'已有迁移目标.md'),{duplicate:'skip'});await done(target.documentId);
  let release!:()=>void;let entered!:()=>void;const waiting=new Promise<void>(resolve=>{entered=resolve;});
  generate.mockImplementationOnce(async()=>{entered();await new Promise<void>(resolve=>{release=resolve;});return {content:'{}'};});
  const pending=await knowledge.upload(file('# 迁移前旧内容\n\n正在调用分类服务的另一份来源文件。','迁移前.md','remote-dedup','inflight'),{duplicate:'skip',sourceId:'remote-dedup',sourceDocumentId:'inflight'});
  await waiting;
  const relinked=await knowledge.upload(file(targetText,'迁移后.md','remote-dedup','inflight'),{duplicate:'skip',sourceId:'remote-dedup',sourceDocumentId:'inflight',documentId:pending.documentId});
  release();expect(relinked.documentId).toBe(target.documentId);
  for(let i=0;i<200;i++){const jobs=await knowledge.db.query('SELECT status FROM ingestion_jobs WHERE document_id=$1',[pending.documentId]);if(jobs.every(j=>j.status==='completed'))break;await new Promise(r=>setTimeout(r,20));}
  expect((await app.inject('/api/documents/'+pending.documentId)).json().document.status).toBe('superseded');
 });
 it('serializes simultaneous identical uploads into one job and keeps both references',async()=>{
  const text='# 并发完全相同\n\n这份资料只允许一次解析与一次分类调用。';
  const [a,b]=await Promise.all([knowledge.upload(file(text,'并发A.md'),{duplicate:'skip'}),knowledge.upload(file(text,'并发B.md'),{duplicate:'skip'})]);
  expect(a.documentId).toBe(b.documentId);await done(a.documentId);expect((await counts(a.documentId)).jobs).toBe(1);
  expect((await dedup.sourceReferences(a.documentId)).items).toHaveLength(2);
 });
 it('reuses an approved canonical when the exact bytes belong to its normalized duplicate member',async()=>{
  const text='# 归一化产品说明\n\n相机支持网络同步 calibration operation，并保存所有来源原始文件。';
  const variant=text.replace('calibration operation','calibration   operation');
  const a=await knowledge.upload(file(text,'归一化产品说明.md','manual','normalize/a'),{duplicate:'keep'});await done(a.documentId);
  const b=await knowledge.upload(file(variant,'归一化产品说明.md','manual','normalize/b'),{duplicate:'keep'});await done(b.documentId);
  await dedup.scan({documentIds:[a.documentId,b.documentId]});const group=(await dedup.list({documentId:a.documentId})).items.find((g:any)=>g.relation==='content_duplicate'&&g.members.some((m:any)=>m.documentId===b.documentId))!;
  expect(group).toBeTruthy();await dedup.merge(group.id,a.documentId);const calls=generate.mock.calls.length;
  const repeat=await knowledge.upload(file(variant,'另一个相同副本.md','local-import','normalize/c'),{duplicate:'skip',sourceId:'local-import'});
  expect(repeat).toMatchObject({status:'duplicate',documentId:a.documentId});expect(generate.mock.calls.length).toBe(calls);
  expect((await dedup.sourceReferences(a.documentId)).items).toHaveLength(3);
 });
 it('deduplicates suggested groups before pagination and restores independent retrieval after dismissal',async()=>{
  const text='# 检索去重独有词\n\n检索去重独有词 光学相机标定资料，内容完全一致。';
  const a=await knowledge.upload(file(text,'检索A.md'),{duplicate:'keep'});await done(a.documentId);
  const b=await knowledge.upload(file(text,'检索B.md'),{duplicate:'keep'});await done(b.documentId);
  await knowledge.edit(a.documentId,{documentType:'manual',authority:'reference'});await knowledge.edit(b.documentId,{documentType:'manual',authority:'reference'});
  await dedup.scan({documentIds:[a.documentId,b.documentId]});
  const groups=await dedup.list({documentId:a.documentId});const group=groups.items.find((g:any)=>g.members.some((m:any)=>m.documentId===b.documentId));expect(group).toBeTruthy();
  const url='/api/search?q='+encodeURIComponent('检索去重独有词')+'&pageSize=1';
  const first=(await app.inject(url)).json();expect(first.total).toBe(1);expect(first.items).toHaveLength(1);expect((await app.inject(url+'&page=2')).json().items).toHaveLength(0);
  await dedup.dismiss(group!.id);const independent=(await app.inject(url)).json();expect(independent.total).toBe(2);
  const other=(await app.inject(url+'&page=2')).json();expect(other.items).toHaveLength(1);expect(other.items[0].document.id).not.toBe(independent.items[0].document.id);
 });
});
