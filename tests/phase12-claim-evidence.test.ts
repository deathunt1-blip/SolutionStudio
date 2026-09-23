import {afterAll,beforeAll,describe,expect,test} from 'vitest';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {claimEvidenceProblems} from '../packages/document-engine/src/claim-evidence.js';
import {parseGeneration} from '../packages/document-engine/src/blocks.js';
import {validateSections} from '../packages/document-engine/src/validation.js';
import {createApp} from '../apps/server/src/app.js';
import type {DocumentEngine} from '../packages/document-engine/src/service.js';
import type {ProjectService} from '../packages/projects/src/service.js';
import type {ProjectContext,LockedFact} from '../packages/projects/src/types.js';
import type {StructuredFact} from '../packages/structured/src/types.js';
import type {Claim,DocumentSection,SourceRef} from '../packages/document-engine/src/types.js';

const project=():ProjectContext=>({projectId:'project',revision:1,confirmed:true,summary:'XR摄像机追踪',requirements:{goals:[],performance:{},interfaces:[],protocols:[],environment:[],installationConstraints:[],specialRequirements:[],acceptanceCriteria:[],unresolved:[]},lockedFacts:[],products:['MC4000'],capabilities:[],assets:[],conflicts:[],unresolved:[]});
const history:SourceRef={type:'knowledge_section',id:'history',label:'无人机历史项目 · 标记设计',evidence:'每个目标安装四个及以上反光刚体标记。',authority:'reference',use:'writing_reference'};
const assertion=(kind:Claim['kind']='capability'):Claim=>({text:'摄像机机身安装四个及以上反光刚体标记。',kind,factIds:[],sourceIds:[history.id]});
const section=(claim:Claim):DocumentSection=>({id:'chapter',title:'追踪装置设计',level:1,order:0,generationMode:'ai',requiredContext:[],status:'generated',revision:1,edited:false,sourceRefs:[history],lockedFactRefs:[],assetRefs:[],claims:[claim],blocks:[{id:'body',type:'paragraph',text:claim.text}]});
const fact=(sourceType:LockedFact['sourceType']='user'):LockedFact=>({id:'layout',key:'marker.layout',label:'标记布置',value:'四个及以上反光刚体标记',sourceType,sourceRef:{type:'user',id:'reviewed-layout',label:'标记布置',evidence:'摄像机机身安装四个及以上反光刚体标记。'},locked:true});
const structured:StructuredFact={id:'product-fact',productKey:'MC4000',field:'数据接口',value:'Ethernet',authority:'authoritative',sourceDatasetId:'table',sourceRecordId:'row',sourceRef:{sourceUrl:'https://example.test/sheet',rowIndex:1},updatedAt:''};

describe('claim evidence roles',()=>{
 test.each(['capability','engineering'] as const)('rejects %s declarations whose only evidence is a historical writing reference',kind=>{
  expect(claimEvidenceProblems([assertion(kind)],project(),[history])).toHaveLength(1);
  expect(validateSections([section(assertion(kind))],project()).some(issue=>issue.type==='unsupported_claim'&&issue.quote===assertion().text&&issue.blockId==='body')).toBe(true);
 });
 test('authority on a standard does not establish selected-product capability',()=>{
  const source:SourceRef={type:'knowledge_chunk',id:'standard',label:'机器人技术规范',evidence:'MC4000系统应支持四种重定向模式。',authority:'authoritative',use:'fact_evidence'};
  expect(claimEvidenceProblems([{...assertion(),text:'本系统支持四种重定向模式。',sourceIds:[source.id]}],project(),[source])).toHaveLength(1);
 });
 test('customer requirement IDs, including confirmed and legacy locked requirements, cannot establish capability',()=>{
  const context=project();context.requirements.specialRequirements=[{id:'requested',value:'支持四种重定向模式',sourceInputId:'customer',evidence:'客户要求支持四种重定向模式',confidence:1,confirmedByUser:true}];context.lockedFacts=[fact('customer_requirement')];
  const source:SourceRef={type:'project_input',id:'customer',label:'客户要求',labelKind:'requirement',evidence:'客户要求支持四种重定向模式',authority:'customer_requirement'};
  expect(claimEvidenceProblems([{...assertion(),factIds:['requested','layout'],sourceIds:[source.id]}],context,[source])).toHaveLength(1);
  expect(claimEvidenceProblems([{...assertion('requirement'),factIds:['requested'],sourceIds:[source.id]}],context,[source])).toEqual([]);
 });
 test.each(['user','engineering_data','historical_reconstruction'] as const)('accepts explicitly cited reviewed project facts from %s',sourceType=>{
  const context=project();context.lockedFacts=[fact(sourceType)];expect(claimEvidenceProblems([{...assertion(),factIds:['layout']}],context,[history])).toEqual([]);
 });
 test('does not borrow unrelated chapter evidence that the assertion never cited',()=>{
  const context=project();context.lockedFacts=[fact()];expect(claimEvidenceProblems([assertion()],context,[history,{...fact().sourceRef,evidence:'布置',labelKind:'fact'}])).toHaveLength(1);
 });
 test('accepts exact selected-model authoritative structured facts, not another model or a reference table',()=>{
  const claim={...assertion(),factIds:[structured.id]};expect(claimEvidenceProblems([claim],project(),[history],[structured])).toEqual([]);
  expect(claimEvidenceProblems([claim],project(),[history],[{...structured,productKey:'MC400'}])).toHaveLength(1);
  expect(claimEvidenceProblems([claim],project(),[history],[{...structured,authority:'reference'}])).toHaveLength(1);
 });
 test('requires the authoritative product document to match the selected model and approved source role',()=>{
  const source:SourceRef={type:'knowledge_chunk',id:'manual',label:'MC4000使用说明书',evidence:'MC4000支持Ethernet数据传输。',authority:'authoritative',use:'fact_evidence'};
  const claim={...assertion(),sourceIds:[source.id]};expect(claimEvidenceProblems([claim],project(),[source])).toEqual([]);
  expect(claimEvidenceProblems([claim],{...project(),products:['MC400']},[source])).toHaveLength(1);
  expect(claimEvidenceProblems([claim],project(),[{...source,use:'writing_reference'}])).toHaveLength(1);
 });
 test('preserves historical technical principles and does not scan all unclaimed prose',()=>{
  const claim={...assertion('principle'),text:'当刚体上多个非共线标记点的几何关系已知时，可由各点位置解算刚体位姿。'};
  expect(claimEvidenceProblems([claim],project(),[history])).toEqual([]);
  expect(validateSections([section(claim)],project()).filter(issue=>issue.type==='unsupported_claim')).toEqual([]);
  expect(claimEvidenceProblems([],project(),[history])).toEqual([]);
  const parsed=parseGeneration(JSON.stringify({content:[{type:'paragraph',text:claim.text}],used_fact_ids:[],used_knowledge_refs:[history.id],used_asset_refs:[],claims:[claim]}),{context:project(),sources:[history],facts:[],factIds:[],assetIds:[],prompt:'',tokens:0});expect(parsed.claims[0].kind).toBe('principle');
 });
 test('principle cannot relabel an explicit project configuration without current evidence',()=>{
  expect(claimEvidenceProblems([{...assertion('principle'),text:'本项目配置四个及以上反光刚体标记。'}],project(),[history])).toHaveLength(1);
 });
});

