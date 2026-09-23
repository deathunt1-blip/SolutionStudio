import type { ProjectFingerprint, SoftTags, TagDimension } from './types.js';

export const sectionRoles = [
 ['project_overview','项目概述'],['background','应用背景'],['objectives','建设目标'],['requirements','客户需求'],['technical_indicators','技术指标'],
 ['architecture','总体架构'],['technical_route','技术路线'],['system_composition','系统组成'],['deployment','相机部署'],['coverage','覆盖分析'],['accuracy','精度分析'],
 ['marker_rigid_body','标记与刚体'],['hardware','硬件'],['camera_product','相机产品'],['synchronization','同步'],['network','网络'],['software','软件'],
 ['data_processing','数据处理'],['sdk_interface','SDK与接口'],['data_flow','数据流'],['installation','安装实施'],['acceptance','验收'],['maintenance','维护'],['features','方案特点'],['other','其他'],
] as const;
export const projectStages = [['planning','规划'],['proposal','方案'],['implementation','实施'],['acceptance','验收'],['operation','运行维护']] as const;
const vocabulary:Partial<Record<TagDimension,Record<string,string[]>>> = {
 document_type:{solution:['技术方案'],product_document:['产品资料'],technical_knowledge:['技术知识'],test_report:['测试报告'],acceptance_report:['验收报告'],implementation_document:['实施文档'],standard:['标准规范'],manual:['使用说明'],case:['项目案例'],style_sample:['写作样例'],contract_or_requirement:['合同与技术要求'],other:['其他']},
 applications:{robotics:['机器人','机器人测试','robot','robot testing'],drone:['无人机','uav'],human_motion:['人体运动','人体动捕','human motion'],underwater:['水下'],vr:['虚拟现实','xr','virtual_reality'],industrial:['工业'],research:['科研','scientific_research'],sports:['体育','sports_analysis'],film:['影视'],measurement:['测量'],education:['教育']},
 target_objects:{humanoid_robot:['人形机器人','humanoid robot'],wheeled_robot:['轮式机器人','wheeled robot'],drone:['无人机','uav'],human:['人体','人员']},
 scenarios:{robot_testing:['机器人测试','机器人检测','robot testing'],complex_terrain:['复杂地形','complex terrain'],large_space:['大空间','large space']},
 technical_topics:{optical_motion_capture:['光学动捕','光学动作捕捉','optical motion capture'],markerless_motion_capture:['无标记动捕','无标记动作捕捉'],optical_inertial_fusion:['光惯融合','光惯混合','光学惯性融合','光学-惯性融合'],motion_retargeting:['运动重定向','动作重定向'],coverage:['覆盖'],accuracy:['精度','高精度','高精度测量'],rigid_body:['刚体','rigid body'],marker:['标记点'],urdf:['URDF'],synchronization:['同步','时间同步','ptp','multi_device_synchronization'],calibration:['标定']},
 system_modules:{camera_deployment:['相机部署','布机','camera deployment'],camera_array:['相机阵列'],sdk:['SDK','sdk接口','sdk_interface'],synchronization:['同步','同步链路','synchronization_system'],network:['网络','network_system'],software:['软件'],data_processing:['数据处理']},
 environment:{underwater:['水下'],pool:['泳池','水池'],indoor_lab:['室内实验室'],indoor:['室内'],outdoor:['室外','户外']},
 project_stage:Object.fromEntries(projectStages.map(([key,label])=>[key,[label]])),
};
/** Both requirement extraction and library enrichment should receive this same open vocabulary. */
export const tagVocabulary=vocabulary;
export interface TagAlias {dimension:string;alias:string;canonical:string}
const folded=(value:string)=>value.normalize('NFKC').trim().replace(/\s+/g,' ').toLowerCase();
export function normalizeTag(dimension:string,value:string,aliases:TagAlias[]=[]):string {
 let clean=value.normalize('NFKC').trim().replace(/\s+/g,' '),normalized=folded(clean);const visited=new Set<string>();
 // Confirmed aliases can subsequently be merged again; follow the complete chain.
 while(!visited.has(normalized)){visited.add(normalized);const approved=aliases.find(alias=>alias.dimension===dimension&&folded(alias.alias)===normalized);if(!approved)break;clean=approved.canonical;normalized=folded(clean);}
 for(const [key,values] of Object.entries(vocabulary[dimension as TagDimension]??{}))if(folded(key)===normalized||values.some(item=>folded(item)===normalized))return key;
 return dimension==='products'?clean.toUpperCase():/^[a-z\d _-]+$/i.test(clean)?normalized.replace(/[\s-]+/g,'_'):clean;
}
export const fingerprintDimensions = {applications:'applications',targetObjects:'target_objects',scenarios:'scenarios',topics:'technical_topics',modules:'system_modules',products:'products',environment:'environment',constraints:'constraints'} as const;
export function normalizeFingerprint(input:Partial<ProjectFingerprint>,aliases:TagAlias[]=[]):ProjectFingerprint {
 return Object.fromEntries(Object.entries(fingerprintDimensions).map(([key,dimension])=>[key,[...new Set((Array.isArray(input[key as keyof ProjectFingerprint])?input[key as keyof ProjectFingerprint]!:[]).filter(value=>typeof value==='string'&&value.trim()).map(value=>normalizeTag(dimension,value,aliases)))]])) as unknown as ProjectFingerprint;
}
export function tagValues(tags:SoftTags,dimension:TagDimension,minConfidence=0):string[]{return (tags[dimension]??[]).filter(tag=>tag.confidence>=minConfidence).map(tag=>tag.value);}
export function tagLabel(dimension:string,value:string):string {
 if(dimension==='section_role')return sectionRoles.find(([key])=>key===value)?.[1]??value;
 return vocabulary[dimension as TagDimension]?.[value]?.find(label=>/[\p{Script=Han}]/u.test(label))??value;
}
export function inferSectionRole(title:string):string {
 if(/安装与部署|安装实施|现场实施/.test(title))return 'installation';
 const markerless=/无\s*标记|无\s*标志点|\bmarker[\s-]?less\b/i;
 if(markerless.test(title)&&/解算|数据处理|重建|姿态估计|processing|reconstruction|(?:pose|motion)\s+estimation/i.test(title))return 'data_processing';
 const markerTitle=title.replace(/无\s*标记|无\s*标志点|\bmarker[\s-]?less\b/gi,'');
 const tests:[string,RegExp][]=[['data_flow',/数据流|data.?flow/i],['marker_rigid_body',/刚体|标记|工装|\bmarkers?\b|\brigid[\s-]?body\b/i],['sdk_interface',/SDK|接口|协议|interface/i],['synchronization',/同步|sync/i],['network',/网络|network/i],['coverage',/覆盖|coverage/i],['accuracy',/精度|accuracy/i],['technical_indicators',/技术指标|性能指标|指标汇总/i],['requirements',/需求|客户要求|requirement/i],['camera_product',/相机产品|动捕相机|camera.?product/i],['deployment',/部署|布置|布机|布设|deployment/i],['installation',/安装|实施|施工|installation/i],['acceptance',/验收|acceptance/i],['maintenance',/维护|售后|maintenance/i],['data_processing',/数据处理|数据解算|data.?processing/i],['software',/软件|software/i],['hardware',/硬件|hardware/i],['technical_route',/技术路线|技术原理/i],['system_composition',/系统组成|配置清单|设备组成/i],['architecture',/架构|拓扑|总体设计|architecture/i],['background',/背景|background/i],['objectives',/目标|objective/i],['features',/特点|优势|feature/i],['project_overview',/概述|总述|overview/i]];
 return tests.find(([role,test])=>test.test(role==='marker_rigid_body'?markerTitle:title))?.[0]??'other';
}
