import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Fastify from 'fastify';
import { openDatabase, type Database } from '../packages/knowledge/src/database.js';
import { KnowledgeService } from '../packages/knowledge/src/service.js';
import { getDocument, saveClassification } from '../packages/knowledge/src/repository.js';
import type { Classification, LLMConfig, LLMProvider, ParsedDocument } from '../packages/core/src/types.js';
import { KnowledgeEnrichmentService } from '../packages/knowledge-enrichment/src/service.js';
import { extractSections } from '../packages/knowledge-enrichment/src/sections.js';
import { enrichSections } from '../packages/knowledge-enrichment/src/engine.js';
import { retrieveSections } from '../packages/knowledge-enrichment/src/retrieval.js';
import { inferSectionRole, normalizeFingerprint } from '../packages/knowledge-enrichment/src/taxonomy.js';
import { registerEnrichmentRoutes } from '../apps/server/src/enrichment-routes.js';

const blueprint={purpose:'解释部署设计',recommendedStructure:['场地约束','交叉观察','遮挡处理'],reusableTechnicalLogic:['交叉观察目标','避免相机共线'],expectedFacts:['当前项目相机数量'],projectSpecificElements:['历史项目为 20 台相机、30×15m 场地']};
const parsed=(blocks:ParsedDocument['blocks']):ParsedDocument=>({title:'测试方案',plainText:blocks.map(block=>block.text).join('\n\n'),blocks,tables:[],parseStatus:'success',parseWarnings:[],metadata:{}});

describe('whole historical sections and shared project taxonomy',()=>{
 test('preserves an entire long chapter and tables instead of concatenating overlapping chunks',()=>{
  const text='交叉覆盖与遮挡分析。'.repeat(1600),document=parsed([{type:'heading',text:'技术方案',level:1},{type:'heading',text:'4.1 相机部署',level:2},{type:'paragraph',text},{type:'table',text:'区域 | 方式\n中心 | 交叉观察'},{type:'heading',text:'4.2 软件接口',level:2},{type:'paragraph',text:'SDK 输出位姿数据。'}]);
  const sections=extractSections(document,'fallback');expect(sections).toHaveLength(2);expect(sections[0].headingPath).toEqual(['技术方案','4.1 相机部署']);expect(sections[0].text).toBe(text+'\n\n区域 | 方式\n中心 | 交叉观察');expect(sections[0].text.length).toBeGreaterThan(10000);expect(sections[1].order).toBe(1);
 });
 test('recovers numbered headings from a PDF paragraph without dropping the final page',()=>{
  const sections=extractSections(parsed([{type:'paragraph',text:'第一章 系统概述\n面向机器人检测。\n2.1 相机部署设计\n交叉覆盖场地。\n2.2 软件数据流\n输出刚体位姿。',page:1}]),'PDF');expect(sections.map(section=>section.title)).toEqual(['第一章 系统概述','2.1 相机部署设计','2.2 软件数据流']);expect(sections[2].text).toBe('输出刚体位姿。');
 });
 test('uses the same Chinese/English normalization for project and knowledge tags, while retaining open terms',()=>{
  expect(normalizeFingerprint({applications:['机器人','robotics'],targetObjects:['人形机器人'],scenarios:['复杂地形'],topics:['光学动捕','URDF'],modules:['相机部署'],products:['k18'],environment:['防尘车间']})).toEqual({applications:['robotics'],targetObjects:['humanoid_robot'],scenarios:['complex_terrain'],topics:['optical_motion_capture','urdf'],modules:['camera_deployment'],products:['K18'],environment:['防尘车间'],constraints:[]});expect(inferSectionRole('4.1 相机部署设计')).toBe('deployment');expect(inferSectionRole('软件数据流')).toBe('data_flow');
  expect(normalizeFingerprint({applications:['scientific_research','sports_analysis'],topics:['光惯融合'],environment:['水下']})).toMatchObject({applications:['research','sports'],topics:['optical_inertial_fusion'],environment:['underwater']});
 });
 test('rejects omitted sections or invalid output before any source index can be replaced',async()=>{
  const sections=extractSections(parsed([{type:'heading',text:'部署',level:1},{type:'paragraph',text:'完整正文'}]),'test');
  await expect(enrichSections({generate:async()=>({content:JSON.stringify({documentTags:{},sections:[]})})},{title:'test',sections})).rejects.toThrow('目录不一致');
  await expect(enrichSections({generate:async()=>({content:'bad response'})},{title:'test',sections})).rejects.toThrow('有效 JSON');
 });
 test('retains K3 variants-only alias suggestions without inventing a dimension or discarding valid sections',async()=>{
  const sections=extractSections(parsed([{type:'heading',text:'部署',level:1},{type:'paragraph',text:'完整正文'}]),'test');
  const response={documentTags:{applications:[{value:'robotics',confidence:.9}]},sections:[{order:0,summary:'部署说明',sectionRole:'deployment',tags:{},reusable:true,blueprint}],aliases:[{canonical:'运动数据融合',variants:['多源运动融合','动捕数据融合'],reason:'同义技术写法',evidenceSections:[0]}]};
  const result=await enrichSections({generate:async()=>({content:JSON.stringify(response)})},{title:'test',sections});expect(result.sections).toHaveLength(1);expect(result.aliases).toEqual([{canonical:'运动数据融合',aliases:['多源运动融合','动捕数据融合'],reason:'同义技术写法',dimension:'unassigned',confidence:0}]);
 });
});

