import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { openDatabase, type Database } from '../packages/knowledge/src/database.js';
import { KnowledgeService } from '../packages/knowledge/src/service.js';
import { getDocument, getRegistries, saveClassification } from '../packages/knowledge/src/repository.js';
import { RefinementService, REFINEMENT_CALL_RESERVATION_CNY } from '../packages/refinement/src/service.js';
import type { Classification, LLMProvider, ParsedDocument } from '../packages/core/src/types.js';
import type { RefinementEngine, RefinementSuggestion, CorpusSuggestion } from '../packages/refinement/src/types.js';

describe('durable refinement proposals and explicit application',()=>{
 let directory:string,db:Database,knowledge:KnowledgeService,service:RefinementService;
 let suggestions:RefinementSuggestion[]=[],corpus:CorpusSuggestion[]=[],calls=0,fail=false;
 const engine:RefinementEngine={refine:async()=>{calls++;if(fail)throw new Error('synthetic failure');return {suggestions:structuredClone(suggestions),warnings:[],usage:{inputTokens:100,outputTokens:30},promptBytes:100};},analyze:async()=>({suggestions:structuredClone(corpus),warnings:[],usage:{inputTokens:80,outputTokens:20},promptBytes:80})};
 const provider:LLMProvider={generate:async()=>{throw new Error('Tests must never send model requests');}};
 beforeAll(async()=>{
  directory=await mkdtemp(path.join(tmpdir(),'solution-refinement-'));db=await openDatabase(directory);
  knowledge=new KnowledgeService(db,directory,{put:async()=>{},get:async()=>new Uint8Array()},()=>provider);
  await knowledge.settings.init();await knowledge.settings.patch({llm:{apiKey:'synthetic-local-test-key',baseUrl:'https://api.moonshot.cn/v1',model:'kimi-k2.6',maxTokens:3000}});
  service=new RefinementService(db,knowledge,()=>provider,engine);await service.start();
 },30000);
 afterAll(async()=>{await service?.close();await db?.close();await rm(directory,{recursive:true,force:true});},30000);
 async function seed(){
  const id=randomUUID(),version=randomUUID(),source=randomUUID();
  const field=<T>(value:T)=>({value,confidence:.9,source:'ai' as const,reasoning:'原始分类'});
  const classification:Classification={documentType:field('solution'),authority:field('reference'),applications:field(['robotics']),topics:field(['camera']),products:field(['K18']),language:field('zh')};
  const parsed:ParsedDocument={title:'概述',plainText:'机器人实验室 K18 相机技术方案，研究相机部署与标定。',blocks:[{type:'paragraph',text:'机器人实验室 K18 相机技术方案，研究相机部署与标定。'}],tables:[],parseStatus:'success',parseWarnings:[],metadata:{}};
  await db.transaction(async tx=>{
   await tx.query('INSERT INTO source_documents(id,source_id,source_document_id,content_hash) VALUES($1,\'manual\',$2,$3)',[source,id,id]);
   await tx.query("INSERT INTO documents(id,organization_id,workspace_id,source_document_id,title,canonical_title,status,active_version_id) VALUES($1,'default','default',$2,'概述','概述','active',$3)",[id,source,version]);
   await tx.query("INSERT INTO document_versions(id,document_id,version_number,filename,content_hash,object_key,size_bytes,summary,extractive_summary,parsed_document,parsed_title,parse_status) VALUES($1,$2,1,'机器人相机方案.md',$2,'test',1,'原始摘要','原始摘要',$3::jsonb,'概述','success')",[version,id,JSON.stringify(parsed)]);
   await saveClassification(tx,version,classification);await knowledge.reindexMetadata(tx,id);
  });return {id,version};
 }
 function suggestion(field:RefinementSuggestion['field'],proposedValue:unknown,confidence=.95):RefinementSuggestion{return {field,proposedValue,confidence,reasoning:'当前文件证据',evidence:['K18 相机技术方案']};}
 async function run(documentIds:string[],options:Record<string,unknown>={}){
  const created=await service.createBatch({documentIds,operations:['title','summary','classification','tags'],budgetCny:10,...options});
  for(let attempt=0;attempt<300;attempt++){const result=await service.getBatch(created.id);if(!['queued','running'].includes(result.batch.status))return result;await new Promise(resolve=>setTimeout(resolve,10));}throw new Error('Refinement job did not complete');
 }
 test('preview does not write metadata; selective apply and rollback restore metadata, search, provenance and examples',async()=>{
  const document=await seed();suggestions=[suggestion('title','机器人实验室相机部署方案'),suggestion('summary','这是 K18 相机在机器人实验室的部署和标定技术方案。'),suggestion('document_type','manual'),suggestion('topics',['camera','calibration'])];
  const before=await getDocument(db,document.id);const originalSearch=await db.query('SELECT search_vector::text AS search FROM knowledge_chunks WHERE version_id=$1 ORDER BY chunk_order',[document.version]);
  const batch=await run([document.id]);expect(batch.proposals).toHaveLength(4);expect((await getDocument(db,document.id))?.title).toBe('概述');
  const onlyTitle=await service.applyBatch(batch.batch.id,{fields:['title']});expect(onlyTitle.applied).toBe(1);
  let after=await getDocument(db,document.id);expect(after?.title).toBe('机器人实验室相机部署方案');expect(after?.titleSource).toBe('user');expect(after?.summary).toBe('原始摘要');expect(after?.classification).toEqual(before?.classification);
  const rest=await service.applyBatch(batch.batch.id,{fields:['summary','document_type','topics']});expect(rest.applied).toBe(3);
  after=await getDocument(db,document.id);expect(after?.classification?.documentType.source).toBe('user');expect(after?.summarySource).toBe('user');expect(after?.extractiveSummary).toBe('原始摘要');
  const confirmed=await db.query('SELECT * FROM confirmed_examples WHERE document_id=$1',[document.id]);expect(confirmed).toHaveLength(1);
  const audits=await db.query("SELECT * FROM audit_events WHERE document_id=$1 AND action='batch_refinement_apply'",[document.id]);expect(audits).toHaveLength(2);
  const result=await service.rollbackBatch(batch.batch.id);expect(result.restored).toBe(2);
  after=await getDocument(db,document.id);expect(after?.title).toBe(before?.title);expect(after?.classification).toEqual(before?.classification);expect(after?.summary).toBe(before?.summary);expect(after?.titleSource).toBe(before?.titleSource);
  expect(await db.query('SELECT * FROM confirmed_examples WHERE document_id=$1',[document.id])).toHaveLength(0);
  expect(await db.query('SELECT search_vector::text AS search FROM knowledge_chunks WHERE version_id=$1 ORDER BY chunk_order',[document.version])).toEqual(originalSearch);
 });
 test('locked human fields and newly confirmed fields cannot be overwritten by an old proposal',async()=>{
  const document=await seed();await knowledge.edit(document.id,{title:'人工确认的相机方案',topics:['camera']});
  suggestions=[suggestion('title','AI 新标题'),suggestion('topics',['calibration']),suggestion('summary','机器人实验室 K18 相机技术方案')];
  let batch=await run([document.id]);expect(batch.proposals.filter(p=>p.locked)).toHaveLength(2);
  const result=await service.applyBatch(batch.batch.id,{});expect(result.applied).toBe(1);expect(result.conflicts).toHaveLength(2);expect((await getDocument(db,document.id))?.title).toBe('人工确认的相机方案');
  suggestions=[suggestion('title','人工主动允许替换的名称')];batch=await run([document.id],{includeUserTitles:true});expect((await service.applyBatch(batch.batch.id,{})).applied).toBe(1);
  const second=await seed();suggestions=[suggestion('topics',['calibration'])];batch=await run([second.id]);await knowledge.edit(second.id,{topics:['camera']});
  await service.applyBatch(batch.batch.id,{});expect((await getDocument(db,second.id))?.classification?.topics.value).toEqual(['camera']);
 });
 test('new versions make proposals stale, and rollback never overwrites later edits',async()=>{
  const document=await seed();suggestions=[suggestion('title','新的机器人相机资料名称')];let batch=await run([document.id]);
  await db.query('UPDATE documents SET active_version_id=$1 WHERE id=$2',[randomUUID(),document.id]);
  expect((await service.getBatch(batch.batch.id)).proposals[0].status).toBe('stale');
  await db.query('UPDATE documents SET active_version_id=$1 WHERE id=$2',[document.version,document.id]);
  batch=await run([document.id]);await service.applyBatch(batch.batch.id,{});await knowledge.edit(document.id,{title:'后续人工修改'});
  await expect(service.rollbackBatch(batch.batch.id)).rejects.toMatchObject({statusCode:409});expect((await getDocument(db,document.id))?.title).toBe('后续人工修改');
 });
 test('invalid edited products and registry keys fail atomically; selected suggestions alone are rejected',async()=>{
  const document=await seed();suggestions=[suggestion('title','新的方案名称'),suggestion('products',['K18'])];
  // Existing equal values do not produce redundant proposals.
  let batch=await run([document.id]);expect(batch.proposals).toHaveLength(1);
  suggestions=[suggestion('products',[])];batch=await run([document.id]);
  await expect(service.applyBatch(batch.batch.id,{edits:{[batch.proposals[0].id]:['INVENTED-99']}})).rejects.toMatchObject({statusCode:400});
  expect((await getDocument(db,document.id))?.classification?.products.value).toEqual(['K18']);
  const accepted=await service.applyBatch(batch.batch.id,{edits:{[batch.proposals[0].id]:['K18']}});
  expect(accepted.proposals[0].proposedValue).toEqual([]);expect(accepted.proposals[0].acceptedValue).toEqual(['K18']);
  suggestions=[suggestion('document_type','unregistered'),suggestion('topics',['calibration'])];batch=await run([document.id]);
  await expect(service.applyBatch(batch.batch.id,{})).rejects.toMatchObject({statusCode:400});
  const topic=batch.proposals.find(p=>p.field==='topics')!;const rejected=await service.rejectBatch(batch.batch.id,{proposalIds:[topic.id]});
  expect(rejected.proposals.find(p=>p.id===topic.id)?.status).toBe('rejected');expect(rejected.proposals.find(p=>p.field==='document_type')?.status).toBe('pending');
 });
 test('budget is reserved before calls, unknown failures retain reservation, interrupted jobs do not replay',async()=>{
  const a=await seed(),b=await seed();suggestions=[suggestion('title','机器人实验室 K18 相机方案')];const prior=calls;
  const limited=await run([a.id,b.id],{budgetCny:REFINEMENT_CALL_RESERVATION_CNY+.00001});expect(calls-prior).toBe(1);expect(limited.batch.status).toBe('partially_failed');expect(limited.batch.reservedCny).toBeCloseTo(REFINEMENT_CALL_RESERVATION_CNY);expect(limited.batch.failed).toBe(1);
  fail=true;const failed=await run([b.id]);fail=false;expect(failed.batch.status).toBe('failed');expect(failed.batch.reservedCny).toBeCloseTo(REFINEMENT_CALL_RESERVATION_CNY);
  await service.close();const interrupted=randomUUID();await db.query("INSERT INTO refinement_batches(id,status,operations,document_ids,targets,total,budget_cny,reserved_cny) VALUES($1,'running','[\"title\"]','[]','[]',1,10,$2)",[interrupted,REFINEMENT_CALL_RESERVATION_CNY]);
  const before=calls;service=new RefinementService(db,knowledge,()=>provider,engine);await service.start();
  expect((await service.getBatch(interrupted)).batch.status).toBe('partially_failed');expect(calls).toBe(before);
 });
 test('corpus analysis only proposes; groups require acceptance and version checks; registry remains unchanged',async()=>{
  const a=await seed(),b=await seed();const registries=await getRegistries(db);
  corpus=[{kind:'group',name:'机器人相机专题 '+a.id.slice(0,5),description:'同类实验室部署资料',documentIds:[a.id,b.id],confidence:.9,evidence:['K18']}];
  const analysis=await service.analyzeCorpus({documentIds:[a.id,b.id]});let result=await service.listCorpusProposals();
  for(let attempt=0;attempt<300&&!result.proposals.some(p=>p.analysisId===analysis.id);attempt++){await new Promise(resolve=>setTimeout(resolve,10));result=await service.listCorpusProposals();}
  const proposal=result.proposals.find(p=>p.analysisId===analysis.id)!;expect(proposal).toBeTruthy();expect(await service.listGroups()).toHaveLength(0);expect(await getRegistries(db)).toEqual(registries);
  await service.acceptCorpusProposal(proposal.id);expect((await service.listGroups())[0].documentCount).toBe(2);expect(await getRegistries(db)).toEqual(registries);
  const second=await service.createGroup({name:'人工分组',documentIds:[a.id]});const first=(await service.listGroups()).find(g=>g.id!==second.id)!;
  const merged=await service.mergeGroups({sourceIds:[second.id],targetId:first.id});expect(merged.documentCount).toBe(2);expect(await service.listGroups()).toHaveLength(1);
  corpus=[{...corpus[0],name:'旧版本分组'}];const stale=await service.analyzeCorpus({documentIds:[a.id,b.id]});
  for(let attempt=0;attempt<300;attempt++){result=await service.listCorpusProposals();if(result.proposals.some(p=>p.analysisId===stale.id))break;await new Promise(resolve=>setTimeout(resolve,10));}
  await db.query("UPDATE documents SET status='archived' WHERE id=$1",[a.id]);
  await expect(service.acceptCorpusProposal(result.proposals.find(p=>p.analysisId===stale.id)!.id)).rejects.toMatchObject({statusCode:409});
  expect((await service.listCorpusProposals()).proposals.find(p=>p.analysisId===stale.id)?.status).toBe('stale');
 });
 test('batch archive is atomic for invalid selections and preserves metadata when valid',async()=>{
  const a=await seed(),b=await seed();const before=await getDocument(db,a.id);
  await expect(service.batchArchive({documentIds:[a.id,'does-not-exist']})).rejects.toMatchObject({statusCode:404});
  expect((await getDocument(db,a.id))?.status).toBe('active');
  suggestions=[suggestion('title','归档之前的待确认建议')];const pending=await run([a.id]);
  expect(await service.batchArchive({documentIds:[a.id,b.id]})).toEqual({archived:2});
  expect((await getDocument(db,a.id))?.status).toBe('archived');expect((await getDocument(db,a.id))?.classification).toEqual(before?.classification);
  expect((await service.getBatch(pending.batch.id)).proposals[0].status).toBe('stale');
 });
});
