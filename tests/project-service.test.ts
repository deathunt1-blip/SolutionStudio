import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import JSZip from 'jszip';
import Fastify from 'fastify';
import multipart from '@fastify/multipart';
import { openDatabase, type Database } from '../packages/knowledge/src/database.js';
import { KnowledgeService } from '../packages/knowledge/src/service.js';
import { ProjectService } from '../packages/projects/src/service.js';
import { SceneLabReportAdapter } from '../packages/projects/src/scenelab.js';
import { StructuredService, inspect } from '../packages/structured/src/service.js';
import { DocumentEngine } from '../packages/document-engine/src/service.js';
import { engineeringOpticsConflicts } from '../packages/projects/src/optics.js';
import { buildRequirementRequest, buildRequirementRequests, extractRequirementsAI, parseRequirements, REQUIREMENT_CONTEXT_BYTES } from '../packages/projects/src/requirements.js';
import { modelProfile } from '../packages/llm/src/models.js';
import { registerProjectRoutes } from '../apps/server/src/project-routes.js';
import { createSceneLabFixture as report } from './helpers/scenelab.js';

describe('project sources, contexts and SceneLab boundary',()=>{
 let directory:string,db:Database,knowledge:KnowledgeService,projects:ProjectService;const objects=new Map<string,Uint8Array>();let calls=0;
 beforeAll(async()=>{directory=await mkdtemp(path.join(tmpdir(),'solution-projects-'));db=await openDatabase(directory);knowledge=new KnowledgeService(db,directory,{put:async(key,bytes)=>{objects.set(key,bytes);},get:async key=>{const bytes=objects.get(key);if(!bytes)throw new Error('Missing fixture');return bytes;}},()=>({generate:async()=>{calls++;throw new Error('No real model calls allowed');}}),true);await knowledge.settings.init();projects=new ProjectService(db,knowledge);},30000);
 afterAll(async()=>{await db?.close();if(directory)await rm(directory,{recursive:true,force:true});},30000);

 test('project inputs share parsers and chunks but cannot leak into global or another project',async()=>{
  const a=await projects.create({name:'实验室甲',customerName:'甲客户'}),b=await projects.create({name:'实验室乙'});
  const imported=await projects.addText(a.id,{title:'客户需求',text:'建设目标：完成机器人动作采集。\n项目私有口令ALPHA。精度≤0.1 mm。\n协议：UDP；接口：SDK。'});
  expect(imported.input.status).toBe('ready');expect(imported.context.requirements.performance.accuracy?.sourceInputId).toBe(imported.input.id);
  const document=(await db.query('SELECT scope,project_id,status FROM documents WHERE id=$1',[imported.input.documentId]))[0];expect(document).toEqual({scope:'project',project_id:a.id,status:'active'});
  expect(await projects.queryChunks(a.id,'私有口令ALPHA')).toHaveLength(1);expect(await projects.queryChunks(b.id,'私有口令ALPHA')).toHaveLength(0);
  expect(await projects.queryChunks(a.id,'',8,[imported.input.id])).toHaveLength(1);expect(await projects.queryChunks(b.id,'',8,[imported.input.id])).toHaveLength(0);
  expect(await db.query("SELECT d.id FROM documents d JOIN knowledge_chunks c ON c.document_id=d.id WHERE d.scope='global' AND c.text LIKE '%ALPHA%'" )).toHaveLength(0);
  await expect(projects.downloadInput(b.id,imported.input.id)).rejects.toMatchObject({statusCode:404});expect(calls).toBe(0);
 });

 test('actual SceneLab schema maps enabled cameras, percentages, null precision and image roles without flattening diagnostics',async()=>{
  const parsed=await new SceneLabReportAdapter().parse(await report(), 'project-a','input-a','space.scenelab-report');
  expect(parsed.engineering.scene?.boundaryM).toEqual([12,10,5]);expect(parsed.engineering.deployment).toEqual({equipmentCount:2,models:[{name:'K18',count:2}],opticalConfigurations:[]});expect(parsed.engineering.metadata?.adapterVersion).toBe(2);
  expect(parsed.engineering.performance?.p95ErrorMm).toBe(.4924875942142447);expect(parsed.engineering.performance?.coverageGe2).toBe(99.5);
  expect(parsed.assets.map(a=>a.asset.role)).toContain('accuracy_front');expect(parsed.assets).toHaveLength(6);expect(JSON.stringify(parsed.engineering)).not.toContain('Never publish');
  const absent=await new SceneLabReportAdapter().parse(await report(({analysis})=>{analysis.accuracy_mm={mean:null,p90:null,p95:null};}), 'a','b','null.scenelab-report');expect(absent.engineering.performance?.p95ErrorMm).toBeNull();
 });

 test('optical groups preserve actual simulation values, variants and lenses without substituting catalog defaults',async()=>{
  const bytes=await report(({project})=>{for(const camera of project.cameras.filter((camera:any)=>camera.enabled))camera.camera_model={model_name:'K18 · Standard',hfov_deg:72,vfov_deg:67,focal_length_mm:8,max_working_distance_m:47,range_mode:'passive',catalog:{camera:{model:'K18'},optical:{profile_name:'Standard',hfov_deg:52,vfov_deg:48,focal_length_mm:12,aperture_f:1.4,passive_range_m:30}}};project.cameras.push({...project.cameras[0],id:'narrow',camera_model:{...project.cameras[0].camera_model,hfov_deg:52,vfov_deg:48,focal_length_mm:12,max_working_distance_m:null,catalog:{camera:{model:'K18'},optical:{profile_name:'Narrow'}}}});});
  const {engineering}=await new SceneLabReportAdapter().parse(bytes,'optical-project','optical-input','optical-fixture.scenelab-report');
  expect(engineering.deployment?.models).toEqual([{name:'K18',count:3}]);expect(engineering.deployment?.opticalConfigurations).toHaveLength(2);
  expect(engineering.deployment?.opticalConfigurations?.[0]).toMatchObject({model:'K18',variant:'Standard',lens:{focalLengthMm:8,apertureF:1.4},hfovDeg:72,vfovDeg:67,maxWorkingDistanceM:47,rangeMode:'passive',cameraIds:['a','b'],sourceRef:{type:'engineering_data',id:'optical-input'}});
  expect(engineering.deployment?.opticalConfigurations?.[1]).toMatchObject({variant:'Narrow',lens:{focalLengthMm:12},hfovDeg:52,vfovDeg:48,maxWorkingDistanceM:null,cameraIds:['narrow']});
 });

 test('legacy optical adaptation preserves originals and immutable snapshots; explicit report selection retains both sources',async()=>{
  const structured=new StructuredService(db),raw={remoteId:'optical-spec-fixture',title:'合成相机规格',sourceUrl:'https://example.test/optics',rows:[['型号','产品规格或简称','备注'],['K18','4512x4096@172fps（52°×48°）/Gigabit Ethernet/RJ45/PoE++','追踪距离30m'],['K1','FOV72°×67°','追踪距离47m']]};
  const dataset=await structured.save('synthetic-optics',raw),preview=inspect(raw);await structured.confirmMapping(dataset.id,{headerRow:preview.headerRow,fields:preview.fields.map(field=>({...field,canonicalName:field.sourceHeader})),productKey:'col_1',isProductTable:true,authority:'authoritative'});
  const packageBytes=await report(({project})=>{for(const camera of project.cameras.filter((camera:any)=>camera.enabled))camera.camera_model={...camera.camera_model,hfov_deg:72,vfov_deg:67,focal_length_mm:8,max_working_distance_m:47,range_mode:'passive',catalog:{camera:{model:'K18'},optical:{profile_name:'Standard'}}};});
  const project=await projects.create({name:'光学配置回归'}),imported=await projects.addInput(project.id,{filename:'optical-fixture.scenelab-report',bytes:packageBytes});
  expect(imported.context.conflicts).toHaveLength(2);expect(imported.context.conflicts.every(conflict=>conflict.status==='open'&&conflict.severity==='error')).toBe(true);
  const distanceFact=(await structured.productFacts(['K18'])).find(fact=>fact.field==='备注')!;
  expect(engineeringOpticsConflicts(imported.context,[{...distanceFact,field:'描述',value:'追踪距离30m'}])).toMatchObject([{status:'open',severity:'error',actual:{authoritative:{field:'描述',value:'追踪距离30m'}}}]);
  expect(engineeringOpticsConflicts(imported.context,[{...distanceFact,field:'描述',value:'样例中包含30m；4512x4096@172fps（52°×48°）'}])).toEqual([]);
  expect(imported.context.conflicts.every(conflict=>conflict.sourceRefs.some(ref=>ref.type==='engineering_data')&&conflict.sourceRefs.some(ref=>ref.type==='structured_fact'))).toBe(true);
  expect(imported.context.capabilities.some(capability=>/hfov|vfov|workingdistance/i.test(capability.key))).toBe(false);
  const legacy=structuredClone(imported.context);delete legacy.engineering!.metadata!.adapterVersion;delete legacy.engineering!.deployment!.opticalConfigurations;legacy.lockedFacts=legacy.lockedFacts.filter(fact=>fact.key!=='engineering.opticalConfigurations');legacy.conflicts=[];
  await db.query('UPDATE project_inputs SET engineering_data=$2::jsonb WHERE id=$1',[imported.input.id,JSON.stringify(legacy.engineering)]);await db.query('UPDATE project_context_snapshots SET context=$3::jsonb WHERE project_id=$1 AND revision=$2',[project.id,legacy.revision,JSON.stringify(legacy)]);
  const confirmed=await projects.confirmContext(project.id,legacy.revision),engine=new DocumentEngine(db,knowledge,projects,structured,()=>({generate:async()=>{throw new Error('No generation required');}}));await engine.start();
  const originalGet=knowledge.storage.get;let packageReads=0;
  try{
   const document=await engine.create(project.id),savedSnapshot=(await db.query('SELECT context_snapshot FROM generated_documents WHERE id=$1',[document.id]))[0].context_snapshot,oldContext=(await db.query('SELECT context FROM project_context_snapshots WHERE project_id=$1 AND revision=$2',[project.id,confirmed.revision]))[0].context;
   const assetsBefore=await db.query('SELECT * FROM project_assets WHERE input_id=$1 ORDER BY id',[imported.input.id]),inputBefore=(await db.query('SELECT object_key,content_hash FROM project_inputs WHERE id=$1',[imported.input.id]))[0],objectKeysBefore=[...objects.keys()].sort(),factsBefore=await structured.productFacts(['K18']);
   knowledge.storage.get=async key=>{if(key===inputBefore.object_key)packageReads++;return originalGet(key);};
   const upgraded=await projects.rebuildContext(project.id);expect(upgraded.revision).toBe(confirmed.revision+1);expect(upgraded.confirmed).toBe(false);expect(upgraded.engineering?.metadata?.adapterVersion).toBe(2);expect(upgraded.engineering?.deployment?.opticalConfigurations?.[0]).toMatchObject({hfovDeg:72,vfovDeg:67,maxWorkingDistanceM:47,lens:{focalLengthMm:8}});
   expect(upgraded.conflicts).toHaveLength(2);expect((await engine.get(document.id)).contextStale).toBe(true);expect((await db.query('SELECT context_snapshot FROM generated_documents WHERE id=$1',[document.id]))[0].context_snapshot).toEqual(savedSnapshot);
   expect((await db.query('SELECT context FROM project_context_snapshots WHERE project_id=$1 AND revision=$2',[project.id,confirmed.revision]))[0].context).toEqual(oldContext);
   expect(await db.query('SELECT * FROM project_assets WHERE input_id=$1 ORDER BY id',[imported.input.id])).toEqual(assetsBefore);expect(upgraded.assets.map(asset=>asset.id).sort()).toEqual(assetsBefore.map(asset=>asset.id).sort());
   expect((await db.query('SELECT object_key,content_hash FROM project_inputs WHERE id=$1',[imported.input.id]))[0]).toEqual(inputBefore);expect(Buffer.from(objects.get(inputBefore.object_key)!)).toEqual(Buffer.from(packageBytes));expect([...objects.keys()].sort()).toEqual(objectKeysBefore);
   const selected=await projects.patchContext(project.id,{revision:upgraded.revision,facts:[{key:'engineering.opticsSource',label:'工程光学配置来源',value:'report'}]});
   expect(selected.conflicts).toHaveLength(2);expect(selected.conflicts.every(conflict=>conflict.status==='resolved'&&conflict.severity==='warning')).toBe(true);expect(selected.conflicts.every(conflict=>conflict.message.includes('报告')&&conflict.message.includes('实测'))).toBe(true);
   expect(selected.engineering?.deployment?.opticalConfigurations).toEqual(upgraded.engineering?.deployment?.opticalConfigurations);expect(await structured.productFacts(['K18'])).toEqual(factsBefore);
   const rebuilt=await projects.rebuildContext(project.id);expect(rebuilt.lockedFacts.find(fact=>fact.key==='engineering.opticsSource')).toMatchObject({value:'report',sourceType:'user'});expect(rebuilt.conflicts.every(conflict=>conflict.status==='resolved')).toBe(true);expect(packageReads).toBe(1);expect(await db.query("SELECT id FROM project_audit_events WHERE project_id=$1 AND action='engineering_adapter_upgraded'",[project.id])).toHaveLength(1);
  }finally{knowledge.storage.get=originalGet;await engine.close();await structured.remove(dataset.id);}
 });

 test('malformed, stale, path-traversing and invalid-unit packages are rejected before imports affect engineering',async()=>{
  const adapter=new SceneLabReportAdapter();
  for(const edit of [({analysis}:any)=>{analysis.scheme_revision=30;},({analysis}:any)=>{analysis.settings.boundary_m=[12,10,6];},({analysis}:any)=>{analysis.coverage_percent.ge1=101;},({project}:any)=>{project.units.accuracy='m';},({zip}:any)=>{zip.file('../escape.txt','no');}])await expect(adapter.parse(await report(edit),'p','i','invalid.scenelab-report')).rejects.toMatchObject({statusCode:400});
  const corruptZip=await JSZip.loadAsync(await report());const corruptPng=await corruptZip.file('images/deployment_perspective.png')!.async('uint8array');corruptPng[25]^=1;corruptZip.file('images/deployment_perspective.png',corruptPng);await expect(adapter.parse(await corruptZip.generateAsync({type:'uint8array'}),'p','i','corrupt-image.scenelab-report')).rejects.toThrow('PNG 图片校验失败');
  const project=await projects.create({name:'失败导入'});const result=await projects.addInput(project.id,{filename:'bad.scenelab-report',bytes:Buffer.from('not a zip')});expect(result.input.status).toBe('failed');expect(result.context.engineering).toBeUndefined();expect((await projects.downloadInput(project.id,result.input.id)).bytes).toEqual(Buffer.from('not a zip'));
 });

 test('customer requirement remains distinct from engineering capability and surfaces precision conflicts',async()=>{
  const project=await projects.create({name:'小空间高精度'});await projects.addText(project.id,{text:'建设目标：空间高精度定位。客户要求精度≤0.1 mm。'});
  const imported=await projects.addInput(project.id,{filename:'A.scenelab-report',bytes:await report()});const context=imported.context;
  expect(context.products).toEqual(['K18']);expect(context.conflicts).toHaveLength(1);expect(context.conflicts[0].message).toContain('不能声明已满足');
  expect(context.requirements.performance.accuracy?.value).toContain('0.1 mm');expect(context.capabilities.find(c=>c.key==='p95ErrorMm')?.value).toBe(.4924875942142447);
  for(const key of ['under03Mm','under05Mm']){expect(context.lockedFacts.find(f=>f.key===`performance.${key}`)?.unit).toBe('%');expect(context.capabilities.find(c=>c.key===key)?.unit).toBe('%');}
  expect(context.lockedFacts.find(f=>f.key==='performance.p95ErrorMm')?.unit).toBe('mm');
  expect(context.requirements.performance.frameRate).toBeUndefined();expect(context.unresolved.some(q=>q.key==='frameRate')).toBe(true);
  const confirmed=await projects.confirmContext(project.id,context.revision);expect(confirmed.confirmed).toBe(true);expect(confirmed.conflicts).toHaveLength(1);
  const other=await projects.create({name:'其他项目'});await expect(projects.downloadAsset(other.id,context.assets[0].id)).rejects.toMatchObject({statusCode:404});
 });

 test('confirmation uses current revisions and fresh uploads invalidate a previously confirmed context',async()=>{
  const project=await projects.create({name:'未完整需求',description:'评估人体动作采集'});let context=await projects.getContext(project.id);context=await projects.confirmContext(project.id,context.revision);expect(context.confirmed).toBe(true);
  const previous=context.revision;const upload=await projects.addText(project.id,{text:'接口：SDK。建设目标：采集运动轨迹。'});expect(upload.context.revision).toBeGreaterThan(previous);expect(upload.context.confirmed).toBe(false);
  await expect(projects.confirmContext(project.id,previous)).rejects.toMatchObject({statusCode:409});
  await expect(projects.patchContext(project.id,{revision:previous,summary:'stale edit'})).rejects.toMatchObject({statusCode:409});
  // In-flight input changes cannot be confirmed through the old context before its rebuild finishes.
  await db.query('UPDATE projects SET input_revision=input_revision+1 WHERE id=$1',[project.id]);await expect(projects.confirmContext(project.id,upload.context.revision)).rejects.toMatchObject({statusCode:409});expect((await projects.getContext(project.id)).confirmed).toBe(false);
 });

 test('user corrections, explicit product selection and confirmed facts survive later extraction',async()=>{
  const project=await projects.create({name:'用户修正'});let context=(await projects.addText(project.id,{text:'建设目标：机器人遥操作。精度≤0.5 mm。'})).context;
  const requirements=structuredClone(context.requirements);requirements.performance.accuracy!.value='精度≤0.2 mm';
  context=await projects.patchContext(project.id,{revision:context.revision,summary:'人工核准的机器人系统项目',requirements,products:['K18','K18'],facts:[{key:'deployment.equipmentCount',label:'相机数量',value:16,unit:'台'}]});
  expect(context.requirements.performance.accuracy?.sourceInputId).toBe('user');expect(context.products).toEqual(['K18']);
  const later=(await projects.addText(project.id,{text:'接口：RJ45。补充供电约束。'})).context;
  expect(later.summary).toBe('人工核准的机器人系统项目');expect(later.products).toEqual(['K18']);expect(later.requirements.performance.accuracy?.value).toBe('精度≤0.2 mm');expect(later.lockedFacts.find(f=>f.key==='deployment.equipmentCount')).toMatchObject({value:16,sourceType:'user',locked:true});
 });

 test('AI extraction discards unsupported values, forged source IDs, and engineering decisions',async()=>{
  const source={id:'input-1',text:'客户要求精度≤0.1 mm。接口：SDK。',chunks:[{id:'chunk-1',text:'客户要求精度≤0.1 mm。接口：SDK。'}]};
  const requirements=await extractRequirementsAI([source],{generate:async()=>({content:JSON.stringify({items:[{category:'performance.cameraCount',value:'48台',sourceInputId:'input-1',evidence:'建议48台相机'},{category:'performance.frameRate',value:'1000fps',sourceInputId:'other-project',evidence:'1000fps'},{category:'interfaces',value:'SDK',sourceInputId:'input-1',evidence:'接口：SDK。'}]})})});
  expect(requirements.performance.cameraCount).toBeUndefined();expect(requirements.performance.frameRate).toBeUndefined();expect(requirements.interfaces.some(item=>item.value==='SDK')).toBe(true);expect(requirements.unresolved.length).toBeGreaterThan(0);
  expect(parseRequirements([{id:'empty',text:'请帮忙设计方案',chunks:[]}]).performance).toEqual({});
  const pending=parseRequirements([{id:'pending',text:'客户精度要求≤0.1 mm。采集帧率待确认。',chunks:[]}]);expect(pending.unresolved.some(q=>q.key==='frameRate')).toBe(true);expect(pending.unresolved.some(q=>q.key==='accuracy')).toBe(false);
  const bounded=buildRequirementRequest([{id:'large',text:'大型需求\"\\'.repeat(20000),chunks:[]}],24000);expect(bounded.inputBytes).toBeLessThanOrEqual(24000);expect(Buffer.byteLength(bounded.request.system+bounded.request.prompt)).toBe(bounded.inputBytes);
 });

 test('default AI extraction includes all project material across model-sized batches',async()=>{
  const sources=Array.from({length:13},(_,index)=>({id:`input-${index}`,text:index===0?'大型需求😀。\n'.repeat(80000):`来源${index}：接口 SDK${index}。`,chunks:[]}));
  expect(REQUIREMENT_CONTEXT_BYTES).toBe(916480);
  const requests=buildRequirementRequests(sources);expect(requests.length).toBeGreaterThan(1);const reconstructed=new Map<string,string>();
  for(const {request,inputBytes} of requests){expect(inputBytes).toBeLessThanOrEqual(REQUIREMENT_CONTEXT_BYTES);expect(Buffer.byteLength(request.system+request.prompt)).toBe(inputBytes);for(const source of JSON.parse(request.prompt).sources)reconstructed.set(source.id,(reconstructed.get(source.id)||'')+source.text);}
  for(const source of sources)expect(reconstructed.get(source.id)).toBe(source.text);
  let calls=0;const extracted=await extractRequirementsAI(sources,{generate:async request=>{calls++;const items=JSON.parse(request.prompt).sources.some((source:any)=>source.id==='input-12')?[{category:'interfaces',value:'SDK12',sourceInputId:'input-12',evidence:'接口 SDK12。'}]:[];return {content:JSON.stringify({items})};}});
  expect(calls).toBe(requests.length);expect(extracted.interfaces.some(item=>item.value==='SDK12')).toBe(true);
  const limited=buildRequirementRequests(sources,{limitsEnabled:true});expect(limited).toHaveLength(1);expect(limited[0].inputBytes).toBeLessThanOrEqual(24000);
  const legacy=buildRequirementRequests(sources,{model:'kimi-k2.6'});expect(legacy.length).toBeGreaterThan(requests.length);expect(legacy.every(item=>item.inputBytes<=228352)).toBe(true);
 });

 test('default AI extraction continues above the old allowance while recording usage and keeping full project material',async()=>{
  const project=await projects.create({name:'默认不限额'});const text='普通材料说明。\n'.repeat(5000)+'尾部要求：接口 SDK-TAIL。';await projects.addText(project.id,{text});
  const original=knowledge.settings.config.bind(knowledge.settings);let requestCount=0;
  knowledge.settings.config=async()=>({baseUrl:'https://api.moonshot.cn/v1',apiKey:'synthetic-test-key',model:'kimi-k2.6',temperature:.9,maxTokens:999});
  const extracting=new ProjectService(db,knowledge,config=>{expect(config).toMatchObject({model:'kimi-k3',temperature:1,maxTokens:131072,requestTimeoutMs:600000,reasoningEffort:'max'});return {generate:async request=>{requestCount++;expect(Buffer.byteLength(request.system+request.prompt)).toBeGreaterThan(24000);expect(request.prompt).toContain('SDK-TAIL');return {content:'{"items":[]}',usage:{inputTokens:20000,outputTokens:20}};}};});
  try{await db.query("INSERT INTO settings(key,value) VALUES('projectExtractionBudget','{\"reservedCny\":100}'::jsonb) ON CONFLICT(key) DO UPDATE SET value=excluded.value");await extracting.rebuildContext(project.id,{useAI:true});expect(requestCount).toBe(1);
   expect((await db.query("SELECT value FROM settings WHERE key='projectExtractionBudget'"))[0].value.reservedCny).toBeGreaterThan(100);
   expect((await db.query("SELECT next_value FROM project_audit_events WHERE project_id=$1 AND action='requirement_extraction_reserved'",[project.id]))[0].next_value).toMatchObject({limitsEnabled:false,maxOutputTokens:131072,batchCount:1,model:'kimi-k3'});
   expect(await db.query("SELECT id FROM project_audit_events WHERE project_id=$1 AND action='requirement_extraction_usage'",[project.id])).toHaveLength(1);
  }finally{knowledge.settings.config=original;await db.query("UPDATE settings SET value='{\"reservedCny\":0}'::jsonb WHERE key='projectExtractionBudget'");}
 });

 test('opt-in AI extraction reserves a shared durable budget before calls and keeps reservations after failure',async()=>{
  const project=await projects.create({name:'预算测试'});await projects.addText(project.id,{text:'建设目标：人体动作采集。精度≤0.2 mm。'});
  const original=knowledge.settings.config.bind(knowledge.settings);let requestCount=0,fail=false;let supplied:any;
  knowledge.settings.config=async()=>({baseUrl:'https://api.moonshot.cn/v1',apiKey:'synthetic-test-key',model:'kimi-k2.6',temperature:.9,maxTokens:999});
  const extracting=new ProjectService(db,knowledge,config=>{supplied=config;return {generate:async request=>{requestCount++;expect(Buffer.byteLength(request.system+request.prompt)).toBeLessThanOrEqual(24000);if(fail)throw new Error('Synthetic failure');return {content:'{"items":[]}',usage:{inputTokens:100,outputTokens:20}};}};});
  try{await extracting.rebuildContext(project.id,{useAI:true,limitsEnabled:true});expect(requestCount).toBe(1);expect(supplied).toMatchObject({temperature:1,maxTokens:4000,model:'kimi-k3',reasoningEffort:'max'});
   const reserved=(await db.query("SELECT value FROM settings WHERE key='projectExtractionBudget'"))[0].value.reservedCny;expect(reserved).toBeGreaterThan(0);
   const audit=(await db.query("SELECT next_value FROM project_audit_events WHERE project_id=$1 AND action='requirement_extraction_reserved'",[project.id]))[0].next_value,profile=modelProfile('kimi-k3');expect(audit.reservedCny).toBeCloseTo(((audit.inputBytes+1024)*(profile.inputCnyPerMillion+profile.cacheWriteCnyPerMillion)+4000*profile.outputCnyPerMillion)*3/1000000,8);
   fail=true;const previous=(await projects.getContext(project.id)).revision;await expect(extracting.rebuildContext(project.id,{useAI:true,limitsEnabled:true})).rejects.toMatchObject({statusCode:502});expect((await projects.getContext(project.id)).revision).toBe(previous);
   expect((await db.query("SELECT value FROM settings WHERE key='projectExtractionBudget'"))[0].value.reservedCny).toBeGreaterThan(reserved);
   await db.query("UPDATE settings SET value='{\"reservedCny\":24.999}'::jsonb WHERE key='projectExtractionBudget'");await expect(extracting.rebuildContext(project.id,{useAI:true,limitsEnabled:true})).rejects.toMatchObject({statusCode:409});expect(requestCount).toBe(2);
   expect(await db.query("SELECT id FROM project_audit_events WHERE project_id=$1 AND action='requirement_extraction_usage'",[project.id])).toHaveLength(1);
  }finally{knowledge.settings.config=original;}
 });

 test('project extraction uses K2.6 only when explicitly selected',async()=>{
  const project=await projects.create({name:'显式旧模型'});await projects.addText(project.id,{text:'接口：SDK。'});
  const original=knowledge.settings.config.bind(knowledge.settings);let supplied:any;
  knowledge.settings.config=async()=>({baseUrl:'https://api.moonshot.cn/v1',apiKey:'synthetic-test-key',model:'kimi-k3',temperature:1,maxTokens:131072});
  const extracting=new ProjectService(db,knowledge,config=>{supplied=config;return {generate:async()=>({content:'{"items":[]}'})};});
  try{await extracting.rebuildContext(project.id,{useAI:true,model:'kimi-k2.6'});expect(supplied).toMatchObject({model:'kimi-k2.6',temperature:.6,maxTokens:32768,requestTimeoutMs:180000});expect(supplied.reasoningEffort).toBeUndefined();}
  finally{knowledge.settings.config=original;}
 });

 test('project HTTP contract wraps objects and validates malformed edits and missing projects',async()=>{
  const app=Fastify();app.setErrorHandler((error:any,_request,reply)=>reply.code(error.statusCode||500).send({message:error.message}));await app.register(multipart);await registerProjectRoutes(app,projects);
  try{const response=await app.inject({method:'POST',url:'/api/projects',payload:{name:'HTTP 项目',description:'测试项目流程'}});expect(response.statusCode).toBe(200);const project=response.json().project;expect(project.companyName).toBe('上海青瞳视觉科技有限公司');
   const context=(await app.inject({method:'GET',url:`/api/projects/${project.id}/context`})).json().context;expect(context.confirmed).toBe(false);
   expect((await app.inject({method:'POST',url:`/api/projects/${project.id}/confirm-context`,payload:{revision:context.revision}})).json().context.confirmed).toBe(true);
   expect((await app.inject({method:'PATCH',url:`/api/projects/${project.id}/context`,payload:{revision:context.revision,engineering:{invented:true}}})).statusCode).toBe(400);
   expect((await app.inject({method:'POST',url:`/api/projects/${project.id}/parse-context`,payload:{useAI:false,limitsEnabled:false}})).statusCode).toBe(200);
   expect((await app.inject({method:'POST',url:`/api/projects/${project.id}/parse-context`,payload:{useAI:false,model:'kimi-k3'}})).statusCode).toBe(200);
   expect((await app.inject({method:'POST',url:`/api/projects/${project.id}/parse-context`,payload:{model:'unsupported'}})).statusCode).toBe(400);
   expect((await app.inject({method:'POST',url:`/api/projects/${project.id}/parse-context`,payload:{limitsEnabled:'false'}})).statusCode).toBe(400);
   expect((await app.inject({method:'GET',url:'/api/projects/no-such-project'})).statusCode).toBe(404);
  }finally{await app.close();}
 });
});
