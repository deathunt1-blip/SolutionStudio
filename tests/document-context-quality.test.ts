import {describe,expect,test,vi} from 'vitest';
import {buildSectionContext,DocumentRetriever,generationSystem} from '../packages/document-engine/src/context.js';
import type {DocumentSection,SourceRef} from '../packages/document-engine/src/types.js';
import type {ProjectContext} from '../packages/projects/src/types.js';
import type {StructuredService} from '../packages/structured/src/service.js';

const section:DocumentSection={id:'section',title:'相机部署设计',level:2,order:0,generationMode:'ai',requiredContext:['engineering'],retrievalPolicy:{query:'相机 部署 安装',limit:6},status:'empty',blocks:[],sourceRefs:[],assetRefs:[],lockedFactRefs:[],claims:[],revision:1,edited:false};
function context():ProjectContext{return {projectId:'private-project',revision:1,confirmed:true,summary:'动作捕捉系统建设',requirements:{goals:[],performance:{},interfaces:[],protocols:[],environment:[],installationConstraints:[],specialRequirements:[],acceptanceCriteria:[],unresolved:[]},lockedFacts:[{id:'count',key:'deployment.equipmentCount',label:'相机数量',value:16,unit:'台',sourceType:'engineering_data',sourceRef:{type:'engineering_data',id:'report',label:'当前部署报告'},locked:true}],products:['K18'],capabilities:[],assets:[],conflicts:[],unresolved:[]};}
type Item=Awaited<ReturnType<DocumentRetriever['retrieve']>>[number];
function item(id:string,text:string,options:{documentId?:string;title?:string;authority?:string;type?:SourceRef['type']}={}):Item{return {documentId:options.documentId??id,source:{id,type:options.type??'knowledge_chunk',label:options.title??`资料 ${id}`,evidence:text,authority:options.authority??'reference'},text,score:1};}
const structured={productFacts:vi.fn(async()=>[])} as unknown as StructuredService;
function retriever(items:Item[]){const retrieve=vi.fn(async(_projectId:string,_query:string,_sourceIds?:string[])=>items);return {retrieve,instance:{retrieve} as unknown as DocumentRetriever};}

