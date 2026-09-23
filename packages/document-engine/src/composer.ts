import type {ProjectContext} from '../../projects/src/types.js';
import type {DocumentSection,VisualPlan} from './types.js';
import type {KnowledgeSection} from '../../knowledge-enrichment/src/types.js';

export interface SectionBrief {purpose:string;factsToUse:string[];requirementsToAddress:string[];recommendedStructure:string[];reusableLogic:string[];doNotClaim:string[];visualPlan?:VisualPlan}
export interface SectionReferenceBundle {role:string;projectFacts:unknown[];customerRequirements:unknown[];structuredFacts:unknown[];authoritativeEvidence:unknown[];historicalSections:unknown[];blueprints:unknown[];styleExample?:unknown}

export function makeSectionBrief(section:DocumentSection,context:ProjectContext,role:string,historical:KnowledgeSection[]):SectionBrief {
 const common=['以当前项目对象和目标引入本章','说明相关环节的功能与技术逻辑','结合已确认条件展开设计方法及衔接关系'];
 const structure:Record<string,string[]>={
  project_overview:['项目应用与建设目的','系统构成和方案范围','章节组织'],background:['应用任务与现有问题','建设动因'],objectives:['客户目标','系统建设方向'],
  deployment:['部署设计依据','布置与视线组织','安装与标定流程'],architecture:['功能层次','模块协同','输入输出关系'],technical_route:['处理流程','核心技术方法','设计取舍'],
  software:['软件功能组织','处理流程','数据管理'],data_flow:['数据来源','处理与传递路径','数据输出'],sdk_interface:['接口职责','数据定义与集成流程','联调方法'],
  acceptance:['验收组织与准备','测试步骤和记录','结果核查与交接'],accuracy:['理论分析条件','结果解释','工程实施要点'],coverage:['覆盖分析条件','空间可见性与遮挡分析','实施要点'],
 };
 const blueprints=historical.map(s=>s.blueprint).filter(Boolean);
 // One coherent reference structure, rather than splicing every retrieved project's scope together.
 const selectedStructure=(blueprints.find(b=>b!.recommendedStructure?.length)?.recommendedStructure??[]).slice(0,8);
 return {purpose:`围绕“${section.title}”形成可直接交付的技术方案章节`,factsToUse:context.lockedFacts.filter(f=>!f.key.startsWith('engineering.optics')).map(f=>f.id),requirementsToAddress:[],recommendedStructure:selectedStructure.length?selectedStructure:structure[role]??common,reusableLogic:blueprints.flatMap(b=>b!.reusableTechnicalLogic??[]).slice(0,12),doNotClaim:[
  '不引入历史项目的客户、场地、数量、型号、性能、设备选型或交付范围',
  '不将其他项目的应用对象、辅助硬件、软件功能或模块组合扩展为当前项目范围',
  '不将标准要求升级为已选产品的现有能力',
  '不将理论分析写成验收实测，不将客户要求写成已实现能力',
  ...(context.doNotClaim??[]),
  ...(context.conflicts.some(c=>c.status==='open')?['不宣称已满足全部客户指标']:[]),
  ...(!context.products.length?['不指定产品型号']:[]),
  ...(!context.engineering?['不编造部署数量、布置坐标或覆盖/精度结果']:[]),
 ],visualPlan:section.visualPlan};
}
