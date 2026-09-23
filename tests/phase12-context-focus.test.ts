import {afterAll,beforeAll,describe,expect,test} from 'vitest';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createApp} from '../apps/server/src/app.js';
import {buildSectionContext,type DocumentRetriever} from '../packages/document-engine/src/context.js';
import {parseGeneration} from '../packages/document-engine/src/blocks.js';
import {validateSections} from '../packages/document-engine/src/validation.js';
import {customerFacingProblems} from '../packages/document-engine/src/customer-facing.js';
import type {DocumentEngine} from '../packages/document-engine/src/service.js';
import type {ProjectService} from '../packages/projects/src/service.js';
import type {DocumentSection} from '../packages/document-engine/src/types.js';
import type {LockedFact,ProjectContext,RequirementItem} from '../packages/projects/src/types.js';
import type {StructuredFact,StructuredService} from '../packages/structured/src/service.js';

const chapter=(title:string):DocumentSection=>({id:'chapter',title,level:2,order:0,generationMode:'ai',requiredContext:['requirements','engineering','products'],status:'empty',blocks:[],sourceRefs:[],assetRefs:[],lockedFactRefs:[],claims:[],revision:1,edited:false});
const requirement=(id:string,value:string):RequirementItem=>({id,key:id,value,sourceInputId:'input',sourceChunkId:id+'-chunk',evidence:value,confidence:1,confirmedByUser:true});
const source={type:'engineering_data' as const,id:'report',label:'当前工程报告'};
const fact=(key:string,value:unknown,unit?:string):LockedFact=>({id:key,key,label:key,value,unit,sourceType:'engineering_data',sourceRef:source,locked:true});
const productFact=(id:string,field:string,value:unknown):StructuredFact=>({id,productKey:'K18',field,value,authority:'authoritative',sourceDatasetId:'dataset',sourceRecordId:id,sourceRef:{sourceUrl:'https://example.invalid/sheet',rowIndex:1},updatedAt:'2026-09-24T00:00:00Z'});
function context():ProjectContext&{structuredFacts:StructuredFact[]}{return {
 projectId:'focus-test',revision:1,confirmed:true,summary:'面向机器人运动分析，建立运动采集和数据处理能力。',
 requirements:{goals:[requirement('goal','实现机器人运动分析')],performance:{accuracy:requirement('accuracy','0.2mm'),coverage:requirement('coverage','覆盖率90%'),cameraCount:requirement('cameraCount','30台')},interfaces:[requirement('sdk','提供SDK输出')],protocols:[],environment:[requirement('environment','室内实验室')],installationConstraints:[requirement('install','墙体不能钻孔')],specialRequirements:[],acceptanceCriteria:[],unresolved:[]},
 lockedFacts:[fact('project.application','机器人运动分析'),fact('project.customWorkflow','提供训练数据集'),fact('deployment.equipmentCount',30,'台'),fact('deployment.models',[{name:'K18',count:30}]),fact('scene.boundaryM',[20,10,3.1],'m'),fact('performance.coverageGe2',98.765,'%'),fact('performance.averageViewCount',6.543),fact('performance.p95ErrorMm',.18765,'mm'),fact('performance.meanErrorMm',.09876,'mm'),fact('engineering.opticsSource','report')],products:['K18'],capabilities:[],assets:[],conflicts:[],unresolved:[],
 engineering:{sourceType:'scenelab',sourceRef:source,assets:[],scene:{boundaryM:[20,10,3.1]},deployment:{equipmentCount:30,models:[{name:'K18',count:30}],opticalConfigurations:[{model:'K18',lens:{focalLengthMm:12},hfovDeg:53.123,vfovDeg:48.123,cameraIds:[],sourceRef:source}]},performance:{coverageGe2:98.765,averageViewCount:6.543,p95ErrorMm:.18765,meanErrorMm:.09876},metadata:{accuracyMetric:'theoretical RMS',coverageUnit:'sampled volume percentage'}},
 structuredFacts:[productFact('spec-resolution','分辨率','4608×4096'),productFact('spec-fov','视场角','52°×48°'),productFact('spec-sdk','SDK接口','SDK输出位姿'),productFact('spec-sync','同步','硬件触发')],
};}
const structured={productFacts:async()=>[]} as unknown as StructuredService;
const emptyRetriever={retrieve:async()=>[],sections:async()=>[]} as unknown as DocumentRetriever;
async function build(title:string,c=context(),retriever=emptyRetriever){const sc=await buildSectionContext(chapter(title),c,retriever,structured,40000);return {sc,prompt:JSON.parse(sc.prompt)};}

