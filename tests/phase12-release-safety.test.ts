import {afterAll,beforeAll,describe,expect,test} from 'vitest';
import {randomUUID} from 'node:crypto';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createApp} from '../apps/server/src/app.js';
import type {DocumentEngine} from '../packages/document-engine/src/service.js';
import type {ProjectService} from '../packages/projects/src/service.js';
import type {KnowledgeService} from '../packages/knowledge/src/service.js';
import {createSceneLabFixture} from './helpers/scenelab.js';

describe('retired proposal pictures and interrupted generation recovery',()=>{
 let directory:string,app:Awaited<ReturnType<typeof createApp>>,projects:ProjectService,engine:DocumentEngine,knowledge:KnowledgeService,calls=0;
 beforeAll(async()=>{directory=await mkdtemp(join(tmpdir(),'studio-release-safety-'));app=await createApp({dataDir:directory,llmDisabled:true,providerFactory:()=>({generate:async()=>{calls++;throw Error('No model calls in release safety tests');}})});projects=(app as any).projects;engine=(app as any).documentEngine;knowledge=(app as any).knowledge;},30000);
 afterAll(async()=>{await app?.close();await rm(directory,{recursive:true,force:true});},30000);
 async function withReport(name:string){
  const project=await projects.create({name,description:'建设目标：完成机器人动作采集。'}),report=await projects.addInput(project.id,{filename:'original.scenelab-report',bytes:await createSceneLabFixture()});await projects.confirmContext(project.id,report.context.revision);
  const asset=(await projects.get(project.id)).assets[0];let doc=await engine.create(project.id);doc=await engine.edit(doc.id,doc.sections[0].id,{revision:doc.sections[0].revision,blocks:[{type:'paragraph',text:'系统按功能模块组织数据采集。'},{type:'asset',assetId:asset.id,caption:'工程示意图'}]});doc=await engine.patch(doc.id,{revision:doc.revision,outputProfile:{coverLogoAssetId:asset.id}});return {project,report,asset,doc};
 }
 test('deleting a report removes current engineering but preserves cited images for the old proposal only',async()=>{
  const {project,report,asset,doc}=await withReport('删除工程报告'),before=(await projects.downloadAsset(project.id,asset.id)).bytes,sourceRef=asset.sourceRef;
  const removed=await projects.removeInput(project.id,report.input.id);expect(removed.engineering).toBeUndefined();expect(removed.assets).toEqual([]);expect((await projects.get(project.id)).assets).toEqual([]);expect((await projects.get(project.id)).inputs).toEqual([]);
  const retained=(await projects.listAssets(project.id,true));expect(retained).toHaveLength(1);expect(retained[0]).toMatchObject({id:asset.id,inputId:null,sourceRef});expect(retained[0].retiredAt).toBeTruthy();expect((await projects.downloadAsset(project.id,asset.id)).bytes).toEqual(before);
  expect((await engine.get(doc.id)).contextStale).toBe(true);expect((await engine.validate(doc.id)).some(issue=>issue.type==='missing_source')).toBe(false);expect((await app.inject(`/api/generated-documents/${doc.id}/export.docx`)).statusCode).toBe(200);
  let old=await engine.get(doc.id);old=await engine.edit(old.id,old.sections[0].id,{revision:old.sections[0].revision,blocks:[{type:'paragraph',text:'保留原工程示意图。'},{type:'asset',assetId:asset.id,caption:'原工程示意图'}]});expect((await engine.patch(old.id,{revision:old.revision,title:'更新旧方案标题'})).outputProfile.coverLogoAssetId).toBe(asset.id);
  let copy=await engine.copy(doc.id);expect(copy.sections[0].blocks.some(block=>block.type==='asset'&&block.assetId===asset.id)).toBe(true);copy=await engine.edit(copy.id,copy.sections[0].id,{revision:copy.sections[0].revision,blocks:[{type:'paragraph',text:'副本保留已有插图。'},{type:'asset',assetId:asset.id,caption:'原工程示意图'}]});expect((await app.inject(`/api/generated-documents/${copy.id}/export.docx`)).statusCode).toBe(200);await expect(engine.edit(copy.id,copy.sections[1].id,{revision:copy.sections[1].revision,blocks:[{type:'asset',assetId:asset.id}]})).rejects.toMatchObject({statusCode:400});
  await projects.confirmContext(project.id,removed.revision);const next=await engine.create(project.id);await expect(engine.edit(next.id,next.sections[0].id,{revision:next.sections[0].revision,blocks:[{type:'asset',assetId:asset.id}]})).rejects.toMatchObject({statusCode:400});await expect(engine.patch(next.id,{revision:next.revision,outputProfile:{coverLogoAssetId:asset.id}})).rejects.toMatchObject({statusCode:400});
  const other=await projects.create({name:'隔离项目'});await expect(projects.downloadAsset(other.id,asset.id)).rejects.toMatchObject({statusCode:404});
 });
 test('successful report replacement retires referenced originals; whole-project deletion also clears retired objects',async()=>{
  const {project,report,asset,doc}=await withReport('替换工程报告');const replacement=await projects.replaceInput(project.id,report.input.id,{filename:'replacement.scenelab-report',bytes:await createSceneLabFixture(({project,analysis})=>{project.boundary_m=[15,12,5];analysis.settings.boundary_m=[15,12,5];})});
  expect(replacement.context.engineering?.scene?.boundaryM).toEqual([15,12,5]);expect((await projects.get(project.id)).assets).toHaveLength(6);expect((await projects.get(project.id)).assets.some(a=>a.id===asset.id)).toBe(false);expect((await projects.listAssets(project.id,true)).find(a=>a.id===asset.id)?.retiredAt).toBeTruthy();expect((await app.inject(`/api/generated-documents/${doc.id}/export.docx`)).statusCode).toBe(200);
  const keys=(await projects.listAssets(project.id,true)).map(a=>a.objectKey);await projects.remove(project.id);expect(await knowledge.db.query('SELECT id FROM project_assets WHERE project_id=$1',[project.id])).toEqual([]);for(const key of keys)await expect(knowledge.storage.get(key)).rejects.toMatchObject({code:'ENOENT'});
 });
 test('deleting an independent unreferenced upload removes its object instead of retiring it',async()=>{
  const project=await projects.create({name:'独立上传图'}),bytes=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGOQ0zD6DwACWAF41TTQUQAAAABJRU5ErkJggg==','base64'),asset=await projects.addAsset(project.id,{filename:'illustration.png',buffer:bytes});
  await projects.removeInput(project.id,asset.inputId!);expect(await projects.listAssets(project.id,true)).toEqual([]);await expect(knowledge.storage.get(asset.objectKey)).rejects.toMatchObject({code:'ENOENT'});
 });
 test('restart marks both started and not-yet-started sections retryable without replaying paid jobs',async()=>{
  const project=await projects.create({name:'恢复任务',description:'建设目标：动作采集。'});await projects.confirmContext(project.id,(await projects.getContext(project.id)).revision);let doc=await engine.create(project.id);doc=await engine.plan(doc.id,{revision:doc.revision,sections:[{title:'完成章',level:1},{title:'请求中',level:1},{title:'尚未请求',level:1}]});
  await engine.close();const jobId=randomUUID();await knowledge.db.query("UPDATE document_sections SET status=CASE WHEN id=$2 THEN 'generated' WHEN id=$3 THEN 'generating' ELSE 'queued' END WHERE document_id=$1",[doc.id,doc.sections[0].id,doc.sections[1].id]);await knowledge.db.query("INSERT INTO generation_jobs(id,document_id,status,section_ids,targets,config,reserved_cny) VALUES($1,$2,'running',$3::jsonb,'[]'::jsonb,'{}'::jsonb,2.5)",[jobId,doc.id,JSON.stringify(doc.sections.map(s=>s.id))]);await knowledge.db.query("UPDATE generated_documents SET status='generating' WHERE id=$1",[doc.id]);await knowledge.db.query("UPDATE projects SET status='generating' WHERE id=$1",[project.id]);const before=calls;
  await engine.start();const after=await engine.get(doc.id),job=(await engine.jobs(doc.id)).find(job=>job.id===jobId)!;expect(after.sections.map(s=>s.status)).toEqual(['generated','failed','failed']);expect(after.status).toBe('draft');expect((await projects.get(project.id)).status).toBe('context_ready');expect(job.status).toBe('interrupted');expect(Number(job.reservedCny)).toBe(2.5);expect(calls).toBe(before);
 });
});
