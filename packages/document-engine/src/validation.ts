import {randomUUID} from 'node:crypto';
import type {ProjectContext,RequirementItem,SourceReference} from '../../projects/src/types.js';
import type {DocumentBlock,DocumentSection,ValidationIssue,SourceRef} from './types.js';
import {asSource,allRequirements} from './context.js';
import {blockText} from './blocks.js';
import type {StructuredFact} from '../../structured/src/types.js';

type Metric = 'count'|'accuracy'|'p95'|'p90'|'mean'|'frameRate'|'latency'|'fov'|'resolution'|'boundary'|'range'|'viewCount'|`coverage${string}`|`under${string}`|'percentage';
interface Quantity {metric:Metric;value:number|number[];unit:string;raw:string;quote:string;factor:number;model?:string}
interface Evidence extends Quantity {source:SourceRef;priority:number;requirement:boolean}
const normalize=(value:string)=>value.normalize('NFKC').replace(/\s+/g,'').toLowerCase();
const numeric=/(?<![\w.])(\d+(?:\.\d+)?)\s*(万像素|像素|毫秒|毫米|厘米|赫兹|帧(?:\s*\/\s*秒)?|[kM]?Hz|fps|mm|cm|ms|m(?![a-z])|米|秒|s(?![a-z])|%|％|度|°|台|视点|视角)/gi;
const modelPattern=/(?<![A-Za-z0-9_])(?:K|MC|M|R|S|C|Q)\d{1,5}(?:[A-Z])?(?![A-Za-z0-9_])/gi;
const singleModel=(text:string):string|undefined=>{const models=[...new Set((text.match(modelPattern)??[]).map(value=>value.toUpperCase()))];return models.length===1?models[0]:undefined;};
function quantityModel(text:string,start:number,end:number,metric:Metric):string|undefined {
 if(metric==='boundary')return undefined; // The project site belongs to the deployment, not one camera model mentioned alongside it.
 const matches=[...text.matchAll(modelPattern)];
 // Camera counts commonly precede their model ("20台K18"); product specifications follow it.
 const following=matches.find(match=>match.index!>=end&&/^\s*$/.test(text.slice(end,match.index)));
 if(metric==='count'&&following)return following[0].toUpperCase();
 return matches.filter(match=>match.index!<start).at(-1)?.[0].toUpperCase()??singleModel(text);
}
const protocolPattern=/\b(?:PTP|NTP|TTL|SDK|USB(?:\s*[23](?:\.\d)?)?|EtherCAT|GigE|TCP\/IP|UDP|RS[- ]?(?:232|485))\b/gi;
const uncertain=/(?:待确认|待核实|待验证|尚未确认|尚未提供|未提供|有待|待测|拟采用|建议(?:采用|配置|选用)?|是否支持|是否满足)/;
const negative=/(?:不满足|不能满足|未满足|尚未满足|未达到|无法达到|不能达到|不保证|不支持|不具备|尚不支持|无法支持)/;
const normative=/(?:应(?:当|该)?|宜|须|必须)(?:为|达到|满足|支持|具备|实现|采用|配置|选用|不低于|不高于|不大于|不小于|至少)|(?:不得|不应|不宜)(?:低于|高于|大于|小于)|(?:示例|举例|假设|若客户)/;
const requirementWording=/(?:客户|项目|用户)[^，；。]{0,12}(?:要求|目标|期望)|(?:要求|目标|期望|需求指标)/;
const capabilityWording=/(?:满足|达到|支持|具备|实现|能够|可达|保证|配置|采用|部署|配备|选用)/;
const metricLabels:Partial<Record<Metric,string>>={count:'设备数量',accuracy:'精度',p95:'P95 理论误差',p90:'P90 理论误差',mean:'平均理论误差',frameRate:'帧率',latency:'时延',fov:'视场角',resolution:'分辨率',boundary:'场地尺寸',range:'距离',viewCount:'平均可见视点数',percentage:'比例'};

