import {beforeAll,afterAll,describe,test,expect} from 'vitest';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import JSZip from 'jszip';
import {createApp} from '../apps/server/src/app.js';
import type {DocumentEngine} from '../packages/document-engine/src/service.js';
import type {ProjectService} from '../packages/projects/src/service.js';
import {buildSectionContext,DocumentRetriever} from '../packages/document-engine/src/context.js';
import type {GeneratedDocument} from '../packages/document-engine/src/types.js';
import {createSceneLabFixture} from './helpers/scenelab.js';
import {parseGeneration} from '../packages/document-engine/src/blocks.js';
import {inspect} from '../packages/structured/src/service.js';
import {deterministicBlocks} from '../packages/document-engine/src/blocks.js';

describe('document engine workflow, private context and durable jobs',()=>{
 let directory:string,app:Awaited<ReturnType<typeof createApp>>,engine:DocumentEngine,projects:ProjectService;
 let calls=0,failedTitle='',customerDraft:'clean'|'repairable'|'blocked'='clean',slow:Promise<void>|undefined;const prompts:any[]=[];const providerConfigs:any[]=[];
 beforeAll(async()=>{
  directory=await mkdtemp(path.join(tmpdir(),'studio-docengine-'));
  app=await createApp({dataDir:directory,providerFactory:config=>{providerConfigs.push(config);return {generate:async request=>{calls++;await slow;if(!request.responseFormat)return {content:'flowchart LR\n A[采集模块] --> B[数据处理]',usage:{inputTokens:90,outputTokens:40}};const repairAt=request.prompt.indexOf('\n请修订以下草稿'),c=JSON.parse(repairAt<0?request.prompt:request.prompt.slice(0,repairAt));prompts.push(c);if(c.sectionTitle===failedTitle)throw new Error('synthetic section failure');return {content:JSON.stringify({content:[{type:'paragraph',text:customerDraft==='blocked'||customerDraft==='repairable'&&repairAt<0?'验收指标尚未明确，待确认。':'系统围绕应用需求组织采集、数据处理和实施流程。'}],used_fact_ids:[],used_knowledge_refs:[],used_asset_refs:[],claims:[]}),usage:{inputTokens:90,outputTokens:40}};}};}});
  engine=(app as any).documentEngine;projects=(app as any).projects;
  await (app as any).knowledge.settings.patch({llm:{apiKey:'synthetic-test-key',baseUrl:'https://api.moonshot.cn/v1',model:'kimi-k2.6'}});
 },30000);
 afterAll(async()=>{await app?.close();if(directory)await rm(directory,{recursive:true,force:true});},30000);
 async function project(name:string,description='建设目标：完成项目应用验证。',report=false){const p=await projects.create({name,description});if(report)await projects.addInput(p.id,{filename:'fixture.scenelab-report',bytes:await createSceneLabFixture()});const c=await projects.getContext(p.id);await projects.confirmContext(p.id,c.revision);return p;}
 async function wait(id:string,timeoutMs=4000){const deadline=Date.now()+timeoutMs;let status='not queued';while(Date.now()<deadline){const job=(await engine.jobs(id))[0];if(job){status=job.status;if(!['queued','running'].includes(job.status))return job;}await new Promise(r=>setTimeout(r,20));}throw new Error(`generation timeout after ${timeoutMs}ms (last status: ${status})`);}
 async function run(doc:GeneratedDocument,sectionIds?:string[],extra:any={},timeoutMs=4000){await engine.generate(doc.id,{expectedRevision:doc.revision,sectionIds,config:{budgetCny:10},...extra});return wait(doc.id,timeoutMs);}
 test('context confirmation is required; plan is data-driven and validates ownership/outline/revisions',async()=>{
  const p=await projects.create({name:'未确认项目',description:'建设目标：验证方案流程。'});await expect(engine.create(p.id)).rejects.toMatchObject({statusCode:409});
  await projects.confirmContext(p.id,(await projects.getContext(p.id)).revision);const doc=await engine.create(p.id);
  expect(doc.sections.some(s=>s.title==='理论精度分析')).toBe(false);
  await expect(engine.plan(doc.id,{revision:doc.revision,sections:[{title:'跳级',level:2}]})).rejects.toMatchObject({statusCode:400});
  const plan=await engine.plan(doc.id,{revision:doc.revision,sections:[{...doc.sections[0],title:'项目概况'},{title:'补充需求',level:1}]});expect(plan.sections.map(s=>s.title)).toEqual(['项目概况','补充需求']);
  await expect(engine.plan(doc.id,{revision:doc.revision,sections:[doc.sections[0]]})).rejects.toMatchObject({statusCode:409});
 });
 test.each([
  ['普通动捕实验室','建设目标：开展教学动作采集。',false],
  ['大空间无人机','建设目标：无人机轨迹测量。',true],
  ['机器人应用','建设目标：机器人遥操作与数据采集。',false],
  ['小空间高精度','客户要求精度≤0.1 mm。',true],
  ['参数不完整','计划建设动作捕捉系统，参数待确认。',false],
 ] as const)('five scenario acceptance: %s',async(name,description,report)=>{
  const p=await project(name,description,report),doc=await engine.create(p.id);
  const job=await run(doc);expect(job.errors).toEqual([]);expect(job.status).toBe('completed');
  const result=await engine.get(doc.id);expect(result.sections.every((s,index)=>s.blocks.length>0||(result.sections[index+1]?.level??0)>s.level)).toBe(true);
  expect(result.sections.every(s=>(s.contextTokens??0)<=job.config.maxContextTokens)).toBe(true);
  const before=calls,exported=await engine.export(doc.id);expect(calls).toBe(before);expect(exported.buffer.subarray(0,2).toString()).toBe('PK');
  const zip=await JSZip.loadAsync(exported.buffer);expect(await zip.file('word/document.xml')!.async('string')).toContain('TOC');
  expect(Object.keys(zip.files).filter(k=>k.startsWith('word/media/')&&!zip.files[k].dir).length).toBe(report?6:0);
  if(report){expect(result.sections.find(s=>s.title==='相机部署设计')?.blocks.some(b=>b.type==='asset')).toBe(true);expect(result.sections.find(s=>s.title==='系统硬件组成')?.blocks.some(b=>b.type==='table'&&b.rows.some(r=>r[0]==='K18'&&r[1]==='2'))).toBe(true);}
 },20000);
 test('failures are isolated, retry works, edited content requires explicit second confirmation and stale writes fail',async()=>{
  const p=await project('章节保护'),doc=await engine.create(p.id),a=doc.sections[0],b=doc.sections.find(s=>s.title==='应用背景')!;
  failedTitle=a.title;const job=await run(doc,[a.id,b.id]);expect(job.status).toBe('partially_failed');expect(job.processed).toBe(1);expect(job.failed).toBe(1);failedTitle='';
  let current=await engine.get(doc.id);await run(current,[a.id]);current=await engine.get(doc.id);
  const edited=await engine.edit(doc.id,a.id,{revision:current.sections[0].revision,blocks:[{type:'paragraph',text:'用户手工确认的专属内容。'}]});
  await expect(engine.generate(doc.id,{expectedRevision:edited.revision,sectionIds:[a.id]})).rejects.toMatchObject({statusCode:409});
  await expect(engine.edit(doc.id,a.id,{revision:current.sections[0].revision,blocks:[]})).rejects.toMatchObject({statusCode:409});
  await run(edited,[b.id]);expect((await engine.get(doc.id)).sections[0].blocks[0]).toMatchObject({text:'用户手工确认的专属内容。'});
  await run(await engine.get(doc.id),[a.id],{overwriteEdited:true});expect((await engine.get(doc.id)).sections[0].edited).toBe(false);
 });
 test('customer prose repair is bounded, bills both replies, and rejects an unrepaired internal draft',async()=>{
  const p=await project('客户正文校验'),doc=await engine.create(p.id),sid=doc.sections[0].id,before=calls;
  try{
   customerDraft='repairable';const repaired=await run(doc,[sid]);
   expect(repaired.status).toBe('completed');expect(calls-before).toBe(2);expect(repaired.inputTokens).toBe(180);expect(repaired.outputTokens).toBe(80);
   const successful=await engine.get(doc.id);expect(successful.sections[0].blocks).toEqual(expect.arrayContaining([expect.objectContaining({text:'系统围绕应用需求组织采集、数据处理和实施流程。'})]));
   customerDraft='blocked';const rejected=await run(successful,[sid]);
   expect(rejected.status).toBe('failed');expect(calls-before).toBe(4);expect(rejected.failed).toBe(1);expect(rejected.errors[0].message).toContain('客户表达检查未通过');
   expect((await engine.get(doc.id)).sections[0].blocks).toEqual(successful.sections[0].blocks);
  }finally{customerDraft='clean';}
 });
 test('cover logos only reference this project raster assets and export without model calls',async()=>{
  const a=await project('封面标识甲',undefined,true),b=await project('封面标识乙',undefined,true),doc=await engine.create(a.id);
  const asset=(await projects.get(a.id)).assets[0],foreign=(await projects.get(b.id)).assets[0],before=calls;
  for(const coverLogoAssetId of [foreign.id,'https://example.test/logo.png',null])await expect(engine.patch(doc.id,{revision:doc.revision,outputProfile:{coverLogoAssetId}})).rejects.toMatchObject({statusCode:400});
  await engine.db.query("UPDATE project_assets SET mime_type='image/svg+xml' WHERE id=$1",[asset.id]);
  try{await expect(engine.patch(doc.id,{revision:doc.revision,outputProfile:{coverLogoAssetId:asset.id}})).rejects.toMatchObject({statusCode:400});}finally{await engine.db.query('UPDATE project_assets SET mime_type=$2 WHERE id=$1',[asset.id,asset.mimeType]);}
  const saved=await engine.patch(doc.id,{revision:doc.revision,outputProfile:{coverLogoAssetId:asset.id}});expect(saved.outputProfile.coverLogoAssetId).toBe(asset.id);
  const zip=await JSZip.loadAsync((await engine.export(doc.id)).buffer);expect(await zip.file('word/document.xml')!.async('string')).toContain(' Logo');expect(Object.keys(zip.files).filter(key=>key.startsWith('word/media/'))).toHaveLength(1);
  const cleared=await engine.patch(doc.id,{revision:saved.revision,outputProfile:{coverLogoAssetId:''}});expect(cleared.outputProfile.coverLogoAssetId).toBeUndefined();
  const plain=await JSZip.loadAsync((await engine.export(doc.id)).buffer);expect(Object.keys(plain.files).filter(key=>key.startsWith('word/media/'))).toHaveLength(0);expect(calls).toBe(before);
 });
 test('budget stop preserves earlier deterministic sections and makes zero unreserved model calls',async()=>{
  const p=await project('预算保护'),doc=await engine.create(p.id),first=doc.sections.find(s=>s.generationMode==='fixed')!,second=doc.sections.find(s=>s.generationMode==='ai')!;
  const plan=await engine.plan(doc.id,{revision:doc.revision,sections:[{...first,level:1},{...second,level:1}]});const before=calls;
  const job=await run(plan,undefined,{config:{limitsEnabled:true,budgetCny:.001}});expect(job.status).toBe('budget_exhausted');expect(job.reservedCny).toBe(0);expect(calls).toBe(before);expect((await engine.get(doc.id)).sections[0].blocks.length).toBeGreaterThan(0);
 });
 test('default generation keeps large required context and ignores optional token and accumulated cost limits',async()=>{
  const p=await project('默认不限额度');const c=await projects.getContext(p.id);
  const updated=await projects.patchContext(p.id,{revision:c.revision,summary:'完整项目依据'.repeat(1400)});await projects.confirmContext(p.id,updated.revision);
  const doc=await engine.create(p.id),sid=doc.sections[0].id;
  await engine.db.query("INSERT INTO generation_jobs(id,document_id,status,section_ids,targets,config,reserved_cny) VALUES('prior-cost-fixture',$1,'failed','[]','[]','{}',1000)",[doc.id]);
  try{
   const before=calls,job=await run(doc,[sid],{config:{maxTokens:512,maxContextTokens:4000,budgetCny:.001}});
   expect(job.status).toBe('completed');expect(job.config).toMatchObject({model:'kimi-k3',temperature:1,reasoningEffort:'max',limitsEnabled:false,maxTokens:131072,maxContextTokens:916480,budgetCny:0});expect(calls).toBe(before+1);
   expect(job.reservedCny).toBeGreaterThan(0);expect(job.estimatedCostCny).toBeGreaterThan(0);
   expect((await engine.get(doc.id)).sections[0].contextTokens).toBeGreaterThan(12000);expect(providerConfigs.at(-1)).toMatchObject({model:'kimi-k3',maxTokens:131072,reasoningEffort:'max',requestTimeoutMs:600000});
   expect(job.estimatedCostCny).toBeCloseTo((90*40+40*100)/1e6);
   const limited=await run(await engine.get(doc.id),[sid],{config:{limitsEnabled:true,maxContextTokens:100000,budgetCny:100}});expect(limited.status).toBe('budget_exhausted');expect(calls).toBe(before+1);
  }finally{await engine.db.query("DELETE FROM generation_jobs WHERE id='prior-cost-fixture'");}
 });
 test('explicit K2.6 retains its profile while K3 validates reasoning parameters',async()=>{
  const p=await project('显式模型选择'),doc=await engine.create(p.id),sid=doc.sections[0].id;
  const job=await run(doc,[sid],{config:{model:'kimi-k2.6',reasoningEffort:'max'}});
  expect(job.status).toBe('completed');expect(job.config).toMatchObject({model:'kimi-k2.6',temperature:.6,maxTokens:32768,maxContextTokens:228352});expect(job.config.reasoningEffort).toBeUndefined();
  expect(providerConfigs.at(-1)).toMatchObject({model:'kimi-k2.6',requestTimeoutMs:180000});expect(job.estimatedCostCny).toBeCloseTo((90*6.5+40*27)/1e6);
  const current=await engine.get(doc.id);
  await expect(engine.generate(doc.id,{expectedRevision:current.revision,sectionIds:[sid],config:{model:'kimi-k3',reasoningEffort:'invalid'}})).rejects.toMatchObject({statusCode:400});
  const k3=await run(current,[sid],{config:{model:'kimi-k3',reasoningEffort:'high'}});expect(k3.config.reasoningEffort).toBe('high');expect(providerConfigs.at(-1).reasoningEffort).toBe('high');
 });
 test('edits while in-flight are rejected and input revision invalidates an old generation result',async()=>{
  const p=await project('生成期间变更'),doc=await engine.create(p.id);let release!:()=>void;slow=new Promise<void>(r=>release=r);
  await engine.generate(doc.id,{expectedRevision:doc.revision,sectionIds:[doc.sections[0].id]});
  await expect(engine.edit(doc.id,doc.sections[0].id,{revision:doc.sections[0].revision,blocks:[]})).rejects.toMatchObject({statusCode:409});
  await projects.addText(p.id,{text:'新的客户需求：验收条件需要重新确认。'});release();slow=undefined;
  const job=await wait(doc.id);expect(job.status).toBe('failed');expect((await engine.get(doc.id)).contextStale).toBe(true);
 });
 test('independent chapters run with at most three calls and keep their own results',async()=>{
  const p=await project('并行章节'),doc=await engine.create(p.id),targets=doc.sections.filter(s=>s.generationMode==='ai').slice(0,4).map(s=>s.id),before=calls;
  let release!:()=>void;slow=new Promise<void>(r=>release=r);
  try{
   await engine.generate(doc.id,{expectedRevision:doc.revision,sectionIds:targets});
   for(let i=0;i<100&&calls<before+3;i++)await new Promise(r=>setTimeout(r,10));
   expect(calls-before).toBe(3);expect((await engine.get(doc.id)).sections.filter(s=>s.status==='generating')).toHaveLength(3);
  }finally{release();slow=undefined;}
  const job=await wait(doc.id);expect(job.processed).toBe(4);expect(job.status).toBe('completed');expect(calls-before).toBe(4);
  expect((await engine.get(doc.id)).sections.filter(s=>targets.includes(s.id)).every(s=>s.blocks.length>0)).toBe(true);
 });
 test('required facts never truncate silently; style-only sources cannot support model claims',async()=>{
  const p=await project('上下文限制'),doc=await engine.create(p.id),context=await projects.getContext(p.id);context.summary='必要事实'.repeat(5000);
  const before=calls;await expect(buildSectionContext(doc.sections[0],context,engine.retriever,engine.structured,4000)).rejects.toMatchObject({statusCode:422});expect(calls).toBe(before);
  context.summary='简述';const sc=await buildSectionContext(doc.sections[0],context,engine.retriever,engine.structured,12000);
  expect(()=>parseGeneration(JSON.stringify({content:[{type:'paragraph',text:'任意断言'}],used_fact_ids:['invented-fact'],used_knowledge_refs:[],used_asset_refs:[],claims:[]}),sc)).toThrow('无效引用');
  const claim= parseGeneration(JSON.stringify({content:[{type:'paragraph',text:'系统实施包括安装、标定与联调。'}],used_fact_ids:[],used_knowledge_refs:[],used_asset_refs:[],claims:[{text:'系统实施包含安装标定环节',factIds:[],sourceIds:[],kind:'requirement'}]}),sc);expect(claim.blocks).toHaveLength(1);
  const patched=await projects.patchContext(p.id,{revision:context.revision,summary:'项目材料'.repeat(2000)});await projects.confirmContext(p.id,patched.revision);const large=await engine.create(p.id),fixed=large.sections.find(s=>s.generationMode==='fixed')!;
  const fixedJob=await run(large,[fixed.id],{config:{maxContextTokens:4000}});expect(fixedJob.status).toBe('completed');expect(calls).toBe(before);
  await expect(engine.generate(large.id,{expectedRevision:(await engine.get(large.id)).revision,sectionIds:[large.sections[0].id],config:{temperature:.4}})).rejects.toMatchObject({statusCode:400});
 });
 test('private source selection is constrained by the selected project and never appears in library search',async()=>{
  const a=await project('私有来源甲'),b=await project('私有来源乙');await projects.addText(a.id,{text:'私有代号 ALPHA 机器人项目客户资料。'});const chunks=await projects.queryChunks(a.id,'ALPHA');expect(chunks.length).toBeGreaterThan(0);
  const retriever=new DocumentRetriever(engine.db,projects);expect((await retriever.retrieve(b.id,'ALPHA')).some(x=>x.text.includes('ALPHA'))).toBe(false);
  expect((await retriever.retrieve(a.id,'',[chunks[0].id])).some(x=>x.source.id===chunks[0].id)).toBe(true);
  const search=await app.inject('/api/search?q=ALPHA');expect(search.json().items).toHaveLength(0);
 });
 test('authoritative product tables use exact model keys and immutable document snapshots',async()=>{
  const raw={remoteId:'models-test',title:'测试产品规格',rows:[['型号','帧率'],['K1',100],['K18',180]],sourceUrl:'https://example.test/specs'},dataset=await engine.structured.save('test',raw),preview=inspect(raw);
  await engine.structured.confirmMapping(dataset.id,{headerRow:preview.headerRow,fields:preview.fields,productKey:'col_1',isProductTable:true,authority:'authoritative'});
  const p=await project('精确型号'),context=await projects.getContext(p.id),patched=await projects.patchContext(p.id,{revision:context.revision,products:['K1']});await projects.confirmContext(p.id,patched.revision);
  const doc=await engine.create(p.id),cameras=doc.sections.find(s=>s.title==='动捕相机')!;await run(doc,[cameras.id]);
  const generated=(await engine.get(doc.id)).sections.find(s=>s.id===cameras.id)!,table=generated.blocks.find(b=>b.type==='table');expect(table?.type).toBe('table');if(table?.type==='table'){expect(table.rows.every(r=>r[0]==='K1')).toBe(true);expect(table.rows.some(r=>r.includes('180'))).toBe(false);}
  await engine.structured.remove(dataset.id);expect((await engine.validate(doc.id)).some(i=>i.type==='stale_context'&&i.message.includes('产品参数'))).toBe(true);
 });
 test('confirmed user facts drive generated tables while original report and discrepancies remain traceable',async()=>{
  const p=await project('人工修正',undefined,true),before=await projects.getContext(p.id),patched=await projects.patchContext(p.id,{revision:before.revision,facts:[{key:'deployment.equipmentCount',label:'相机数量',value:32,unit:'台'},{key:'performance.p95ErrorMm',label:'P95理论误差',value:.1,unit:'mm'}]});
  expect(patched.engineering?.deployment?.equipmentCount).toBe(2);expect(patched.conflicts.some(c=>c.key==='deployment.equipmentCount')).toBe(true);
  await projects.confirmContext(p.id,patched.revision);const doc=await engine.create(p.id),equipment=doc.sections.find(s=>s.tableKind==='equipment')!,accuracy=doc.sections.find(s=>s.title==='理论精度分析')!;
  const context=await projects.getContext(p.id),equipmentContext=await buildSectionContext(equipment,context,engine.retriever,engine.structured,32000),accuracyContext=await buildSectionContext(accuracy,context,engine.retriever,engine.structured,32000);
  const countTable=deterministicBlocks(equipment,equipmentContext).find(b=>b.type==='table'),accuracyTable=deterministicBlocks(accuracy,accuracyContext).find(b=>b.type==='table');
  expect(countTable).toMatchObject({rows:[['K18','32']]});if(accuracyTable?.type==='table')expect(accuracyTable.rows.find(r=>r[0].includes('P95'))?.[1]).toBe('0.1mm');else throw new Error('missing engineering table');
 });
 test('edited and deleted customer requirements never reappear when adding another source',async()=>{
  const p=await project('要求修正'),input=await projects.addText(p.id,{text:'协议：PTP。\n建设目标：动作采集。'}),requirements=structuredClone(input.context.requirements);
  requirements.protocols= requirements.protocols.map(r=>({...r,value:'NTP'}));requirements.goals=[];
  await projects.patchContext(p.id,{revision:input.context.revision,requirements});const after=await projects.addText(p.id,{text:'安装约束：墙体不可钻孔。'});
  expect(after.context.requirements.protocols.map(r=>r.value)).toEqual(['NTP']);expect(after.context.requirements.goals).toEqual([]);expect(after.context.requirements.installationConstraints.length).toBeGreaterThan(0);
  const local=await projects.queryChunks(p.id,'PTP'),docSource=await engine.retriever.retrieve(p.id,'',[local[0].documentId]),inputSource=await engine.retriever.retrieve(p.id,'',[input.input.id]);expect(docSource.some(s=>s.source.inputId===input.input.id)).toBe(true);expect(inputSource.some(s=>s.source.inputId===input.input.id)).toBe(true);
 });
 test('adding an AI technical diagram retains original edited prose and its overwrite protection',async()=>{
  const p=await project('配图保留人工正文'),doc=await engine.create(p.id),section=doc.sections[0];
  const edited=await engine.edit(doc.id,section.id,{revision:section.revision,blocks:[{type:'paragraph',text:'人工核验并编辑的技术设计说明。'}]}),before=edited.sections[0].blocks;
  // This path starts a real Chromium renderer; allow bounded startup time on
  // shared CI runners while still requiring the actual durable job terminal state.
  const job=await run(edited,[section.id],{mode:'diagram',overwriteEdited:true},25000);expect(job.status).toBe('completed');
  const after=await engine.get(doc.id),updated=after.sections.find(item=>item.id===section.id)!;expect(updated.blocks.filter(block=>block.type!=='diagram')).toEqual(before);expect(updated.blocks.filter(block=>block.type==='diagram')).toHaveLength(1);expect(updated.edited).toBe(true);
  await expect(engine.generate(doc.id,{expectedRevision:after.revision,sectionIds:[section.id],mode:'regenerate'})).rejects.toMatchObject({statusCode:409});
 },30000);
 test('restart preserves job billing reservation and does not automatically repeat in-flight requests',async()=>{
  const p=await project('恢复任务'),doc=await engine.create(p.id),section=doc.sections[0];await engine.close();
  await engine.db.query("INSERT INTO generation_jobs(id,document_id,status,section_ids,targets,config,reserved_cny) VALUES('interrupted-fixture',$1,'running',$2::jsonb,$3::jsonb,$4::jsonb,0.7)",[doc.id,JSON.stringify([section.id]),JSON.stringify([{id:section.id,revision:section.revision}]),JSON.stringify({model:'kimi-k2.6',temperature:.4,maxTokens:2200,maxContextTokens:12000,budgetCny:1})]);
  await engine.db.query("UPDATE document_sections SET status='generating' WHERE id=$1",[section.id]);const before=calls;await engine.start();const job=(await engine.jobs(doc.id))[0];expect(job.status).toBe('interrupted');expect(job.reservedCny).toBe(.7);expect(calls).toBe(before);expect((await engine.get(doc.id)).sections[0].status).toBe('failed');
 });
});
