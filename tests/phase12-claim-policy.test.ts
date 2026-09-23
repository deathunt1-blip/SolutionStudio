import {describe,expect,test} from 'vitest';
import {highRiskClaimProblems} from '../packages/document-engine/src/claim-policy.js';
import {parseGeneration} from '../packages/document-engine/src/blocks.js';
import {validateSections} from '../packages/document-engine/src/validation.js';
import {allRequirements,buildSectionContext,type SectionContext,type DocumentRetriever} from '../packages/document-engine/src/context.js';
import {inferSectionRole} from '../packages/knowledge-enrichment/src/taxonomy.js';
import type {ProjectContext,RequirementItem} from '../packages/projects/src/types.js';
import type {DocumentSection} from '../packages/document-engine/src/types.js';
import type {StructuredService} from '../packages/structured/src/service.js';

const project=():ProjectContext=>({projectId:'local-unit-test',revision:1,confirmed:true,summary:'机器人动作捕捉',requirements:{goals:[],performance:{},interfaces:[],protocols:[],environment:[],installationConstraints:[],specialRequirements:[],acceptanceCriteria:[],unresolved:[]},lockedFacts:[],products:[],capabilities:[],assets:[],conflicts:[],unresolved:[]});
const section=(text:string):DocumentSection=>({id:'chapter',title:'技术说明',level:2,order:0,generationMode:'ai',requiredContext:['requirements'],status:'generated',revision:1,edited:false,sourceRefs:[],lockedFactRefs:[],assetRefs:[],claims:[],blocks:[{id:'body',type:'paragraph',text}]});
const requirement=(id='accuracy'):RequirementItem=>({id,key:'accuracy',value:'0.1mm',sourceInputId:'input',sourceChunkId:'chunk',evidence:'客户要求定位精度0.1mm',confidence:1,confirmedByUser:true});

describe('narrow high-risk technical assertion policy',()=>{
 test.each([
  '本系统通过运动预测补全实现无损真实测量。',
  '缺失轨迹采用插值补点，这些数据作为真实实测结果。',
  '系统实现零误差同步。',
  '各采集节点时间对齐不存在任何同步误差。',
  '任意遮挡条件下测量精度不变。',
  '完全遮挡也不影响测量结果。',
  '完全遮挡也不会影响测量结果。',
  '所有目标被完全遮挡仍保证稳定测量。',
 ])('rejects explicit overclaim: %s',value=>{expect(highRiskClaimProblems(section(value).blocks)).toHaveLength(1);});
 test.each([
  '预测补全不能等同于真实测量。',
  '预测补全结果应与真实测量结果进行比对。',
  '将预测轨迹与实测结果比较以评价补全误差。',
  '将预测补全数据与原始实测结果分别标识。',
  '同步链路并非零误差同步。',
  '客户要求零误差同步。',
  '设计目标为降低同步误差。',
  '目标是研究无损真实测量与预测补全的差异。',
  '无法保证完全遮挡时精度不变。',
  '不应宣称任意遮挡条件下无影响。',
  '通过多视角布置降低遮挡风险，同步链路用于统一时基。',
 ])('preserves negation, goals, comparisons and grounded method: %s',value=>{expect(highRiskClaimProblems(section(value).blocks)).toEqual([]);});
 test('a negation in one clause does not hide an assertion in the next clause',()=>{expect(highRiskClaimProblems(section('系统不支持录播，但是同步链路能够实现零误差同步。').blocks)).toHaveLength(1);});
 test('also checks diagram labels and table cells',()=>{expect(highRiskClaimProblems([{id:'diagram',type:'diagram',diagramType:'mermaid',source:'flowchart LR\nA[零误差同步]-->B[输出]',generatedBy:'ai',sourceRefs:[]},{id:'table',type:'table',title:'能力',columns:['说明'],rows:[['任意遮挡不影响测量精度']],sourceRefs:[]}]).map(problem=>problem.blockId)).toEqual(['diagram','table']);});
});

