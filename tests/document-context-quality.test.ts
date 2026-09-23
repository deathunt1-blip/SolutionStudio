import {describe,expect,test,vi} from 'vitest';
import {allRequirements,buildSectionContext,DocumentRetriever,generationSystem} from '../packages/document-engine/src/context.js';
import type {DocumentSection,SourceRef} from '../packages/document-engine/src/types.js';
import type {ProjectContext,RequirementItem,WorkspaceRequirement} from '../packages/projects/src/types.js';
import type {StructuredService} from '../packages/structured/src/service.js';
import type {HistoricalSectionReference,KnowledgeSection} from '../packages/knowledge-enrichment/src/types.js';
import {deterministicBlocks} from '../packages/document-engine/src/blocks.js';
import {customerFacingProblems} from '../packages/document-engine/src/customer-facing.js';
import {validateSections} from '../packages/document-engine/src/validation.js';
import {standardTemplate} from '../packages/document-engine/src/templates.js';

const section:DocumentSection={id:'section',title:'相机部署设计',level:2,order:0,generationMode:'ai',requiredContext:['engineering'],retrievalPolicy:{query:'相机 部署 安装',limit:6},status:'empty',blocks:[],sourceRefs:[],assetRefs:[],lockedFactRefs:[],claims:[],revision:1,edited:false};
function context():ProjectContext{return {projectId:'private-project',revision:1,confirmed:true,summary:'动作捕捉系统建设',requirements:{goals:[],performance:{},interfaces:[],protocols:[],environment:[],installationConstraints:[],specialRequirements:[],acceptanceCriteria:[],unresolved:[]},lockedFacts:[{id:'count',key:'deployment.equipmentCount',label:'相机数量',value:16,unit:'台',sourceType:'engineering_data',sourceRef:{type:'engineering_data',id:'report',label:'当前部署报告'},locked:true}],products:['K18'],capabilities:[],assets:[],conflicts:[],unresolved:[]};}
type Item=Awaited<ReturnType<DocumentRetriever['retrieve']>>[number];
function item(id:string,text:string,options:{documentId?:string;title?:string;authority?:string;type?:SourceRef['type']}={}):Item{return {documentId:options.documentId??id,source:{id,type:options.type??'knowledge_chunk',label:options.title??`资料 ${id}`,evidence:text,authority:options.authority??'reference'},text,score:1};}
function history(id='history-section'):HistoricalSectionReference{return {documentTitle:'某历史客户机器人技术方案',score:10,use:'writing_reference',section:{id,documentId:'historical-document',versionId:'history-v1',title:'相机部署设计',headingPath:['系统设计','相机部署设计'],level:2,text:'历史场地采用 96 台 K9 相机。安装先检查支撑面，再进行标定。',summary:'支撑面检查、安装和标定流程',sectionRole:'deployment',tags:['部署'],softTags:{},applications:['机器人'],targetObjects:['机械臂'],scenarios:[],topics:['部署'],modules:['相机'],products:['K9'],reusable:true,quality:'preferred',authority:'reference',order:0,blueprint:{purpose:'说明部署方法',recommendedStructure:['部署依据','安装支撑与视线','系统标定'],reusableTechnicalLogic:['先检查支撑条件，再完成安装与标定'],expectedFacts:['当前设备数量'],projectSpecificElements:['历史设备数量和型号']}} satisfies KnowledgeSection};}
const structured={productFacts:vi.fn(async()=>[])} as unknown as StructuredService;
function retriever(items:Item[],historical:HistoricalSectionReference[]=[]){const retrieve=vi.fn(async(_projectId:string,_query:string,_sourceIds?:string[])=>items),sections=vi.fn(async(_query:unknown)=>historical);return {retrieve,sections,instance:{retrieve,sections} as unknown as DocumentRetriever};}
const requirement=(id:string,value:string,key='安装要求'):RequirementItem=>({id,key,value,sourceInputId:'input-one',sourceChunkId:`chunk-${id}`,evidence:value,confidence:1,confirmedByUser:true});