describe('generation evidence repair and preservation',()=>{
 let directory:string,app:Awaited<ReturnType<typeof createApp>>,engine:DocumentEngine,projects:ProjectService,calls=0,repairable=true;
 beforeAll(async()=>{
  directory=await mkdtemp(join(tmpdir(),'studio-claim-evidence-'));app=await createApp({dataDir:directory,providerFactory:()=>({generate:async request=>{
   calls++;const repaired=repairable&&request.prompt.includes('\n请修订以下草稿'),claim=repaired?{...assertion('principle'),text:'当标记点的几何关系已知时，可通过多点位置解算刚体位姿。'}:assertion();
   return {content:JSON.stringify({content:[{type:'paragraph',text:claim.text}],used_fact_ids:[],used_knowledge_refs:[history.id],used_asset_refs:[],claims:[claim]}),usage:{inputTokens:100,outputTokens:80}};
  }})});engine=(app as any).documentEngine;projects=(app as any).projects;
  engine.retriever.retrieve=async()=>[{source:{...history,type:'knowledge_chunk'},documentId:'historical-source',text:history.evidence,score:1}];
  await (app as any).knowledge.settings.patch({llm:{apiKey:'synthetic-test-key',baseUrl:'https://api.moonshot.cn/v1',model:'kimi-k3'}});
 },30000);
 afterAll(async()=>{await app?.close();await rm(directory,{recursive:true,force:true});},30000);
 async function run(blocked=false){
  repairable=!blocked;const p=await projects.create({name:'声明来源测试',description:'建设目标：追踪摄像机位姿。'});await projects.confirmContext(p.id,(await projects.getContext(p.id)).revision);const created=await engine.create(p.id);let doc=await engine.plan(created.id,{revision:created.revision,sections:[{title:'标记与追踪设计',level:1}]});
  if(blocked)doc=await engine.edit(doc.id,doc.sections[0].id,{revision:doc.sections[0].revision,blocks:[{type:'paragraph',text:'保留的原有设计说明。'}]});
  const before=calls;await engine.generate(doc.id,{expectedRevision:doc.revision,sectionIds:[doc.sections[0].id],overwriteEdited:blocked,config:{model:'kimi-k3',limitsEnabled:false}});
  for(let n=0;n<300;n++){const job=(await engine.jobs(doc.id))[0];if(!['queued','running'].includes(job.status))return {job,document:await engine.get(doc.id),calls:calls-before};await new Promise(resolve=>setTimeout(resolve,10));}throw Error('generation timeout');
 }
 test('repairs a history-only capability once into a conditional technical principle',async()=>{
  const result=await run();expect(result.calls).toBe(2);expect(result.job).toMatchObject({status:'completed',processed:1,inputTokens:200,outputTokens:160});expect(result.document.sections[0].claims[0].kind).toBe('principle');expect(result.document.issues.filter(issue=>issue.type==='unsupported_claim')).toEqual([]);
 },15000);
 test('retains original content and fails after one unsuccessful evidence repair',async()=>{
  const result=await run(true);expect(result.calls).toBe(2);expect(result.job.status).toBe('failed');expect(result.job.errors[0].message).toContain('断言未引用当前锁定事实');expect(result.document.sections[0].blocks).toEqual([expect.objectContaining({text:'保留的原有设计说明。'})]);
 },15000);
});