describe('chapter-focused writer context retains the complete immutable fact snapshot',()=>{
 test('overview retains business goals and project scale without detailed optics, simulations or product parameters',async()=>{
  const {sc,prompt}=await build('项目概述');expect(prompt.projectFacts.map((f:any)=>f.id)).toEqual(['project.application','project.customWorkflow','deployment.equipmentCount','deployment.models']);
  expect(prompt.customerRequirements.map((f:any)=>f.id)).toContain('goal');expect(prompt.structuredFacts).toEqual([]);expect(prompt.reportOptics).toEqual([]);expect(prompt.engineeringFacts).toBeUndefined();
  for(const hidden of ['98.765','6.543','0.18765','0.09876','53.123','4608×4096','52°×48°'])expect(sc.prompt).not.toContain(hidden);
  expect(prompt.sectionBrief.factsToUse).toEqual(prompt.projectFacts.map((f:any)=>f.id));expect(prompt.projectFacts.find((f:any)=>f.id==='deployment.equipmentCount').value).toBe(30);
 });
 test.each(['应用背景','建设目标'])('%s receives business facts without engineering statistics',async title=>{
  const {sc,prompt}=await build(title);expect(prompt.projectFacts.map((f:any)=>f.id)).toEqual(['project.application','project.customWorkflow']);expect(prompt.engineeringFacts).toBeUndefined();expect(prompt.reportOptics).toEqual([]);expect(prompt.structuredFacts).toEqual([]);for(const value of ['98.765','0.18765','53.123'])expect(sc.prompt).not.toContain(value);
 });
 test('coverage and accuracy receive only their own engineering results and matching requirements',async()=>{
  const coverage=await build('捕捉覆盖设计'),accuracy=await build('理论精度分析');
  expect(coverage.prompt.engineeringFacts.performance).toEqual({coverageGe2:98.765,averageViewCount:6.543});expect(accuracy.prompt.engineeringFacts.performance).toEqual({p95ErrorMm:.18765,meanErrorMm:.09876});
  expect(coverage.prompt.customerRequirements.map((r:any)=>r.id)).toContain('coverage');expect(coverage.prompt.customerRequirements.map((r:any)=>r.id)).not.toContain('accuracy');expect(accuracy.prompt.customerRequirements.map((r:any)=>r.id)).toContain('accuracy');expect(accuracy.prompt.customerRequirements.map((r:any)=>r.id)).not.toContain('coverage');
  expect(coverage.sc.prompt).not.toContain('0.18765');expect(accuracy.sc.prompt).not.toContain('98.765');
 });
 test('unknown roles preserve business inputs and engineering facts while the original context is untouched',async()=>{
  const c=context(),before=structuredClone(c),{sc,prompt}=await build('专题附录',c);
  expect(prompt.projectFacts.map((f:any)=>f.id)).toEqual(c.lockedFacts.filter(f=>!f.key.startsWith('engineering.optics')).map(f=>f.id));expect(prompt.engineeringFacts.performance).toEqual(c.engineering!.performance);expect(prompt.structuredFacts).toHaveLength(4);expect(sc.context).toBe(c);expect(c).toEqual(before);
 });
 test('allowed fact IDs exactly match writer-visible facts, but validation still checks the full snapshot',async()=>{
  const c=context(),{sc,prompt}=await build('项目概述',c),visible=[...prompt.projectFacts,...prompt.customerRequirements,...prompt.structuredFacts].map((f:any)=>f.id);
  expect(sc.factIds).toEqual(visible);expect(sc.factIds).not.toContain('performance.p95ErrorMm');
  expect(()=>parseGeneration(JSON.stringify({content:[{type:'paragraph',text:'技术说明'}],used_fact_ids:['performance.p95ErrorMm'],used_knowledge_refs:[],used_asset_refs:[],claims:[]}),sc)).toThrow('无效引用');
  const docSection={...chapter('项目概述'),blocks:[{id:'mismatch',type:'paragraph' as const,text:'P95理论误差为0.9mm。'}]};
  expect(validateSections([docSection],sc.context).some(issue=>issue.type==='fact_mismatch'&&issue.quote==='0.9mm')).toBe(true);
 });
 test('introductory chapters do not reintroduce detailed product parameters through authoritative chunk retrieval',async()=>{
  const text='K18 分辨率4608×4096，采样170fps，镜头8mm，视场角52°×48°。',retriever={sections:async()=>[],retrieve:async()=>[{documentId:'manual',score:10,text,source:{id:'manual-chunk',type:'knowledge_chunk',label:'K18产品技术手册',evidence:text,authority:'authoritative'}}]} as unknown as DocumentRetriever;
  const {sc,prompt}=await build('项目概述',context(),retriever);expect(prompt.authoritativeEvidence).toEqual([]);expect(sc.prompt).not.toContain('170fps');expect(sc.sources.some(s=>s.id==='manual-chunk')).toBe(false);
 });
 test('business fact labels can appear in prose while explicit historical document titles remain private',async()=>{
  const c=context(),label='主动标记手套传感单元';c.lockedFacts.push({id:'glove-fact',key:'project.glove',label,value:label,sourceType:'historical_reconstruction',locked:true,sourceRef:{type:'project_input',id:'glove-source',label,evidence:label}});
  const {sc}=await build('项目概述',c),blocks=[{id:'body',type:'paragraph' as const,text:'主动标记手套传感单元用于手部运动数据采集。'}];
  expect(sc.sources.find(source=>source.id==='glove-source')?.labelKind).toBe('fact');expect(customerFacingProblems(blocks,sc.sources)).toEqual([]);
  const documentSource={id:'private-history',type:'knowledge_section' as const,label:'某历史客户机器人项目技术方案 · 总体设计',labelKind:'document' as const,evidence:'历史资料',use:'writing_reference' as const};
  expect(customerFacingProblems([{id:'leak',type:'paragraph',text:'某历史客户机器人项目技术方案中的设计可复用。'}],[documentSource])).toHaveLength(1);
 });
});