describe('chapter composer and optional economy controls',()=>{
 test('default consumes relevant evidence beyond the legacy six-chunk throttle and only explicit limits reduce it',async()=>{
  const sources=Array.from({length:12},(_,i)=>item(`source-${i}`,`K18 相机部署与安装依据 ${i}`));
  const found=retriever(sources),built=await buildSectionContext(section,context(),found.instance,structured,32000);
  const prompt=JSON.parse(built.prompt);
  expect(prompt.historicalSections).toHaveLength(12);expect(prompt.selectedProducts).toEqual(['K18']);
  expect(found.retrieve).toHaveBeenCalledWith('private-project',expect.stringContaining('K18'),undefined);
  expect(found.retrieve.mock.calls[0]?.[1]).toContain('相机 部署 安装');
  const limited=await buildSectionContext(section,context(),found.instance,structured,32000,{limitsEnabled:true});
  expect(JSON.parse(limited.prompt).historicalSections).toHaveLength(6);
 });
 test('exact-model chapter relevance and diversity determine evidence selection while accepted requirements replace raw excerpts',async()=>{
  const sources=[item('norm-1','相机安装应考虑部署条件。',{documentId:'norm',title:'动作捕捉系统团体标准',authority:'authoritative'}),item('norm-2','相机部署安装规范的一般要求。',{documentId:'norm',title:'动作捕捉系统团体标准',authority:'authoritative'}),item('norm-3','安装部署相机应满足设计条件。',{documentId:'norm',title:'动作捕捉系统团体标准',authority:'authoritative'}),item('wrong-model','K180 相机部署安装。',{title:'K180 技术手册',authority:'authoritative'}),item('right-model','K18 相机部署安装时需结合安装面的结构。',{title:'K18 技术手册',authority:'authoritative'}),item('customer','原始草稿要求增加 999 台相机。',{title:'客户项目条件',type:'project_input',authority:'customer_requirement'})];
  const project=context();project.requirements.installationConstraints=[requirement('accepted','现有墙体不允许钻孔')];
  const built=await buildSectionContext({...section,retrievalPolicy:{query:'相机 部署 安装',limit:3}},project,retriever(sources).instance,structured,32000,{limitsEnabled:true});
  const prompt=JSON.parse(built.prompt),evidence=prompt.authoritativeEvidence;
  expect(evidence.map((c:any)=>c.id)).toEqual(['right-model']);expect(built.prompt).not.toContain('K180');
  expect(prompt.customerRequirements).toEqual([expect.objectContaining({id:'accepted',value:'现有墙体不允许钻孔'})]);
  expect(built.prompt).not.toContain('999 台');expect(evidence.some((c:any)=>c.id==='customer')).toBe(false);
 });
 test('retrieves whole historical chapters with the project fingerprint and separates them from facts and style',async()=>{
  const project=context();project.fingerprint={applications:['机器人'],targetObjects:['机械臂'],scenarios:['实验室'],topics:['部署'],modules:['相机'],products:['K18'],environment:[],constraints:[]};
  const found=retriever([item('legacy','旧方案写法。',{title:'历史方案',authority:'reference'}),item('style','写作示例。',{title:'投标书表达参考',authority:'style_only'})],[history()]);
  const built=await buildSectionContext(section,project,found.instance,structured,32000),prompt=JSON.parse(built.prompt);
  expect(found.sections).toHaveBeenCalledWith(expect.objectContaining({role:'deployment',fingerprint:project.fingerprint,products:['K18']}));
  expect(prompt.historicalSections[0]).toMatchObject({id:'history-section',title:'相机部署设计',use:'writing_reference'});
  expect(prompt.projectFingerprint).toEqual(project.fingerprint);
  expect(prompt.historicalSections[0].referenceScope).toMatchObject({targetObjects:['机械臂'],products:['K9'],projectSpecificElements:['历史设备数量和型号']});
  expect(prompt.historicalSections[0].text).toContain('96 台 K9');expect(prompt.projectFacts[0]).toMatchObject({id:'count',value:16});
  expect(prompt.authoritativeEvidence).toEqual([]);expect(prompt.structuredFacts).toEqual([]);
  expect(prompt.styleExample).toEqual({text:'写作示例。'});expect(built.sources.some(s=>s.id==='style')).toBe(false);
  expect(prompt.sectionBrief.recommendedStructure).toEqual(['部署依据','安装支撑与视线','系统标定']);
  expect(prompt.sectionBrief.reusableLogic).toContain('先检查支撑条件，再完成安装与标定');
  expect(prompt.blueprints[0].projectSpecificElements).toContain('历史设备数量和型号');
  expect(built.sources.find(s=>s.id==='history-section')).toMatchObject({type:'knowledge_section',use:'writing_reference',documentId:'historical-document'});
  expect(built.prompt).not.toContain('某历史客户机器人技术方案');
  expect(generationSystem).toContain('不能移植为当前项目能力');expect(generationSystem).toContain('不限制固定段数');expect(generationSystem).toContain('不为了减少token压缩成摘要');
 });
 test('unselected products and normative requirements cannot enter product capability evidence even if classified authoritative',async()=>{
  const sources=[item('standard','K18 软件应支持不少于4种动作重定向模式。',{title:'动作捕捉系统团体标准',authority:'authoritative'}),item('foreign','MC4000支持同步协议。',{title:'MC4000说明书',authority:'authoritative'}),item('selected','K18 相机安装需固定支撑。',{title:'K18说明书',authority:'authoritative'})];
  let built=await buildSectionContext(section,context(),retriever(sources).instance,structured,32000);
  expect(JSON.parse(built.prompt).authoritativeEvidence.map((x:any)=>x.id)).toEqual(['selected']);expect(built.sources.map(s=>s.id)).not.toContain('standard');expect(built.prompt).not.toContain('4种动作');
  const noProduct=context();noProduct.products=[];built=await buildSectionContext(section,noProduct,retriever(sources).instance,structured,32000);
  expect(JSON.parse(built.prompt).authoritativeEvidence).toEqual([]);expect(JSON.parse(built.prompt).historicalSections).toEqual([]);
 });
 test('a chapter uses one coherent blueprint structure instead of combining unrelated project modules',async()=>{
  const main=history(),unrelated=history('unrelated');unrelated.section.blueprint!.recommendedStructure=['机器人多足采集','肌电设备配置'];
  const built=await buildSectionContext(section,context(),retriever([],[main,unrelated]).instance,structured,32000);
  expect(JSON.parse(built.prompt).sectionBrief.recommendedStructure).toEqual(main.section.blueprint!.recommendedStructure);
 });
 test('writer gets a focused brief without unresolved questions, full conflict messages or internal choice fields',async()=>{
  const project=context();project.unresolved=[{id:'pending-secret',key:'accuracy',question:'内部澄清清单 精度到底多少？'}];project.requirements.unresolved=project.unresolved;
  project.conflicts=[{id:'private-conflict',key:'accuracy',severity:'error',message:'内部核对日志 表格和测试报告精度冲突',status:'open',sourceRefs:[]}];
  project.lockedFacts.push({id:'optics-choice',key:'engineering.opticsSource',label:'engineeringOpticsSource',value:'report',sourceType:'user',sourceRef:{type:'user',id:'user',label:'内部选择'},locked:true});
  const built=await buildSectionContext(section,project,retriever([]).instance,structured,32000),prompt=JSON.parse(built.prompt);
  for(const value of ['pending-secret','内部澄清清单','private-conflict','内部核对日志','engineeringOpticsSource','engineering.opticsSource'])expect(built.prompt).not.toContain(value);
  expect(prompt).not.toHaveProperty('unresolved');expect(prompt).not.toHaveProperty('conflicts');
  expect(prompt.sectionBrief.doNotClaim).toContain('不宣称已满足全部客户指标');
  expect(prompt.sectionBrief.factsToUse).toEqual(['count']);
  expect(generationSystem).toContain('未知数值直接不写');expect(generationSystem).toContain('不编造事实以消除缺口');
 });
 test('actual model-window bounds remain enforced without silently truncating current project facts',async()=>{
  const project=context(),found=retriever([item('oversize','相机'.repeat(10000)),item('fits','K18 相机安装应结合现场条件。')]);
  const built=await buildSectionContext(section,project,found.instance,structured,10000),prompt=JSON.parse(built.prompt);
  expect(prompt.historicalSections.map((c:any)=>c.id)).toEqual(['fits']);expect(prompt.projectFacts[0]).toMatchObject({id:'count',value:16});expect(built.tokens).toBeLessThanOrEqual(10000);
  project.summary='必须保留的客户条件'.repeat(5000);
  await expect(buildSectionContext(section,project,found.instance,structured,10000)).rejects.toMatchObject({statusCode:422});
 });
 test('selected-source rewriting respects canonical project requirements and rejects unavailable selected sources',async()=>{
  const project=context();project.requirements.installationConstraints=[{...requirement('accepted','项目专属安装约束'),sourceChunkId:'selected'}];
  const found=retriever([item('selected','旧草稿 999 台设备。',{type:'project_input',authority:'customer_requirement'})]);
  const built=await buildSectionContext(section,project,found.instance,structured,32000,{mode:'rewrite',sourceIds:['selected'],previous:'已有正文'});
  expect(found.retrieve).toHaveBeenCalledWith('private-project',expect.any(String),['selected']);
  expect(JSON.parse(built.prompt)).toMatchObject({mode:'rewrite',previousText:'已有正文'});expect(built.prompt).not.toContain('999 台');
  await expect(buildSectionContext(section,context(),retriever([]).instance,structured,32000,{sourceIds:['foreign-private-source']})).rejects.toMatchObject({statusCode:422});
 });
 test('report optics and generic product facts stay separate in writer and compact customer tables',async()=>{
  const project=context(),sourceRef={type:'engineering_data' as const,id:'report',label:'工程报告'};
  project.engineering={sourceType:'scenelab',assets:[],sourceRef,metadata:{accuracyMetric:'theoretical one-sigma 3D position RMS',coverageUnit:'percent of sampled points'},deployment:{opticalConfigurations:[{model:'K18',variant:'K18-STD',lens:{focalLengthMm:8},hfovDeg:70,vfovDeg:65,maxWorkingDistanceM:45,cameraIds:['cam-1'],sourceRef}]}};
  project.lockedFacts.push({id:'optics-choice',key:'engineering.opticsSource',label:'工程光学配置',value:'report',sourceType:'user',sourceRef:{type:'user',id:'user',label:'明确选择报告配置'},locked:true});
  const productFacts=[{id:'generic-fov',productKey:'K18',field:'产品规格或简称',value:'4608x4096@170fps（50°×46°）/30m',authority:'authoritative'}],service={productFacts:async()=>productFacts} as unknown as StructuredService;
  const built=await buildSectionContext({...section,requiredContext:['requirements'],tableKind:'products'},project,retriever([]).instance,service,40000),prompt=JSON.parse(built.prompt);
  expect(prompt.reportOptics[0]).toMatchObject({hfovDeg:70,vfovDeg:65,maxWorkingDistanceM:45});expect(prompt.structuredFacts[0].value).toContain('50°×46°');expect(prompt).not.toHaveProperty('engineeringOpticsSource');
  const analysis=await buildSectionContext({...section,title:'理论精度分析'},project,retriever([]).instance,service,40000);expect(JSON.parse(analysis.prompt).engineeringFacts.metricDefinitions).toEqual(project.engineering.metadata);
  const blocks=deterministicBlocks({...section,tableKind:'products'},built),tables=blocks.filter(b=>b.type==='table');
  expect(tables).toHaveLength(2);for(const table of tables)expect(table.columns.length).toBeLessThanOrEqual(3);
  expect(tables[0].rows.flat().join(' ')).toContain('70°');expect(tables[0].sourceRefs[0].type).toBe('engineering_data');
  expect(tables[1].rows.flat()).toContain(productFacts[0].value);expect(tables[1].sourceRefs[0].type).toBe('structured_fact');
  expect(JSON.stringify(blocks)).not.toContain('来源原文');expect(JSON.stringify(blocks)).not.toContain('需分别核对');expect(customerFacingProblems(blocks)).toEqual([]);
  expect(validateSections([{...section,blocks,sourceRefs:built.sources}],project).filter(issue=>issue.message.includes('未说明报告仿真配置或通用产品规格口径'))).toEqual([]);
  project.engineering.deployment!.opticalConfigurations![0]={model:'K18',lens:{focalLengthMm:8},cameraIds:[],sourceRef};
  const partial=await buildSectionContext({...section,tableKind:'products'},project,retriever([]).instance,service,40000);
  const partialBlocks=deterministicBlocks({...section,tableKind:'products'},partial);
  expect(JSON.stringify(partialBlocks)).not.toContain('未提供');
  expect(partialBlocks.filter(b=>b.type==='table')[0].rows).toEqual([['K18','镜头焦距','8mm']]);
 });
 test('unknown customer metrics remain in the workspace and never become a question list in proposal blocks',async()=>{
  const project=context();project.unresolved=[{id:'pending',key:'accuracy',question:'精度验收口径待确认。'}];
  const built=await buildSectionContext({...section,tableKind:'requirements'},project,retriever([]).instance,structured,32000);
  expect(deterministicBlocks({...section,tableKind:'requirements'},built)).toEqual([]);
  expect(built.prompt).not.toContain('精度验收口径待确认');
 });
 test('workspace unknown, not-applicable and conflicted states cannot be resurrected by legacy requirement entries',async()=>{
  const project=context();project.requirements.specialRequirements=['confirmed','unknown','not_applicable','conflicted'].map(status=>requirement(status,`值-${status}`));
  project.workspaceRequirements=['confirmed','unknown','not_applicable','conflicted'].map(status=>({id:status,semanticKey:status,category:'其他',label:status,value:`值-${status}`,status:status as WorkspaceRequirement['status'],evidenceRefs:[{sourceType:'user',sourceId:'user'}],confirmedByUser:status==='confirmed'}));
  const built=await buildSectionContext(section,project,retriever([]).instance,structured,32000);
  expect(allRequirements(project).map(r=>r.id)).toEqual(['confirmed']);
  expect(JSON.parse(built.prompt).customerRequirements.map((r:any)=>r.id)).toEqual(['confirmed']);
 });
});