describe('chapter context quality and optional economy controls',()=>{
 test('default uses the available relevant evidence beyond the legacy six-chunk throttle',async()=>{
  const sources=Array.from({length:12},(_,i)=>item(`source-${i}`,`K18 相机部署与安装依据 ${i}`));
  const found=retriever(sources),built=await buildSectionContext(section,context(),found.instance,structured,32000);
  const prompt=JSON.parse(built.prompt);
  expect(prompt.knowledgeChunks).toHaveLength(12);expect(prompt.selectedProducts).toEqual(['K18']);
  expect(found.retrieve).toHaveBeenCalledWith('private-project',expect.stringContaining('K18'),undefined);
  expect(found.retrieve.mock.calls[0]?.[1]).toContain('相机 部署 安装');
  const limited=await buildSectionContext(section,context(),found.instance,structured,32000,{limitsEnabled:true});
  expect(JSON.parse(limited.prompt).knowledgeChunks).toHaveLength(6);
 });
 test('chapter and exact-model relevance beat unrelated authoritative prose, with source diversity',async()=>{
  const sources=[
   item('norm-1','相机安装应考虑部署条件。',{documentId:'norm',title:'动作捕捉系统团体标准',authority:'authoritative'}),
   item('norm-2','相机部署安装规范的一般要求。',{documentId:'norm',title:'动作捕捉系统团体标准',authority:'authoritative'}),
   item('norm-3','安装部署相机应满足设计条件。',{documentId:'norm',title:'动作捕捉系统团体标准',authority:'authoritative'}),
   item('wrong-model','K180 相机部署安装。',{title:'K180 技术手册',authority:'authoritative'}),
   item('right-model','K18 相机部署安装时需结合安装面的结构。',{title:'K18 技术手册',authority:'authoritative'}),
   item('customer','相机安装：现有墙体不允许钻孔。',{title:'客户项目条件',type:'project_input',authority:'customer_requirement'}),
  ];
  const built=await buildSectionContext({...section,retrievalPolicy:{query:'相机 部署 安装',limit:4}},context(),retriever(sources).instance,structured,32000,{limitsEnabled:true});
  const chunks=JSON.parse(built.prompt).knowledgeChunks;
  expect(chunks[0].id).toBe('right-model');expect(chunks.slice(0,3).map((c:any)=>c.id)).toContain('customer');
  expect(chunks.filter((c:any)=>c.title.includes('团体标准'))).toHaveLength(1);
  expect(chunks.find((c:any)=>c.id==='right-model')).toMatchObject({title:'K18 技术手册',sourceType:'knowledge_chunk',scope:'library',use:'product_evidence'});
  expect(chunks.find((c:any)=>c.id==='customer')).toMatchObject({scope:'current_project',use:'customer_requirement'});
  expect(chunks.find((c:any)=>c.title.includes('团体标准'))?.use).toBe('design_reference');
 });
 test('historical facts and styles keep explicit titles and cannot become product evidence',async()=>{
  const sources=[item('history','既往项目采用其他设备。',{title:'历史客户技术方案',authority:'reference'}),item('style','写作示例。',{title:'投标书表达参考',authority:'style_only'})];
  const built=await buildSectionContext(section,context(),retriever(sources).instance,structured,32000),prompt=JSON.parse(built.prompt);
  expect(prompt.knowledgeChunks).toEqual([expect.objectContaining({id:'history',title:'历史客户技术方案',use:'design_reference'})]);
  expect(prompt.styleExamples).toEqual([{title:'投标书表达参考',text:'写作示例。'}]);
  expect(built.sources.some(s=>s.id==='style')).toBe(false);
  expect(generationSystem).toContain('不限制固定段数');expect(generationSystem).toContain('不为了减少token压缩成摘要');
  expect(generationSystem).toContain('不能移植为当前项目能力');expect(generationSystem).toContain('不能因为部分参数未知');
  expect(generationSystem).toContain('条件句包装的数字假设');expect(generationSystem).toContain('正文不得带入其他客户');
  expect(generationSystem).toContain('不得擅自宣布当前项目排除某种应用');expect(generationSystem).toContain('不自动成为客户确认');
  expect(generationSystem).toContain('各章节无需覆盖整个方案');
 });
 test('unlimited product mode still obeys the actual model window without truncating required facts',async()=>{
  const project=context(),found=retriever([item('oversize','相机'.repeat(10000)),item('fits','K18 相机安装应结合现场条件。')]);
  const built=await buildSectionContext(section,project,found.instance,structured,10000);
  const prompt=JSON.parse(built.prompt);expect(prompt.knowledgeChunks.map((c:any)=>c.id)).toEqual(['fits']);expect(prompt.lockedFacts[0]).toMatchObject({id:'count',value:16});expect(built.tokens).toBeLessThanOrEqual(10000);
  project.summary='必须保留的客户条件'.repeat(5000);
  await expect(buildSectionContext(section,project,found.instance,structured,10000)).rejects.toMatchObject({statusCode:422});
 });
 test('selected-source rewriting preserves source restrictions and rejects a missing selected source',async()=>{
  const found=retriever([item('selected','项目专属安装约束。',{type:'project_input',authority:'customer_requirement'})]);
  const built=await buildSectionContext(section,context(),found.instance,structured,32000,{mode:'rewrite',sourceIds:['selected'],previous:'已有正文'});
  expect(found.retrieve).toHaveBeenCalledWith('private-project',expect.any(String),['selected']);
  expect(JSON.parse(built.prompt)).toMatchObject({mode:'rewrite',previousText:'已有正文'});
  await expect(buildSectionContext(section,context(),retriever([]).instance,structured,32000,{sourceIds:['foreign-private-source']})).rejects.toMatchObject({statusCode:422});
 });
});