describe('durable K3 knowledge enrichment, scope isolation and ranking',()=>{
 let directory:string,db:Database,knowledge:KnowledgeService,service:KnowledgeEnrichmentService,app:ReturnType<typeof Fastify>;
 let calls=0,mode:'normal'|'invalid'|'throw'|'hold'='normal',release:(()=>void)|undefined,started:(()=>void)|undefined;
 const configs:LLMConfig[]=[],provider:LLMProvider={generate:async request=>{
  calls++;if(mode==='throw')throw new Error('synthetic provider failure');if(mode==='hold'){started?.();await new Promise<void>(resolve=>{release=resolve;});}
  if(mode==='invalid')return {content:'not-json',usage:{inputTokens:71,outputTokens:23}};
  const input=JSON.parse(request.prompt);
  return {content:JSON.stringify({documentTags:{applications:[{value:'机器人',confidence:.97}],target_objects:[{value:'人形机器人',confidence:.95}],products:[{value:'K18',confidence:.96}]},sections:input.sections.map((section:any)=>({order:section.order,summary:'为机器人测试场提供交叉观察。',sectionRole:inferSectionRole(section.title),tags:{applications:[{value:'robotics',confidence:.98}],technical_topics:[{value:'覆盖',confidence:.98}],system_modules:[{value:'相机部署',confidence:.93}]},reusable:true,blueprint})),aliases:[],authority:'authoritative',productFacts:[{value:'fabricated'}]}),usage:{inputTokens:200,outputTokens:100}};
 }};
 const objects=new Map<string,Uint8Array>();
 beforeAll(async()=>{
  directory=await mkdtemp(join(tmpdir(),'studio-enrichment-'));db=await openDatabase(directory);knowledge=new KnowledgeService(db,directory,{get:async key=>objects.get(key)??new Uint8Array(),put:async(key,value)=>{objects.set(key,value);}},()=>provider);
  await knowledge.settings.init();await knowledge.settings.patch({llm:{apiKey:'synthetic-local-test-key',model:'kimi-k2.6'}});
  service=new KnowledgeEnrichmentService(knowledge,{providerFactory:config=>{configs.push(config);return provider;}});await service.start();
  app=Fastify();app.setErrorHandler((error:any,_request:any,reply:any)=>reply.code(error.statusCode??500).send({message:error.message}));await registerEnrichmentRoutes(app,knowledge,service);
 },30000);
 afterAll(async()=>{await app?.close();await service?.close();await db?.close();await rm(directory,{recursive:true,force:true});},30000);
 async function seed(title='机器人部署方案',options:{scope?:string;status?:string;text?:string}={}){
  const id=randomUUID(),version=randomUUID(),source=randomUUID(),field=<T>(value:T)=>({value,confidence:.9,source:'user' as const});
  const classification:Classification={documentType:field('solution'),authority:field('reference'),applications:field(['robotics']),topics:field(['camera']),products:field(['K18']),language:field('zh')};
  const document=parsed([{type:'heading',text:'4.1 相机部署设计',level:2},{type:'paragraph',text:options.text??'历史项目使用20台K18相机覆盖30×15m场地。多视角交叉观察机器人。'},{type:'heading',text:'4.2 软件接口',level:2},{type:'paragraph',text:'SDK 输出位姿。'}]);
  await db.transaction(async tx=>{await tx.query("INSERT INTO source_documents(id,source_id,source_document_id,content_hash) VALUES($1,'manual',$1,$1)",[source]);await tx.query("INSERT INTO documents(id,organization_id,workspace_id,source_document_id,title,canonical_title,status,scope,project_id,active_version_id) VALUES($1,'default','default',$2,$3,$3,$4,$5,$6,$7)",[id,source,title,options.status??'active',options.scope??'global',options.scope==='project'?'private-project':null,version]);await tx.query("INSERT INTO document_versions(id,document_id,version_number,filename,content_hash,object_key,size_bytes,parse_status,parsed_document) VALUES($1,$2,1,$3,$2,'test',1,'success',$4::jsonb)",[version,id,title+'.md',JSON.stringify(document)]);await saveClassification(tx,version,classification);});return {id,version,document};
 }
 async function done(id:string){for(let i=0;i<300;i++){const result=await service.getBatch(id);if(!['queued','running'].includes(result.batch.status))return result;await new Promise(resolve=>setTimeout(resolve,10));}throw Error('enrichment did not finish');}
 async function run(ids:string[],budgetCny?:number){const batch=await service.createBatch({documentIds:ids,budgetCny});return done(batch.id);}
 test('indexes full original sections with soft tags and blueprints, preserving authority, source text and product facts',async()=>{
  const doc=await seed('完整原文',{text:'旧项目相机部署设计。'.repeat(1600)}),before=await getDocument(db,doc.id),facts=await db.query('SELECT * FROM structured_facts');
  const result=await run([doc.id]);expect(result.batch.status).toBe('completed');expect(result.batch.budgetCny).toBeNull();expect(result.batch.inputTokens).toBe(200);expect(result.batch.outputTokens).toBe(100);expect(configs.at(-1)?.model).toBe('kimi-k3');expect(configs.at(-1)?.maxTokens).toBe(131072);
  const after=await service.listSections(doc.id);expect(after.sections).toHaveLength(2);expect(after.sections[0].text).toBe(doc.document.blocks[1].text);expect(after.sections[0].applications).toEqual(['robotics']);expect(after.sections[0].blueprint).toEqual(blueprint);expect((await getDocument(db,doc.id))?.classification).toEqual(before?.classification);expect((await getDocument(db,doc.id))?.title).toBe(before?.title);expect(await db.query('SELECT * FROM structured_facts')).toEqual(facts);
 });
 test('quality survives re-enrichment and changes ranking; historical references remain writing-only',async()=>{
  const a=await seed('普通样例'),b=await seed('首选样例');await run([a.id,b.id]);await service.setDocumentQuality(b.id,'preferred');const section=(await service.listSections(b.id)).sections[0];await service.setSectionQuality(section.id,'preferred');await run([b.id]);expect((await service.listSections(b.id)).sections[0].id).toBe(section.id);expect((await service.listSections(b.id)).sections[0].quality).toBe('preferred');
  const found=await retrieveSections(db,{role:'deployment',fingerprint:{applications:['机器人'],topics:['覆盖']},sourceIds:[a.id,b.id]});expect(found[0].section.documentId).toBe(b.id);expect(found[0].use).toBe('writing_reference');expect(found[0].section.authority).toBe('reference');expect(found[0].section.text).toContain('20台');expect(found[0].section.blueprint.projectSpecificElements.join()).toContain('20 台');
 });
 test('does not retrieve private, archived, superseded or canonical duplicate document sections',async()=>{
  const current=await seed('当前资料'),archived=await seed('稍后归档'),privateDoc=await seed('稍后设为项目私有'),duplicate=await seed('重复副本');await run([current.id,archived.id,privateDoc.id,duplicate.id]);
  await db.query("UPDATE documents SET status='archived' WHERE id=$1",[archived.id]);await db.query("UPDATE documents SET scope='project',project_id='private-project' WHERE id=$1",[privateDoc.id]);await db.query('UPDATE documents SET canonical_document_id=$2 WHERE id=$1',[duplicate.id,current.id]);
  const result=await retrieveSections(db,{role:'deployment',sourceIds:[current.id,archived.id,privateDoc.id,duplicate.id]});expect(result.map(item=>item.section.documentId)).toEqual([current.id]);
  await db.query('UPDATE documents SET active_version_id=$2 WHERE id=$1',[current.id,randomUUID()]);expect(await retrieveSections(db,{role:'deployment',sourceIds:[current.id]})).toEqual([]);
  await expect(service.createBatch({documentIds:[archived.id]})).rejects.toMatchObject({statusCode:409});await expect(service.createBatch({documentIds:[privateDoc.id]})).rejects.toMatchObject({statusCode:409});
 });
 test('retains the previous index and usage accounting if the model output is invalid',async()=>{
  const doc=await seed('索引保持');await run([doc.id]);const old=await service.listSections(doc.id);for(const key of objects.keys())if(key.includes(doc.version))objects.delete(key);mode='invalid';const result=await run([doc.id]);mode='normal';expect(result.batch.status).toBe('failed');expect(result.batch.inputTokens).toBe(71);expect(result.batch.outputTokens).toBe(23);expect(result.batch.estimatedCostCny).toBeGreaterThan(0);expect((await service.listSections(doc.id)).sections).toEqual(old.sections);
 });
 test('keeps navigation sections visible in the index but never retrieves them as body references',async()=>{
  const doc=await seed('封面目录');await run([doc.id]);const sections=(await service.listSections(doc.id)).sections;await db.query("UPDATE knowledge_sections SET section_role=CASE WHEN id=$2 THEN 'cover' ELSE 'toc' END,reusable=true WHERE document_id=$1",[doc.id,sections[0].id]);
  expect((await service.listSections(doc.id)).sections).toHaveLength(2);expect(await retrieveSections(db,{role:'toc',fingerprint:{applications:['robotics']},products:['K18'],sourceIds:[doc.id]})).toEqual([]);
 });
 test('reuses exact-version request cache without rebilling and replaces an invalid cache with one fresh call',async()=>{
  const doc=await seed('缓存复用');const first=await run([doc.id]);expect(first.batch.inputTokens).toBe(200);const prior=calls,cached=await run([doc.id]);expect(calls).toBe(prior);expect(cached.batch.processed).toBe(1);expect(cached.batch.inputTokens).toBe(0);expect(cached.batch.estimatedCostCny).toBe(0);
  const key=[...objects.keys()].find(key=>key.includes(doc.version)&&key.split('/').length===3)!;expect(key).toContain('enrichment-responses/');objects.set(key,Buffer.from(JSON.stringify({documentId:doc.id,versionId:doc.version,response:{content:'invalid cached JSON'}})));const repaired=await run([doc.id]);expect(repaired.batch.status).toBe('completed');expect(calls).toBe(prior+1);
 });
 test('an explicitly chosen insufficient budget prevents API requests; default budget is unlimited',async()=>{
  const doc=await seed('可选预算'),prior=calls,result=await run([doc.id],.001);expect(result.batch.status).toBe('failed');expect(calls).toBe(prior);expect(result.items[0].error).toContain('尚未发送');expect((await run([doc.id])).batch.status).toBe('completed');
 });
 test('rejects applying enrichment after the original changes during a model call',async()=>{
  const doc=await seed('处理中版本更新');let notifyStart!:()=>void;const waiting=new Promise<void>(resolve=>{notifyStart=resolve;});started=notifyStart;mode='hold';const batch=await service.createBatch({documentIds:[doc.id]});await waiting;
  await expect(service.createBatch({documentIds:[doc.id]})).rejects.toMatchObject({statusCode:409});await db.query('UPDATE documents SET active_version_id=$2 WHERE id=$1',[doc.id,randomUUID()]);release!();const result=await done(batch.id);mode='normal';started=undefined;expect(result.batch.status).toBe('failed');expect(result.items[0].error).toContain('版本或状态已改变');expect(await db.query('SELECT id FROM knowledge_sections WHERE document_id=$1',[doc.id])).toEqual([]);
 });
 test('low-confidence soft tags contribute less than strong section evidence',async()=>{
  const a=await seed('低置信度'),b=await seed('高置信度');await run([a.id,b.id]);await db.query('UPDATE knowledge_sections SET tags=$2::jsonb WHERE document_id=$1',[a.id,JSON.stringify({scenarios:[{value:'梯形试验场',confidence:.35}]})]);await db.query('UPDATE knowledge_sections SET tags=$2::jsonb WHERE document_id=$1',[b.id,JSON.stringify({scenarios:[{value:'梯形试验场',confidence:.95}]})]);const result=await retrieveSections(db,{role:'deployment',fingerprint:{scenarios:['梯形试验场']},sourceIds:[a.id,b.id]});expect(result[0].section.documentId).toBe(b.id);expect(result[0].score).toBeGreaterThan(result[1].score);
 });
 test('matches an exact product model with a brand prefix without confusing a longer model number',async()=>{
  const a=await seed('品牌前缀型号'),b=await seed('不同型号');await run([a.id,b.id]);await db.query("UPDATE knowledge_sections SET section_role='other',tags=$2::jsonb WHERE document_id=$1",[a.id,JSON.stringify({products:[{value:'青瞳UWR3',confidence:.95}]})]);await db.query("UPDATE knowledge_sections SET section_role='other',tags=$2::jsonb WHERE document_id=$1",[b.id,JSON.stringify({products:[{value:'青瞳UWR30',confidence:.95}]})]);const result=await retrieveSections(db,{role:'unregistered_role',products:['UWR3'],sourceIds:[a.id,b.id]});expect(result.length).toBeGreaterThan(0);expect([...new Set(result.map(item=>item.section.documentId))]).toEqual([a.id]);
 });
 test('alias suggestions require explicit acceptance and then normalize matching without rewriting product facts',async()=>{
  const doc=await seed('同义场景');await run([doc.id]);await db.query('UPDATE knowledge_sections SET section_role=\'other\',tags=$2::jsonb WHERE document_id=$1',[doc.id,JSON.stringify({scenarios:[{value:'机器人崎岖路面试验',confidence:.98}]})]);expect(await retrieveSections(db,{role:'unregistered_role',fingerprint:{scenarios:['rough_surface_testing']},sourceIds:[doc.id]})).toEqual([]);
  const aliasId=randomUUID();await db.query('INSERT INTO knowledge_alias_suggestions(id,dimension,canonical,aliases,confidence,reason) VALUES($1,\'scenarios\',\'rough_surface_testing\',$2::jsonb,.92,\'same scenario\')',[aliasId,JSON.stringify(['机器人崎岖路面试验'])]);expect((await service.listAliases()).find(item=>item.id===aliasId)?.status).toBe('pending');await service.decideAlias(aliasId,true);const result=await retrieveSections(db,{role:'unregistered_role',fingerprint:{scenarios:['rough_surface_testing']},sourceIds:[doc.id]});expect(result.length).toBeGreaterThan(0);expect(result[0].section.documentId).toBe(doc.id);
 });
 test('aliases without an inferred dimension require a user choice before entering the shared taxonomy',async()=>{
  const id=randomUUID();await db.query("INSERT INTO knowledge_alias_suggestions(id,dimension,canonical,aliases) VALUES($1,'unassigned','运动数据融合',$2::jsonb)",[id,JSON.stringify(['动捕数据融合'])]);await expect(service.decideAlias(id,true)).rejects.toMatchObject({statusCode:400});expect((await service.listAliases()).find(item=>item.id===id)?.status).toBe('pending');await service.decideAlias(id,true,'technical_topics');expect((await service.listAliases()).find(item=>item.id===id)?.dimension).toBe('technical_topics');
 });
 test('HTTP scope selection snapshots filtered documents and exposes quality and complete sections',async()=>{
  const doc=await seed('ONLY_ENRICH_HTTP_'+randomUUID());const created=await app.inject({method:'POST',url:'/api/enrichment/batches',payload:{selection:{mode:'filtered',filters:{q:doc.id}}}});expect(created.statusCode).toBe(400);
  const title=(await getDocument(db,doc.id))!.title;const response=await app.inject({method:'POST',url:'/api/enrichment/batches',payload:{selection:{mode:'filtered',filters:{q:title}}}});expect(response.statusCode).toBe(202);expect(response.json().batch.total).toBe(1);await done(response.json().batch.id);
  expect((await app.inject(`/api/documents/${doc.id}/enrichment`)).json().sections).toHaveLength(2);expect((await app.inject({method:'PATCH',url:`/api/documents/${doc.id}/reference-quality`,payload:{quality:'preferred'}})).json().quality).toBe('preferred');
  expect((await app.inject({method:'POST',url:'/api/enrichment/batches',payload:{documentIds:[doc.id],selection:{mode:'all'}}})).statusCode).toBe(400);expect((await app.inject({method:'PATCH',url:`/api/documents/${doc.id}/reference-quality`,payload:{quality:'authoritative'}})).statusCode).toBe(400);
 });
 test('service restart does not replay an interrupted paid request',async()=>{
  const doc=await seed('中断任务');await service.close();const batch=randomUUID(),item=randomUUID();await db.query("INSERT INTO knowledge_enrichment_batches(id,status,total,reserved_cny) VALUES($1,'running',1,1.5)",[batch]);await db.query("INSERT INTO knowledge_enrichment_items(id,batch_id,document_id,version_id,status,reserved_cny) VALUES($1,$2,$3,$4,'running',1.5)",[item,batch,doc.id,doc.version]);const prior=calls;await service.start();const result=await service.getBatch(batch);expect(result.batch.status).toBe('failed');expect(result.batch.reservedCny).toBe(1.5);expect(calls).toBe(prior);expect(result.items[0].error).toContain('服务中断');
 });
});
