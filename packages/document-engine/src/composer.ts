import type {ProjectContext} from '../../projects/src/types.js';
import type {DocumentSection,VisualPlan} from './types.js';
import type {KnowledgeSection} from '../../knowledge-enrichment/src/types.js';

export interface SectionBrief {purpose:string;factsToUse:string[];requirementsToAddress:string[];recommendedStructure:string[];reusableLogic:string[];referenceUseRules:string[];currentConfiguration:{id:string;label:string;value:unknown;unit?:string}[];referenceDesignChoices:{sourceId:string;notCurrentDecisions:string[]}[];doNotClaim:string[];visualPlan?:VisualPlan}
export interface SectionReferenceBundle {role:string;projectFacts:unknown[];customerRequirements:unknown[];structuredFacts:unknown[];authoritativeEvidence:unknown[];historicalSections:unknown[];blueprints:unknown[];styleExample?:unknown}

export function makeSectionBrief(section:DocumentSection,context:ProjectContext,role:string,historical:KnowledgeSection[]):SectionBrief {
 const common=['以当前项目对象和目标引入本章','说明相关环节的功能与技术逻辑','结合已确认条件展开设计方法及衔接关系'];
 const structure:Record<string,string[]>={
  project_overview:['项目应用与建设目的','系统构成和方案范围','章节组织'],background:['应用任务与现有问题','建设动因'],objectives:['客户目标','系统建设方向'],
  deployment:['部署设计依据','布置与视线组织','安装与标定流程'],architecture:['功能层次','模块协同','输入输出关系'],technical_route:['处理流程','核心技术方法','设计取舍'],system_composition:['已确认系统组成','各组成部分的职责','设备与处理环节的衔接'],
  software:['软件功能组织','处理流程','数据管理'],data_flow:['数据来源','处理与传递路径','数据输出'],sdk_interface:['接口职责','数据定义与集成流程','联调方法'],
  acceptance:['验收组织与准备','测试步骤和记录','结果核查与交接'],accuracy:['理论分析条件','结果解释','工程实施要点'],coverage:['覆盖分析条件','空间可见性与遮挡分析','实施要点'],
 };
 // The brief instructs the writer, so a previous project's blueprint must not
 // become its imperative plan. Keep examples separately with explicit provenance.
 return {purpose:`围绕“${section.title}”形成可直接交付的技术方案章节`,factsToUse:context.lockedFacts.filter(f=>!f.key.startsWith('engineering.optics')).map(f=>f.id),requirementsToAddress:[],recommendedStructure:structure[role]??common,reusableLogic:[
  '先以当前项目事实或客户要求说明设计问题，再解释相关功能关系，最后说明实施与验证方法',
  '通用原理只说明适用条件和作用，具体结构、算法、软件功能及产品能力必须另有当前项目依据',
 ],referenceUseRules:[
  '历史提纲和蓝图只作为论证顺序示例，不作为本章必须实现的功能、结构或设计指令',
  '可吸收与本章相关的论证顺序、比较维度、因果解释及机制逻辑，再围绕当前事实重新组织；保留通用机理的适用条件，不必机械套用推荐提纲',
  '围绕当前已确认配置组织一个一致方案；仅当当前项目明确要求比较或替代选项时才划分多个方案',
  '历史开放/封闭分区、网格单元、独立标定后全场融合等结构不能因可复用或通用而成为本项目部署方案',
  '历史光惯融合、滤波算法、自动标定、全局定位及软件功能，须有当前已选设备和软件的适用依据；单独选中同系列相机不代表具备这些系统能力',
 ],currentConfiguration:context.lockedFacts.filter(f=>/^deployment\.(models|equipmentCount)$/.test(f.key)).map(({id,label,value,unit})=>({id,label,value,unit})),referenceDesignChoices:historical.filter(s=>s.blueprint).map(s=>({sourceId:s.id,notCurrentDecisions:[...s.blueprint.projectSpecificElements,...s.blueprint.reusableTechnicalLogic]})),doNotClaim:[
  '不引入历史项目的客户、场地、数量、型号、性能、设备选型或交付范围',
  '不将其他项目的应用对象、辅助硬件、软件功能或模块组合扩展为当前项目范围',
  '不将历史方案划分、分区结构、标定组织、融合算法或软件能力改写为当前已确认方案；依据不足时仅解释有条件的原理，不承诺其实施',
  '不将标准要求升级为已选产品的现有能力',
  '不将理论分析写成验收实测，不将客户要求写成已实现能力',
  ...(context.doNotClaim??[]),
  ...(context.conflicts.some(c=>c.status==='open')?['不宣称已满足全部客户指标']:[]),
  ...(!context.products.length?['不指定产品型号']:[]),
  ...(!context.engineering?['不编造部署数量、布置坐标或覆盖/精度结果']:[]),
 ],visualPlan:section.visualPlan};
}