function metricFromLabel(label:string):Metric|undefined {
 const value=normalize(label);
 if(/boundary|场地尺寸|空间尺寸|场地边界/.test(value))return 'boundary';
 const ratio=/占比|比例|%/.test(value);
 if(/under03/.test(value)||ratio&&/(?<![\d.])0\.30*(?:mm|毫米)/.test(value))return 'under03';
 if(/under05/.test(value)||ratio&&/(?<![\d.])0\.50*(?:mm|毫米)/.test(value))return 'under05';
 const coverage=value.match(/coveragege([1-5])|(?:≥|>=|至少|大于等于)([1-5])(?:视点|视角|相机|路)?(?:覆盖|.*覆盖)/);
 if(coverage)return `coverage${coverage[1]??coverage[2]}`;
 if(/averageviewcount|平均可见视[点角]|平均视[点角]数/.test(value))return 'viewCount';
 if(/p95|95(?:百分位|分位)/.test(value))return 'p95';
 if(/p90|90(?:百分位|分位)/.test(value))return 'p90';
 if(/meanerror|(?:平均|均值).*(?:误差|精度)|(?:误差|精度).*(?:平均|均值)/.test(value))return 'mean';
 if(/equipmentcount|cameracount|相机数量|设备数量|数量.*台/.test(value))return 'count';
 if(/framerate|帧率|采样率|采集频率/.test(value))return 'frameRate';
 if(/latency|时延|延迟/.test(value))return 'latency';
 if(/fov|视场角/.test(value))return 'fov';
 if(/resolution|分辨率|像素/.test(value))return 'resolution';
 if(/accuracy|精度|误差/.test(value))return 'accuracy';
 if(/coverage|覆盖率/.test(value))return 'coverage';
 if(/range|距离|范围|長度|长度|高度/.test(value))return 'range';
}
function defaultUnit(metric:Metric|undefined):string {
 if(metric==='count')return '台';if(['accuracy','p95','p90','mean'].includes(metric??''))return 'mm';
 if(metric==='frameRate')return 'fps';if(metric==='latency')return 'ms';if(metric==='fov')return '°';
 if(metric==='resolution')return '像素';if(metric==='range'||metric==='boundary')return 'm';
 if(metric==='viewCount')return '视点';if(metric?.startsWith('coverage')||metric?.startsWith('under')||metric==='percentage')return '%';return '';
}
function quantities(text:string,forced?:Metric):Quantity[] {
 const result:Quantity[]=[];
 const tuples=[...text.matchAll(/(\d+(?:\.\d+)?)\s*(mm|毫米|cm|厘米|m\b|米|像素|px)?\s*[×xX*]\s*(\d+(?:\.\d+)?)\s*(mm|毫米|cm|厘米|m\b|米|像素|px)?(?:\s*[×xX*]\s*(\d+(?:\.\d+)?)\s*(mm|毫米|cm|厘米|m\b|米|像素|px)?)?/g)];
 const tupleSpans:[number,number][]=[];
 for(const match of tuples){
  const metric=match[5]?'boundary':forced==='resolution'||/分辨率|resolution|像素/i.test(text)?'resolution':undefined;
  if(!metric)continue;
  const sharedUnit=match[6]??match[4]??match[2]??'';
  const factorFor=(unit:string)=>metric==='resolution'?1:/mm|毫米/.test(unit)?.001:/cm|厘米/.test(unit)?.01:1;
  const value=(match[5]?[1,3,5]:[1,3]).map(index=>Number(match[index])*factorFor(match[index+1]??sharedUnit));
  result.push({metric,value,unit:metric==='resolution'?'pixels':'m',raw:match[1],quote:match[0],factor:factorFor(match[2]??sharedUnit),model:quantityModel(text,match.index!,match.index!+match[0].length,metric)});
  tupleSpans.push([match.index!,match.index!+match[0].length]);
 }
 for(const match of text.matchAll(numeric)){
  if(tupleSpans.some(([start,end])=>match.index!>=start&&match.index!<end))continue;
  const raw=match[1],unit=match[2],value=Number(raw),label=forced??metricFromLabel(text);
  let metric:Metric,factor=1,canonical=unit;
  if(/^(mm|毫米|cm|厘米|m|米)$/i.test(unit)){
   if(label?.startsWith('under')&&[.3,.5].includes(value))continue;
   metric=label&&['p95','p90','mean','accuracy','range','boundary'].includes(label)?label:'accuracy';
   factor=/cm|厘米/i.test(unit)?10:/^(m|米)$/i.test(unit)?1000:1;canonical='mm';
   if(metric==='range'||metric==='boundary'){factor/=1000;canonical='m';}
  }else if(/^(fps|[kM]?Hz|赫兹|帧)/i.test(unit)){metric='frameRate';factor=/^kHz$/i.test(unit)?1000:unit==='MHz'?1000000:unit==='mHz'?.001:1;canonical='fps';}
  else if(/^(ms|毫秒|秒|s)$/i.test(unit)){metric='latency';factor=/^(s|秒)$/.test(unit)?1000:1;canonical='ms';}
  else if(/[%％]/.test(unit)){metric=label?.startsWith('coverage')||label?.startsWith('under')?label:'percentage';canonical='%';}
  else if(/度|°/.test(unit)){metric='fov';canonical='°';}
  else if(/像素/.test(unit)){metric='resolution';factor=unit==='万像素'?10000:1;canonical='pixels';}
  else if(/视点|视角/.test(unit)){if(label!=='viewCount')continue;metric='viewCount';canonical='views';}
  else {metric='count';canonical='count';}
  result.push({metric,value:value*factor,unit:canonical,raw,quote:match[0],factor,model:quantityModel(text,match.index!,match.index!+match[0].length,metric)});
 }
 return result;
}
function sameQuantity(claim:Quantity,evidence:Quantity):boolean {
 if(claim.metric!==evidence.metric||claim.unit!==evidence.unit)return false;
 if(Array.isArray(claim.value)||Array.isArray(evidence.value))return Array.isArray(claim.value)&&Array.isArray(evidence.value)&&claim.value.length===evidence.value.length&&claim.value.every((value,index)=>Math.abs(value-(evidence.value as number[])[index])<=Math.max(1e-7,Math.abs(value)*.0001));
 if(Math.abs(claim.value-evidence.value)<=Math.max(1e-7,Math.abs(evidence.value)*.00001))return true;
 if(claim.metric==='count'||claim.metric==='resolution'||claim.value===0||claim.unit==='%'&&claim.value===100)return false;
 const precision=claim.raw.split('.')[1]?.length??0;
 const rounding=Math.min(.5*10**(-precision)*claim.factor,Math.abs(evidence.value)*.025)+1e-8;
 return Math.abs(claim.value-evidence.value)<=rounding;
}
const requirementSource=(item:RequirementItem):SourceRef=>({type:'project_input',id:item.sourceChunkId??item.sourceInputId,label:item.key??'客户要求',evidence:item.evidence,authority:'customer_requirement'});
const requirementReference=(ref:SourceRef)=>ref.type==='project_input'||ref.authority==='customer_requirement';
function productReference(ref:SourceRef):boolean {
 if(ref.type!=='knowledge_chunk')return true;
 // Classification authority is not enough: a standard or previous tender can be
 // authoritative about its own contents without proving this product's capability.
 if(/标准|规范|规程|standard|(?:^|[\s_])(?:GB|ISO|IEC|IEEE|EN|T[\/_])[\s\/_\d.-]/i.test(ref.label))return false;
 if(/历史|案例|示例|招标|投标|采购|合同|项目|方案|proposal|tender|\bbid\b/i.test(ref.label))return false;
 if(ref.authority==='authoritative')return true;
 return ref.authority==='reference'&&/产品|规格|参数|说明|手册|技术文档|技术资料|SDK|接口|manual|datasheet|specification/i.test(ref.label);
}
const allowedReference=(ref:SourceRef,isRequirement:boolean)=>ref.authority!=='style_only'&&(isRequirement||!requirementReference(ref)&&productReference(ref));
function isRequirement(text:string):boolean {
 if(!requirementWording.test(text))return false;
 if(/设计目标/.test(text)&&!/(?:客户|用户)[^，；。]{0,12}(?:要求|需求|目标|期望)|项目[^，；。]{0,12}(?:要求|需求)|需求指标/.test(text))return false;
 if(!negative.test(text)&&/(?:满足[^。；]{0,30}(?:要求|目标|指标)|达到[^。；]{0,30}(?:要求|目标|指标)|(?:要求|目标|指标)[^。；]{0,12}(?:已满足|已达到))/.test(text))return false;
 return true;
}
function textEvidence(text:string,source:SourceRef,priority:number,requirement:boolean,forced?:Metric):Evidence[] {
 const sourceModel=singleModel(source.label+' '+text);
 return text.split(/[。！？\n，；]+/).flatMap(sentence=>{
   if(!requirement&&(uncertain.test(sentence)||negative.test(sentence)||normative.test(sentence)||isRequirement(sentence)))return [];
  return quantities(sentence,forced).map(value=>({...value,model:value.model??sourceModel,source,priority,requirement}));
 });
}
function contextEvidence(context:ProjectContext):Evidence[] {
 const result:Evidence[]=[];
 const add=(key:string,label:string,value:unknown,unit:string|undefined,source:SourceReference,priority:number,requirement=false)=>{
  const metric=metricFromLabel(key+' '+label),reference=asSource(source);
  if(metric==='boundary'&&Array.isArray(value)&&value.length===3&&value.every(v=>typeof v==='number')){
   result.push({metric,value,unit:'m',raw:String(value[0]),quote:`${value.join(' × ')} m`,factor:1,source:reference,priority,requirement});return;
  }
  if(/models/.test(key)&&Array.isArray(value)){
   for(const model of value)if(model&&typeof model==='object'&&typeof model.name==='string'&&typeof model.count==='number')result.push({metric:'count',value:model.count,unit:'count',raw:String(model.count),quote:`${model.count}台 ${model.name}`,factor:1,model:model.name.toUpperCase(),source:reference,priority,requirement});
   return;
  }
  // Older SceneLab snapshots gave these percentage fields an "mm" unit from their key suffix.
  const actualUnit=source.type==='engineering_data'&&/^(?:performance\.)?under(?:03|05)Mm$/.test(key)?'%':unit??defaultUnit(metric);
  const scalar=typeof value==='number'?`${value}${actualUnit}`:String(value??'');
  result.push(...textEvidence(`${label} ${scalar}`,reference,priority,requirement,metric));
 };
 for(const fact of context.lockedFacts)add(fact.key,fact.label,fact.value,fact.unit,fact.sourceRef,fact.sourceType==='user'?0:fact.sourceType==='engineering_data'?1:2,fact.sourceType==='customer_requirement');
 const e=context.engineering;
 if(e){
  if(e.scene?.boundaryM)add('boundaryM','场地尺寸',e.scene.boundaryM,'m',e.sourceRef,1);
  if(e.deployment?.equipmentCount!==undefined)add('equipmentCount','相机数量',e.deployment.equipmentCount,'台',e.sourceRef,1);
  if(e.deployment?.models)add('models','相机型号与数量',e.deployment.models,undefined,e.sourceRef,1);
  for(const [key,value] of Object.entries(e.performance??{}))if(value!==undefined&&value!==null)add(key,key,value,defaultUnit(metricFromLabel(key)),e.sourceRef,1);
 }
 for(const capability of context.capabilities)add(capability.key,capability.label,capability.value,capability.unit,capability.sourceRef,2);
 // Always validate against the document's authoritative snapshot, even if the current chapter did not retrieve that parameter.
 for(const fact of (context as ProjectContext&{structuredFacts?:StructuredFact[]}).structuredFacts??[]){
  const ref:SourceRef={type:'structured_fact',id:fact.id,label:`${fact.productKey} ${fact.field}`,evidence:`${fact.productKey} ${fact.field} ${String(fact.value)}${fact.unit??''}`,authority:fact.authority};
  result.push(...textEvidence(ref.evidence,ref,2,false,metricFromLabel(fact.field)));
 }
 for(const [key,item] of Object.entries(context.requirements.performance))if(item)add(key,key,item.value,undefined,requirementSource(item),1,true);
 for(const requirement of allRequirements(context))result.push(...textEvidence(`${requirement.key??''} ${String(requirement.value)} ${requirement.evidence}`,requirementSource(requirement),2,true,metricFromLabel(requirement.key??'')));
 return result;
}
function segments(block:DocumentBlock):string[] {
 if(block.type!=='table')return blockText(block).split(/[。！？\n，；]+/).filter(Boolean);
 return block.rows.map(row=>{
  const rowLabel=row[0]??'';
  return `${block.title} ${row.map((cell,index)=>{
   const metric=metricFromLabel(`${rowLabel} ${block.columns[index]??''}`);
   const suffix=/^\s*\d+(?:\.\d+)?\s*$/.test(cell)?defaultUnit(metric):'';
   return `${block.columns[index]??''}：${cell}${suffix}`;
  }).join(' ')} ${rowLabel}`;
 });
}
function selectedEvidence(claim:Quantity,evidence:Evidence[],requirement:boolean,products:string[]):Evidence[] {
 let candidates=evidence.filter(item=>item.requirement===requirement&&item.metric===claim.metric&&item.unit===claim.unit);
 if(!requirement){
  const selected=products.map(model=>model.toUpperCase()),model=claim.model??(selected.length===1?selected[0]:undefined);
  // Library product evidence must identify the same selected model. A generic
  // manual or a similarly named model cannot establish a project capability.
  candidates=candidates.filter(item=>item.source.type!=='knowledge_chunk'||!!model&&selected.includes(model)&&item.model===model);
 }
 if(claim.metric==='count'&&claim.model){
  const userTotal=candidates.filter(item=>item.priority===0&&!item.model),model=candidates.filter(item=>item.model===claim.model);
  candidates=userTotal.length?userTotal:model.length?model:candidates.filter(item=>!item.model);
 }else if(claim.metric==='count')candidates=candidates.filter(item=>!item.model);
 else if(claim.model)candidates=candidates.filter(item=>item.model===claim.model);
 if(!candidates.length)return [];
 const priority=Math.min(...candidates.map(item=>item.priority));return candidates.filter(item=>item.priority===priority);
}