describe('accepted requirement evidence and complete claim provenance',()=>{
 test.each(['unknown','not_applicable','conflicted'] as const)('does not revive discarded performance evidence in %s state',async status=>{
  const context=project(),item=requirement();context.requirements.performance.accuracy=item;
  context.workspaceRequirements=[{id:item.id,semanticKey:'accuracy',category:'性能',label:'精度',value:item.value,status,evidenceRefs:[],confirmedByUser:false}];
  const s=section('客户要求定位精度为0.1mm。'),sc=await buildSectionContext(s,context,{retrieve:async()=>[],sections:async()=>[]} as unknown as DocumentRetriever,{productFacts:async()=>[]} as unknown as StructuredService,30000);
  expect(allRequirements(context)).toEqual([]);expect(JSON.parse(sc.prompt).customerRequirements).toEqual([]);
  expect(validateSections([s],context).some(issue=>issue.type==='unsupported_claim'&&issue.quote==='0.1mm')).toBe(true);
 });
 test.each(['proposed','confirmed'] as const)('retains accepted %s performance evidence',status=>{
  const context=project(),item=requirement();context.requirements.performance.accuracy=item;context.workspaceRequirements=[{id:item.id,semanticKey:'accuracy',category:'性能',label:'精度',value:item.value,status,evidenceRefs:[],confirmedByUser:true}];
  expect(validateSections([section('客户要求定位精度为0.1mm。')],context)).toEqual([]);
 });
 test('claim-only locked facts and requirements retain their IDs and source evidence',()=>{
  const context=project(),item=requirement();context.requirements.performance.accuracy=item;
  const fact={id:'count',key:'deployment.equipmentCount',label:'相机数量',value:16,unit:'台',sourceType:'user' as const,sourceRef:{type:'user' as const,id:'confirmed-input',label:'用户确认',evidence:'配置16台相机'},locked:true as const};context.lockedFacts=[fact];
  const sc:SectionContext={context,prompt:'',tokens:0,facts:[],factIds:[fact.id,item.id],assetIds:[],sources:[fact.sourceRef,{type:'project_input',id:'chunk',label:'客户要求',evidence:item.evidence}]};
  const result=parseGeneration(JSON.stringify({content:[{type:'paragraph',text:'本项目配置16台相机，客户要求定位精度为0.1mm。'}],used_fact_ids:[],used_knowledge_refs:[],used_asset_refs:[],claims:[{text:'本项目配置16台相机。',factIds:[fact.id],sourceIds:[],kind:'engineering'},{text:'客户要求定位精度为0.1mm。',factIds:[item.id],sourceIds:[],kind:'requirement'}]}),sc);
  expect(result.lockedFactRefs).toEqual([fact.id,item.id]);expect(result.sourceRefs.map(source=>source.id)).toEqual(['confirmed-input','chunk']);
 });
 test('maps accepted requirement provenance even when no chunk ID exists',()=>{
  const context=project(),item={...requirement(),sourceChunkId:undefined};context.requirements.performance.accuracy=item;
  const sc:SectionContext={context,prompt:'',tokens:0,facts:[],factIds:[item.id],assetIds:[],sources:[{type:'project_input',id:'input',label:'客户要求',evidence:item.evidence}]};
  const result=parseGeneration(JSON.stringify({content:[{type:'paragraph',text:'客户要求定位精度为0.1mm。'}],used_fact_ids:[],used_knowledge_refs:[],used_asset_refs:[],claims:[{text:'客户要求定位精度为0.1mm。',factIds:[item.id],sourceIds:[]}]}),sc);
  expect(result.sourceRefs.map(source=>source.id)).toEqual(['input']);
 });
 test('installation and deployment chapter uses installation references without changing camera placement role',()=>{
  for(const title of ['安装与部署设计','系统安装实施','现场实施流程'])expect(inferSectionRole(title)).toBe('installation');
  expect(inferSectionRole('相机部署设计')).toBe('deployment');
 });
});
