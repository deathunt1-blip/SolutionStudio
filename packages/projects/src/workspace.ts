import { emptyRequirements, parseRequirements, isPromotionalTarget, requirementEntries, stableId, type RequirementSource } from './requirements.js';
import type { EvidenceRef, ProjectFingerprint, ProjectRequirements, WorkspaceRequirement, ProjectFactProposal, RequirementItem } from './types.js';

export const requirementCategoryLabels:Record<string,string>={'performance.accuracy':'精度要求','performance.frameRate':'帧率要求','performance.latency':'时延要求','performance.coverage':'覆盖要求','performance.range':'工作范围','performance.cameraCount':'设备数量要求',goals:'建设目标',interfaces:'接口要求',protocols:'协议要求',environment:'环境要求',installationConstraints:'安装要求',specialRequirements:'其他要求',acceptanceCriteria:'验收要求'};
export const categoryForType:Record<string,string>={accuracy:'performance.accuracy',frameRate:'performance.frameRate',latency:'performance.latency',coverage:'performance.coverage',range:'performance.range',cameraCount:'performance.cameraCount',interface:'interfaces',environment:'environment',installation:'installationConstraints',acceptance:'acceptanceCriteria',other:'specialRequirements'};
export function normalizedRequirement(value:unknown,unit?:string):string {
 const text=String(value??'').normalize('NFKC').toLowerCase().replace(/不得低于|不低于|不少于|大于等于/g,'>=').replace(/不得超过|不超过|不大于|小于等于/g,'<=').replace(/≥/g,'>=').replace(/≤/g,'<=').replace(/毫米/g,'mm').replace(/厘米/g,'cm').replace(/毫秒/g,'ms').replace(/赫兹|帧\/秒|fps/g,'hz').replace(/\s+/g,'');
 const metric=text.match(/(>=|<=|>|<|=)?(\d+(?:\.\d+)?)(mm|cm|ms|hz|%|m|台|s)?/g);
 // Normalize only an unambiguous single metric; retain distinct conditions in compound requirements.
 if(metric?.length===1&&/[\d]/.test(text)){const m=metric[0].match(/(>=|<=|>|<|=)?(\d+(?:\.\d+)?)(.*)/)!;let n=Number(m[2]),u=m[3]||unit||'';if(u==='cm'){n*=10;u='mm';}return `${m[1]||'='}${n}${u}`;}
 return text.replace(/[：:，,。；;]/g,'');
}
export const evidenceFor=(source:RequirementSource,value:string):EvidenceRef=>({sourceType:source.kind==='manual_note'?'manual_note':'project_file',sourceId:source.id,excerpt:value});
const uniqueEvidence=(refs:EvidenceRef[])=>[...new Map(refs.map(ref=>[`${ref.sourceType}:${ref.sourceId}:${ref.excerpt||''}`,ref])).values()];
function metricValue(category:string,value:unknown,unit?:string):string|undefined {
 const text=`${String(value??'')} ${unit||''}`;const tests:Record<string,RegExp>={'performance.accuracy':/\d+(?:\.\d+)?\s*(?:mm|cm|μm|um|毫米|厘米|微米)/i,'performance.coverage':/\d+(?:\.\d+)?\s*%|百分之\s*\d/,'performance.range':/\d+(?:\.\d+)?\s*(?:m|米)/i,'performance.frameRate':/\d+(?:\.\d+)?\s*(?:hz|fps|帧)/i,'performance.latency':/\d+(?:\.\d+)?\s*(?:ms|s|毫秒|秒)/i,'performance.cameraCount':/\d+\s*台|^\s*\d+\s*$/};
 if(!tests[category]?.test(text))return undefined;if(category==='performance.cameraCount'){const count=text.match(/(\d+)\s*台|^\s*(\d+)\s*$/);if(count)return `=${Number(count[1]||count[2])}台`;}
 return normalizedRequirement(value,unit);
}
function qualitativeConflict(category:string,a:unknown,b:unknown):boolean {
 const left=String(a),right=String(b);const grade=(text:string)=>['亚毫米','微米级','毫米级','厘米级','米级'].find(g=>text.includes(g));
 if(category==='performance.accuracy'&&grade(left)&&grade(right)&&grade(left)!==grade(right))return true;
 const environment=(text:string)=>/室内外/.test(text)?'both':/室内/.test(text)&&!/室外/.test(text)?'indoor':/室外/.test(text)&&!/室内/.test(text)?'outdoor':undefined;
 if(environment(left)&&environment(right)&&environment(left)!==environment(right)&&environment(left)!=='both'&&environment(right)!=='both')return true;
 const positive=(text:string)=>text.replace(/[\s，,。；;：:]/g,'').replace(/不支持/g,'支持').replace(/不允许|禁止/g,'允许').replace(/不需要|无需/g,'需要').replace(/不包含|不含/g,'包含');const negative=/(?:不支持|不允许|禁止|不需要|无需|不包含|不含)/;
 return negative.test(left)!==negative.test(right)&&positive(left)===positive(right);
}
export function mergeWorkspaceRequirements(projectId:string,sources:RequirementSource[],extracted:ProjectRequirements,previous:WorkspaceRequirement[]=[],decisions:WorkspaceRequirement[]=[],reviewedInputIds:string[]=[],restoreCategories:string[]=[],aiItems:{category:string;item:RequirementItem}[]=[],aiReviewedSourceIds:string[]=[]):WorkspaceRequirement[] {
 const groups=new Map<string,WorkspaceRequirement>();const sourceMap=new Map(sources.map(s=>[s.id,s]));
 const add=(category:string,item:{id:string;value:unknown;sourceInputId:string;evidence:string;confirmedByUser:boolean})=>{
  if(item.sourceInputId!=='user'&&!item.confirmedByUser&&isPromotionalTarget(category,item.value))return;
  const source=sourceMap.get(item.sourceInputId);if(!source&&item.sourceInputId!=='user')return;
  const semanticKey=category.startsWith('performance.')?category:`${category}:${normalizedRequirement(item.value)}`;
  const refs:EvidenceRef[]=[source?evidenceFor(source,item.evidence):{sourceType:'user',sourceId:projectId,excerpt:item.evidence}];
  const old=groups.get(semanticKey);if(!old){groups.set(semanticKey,{id:stableId(projectId,'requirement',semanticKey),semanticKey,category,label:requirementCategoryLabels[category]||'客户要求',value:item.value,status:'proposed',evidenceRefs:refs,confirmedByUser:false});return;}
  if(category.startsWith('performance.')){const a=metricValue(category,old.value,old.unit),b=metricValue(category,item.value);if((!a||!b)&&!qualitativeConflict(category,old.value,item.value)){if(b)old.value=item.value;else if(!a&&String(old.value)!==String(item.value)){const pending=/待确认|未明确|尚未明确|未知|不清楚|\bTBD\b/i;if(pending.test(String(old.value)))old.value=item.value;else if(!pending.test(String(item.value))){const values=[...new Set([...(Array.isArray(old.value)?old.value.map(String):[String(old.value)]),String(item.value)])];const sameAccuracyGrade=category==='performance.accuracy'&&['亚毫米','微米级','毫米级','厘米级'].some(g=>values.every(v=>v.includes(g)));const wallScope=category==='performance.coverage'&&values.every(v=>/实验墙|墙前|工位|机械臂运行空间/.test(v));old.value=sameAccuracyGrade||wallScope?values.join('；'):values;}}old.evidenceRefs=uniqueEvidence([...old.evidenceRefs,...refs]);return;}if(a&&b&&a===b){old.evidenceRefs=uniqueEvidence([...old.evidenceRefs,...refs]);return;}}
  else if(normalizedRequirement(old.value)===normalizedRequirement(item.value)){old.evidenceRefs=uniqueEvidence([...old.evidenceRefs,...refs]);return;}
  const alternatives=old.alternatives||[{value:old.value,evidenceRefs:old.evidenceRefs}];const same=alternatives.find(a=>normalizedRequirement(a.value)===normalizedRequirement(item.value));if(same)same.evidenceRefs=uniqueEvidence([...same.evidenceRefs,...refs]);else alternatives.push({value:item.value,evidenceRefs:refs});old.alternatives=alternatives;old.status='conflicted';old.evidenceRefs=uniqueEvidence(alternatives.flatMap(a=>a.evidenceRefs));
 };
 for(const source of sources)for(const line of source.text.split(/[\r\n]+|(?<=[。；])/).filter(Boolean))for(const [category,item] of requirementEntries(parseRequirements([{...source,text:line}])))if(!aiReviewedSourceIds.includes(source.id)&&(!reviewedInputIds.includes(source.id)||restoreCategories.includes(category)))add(category,item);
 for(const [category,item] of requirementEntries(extracted))if(item.sourceInputId==='user'||!aiReviewedSourceIds.includes(item.sourceInputId))add(category,item);
 for(const {category,item} of aiItems)if(!reviewedInputIds.includes(item.sourceInputId)||restoreCategories.includes(category))add(category,item);
 for(const prior of previous.filter(r=>r.confirmedByUser)){
  const retained=prior.evidenceRefs.filter(e=>e.sourceType==='user'||sourceMap.has(e.sourceId));const current=groups.get(prior.semanticKey);
  const equivalent=current&&normalizedRequirement(current.value,current.unit)===normalizedRequirement(prior.value,prior.unit);
  // A previously confirmed choice is explicit evidence, independent from its original file.
  const userEvidence:EvidenceRef={sourceType:'user',sourceId:projectId,excerpt:`用户确认：${String(prior.value)}`};
  groups.set(prior.semanticKey,{...prior,evidenceRefs:uniqueEvidence([...retained,...(equivalent?current.evidenceRefs:[]),userEvidence]),alternatives:current?.alternatives||prior.alternatives});
 }
 for(const decision of decisions){const current=groups.get(decision.semanticKey);groups.set(decision.semanticKey,{...decision,evidenceRefs:uniqueEvidence([...decision.evidenceRefs.filter(e=>e.sourceType==='user'||sourceMap.has(e.sourceId)),...(current?.evidenceRefs||[])]),alternatives:current?.alternatives||decision.alternatives});}
 return [...groups.values()];
}
export function safeRequirements(base:ProjectRequirements,items:WorkspaceRequirement[]):ProjectRequirements {
 const result={...emptyRequirements(),projectName:base.projectName,customerName:base.customerName,application:base.application};
 for(const row of items){if(!['proposed','confirmed'].includes(row.status))continue;const ref=row.evidenceRefs.find(e=>e.sourceType==='user')||row.evidenceRefs[0];if(!ref)continue;const value=row.unit&&!String(row.value).toLowerCase().includes(row.unit.toLowerCase())?`${String(row.value)} ${row.unit}`:row.value;const item={id:row.id,key:row.category.replace('performance.',''),value,sourceInputId:ref.sourceType==='user'?'user':ref.sourceId,evidence:ref.excerpt||String(row.value),confidence:row.confirmedByUser?1:.82,confirmedByUser:row.confirmedByUser};if(row.category.startsWith('performance.'))result.performance[row.category.slice(12) as keyof ProjectRequirements['performance']]=item;else (result[row.category as 'goals'] as typeof result.goals)?.push(item);}
 return result;
}
export const emptyFingerprint=():ProjectFingerprint=>({applications:[],targetObjects:[],scenarios:[],topics:[],modules:[],products:[],environment:[],constraints:[]});
export function inferFingerprint(text:string,products:string[]=[],override:Partial<ProjectFingerprint>={}):ProjectFingerprint {
 const result=emptyFingerprint();const patterns:Partial<Record<keyof ProjectFingerprint,[string,RegExp][]>>={applications:[['robotics',/机器人|robot/i],['drone',/无人机|飞行器|drone/i],['human_motion',/人体|动作捕捉|步态/],['industrial',/工业|产线/],['sports',/体育|运动训练/],['education',/教学|实训|学校/],['vr',/虚拟现实|\bVR\b|\bXR\b/i],['research',/科研|实验室/]],targetObjects:[['机器人',/机器人/],['无人机',/无人机/],['人体',/人体|人员|运动员/],['刚体',/刚体/]],scenarios:[['动作捕捉',/动捕|动作捕捉/],['运动分析',/运动分析|步态/],['遥操作',/遥操作/]],topics:[['accuracy',/精度|误差/],['synchronization',/同步|PTP/],['sdk',/SDK|接口/i],['deployment',/部署|安装/],['network',/网络|以太网/]],modules:[['光学捕捉',/光学|相机/],['数据处理',/数据处理/],['同步系统',/同步/]],environment:[['室内',/室内/],['室外',/室外/],['水下',/水下/]],constraints:[['遮挡',/遮挡/],['不可打孔',/不可打孔|禁止打孔/]]};
 for(const [key,entries] of Object.entries(patterns))result[key as keyof ProjectFingerprint]=entries.filter(([,p])=>p.test(text)).map(([tag])=>tag);result.products=[...new Set(products)];for(const key of Object.keys(result) as (keyof ProjectFingerprint)[])if(override[key])result[key]=[...new Set(override[key]!.map(v=>v.trim()).filter(Boolean))];return result;
}
export function factProposals(sources:RequirementSource[]):ProjectFactProposal[] {
 const result:ProjectFactProposal[]=[];for(const source of sources)for(const line of source.text.split(/[\r\n。；]+/)){
  const add=(key:string,label:string,value:unknown,unit:string,category:string)=>result.push({id:stableId(source.id,key,JSON.stringify(value)),key,label,value,unit,category,evidenceRefs:[evidenceFor(source,line)]});
  const count=line.match(/(?:相机数量|设备数量)\s*[:：为是]?\s*(\d+)\s*(?:台)?/);if(count&&!/要求|至少|不低于/.test(line))add('deployment.equipmentCount','相机数量',Number(count[1]),'台','设备');
  const dimensions=line.trim().match(/^(?:本项目|项目|总)?(?:场地尺寸|空间尺寸|场地|空间)[^\d]{0,10}(\d+(?:\.\d+)?)\s*[×xX*]\s*(\d+(?:\.\d+)?)\s*[×xX*]\s*(\d+(?:\.\d+)?)\s*(?:米|m)/);if(dimensions)add('scene.boundaryM','场地尺寸（长、宽、高）',dimensions.slice(1).map(Number),'m','场地');
 }return result;
}
export function mergeFactProposals(proposals:ProjectFactProposal[]):ProjectFactProposal[]{
 const merged=new Map<string,ProjectFactProposal>();for(const proposal of proposals){let value=proposal.value,unit=proposal.unit;if(proposal.key==='deployment.equipmentCount'&&typeof value==='string'&&/^\d+\s*(?:台)?$/.test(value.trim())){value=Number(value.replace(/\s*台\s*$/,''));unit='台';}const key=`${proposal.key}:${JSON.stringify(value)}:${unit||''}`;const prior=merged.get(key);if(prior)prior.evidenceRefs=uniqueEvidence([...prior.evidenceRefs,...proposal.evidenceRefs]);else merged.set(key,{...proposal,value,unit});}return [...merged.values()];
}
export function userFactKey(label:string,category:string,value?:unknown):string {if(/相机数量|设备数量/.test(label))return 'deployment.equipmentCount';if(/^(?:本项目)?(?:场地尺寸|空间尺寸)(?:[（(]长[、,，]宽[、,，]高[）)])?$/.test(label)){const dimensions=Array.isArray(value)?value:typeof value==='string'?value.match(/\d+(?:\.\d+)?/g)?.map(Number):undefined;if(dimensions?.length===3&&dimensions.every(v=>typeof v==='number'&&Number.isFinite(v)&&v>0))return 'scene.boundaryM';}if(/型号与数量|型号和数量/.test(label))return 'deployment.models';if(/设备型号|相机型号/.test(label))return 'products';if(/坐标系/.test(label))return 'scene.coordinateSystem';if(/安装高度|架设高度|相机高度/.test(label))return 'deployment.installationHeight';if(/安装位置|架设位置/.test(label))return 'deployment.installationPosition';if(/安装方式|安装方法|部署方式|固定方式/.test(label))return 'installation.method';return `user.${stableId(category,label)}`;}
