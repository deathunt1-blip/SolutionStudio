import type {LockedFact,ProjectContext,RequirementItem} from '../../projects/src/types.js';
import type {StructuredFact} from '../../structured/src/service.js';
import {sectionRoles} from '../../knowledge-enrichment/src/taxonomy.js';

const introductory=new Set(['project_overview','background','objectives','architecture','technical_route','features']);
const opticsRoles=new Set(['deployment','coverage','accuracy','hardware','camera_product']);
const focusedRoles=new Set<string>(sectionRoles.map(([role])=>role).filter(role=>role!=='other'));
const metric=/精度|误差|帧率|时延|分辨率|视场角|焦距|覆盖率|像素|accuracy|error|frame.?rate|latency|resolution|fov/i;
const systems=/软件|数据|接口|协议|同步|网络|格式|骨架|重定向|标定|校准|sdk|protocol|software|data|sync|network/i;
const selection=(fact:LockedFact)=>/^deployment\.(models|equipmentCount)$/.test(fact.key);
const narrative=(fact:LockedFact)=>!/^scene\.|^deployment\.|^performance\.|^engineering\.optics/.test(fact.key)&&!metric.test(fact.key+' '+fact.label);

/** Select writing context only. The immutable snapshot and independent validator retain every fact. */
export function focusFacts(role:string,facts:LockedFact[]):LockedFact[]{
 return facts.filter(f=>{
  if(f.key.startsWith('engineering.optics'))return false;
  // Report optical inputs travel through reportOptics for focused chapters. Keep
  // the complete factual fallback for unclassified/custom chapter roles.
  if(f.key==='engineering.opticalConfigurations'&&focusedRoles.has(role))return false;
  if(introductory.has(role))return narrative(f)||(role==='project_overview'&&selection(f));
  if(role==='deployment'||role==='installation')return /^scene\.|^deployment\./.test(f.key)||narrative(f);
  if(role==='coverage')return /^scene\.|^deployment\.|^performance\.(coverage|averageViewCount)/.test(f.key)||narrative(f);
  if(role==='accuracy')return /^scene\.|^deployment\.|^performance\.(meanError|p90Error|p95Error|under)/.test(f.key)||narrative(f);
  if(role==='hardware'||role==='camera_product'||role==='system_composition')return selection(f)||narrative(f);
  if(['software','sdk_interface','synchronization','network','data_processing','data_flow','marker_rigid_body','maintenance'].includes(role))return narrative(f)||selection(f)||systems.test(f.key+' '+f.label);
  return true;
 });
}
export function focusRequirements(role:string,context:ProjectContext,accepted:RequirementItem[]):RequirementItem[]{
 const r=context.requirements;
 let items:RequirementItem[];
 if(['project_overview','background'].includes(role))items=[...r.goals,...r.environment,...r.specialRequirements];
 else if(role==='objectives')items=[...r.goals,...Object.values(r.performance).filter((x):x is RequirementItem=>!!x),...r.specialRequirements];
 else if(role==='coverage')items=[...r.goals,...[r.performance.coverage,r.performance.range].filter((x):x is RequirementItem=>!!x),...r.environment,...r.installationConstraints];
 else if(role==='accuracy')items=[...r.goals,...[r.performance.accuracy].filter((x):x is RequirementItem=>!!x),...r.acceptanceCriteria];
 else if(role==='deployment'||role==='installation')items=[...r.environment,...r.installationConstraints,...[r.performance.range,r.performance.cameraCount,r.performance.coverage].filter((x):x is RequirementItem=>!!x),...r.specialRequirements];
 else if(['sdk_interface','data_flow','synchronization','network','software','data_processing'].includes(role))items=[...r.goals,...r.interfaces,...r.protocols,...r.specialRequirements];
 else items=accepted;
 const selected=new Set(items.map(i=>i.id));return accepted.filter(i=>selected.has(i.id));
}
export function focusProductFacts(role:string,facts:StructuredFact[]):StructuredFact[]{
 if(introductory.has(role)||role==='system_composition')return [];
 const filters:Record<string,RegExp>={
  network:/网络|接口|带宽|同步|供电|network|interface|ethernet|bandwidth|sync|poe/i,
  synchronization:/同步|时钟|时延|触发|sync|clock|latency|trigger/i,
  sdk_interface:/接口|协议|格式|软件|系统支持|数据|sdk|protocol|interface|format|software|data/i,
  software:/软件|系统支持|数据|格式|接口|sdk|software|data|format|interface/i,
  data_flow:systems,data_processing:systems,
  coverage:/视场|距离|焦距|分辨率|镜头|精度|field|fov|range|distance|lens|resolution|accuracy/i,
  accuracy:/精度|误差|分辨率|焦距|视场|镜头|accuracy|error|resolution|focal|lens|fov/i,
 };
 return filters[role]?facts.filter(f=>filters[role].test(f.field)):facts;
}
export function focusedEngineering(role:string,context:ProjectContext){
 const e=context.engineering;if(!e||introductory.has(role))return undefined;
 if(role==='other')return {scene:e.scene,deployment:e.deployment,performance:e.performance,metricDefinitions:e.metadata};
 const performance=role==='coverage'?Object.fromEntries(Object.entries(e.performance??{}).filter(([key])=>/^(coverage|averageViewCount)/.test(key))):role==='accuracy'?Object.fromEntries(Object.entries(e.performance??{}).filter(([key])=>/^(meanError|p90Error|p95Error|under)/.test(key))):undefined;
 return {scene:e.scene,deployment:e.deployment?{equipmentCount:e.deployment.equipmentCount,models:e.deployment.models}:undefined,...(performance?{performance,metricDefinitions:e.metadata}:{})};
}
export const includeReportOptics=(role:string)=>role==='other'||opticsRoles.has(role);
export const includeDetailedProductEvidence=(role:string)=>!introductory.has(role);