describe('customer-facing content gate',()=>{
 test('validates edited section titles even when customer paragraphs are clean',()=>{
  const sources:SourceRef[]=[{type:'knowledge_section',id:'history',label:'某历史客户机器人技术方案 · 系统总体架构',evidence:'旧方案'}];
  const cleanBody=[{id:'body',type:'paragraph' as const,text:'系统由采集、处理与数据输出环节组成。'}];
  for(const title of ['待确认事项','ContextSnapshot','某历史客户机器人技术方案']){
   const issues=validateSections([{...section,title,blocks:cleanBody,sourceRefs:sources}],context()).filter(issue=>issue.type==='customer_facing');
   expect(issues).toHaveLength(1);expect(issues[0]).toMatchObject({sectionId:section.id,severity:'error',quote:title});expect(issues[0].blockId).toBeUndefined();
  }
  expect(validateSections([{...section,title:'系统总体架构',blocks:cleanBody,sourceRefs:sources}],context()).filter(issue=>issue.type==='customer_facing')).toEqual([]);
 });
 test('finds internal wording in paragraphs, rich text, lists, captions and tables',()=>{
  const blocks:DocumentSection['blocks']=[{id:'paragraph',type:'paragraph',text:'正常文字',runs:[{text:'尚未明确相关参数'}]},{id:'list',type:'list',items:['工程口径 engineeringOpticsSource']},{id:'table',type:'table',title:'参数',columns:['项目'],rows:[['ContextSnapshot']],sourceRefs:[]},{id:'asset',type:'asset',assetId:'asset',caption:'知识库图片'},{id:'diagram',type:'diagram',diagramType:'mermaid',source:'flowchart LR\nA-->B',caption:'待确认的拓扑',generatedBy:'user',sourceRefs:[]}];
  expect(customerFacingProblems(blocks).map(problem=>problem.blockId)).toEqual(['paragraph','list','table','asset','diagram']);
 });
 test('rejects internal source titles including the document part of a section citation, while allowing formal standards',()=>{
  const sources:SourceRef[]=[{type:'knowledge_section',id:'history',label:'某历史客户机器人技术方案 · 系统总体架构',evidence:'旧方案'},{type:'knowledge_chunk',id:'standard',label:'GB/T 12345 测试标准',evidence:'正式标准'}];
  const leaking={id:'leak',type:'paragraph' as const,text:'某历史客户机器人技术方案采用此方法。'};
  expect(customerFacingProblems([leaking],sources)).toHaveLength(1);
  expect(customerFacingProblems([{id:'good',type:'paragraph',text:'测试记录采用 GB/T 12345 测试标准规定的格式。'}],sources)).toEqual([]);
 });
 test('historical writing references never establish current product numeric or protocol capability',()=>{
  const project=context();project.lockedFacts=[];
  const historyRef:SourceRef={type:'knowledge_section',id:'history',label:'既有工程资料 · 性能设计',evidence:'K18 支持 888 fps，支持 EtherCAT。',authority:'authoritative',use:'writing_reference'};
  const prose={...section,blocks:[{id:'claim',type:'paragraph' as const,text:'K18 支持 888 fps，支持 EtherCAT。'}],sourceRefs:[historyRef],claims:[{text:'K18 支持 888 fps，支持 EtherCAT。',sourceIds:['history'],factIds:[],kind:'capability' as const}]};
  const issues=validateSections([prose],project);
  expect(issues.some(issue=>issue.type==='unsupported_claim'&&issue.quote==='888 fps')).toBe(true);
  expect(issues.some(issue=>issue.type==='unsupported_claim'&&issue.quote==='EtherCAT')).toBe(true);
 });
 test('standard template fixed prose avoids internal work logs',async()=>{
  for(const templateSection of standardTemplate.sections){
   const current={...section,...templateSection},built=await buildSectionContext(current,context(),retriever([]).instance,structured,32000);
   expect(customerFacingProblems(deterministicBlocks(current,built))).toEqual([]);
  }
 });
});
