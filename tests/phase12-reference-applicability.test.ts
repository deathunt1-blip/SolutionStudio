import {expect,it} from 'vitest';
import {buildSectionContext,generationSystem,type DocumentRetriever} from '../packages/document-engine/src/context.js';
import type {DocumentSection} from '../packages/document-engine/src/types.js';
import type {ProjectContext} from '../packages/projects/src/types.js';
import type {HistoricalSectionReference} from '../packages/knowledge-enrichment/src/types.js';
import type {StructuredService} from '../packages/structured/src/service.js';

const context:ProjectContext={projectId:'current',revision:1,confirmed:true,summary:'机器人运动采集',products:['MC4000'],lockedFacts:[{id:'count',key:'deployment.equipmentCount',label:'相机数量',value:30,unit:'台',locked:true,sourceType:'user',sourceRef:{type:'user',id:'selection',label:'已确认配置'}},{id:'models',key:'deployment.models',label:'相机配置',value:[{name:'MC4000',count:30}],locked:true,sourceType:'user',sourceRef:{type:'user',id:'selection',label:'已确认配置'}}],requirements:{goals:[],performance:{},interfaces:[],protocols:[],environment:[],installationConstraints:[],specialRequirements:[],acceptanceCriteria:[],unresolved:[]},assets:[],capabilities:[],conflicts:[],unresolved:[]};
const fixture=(specific:string):HistoricalSectionReference=>({documentTitle:'历史项目',score:10,use:'writing_reference',section:{id:'reference',documentId:'history',versionId:'v1',title:'参考结构',level:1,headingPath:[],text:specific+'。先说明需求，再解释处理关系。',summary:specific,sectionRole:'architecture',tags:[],softTags:{},applications:['film'],targetObjects:['摄影机'],scenarios:[],topics:[],modules:[],products:['K26'],reusable:true,quality:'preferred',authority:'reference',order:0,blueprint:{purpose:'参考设计',recommendedStructure:[specific],reusableTechnicalLogic:[specific],expectedFacts:['历史分区数量'],projectSpecificElements:[specific]}}});
it.each([
 ['系统总体架构','开放A与封闭B两个方案并行'],
 ['系统组成','网格单元独立标定后同步融合全场'],
 ['技术路线','采用光惯EKF融合与全局自动标定'],
 ['系统总体架构','系统另配独立同步器组织所有设备的统一时钟'],
])('%s anchors the confirmed configuration and keeps prior design choices outside the writer instructions',async(title,specific)=>{
 const section:DocumentSection={id:'s',title,level:1,order:0,generationMode:'ai',requiredContext:[],status:'empty',revision:1,edited:false,blocks:[],sourceRefs:[],assetRefs:[],lockedFactRefs:[],claims:[]};
 const reference=fixture(specific),retriever={sections:async()=>[reference],retrieve:async()=>[]} as unknown as DocumentRetriever;
 const sc=await buildSectionContext(section,structuredClone(context),retriever,{productFacts:async()=>[]} as unknown as StructuredService,40000),prompt=JSON.parse(sc.prompt);
 expect(prompt.projectFacts).toEqual(expect.arrayContaining([expect.objectContaining({id:'count',value:30}),expect.objectContaining({id:'models',value:[{name:'MC4000',count:30}]})]));
 expect(sc.factIds).toEqual(expect.arrayContaining(['count','models']));
 expect(prompt.sectionBrief.currentConfiguration).toEqual(expect.arrayContaining([expect.objectContaining({id:'count',value:30})]));
 expect(prompt.sectionBrief.recommendedStructure).not.toContain(specific);expect(prompt.sectionBrief.reusableLogic).not.toContain(specific);
 expect(prompt.sectionBrief.referenceDesignChoices).toEqual([expect.objectContaining({sourceId:'reference',notCurrentDecisions:expect.arrayContaining([specific])})]);
 expect(prompt.historicalSections[0].text).toBe(reference.section.text);
 expect(prompt.blueprints[0]).toMatchObject({sourceId:'reference',use:'writing_reference',allowedUse:'conditional_reasoning_and_organization',currentProjectDecisions:false,referenceBlueprint:reference.section.blueprint});
 expect(prompt.authoritativeEvidence).toEqual([]);expect(sc.sources.find(ref=>ref.id==='reference')?.use).toBe('writing_reference');
 expect(generationSystem).toContain('默认围绕currentConfiguration写一个一致方案');
 expect(prompt.sectionBrief.referenceUseRules.join('')).toContain('因果解释及机制逻辑');
});

it('does not retain instructions from a historical section that cannot enter the evidence window',async()=>{
 const reference=fixture('采用参考系统的外置同步器');reference.section.text='历史详细材料'.repeat(12000);
 const section:DocumentSection={id:'s',title:'系统总体架构',level:1,order:0,generationMode:'ai',requiredContext:[],status:'empty',revision:1,edited:false,blocks:[],sourceRefs:[],assetRefs:[],lockedFactRefs:[],claims:[]};
 const sc=await buildSectionContext(section,structuredClone(context),{sections:async()=>[reference],retrieve:async()=>[]} as unknown as DocumentRetriever,{productFacts:async()=>[]} as unknown as StructuredService,14000),prompt=JSON.parse(sc.prompt);
 expect(prompt.historicalSections).toEqual([]);expect(prompt.blueprints).toEqual([]);expect(prompt.sectionBrief.referenceDesignChoices).toEqual([]);
 expect(sc.sources.some(source=>source.id==='reference')).toBe(false);
 expect(sc.prompt).not.toContain('采用参考系统的外置同步器');
});
