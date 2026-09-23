import {effectiveEngineering} from './facts.js';
import {randomUUID} from 'node:crypto';
import {HttpError} from '../../knowledge/src/service.js';
import type {ProjectContext} from '../../projects/src/types.js';
import type {DocumentBlock,DocumentSection,Claim,SourceRef} from './types.js';
import type {SectionContext} from './context.js';
import {allRequirements,asSource,factSource,requirementLabel} from './context.js';
import {cleanMermaidSource} from './diagram-policy.js';
import {customerText} from './customer-facing.js';
const text=(value:unknown,max=16000)=>{if(typeof value!=='string'||value.length>max)throw new HttpError(400,'文档内容格式或长度无效');return value;};
export function cleanBlocks(value:unknown,context:ProjectContext):DocumentBlock[]{
 if(!Array.isArray(value)||value.length>150)throw new HttpError(400,'每章最多 150 个内容块');
 return value.map((raw:any):DocumentBlock=>{
  if(!raw||typeof raw!=='object')throw new HttpError(400,'内容块无效');
  const id=randomUUID();
  if(raw.type==='diagram'){try{return {id,type:'diagram',diagramType:'mermaid',source:cleanMermaidSource(raw.source),caption:text(raw.caption??'',500),generatedBy:'user',sourceRefs:[]};}catch(error){throw new HttpError(400,error instanceof Error?error.message:'技术图代码无效');}}
  if(raw.type==='callout'&&['设计说明','关键参数','工程依据'].includes(raw.kind))return {id,type:'callout',kind:raw.kind,text:text(raw.text)};
  if(raw.type==='paragraph'||raw.type==='heading')return {id,type:raw.type,text:text(raw.text),...(raw.type==='heading'?{level:Math.min(3,Math.max(1,Number(raw.level)||3))}:{}),...(Array.isArray(raw.runs)?{runs:raw.runs.slice(0,200).map((r:any)=>({text:text(r.text),bold:r.bold===true}))}:{})};
  if(raw.type==='list'&&Array.isArray(raw.items)&&raw.items.length<=100)return {id,type:'list',items:raw.items.map((v:unknown)=>text(v)),ordered:raw.ordered===true};
  if(raw.type==='table'&&Array.isArray(raw.columns)&&Array.isArray(raw.rows)&&raw.columns.length>0&&raw.columns.length<=12&&raw.rows.length<=200){
   const columns=raw.columns.map((v:unknown)=>text(v,300));
   return {id,type:'table',title:text(raw.title??'',300),columns,rows:raw.rows.map((row:unknown)=>{if(!Array.isArray(row)||row.length!==columns.length)throw new HttpError(400,'表格每行列数须一致');return row.map(v=>text(v,4000));}),sourceRefs:[],generated:false};
  }
  if(raw.type==='asset'&&context.assets.some(a=>a.id===raw.assetId))return {id,type:'asset',assetId:raw.assetId,caption:text(raw.caption??'',500),role:context.assets.find(a=>a.id===raw.assetId)?.role};
  throw new HttpError(400,'不支持的内容块或图片不属于当前项目');
 });
}
export const blockText=customerText;
export function deterministicBlocks(section:DocumentSection,sc:SectionContext):DocumentBlock[]{
 const c=sc.context,engineering=effectiveEngineering(c),out:DocumentBlock[]=[];
 if(section.fixedContent)out.push({id:randomUUID(),type:'paragraph',text:section.fixedContent});
 const table=(title:string,columns:string[],rows:string[][],sourceRefs:SourceRef[])=>{if(rows.length)out.push({id:randomUUID(),type:'table',title,columns,rows,sourceRefs,generated:true});};
 if(section.tableKind==='requirements'){
  const accepted=allRequirements(c).filter(r=>r.confirmedByUser||c.confirmed);
  table('主要技术要求',['指标 / 要求','内容'],accepted.map(r=>[requirementLabel(r.key),String(r.value)]),accepted.map(r=>({type:'project_input',id:r.sourceChunkId??r.sourceInputId,label:requirementLabel(r.key),labelKind:'requirement',evidence:r.evidence})));
 }
 if(section.tableKind==='equipment')table('设备配置',['设备型号','数量（台）'],(engineering?.deployment?.models??[]).map(m=>[m.name,String(m.count)]),engineering?[asSource(engineering.sourceRef),...c.lockedFacts.filter(f=>f.sourceType==='user'&&f.key.startsWith('deployment.')).map(f=>asSource(f.sourceRef))]:[]);
 if(section.tableKind==='products'){
  const optics=engineering?.deployment?.opticalConfigurations??[];
  const rows=optics.flatMap(o=>[['镜头焦距',o.lens?.focalLengthMm,'mm'],['仿真水平视场角',o.hfovDeg,'°'],['仿真垂直视场角',o.vfovDeg,'°'],['仿真最大距离',o.maxWorkingDistanceM,'m']].filter(r=>r[1]!=null).map(([label,value,unit])=>[o.variant?`${o.model}（${o.variant}）`:o.model,String(label),`${value}${unit}`]));
  table('工程设计光学配置',['配置型号','参数','值'],rows,optics.map(o=>asSource(o.sourceRef)));
  table('产品技术参数',['产品型号','参数','规格'],sc.facts.map(f=>[f.productKey,f.field,`${String(f.value)}${f.unit??''}`]),sc.facts.map(factSource));
 }
 if(section.tableKind==='engineering'&&engineering){
  const p=engineering.performance??{},accuracy=section.id.includes('accuracy')||/精度|误差/.test(section.title);
  const rows=accuracy?[['平均理论误差',p.meanErrorMm,'mm'],['P90 理论误差',p.p90ErrorMm,'mm'],['P95 理论误差',p.p95ErrorMm,'mm'],['理论误差 ≤0.3 mm 占比',p.under03Mm,'%'],['理论误差 ≤0.5 mm 占比',p.under05Mm,'%']]:[['≥1 视角覆盖率',p.coverageGe1,'%'],['≥2 视角覆盖率',p.coverageGe2,'%'],['≥3 视角覆盖率',p.coverageGe3,'%'],['≥4 视角覆盖率',p.coverageGe4,'%'],['≥5 视角覆盖率',p.coverageGe5,'%'],['平均可见视角数',p.averageViewCount,'']];
  table(accuracy?'理论精度分析结果':'理论覆盖分析结果',['指标',c.lockedFacts.some(f=>f.sourceType==='user'&&f.key.startsWith('performance.'))?'当前确认值':'工程报告结果'],rows.filter(r=>r[1]!==undefined).map(([k,v,u])=>[String(k),v===null?'无有效结果':`${typeof v==='number'?Number(v.toFixed(6)):v}${u}`]),[asSource(engineering.sourceRef),...c.lockedFacts.filter(f=>f.sourceType==='user'&&f.key.startsWith('performance.')).map(f=>asSource(f.sourceRef))]);
 }
 for(const asset of c.assets.filter(a=>section.assetRoles?.includes(a.role)))out.push({id:randomUUID(),type:'asset',assetId:asset.id,role:asset.role,caption:asset.caption??section.title});
 return out;
}
export function parseGeneration(content:string,sc:SectionContext){
 let raw:any;try{raw=JSON.parse(content.trim().replace(/^```(?:json)?\s*/,'').replace(/\s*```$/,''));}catch{throw new Error('模型未返回有效的章节 JSON，请重试此章节');}
 const blocks=cleanBlocks(raw.content,sc.context);
 if(!blocks.length||blocks.some(b=>!['paragraph','list'].includes(b.type)))throw new Error('模型章节为空或包含未经允许的表格/图片');
 const checkIds=(value:unknown,allowed:string[],label:string)=>{if(!Array.isArray(value)||value.length>200||value.some(id=>typeof id!=='string'||!allowed.includes(id)))throw new Error(`模型${label}包含无效引用`);return [...new Set(value as string[])];};
 const declaredFactRefs=checkIds(raw.used_fact_ids,sc.factIds,'事实'),sourceIds=checkIds(raw.used_knowledge_refs,sc.sources.map(s=>s.id),'资料'),assetRefs=checkIds(raw.used_asset_refs,sc.assetIds,'图片');
 if(!Array.isArray(raw.claims)||raw.claims.length>100)throw new Error('模型未返回事实断言清单');
 // Claims may paraphrase the prose. Their IDs remain strictly checked, and validation scans every body block independently.
 const claims:Claim[]=raw.claims.map((r:any)=>{const claimText=text(r.text);if(!claimText.trim())throw new Error('模型断言内容为空');return {text:claimText,factIds:checkIds(r.factIds??[],sc.factIds,'断言事实'),sourceIds:checkIds(r.sourceIds??[],sc.sources.map(s=>s.id),'断言来源'),kind:['requirement','capability','engineering','principle'].includes(r.kind)?r.kind:undefined};});
 const lockedFactRefs=[...new Set([...declaredFactRefs,...claims.flatMap(claim=>claim.factIds)])];
 const factSourceIds=[...sc.context.lockedFacts.filter(f=>lockedFactRefs.includes(f.id)).map(f=>f.sourceRef.id),...allRequirements(sc.context).filter(requirement=>lockedFactRefs.includes(requirement.id)).map(requirement=>requirement.sourceChunkId??requirement.sourceInputId)];
 const allIds=new Set([...sourceIds,...factSourceIds,...lockedFactRefs,...claims.flatMap(c=>[...c.sourceIds,...c.factIds])]);
 return {blocks,lockedFactRefs,assetRefs,claims,sourceRefs:sc.sources.filter(s=>allIds.has(s.id))};
}