describe('high-risk claim export API gate',()=>{
 let directory:string,app:Awaited<ReturnType<typeof createApp>>,engine:DocumentEngine,projects:ProjectService;
 beforeAll(async()=>{directory=await mkdtemp(join(tmpdir(),'studio-focus-export-'));app=await createApp({dataDir:directory,llmDisabled:true,providerFactory:()=>({generate:async()=>{throw Error('Model calls are forbidden in this test');}})});engine=(app as any).documentEngine;projects=(app as any).projects;},30000);
 afterAll(async()=>{await app?.close();await rm(directory,{recursive:true,force:true});},30000);
 test('edited forbidden promises get 422 and cannot be hidden by warning-only numeric checks',async()=>{
  const project=await projects.create({name:'高风险导出测试',description:'建设目标：完成机器人运动分析。'});await projects.confirmContext(project.id,(await projects.getContext(project.id)).revision);let doc=await engine.create(project.id);
  for(const text of ['通过预测补全实现无损真实测量。','所有节点实现零误差同步。','任意遮挡条件下测量性能不变。']){
   doc=await engine.edit(doc.id,doc.sections[0].id,{revision:doc.sections[0].revision,blocks:[{type:'paragraph',text}]});
   expect(doc.issues.some(issue=>issue.type==='prohibited_claim'&&issue.severity==='error')).toBe(true);
   const exported=await app.inject(`/api/generated-documents/${doc.id}/export.docx`);expect(exported.statusCode).toBe(422);expect(exported.json().message).toContain('不当技术承诺');
  }
  doc=await engine.edit(doc.id,doc.sections[0].id,{revision:doc.sections[0].revision,blocks:[{type:'paragraph',text:'同步链路不能保证零误差同步，实施时通过联调核对时间对齐情况。'}]});
  expect(doc.issues.some(issue=>issue.type==='prohibited_claim')).toBe(false);expect((await app.inject(`/api/generated-documents/${doc.id}/export.docx`)).statusCode).toBe(200);
 });
});
