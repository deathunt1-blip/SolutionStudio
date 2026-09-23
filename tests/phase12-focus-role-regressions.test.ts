import {describe,expect,it} from 'vitest';
import {focusFacts,includeReportOptics} from '../packages/document-engine/src/focus.js';
import {buildSectionContext} from '../packages/document-engine/src/context.js';
import {inferSectionRole} from '../packages/knowledge-enrichment/src/taxonomy.js';
import type {DocumentSection} from '../packages/document-engine/src/types.js';
import type {ProjectContext} from '../packages/projects/src/types.js';
import type {DocumentRetriever} from '../packages/document-engine/src/context.js';
import type {StructuredService} from '../packages/structured/src/service.js';

const sourceRef={type:'engineering_data' as const,id:'report',label:'工程分析',evidence:'用户已选择报告光学配置'};
const optics={model:'MC4000',lens:{focalLengthMm:12},hfovDeg:53,vfovDeg:53,cameraIds:['camera-1'],sourceRef};
const context:ProjectContext={projectId:'project',revision:3,confirmed:true,summary:'轮式和人形机器人运动检测',requirements:{goals:[],performance:{},interfaces:[],protocols:[],environment:[],installationConstraints:[],specialRequirements:[],acceptanceCriteria:[],unresolved:[]},lockedFacts:[{id:'count',key:'deployment.equipmentCount',label:'相机数量',value:30,sourceType:'engineering_data',sourceRef,locked:true},{id:'actual-optical-key',key:'engineering.opticalConfigurations',label:'原报告工程仿真光学配置',value:[optics],sourceType:'engineering_data',sourceRef,locked:true},{id:'choice',key:'engineering.opticsSource',label:'工程分析光学口径',value:'report',sourceType:'user',sourceRef:{...sourceRef,type:'user'},locked:true}],products:['MC4000'],capabilities:[],assets:[],conflicts:[],unresolved:[],engineering:{sourceType:'scenelab',assets:[],sourceRef,deployment:{equipmentCount:30,opticalConfigurations:[optics]}}};
const section:DocumentSection={id:'section',title:'项目概述',level:1,order:0,generationMode:'ai',requiredContext:['engineering'],status:'empty',blocks:[],sourceRefs:[],assetRefs:[],lockedFactRefs:[],claims:[],revision:1,edited:false};
const retriever={sections:async()=>[],retrieve:async()=>[]} as unknown as DocumentRetriever;
const structured={productFacts:async()=>[]} as unknown as StructuredService;

describe('real proposal section focus regressions',()=>{
 it('does not leak the actual engineering.opticalConfigurations key into introductory writing',async()=>{
  for(const title of ['项目概述','应用背景','建设目标','系统总体架构']){
   const built=await buildSectionContext({...section,title},context,retriever,structured,32000),prompt=JSON.parse(built.prompt);
   expect(prompt.projectFacts.map((f:any)=>f.id)).not.toContain('actual-optical-key');
   expect(prompt.sectionBrief.factsToUse).not.toContain('actual-optical-key');
   expect(prompt.reportOptics).toEqual([]);expect(built.prompt).not.toContain('focalLengthMm');
  }
 });
 it('passes report optical configurations through the dedicated channel for camera chapters',async()=>{
  const built=await buildSectionContext({...section,title:'动捕相机'},context,retriever,structured,32000),prompt=JSON.parse(built.prompt);
  expect(prompt.reportOptics).toEqual([expect.objectContaining({model:'MC4000',lens:{focalLengthMm:12},hfovDeg:53,vfovDeg:53})]);
  expect(prompt.projectFacts.map((f:any)=>f.id)).not.toContain('actual-optical-key');expect(built.prompt).not.toContain('engineering.opticsSource');
 });
 it('preserves complete facts for unknown roles while withholding the internal optical-choice field',async()=>{
  for(const role of ['other','custom_role']){expect(focusFacts(role,context.lockedFacts).map(f=>f.id)).toEqual(['count','actual-optical-key']);}
  expect(includeReportOptics('other')).toBe(true);
  const built=await buildSectionContext({...section,title:'自定义专题'},context,retriever,structured,32000),prompt=JSON.parse(built.prompt);
  expect(prompt.projectFacts.map((f:any)=>f.id)).toContain('actual-optical-key');expect(prompt.reportOptics[0].lens.focalLengthMm).toBe(12);
 });
 it('classifies markerless pose solving as data processing without treating markerless as marker hardware',()=>{
  for(const title of ['无标记人体动作解算','水下无标志点三维重建','Markerless pose estimation','Marker-less data processing'])expect(inferSectionRole(title)).toBe('data_processing');
  expect(inferSectionRole('无标记软件')).toBe('software');expect(inferSectionRole('Markerless software')).toBe('software');expect(inferSectionRole('biomarker analysis')).toBe('other');
  for(const title of ['Marker / 刚体设计','Markers placement','rigid body design','标记点与工装设计','标记与无标记混合方法'])expect(inferSectionRole(title)).toBe('marker_rigid_body');
 });
});