/** Metric, unit and source role must agree: an unrelated matching number cannot
 * establish a fact. This review never certifies real-world performance. */
export function validateSections(sections:DocumentSection[],context:ProjectContext,stale=false):ValidationIssue[]{
 const issues:ValidationIssue[]=[],base=contextEvidence(context),seen=new Set<string>();
 const add=(section:DocumentSection,type:ValidationIssue['type'],message:string,quote:string|undefined,sourceRefs:SourceRef[]=[],blockId?:string,severity:ValidationIssue['severity']='error')=>{
  const key=JSON.stringify([section.id,blockId,type,message,quote]);if(seen.has(key))return;seen.add(key);
  issues.push({id:randomUUID(),sectionId:section.id,blockId,severity,type,message,quote,sourceRefs:[...new Map(sourceRefs.map(ref=>[ref.type+':'+ref.id,ref])).values()]});
 };
 for(const section of sections){
  if(stale)add(section,'stale_context','项目资料或确认事实已更改，此方案保留旧快照，请按最新项目理解新建方案。',undefined);
  if(!section.blocks.length)add(section,'incomplete','章节尚未生成或编辑。',undefined,[],undefined,'warning');
  for(const block of section.blocks){
   if(block.type==='asset'){if(!context.assets.some(asset=>asset.id===block.assetId))add(section,'missing_source','图片不属于本项目快照。',block.caption,[],block.id);continue;}
   const refs=block.type==='table'&&block.sourceRefs.length?block.sourceRefs:section.sourceRefs;
   for(const sentence of segments(block)){
    const quote=sentence.trim();if(!quote)continue;
    const pending=uncertain.test(sentence),requirement=isRequirement(sentence)||(block.type==='table'&&/客户要求|需求|确认状态/.test(block.title)&&!capabilityWording.test(sentence));
    const claims=section.claims.filter(claim=>claim.text.includes(quote)||quote.includes(claim.text));
    const ids=new Set(claims.flatMap(claim=>[...claim.factIds,...claim.sourceIds]));
    const claimRefs=ids.size?refs.filter(ref=>ids.has(ref.id)||context.lockedFacts.some(fact=>ids.has(fact.id)&&fact.sourceRef.id===ref.id)):refs;
    const validRefs=claimRefs.filter(ref=>allowedReference(ref,requirement));
    const openConflicts=context.conflicts.filter(conflict=>conflict.status==='open');
    if(!pending&&!negative.test(sentence)&&/(?:满足[^。；]{0,30}(?:要求|目标|指标)|达到[^。；]{0,30}(?:目标|要求)|符合[^。；]{0,20}(?:要求|指标))/.test(sentence)&&openConflicts.length){
     add(section,'requirement_conflict','项目仍有未解决的要求与能力冲突，不能宣称已满足客户要求。',quote,openConflicts.flatMap(conflict=>conflict.sourceRefs.map(asSource)),block.id);
    }
    if(pending||negative.test(sentence))continue;
    const referenceEvidence=validRefs.flatMap(ref=>textEvidence(ref.evidence,ref,ref.type==='structured_fact'?2:3,requirementReference(ref),metricFromLabel(ref.label)));
    const evidence=[...base,...referenceEvidence],values=quantities(sentence);
    for(const claim of values){
     const candidates=selectedEvidence(claim,evidence,requirement,context.products);
     if(candidates.some(candidate=>sameQuantity(claim,candidate)))continue;
     const strong=candidates.filter(candidate=>candidate.priority<=2);
     const label=metricLabels[claim.metric]??(claim.metric.startsWith('coverage')?'对应视角覆盖率':claim.metric.startsWith('under')?'对应误差阈值比例':'技术参数');
     if(strong.length)add(section,'fact_mismatch',`${label}与${requirement?'客户要求':'当前锁定事实或参数来源'}不一致；依据为 ${strong.map(candidate=>candidate.quote).join('；')}。`,claim.quote,strong.map(candidate=>candidate.source),block.id);
     else add(section,'unsupported_claim',`${label}缺少同一指标、同一单位口径的有效依据，不能使用其他参数的数值代替。`,claim.quote,validRefs,block.id);
    }
    const selectedModels=context.products.map(normalize);
    for(const model of [...new Set(sentence.match(modelPattern)??[])]){
     if(selectedModels.includes(normalize(model)))continue;
     const source=validRefs.some(ref=>normalize(ref.evidence).includes(normalize(model))&&!negative.test(ref.evidence));
     if(selectedModels.length&&(/配置|采用|部署|选用|配备|\d+\s*台/.test(sentence)||!requirement&&values.some(value=>value.model&&normalize(value.model)===normalize(model))))add(section,'fact_mismatch','所述设备型号与本项目已确认选型不一致。',model,context.lockedFacts.filter(fact=>/products|models/.test(fact.key)).map(fact=>asSource(fact.sourceRef)),block.id);
     else if(!source)add(section,'unsupported_claim','型号未出现在本项目选型或有效引用依据中。',model,validRefs,block.id);
    }
    const protocolSources=[...validRefs,...(requirement?allRequirements(context).map(requirementSource):[]),...context.lockedFacts.filter(fact=>requirement||fact.sourceType!=='customer_requirement').map(fact=>({...asSource(fact.sourceRef),evidence:`${fact.label} ${String(fact.value)} ${fact.sourceRef.evidence??''}`})),...context.capabilities.map(capability=>({...asSource(capability.sourceRef),evidence:`${capability.label} ${String(capability.value)} ${capability.sourceRef.evidence??''}`}))];
    for(const protocol of [...new Set(sentence.match(protocolPattern)??[])]){
     const targetModel=singleModel(sentence)??(context.products.length===1?context.products[0].toUpperCase():undefined);
     const supported=protocolSources.some(ref=>allowedReference(ref,requirement)&&ref.evidence.split(/[。！？\n，；]+/).some(line=>{
      const sourceModel=singleModel(line)??singleModel(ref.label+' '+ref.evidence);
      return normalize(line).includes(normalize(protocol))&&!negative.test(line)&&!uncertain.test(line)&&(requirement||!normative.test(line)&&!isRequirement(line))&&(requirement||ref.type!=='knowledge_chunk'||!!targetModel&&sourceModel===targetModel&&selectedModels.includes(normalize(targetModel)));
     }));
     if(!supported)add(section,'unsupported_claim',`${protocol} 接口或协议${requirement?'要求':'能力'}缺少对应来源依据。`,protocol,validRefs,block.id);
    }
    if(!values.length&&/支持|具备|实现|精度|准确率|覆盖率|分辨率|视场角|延迟/.test(sentence)&&!requirement&&!validRefs.length)add(section,'missing_source','技术能力表述缺少来源，请补充依据后确认。',quote,[],block.id,'warning');
   }
   if(block.type==='table'&&block.generated&&!block.sourceRefs.length)add(section,'missing_source','程序参数表缺少事实来源。',block.title,[],block.id);
  }
 }
 return issues;
}
