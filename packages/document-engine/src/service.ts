import {randomUUID} from 'node:crypto';
import type {Database,Connection} from '../../knowledge/src/database.js';
import {HttpError,type KnowledgeService} from '../../knowledge/src/service.js';
import type {LLMConfig,LLMProvider} from '../../core/src/types.js';
import {modelProfile,estimatedModelCost} from '../../llm/src/models.js';
import type {ProjectService} from '../../projects/src/service.js';
import type {ProjectContext} from '../../projects/src/types.js';
import type {StructuredService,StructuredFact} from '../../structured/src/service.js';
import {standardTemplate} from './templates.js';
import {defaultOutputProfile,type GeneratedDocument,type DocumentSection,type DocumentTemplate,type GenerationConfig,type GenerationJob,type GenerationMode,type DocumentBlock,type SourceRef} from './types.js';
import {DocumentRetriever,buildSectionContext,generationSystem,asSource} from './context.js';
import {blockText,cleanBlocks,deterministicBlocks,parseGeneration} from './blocks.js';
import {validateSections} from './validation.js';
import {exportDocument} from './export.js';

const date=(value:unknown)=>value instanceof Date?value.toISOString():String(value);
const json=JSON.stringify;
const safeId=(v:unknown)=>typeof v==='string'&&v.length>0&&v.length<=200;
const rowJob=(r:any):GenerationJob=>({id:r.id,documentId:r.document_id,status:r.status,sectionIds:r.section_ids,processed:r.processed,failed:r.failed,config:r.config,reservedCny:r.reserved_cny,estimatedCostCny:r.estimated_cost_cny,inputTokens:Number(r.input_tokens),outputTokens:Number(r.output_tokens),errors:r.errors,createdAt:date(r.created_at),updatedAt:date(r.updated_at)});
// Reserve all three provider attempts, including failures, without querying account balance.
export const reservation=(c:GenerationConfig,inputTokens=c.maxContextTokens)=>3*estimatedModelCost(c.model,Math.min(c.maxContextTokens,inputTokens)+1024,c.maxTokens);
export const cumulativeGenerationBudgetCny=250;
// Model-native K3 defaults; application spending/token restrictions remain opt-in.
export const modelOutputTokens=modelProfile('kimi-k3').defaultOutputTokens;
export const modelInputTokens=modelProfile('kimi-k3').contextTokens-modelOutputTokens-1024;
export class DocumentEngine {
 private timer?:ReturnType<typeof setInterval>;
 private current?:Promise<void>;
 private stopping=false;
 readonly retriever:DocumentRetriever;
 constructor(readonly db:Database,readonly knowledge:KnowledgeService,readonly projects:ProjectService,readonly structured:StructuredService,private providerFactory:(config:LLMConfig)=>LLMProvider){this.retriever=new DocumentRetriever(db,projects);}
 async start(){
  await this.db.transaction(async tx=>{
   await tx.query('INSERT INTO document_templates(id,name,document_type,active_version) VALUES($1,$2,$3,$4) ON CONFLICT(id) DO UPDATE SET active_version=GREATEST(document_templates.active_version,excluded.active_version)',[standardTemplate.id,standardTemplate.name,standardTemplate.documentType,standardTemplate.version]);
   await tx.query('INSERT INTO document_template_versions(template_id,version,definition) VALUES($1,$2,$3::jsonb) ON CONFLICT DO NOTHING',[standardTemplate.id,standardTemplate.version,json(standardTemplate)]);
   await tx.query("UPDATE generation_jobs SET status='interrupted',errors=errors||$1::jsonb,updated_at=now() WHERE status='running'",[json([{sectionId:'',message:'服务中断，已保留完成章节与费用预留。请手动重试未完成章节。'}])]);
   await tx.query("UPDATE document_sections SET status='failed',error='服务中断，请重试此章' WHERE status='generating'");
  });
  this.stopping=false;this.timer=setInterval(()=>this.wake(),500);this.timer.unref();this.wake();
 }
 async close(){this.stopping=true;clearInterval(this.timer);await this.current;}
 wake(){if(this.stopping||this.current)return;this.current=this.drain().catch(()=>{/* job errors are persisted; next timer may claim pending work */}).finally(()=>{this.current=undefined;});}
 async templates():Promise<DocumentTemplate[]>{return (await this.db.query('SELECT v.definition FROM document_templates t JOIN document_template_versions v ON v.template_id=t.id AND v.version=t.active_version ORDER BY t.name')).map(r=>r.definition);}
 async list(projectId:string){await this.projects.get(projectId);return Promise.all((await this.db.query('SELECT id FROM generated_documents WHERE project_id=$1 ORDER BY created_at DESC',[projectId])).map(r=>this.get(r.id)));}
 private async row(id:string,tx:Connection=this.db){const row=(await tx.query("SELECT d.*,p.name AS project_name,p.customer_name,p.context_revision AS current_context_revision,p.input_revision AS current_input_revision,p.status AS project_status FROM generated_documents d JOIN projects p ON p.id=d.project_id WHERE d.id=$1 AND p.organization_id='default' AND p.workspace_id='default'",[id]))[0];if(!row)throw new HttpError(404,'方案不存在');return row;}
 async get(id:string):Promise<GeneratedDocument>{
  const row=await this.row(id),rows=await this.db.query('SELECT * FROM document_sections WHERE document_id=$1 ORDER BY section_order,id',[id]);
  const blocks=await this.db.query('SELECT b.* FROM document_blocks b JOIN document_sections s ON s.id=b.section_id WHERE s.document_id=$1 ORDER BY b.block_order',[id]);
  return {id:row.id,projectId:row.project_id,projectName:row.project_name,customerName:row.customer_name??'',title:row.title,documentType:'technical_proposal',templateId:row.template_id,templateVersion:row.template_version,contextRevision:row.context_revision,revision:row.revision,status:row.status,outputProfile:row.output_profile,createdAt:date(row.created_at),updatedAt:date(row.updated_at),contextStale:row.current_context_revision!==row.context_revision||row.current_input_revision!==row.context_snapshot.inputRevision,
   sections:rows.map(r=>({...r.definition,id:r.id,order:r.section_order,status:r.status,revision:r.revision,edited:r.edited,blocks:blocks.filter(b=>b.section_id===r.id).map(b=>b.content),sourceRefs:r.source_refs,assetRefs:r.asset_refs,lockedFactRefs:r.locked_fact_refs,claims:r.claims,error:r.error??undefined,contextTokens:r.context_tokens??undefined})),
   issues:(await this.db.query('SELECT issue FROM document_validation_issues WHERE document_id=$1 ORDER BY created_at,id',[id])).map(r=>r.issue)};
 }
 private async snapshot(id:string):Promise<ProjectContext&{structuredFacts?:StructuredFact[]}>{return (await this.row(id)).context_snapshot;}
 private async audit(tx:Connection,id:string,action:string,previous:unknown,next:unknown){await tx.query('INSERT INTO audit_events(id,generated_document_id,action,previous_value,next_value) VALUES($1,$2,$3,$4::jsonb,$5::jsonb)',[randomUUID(),id,action,json(previous),json(next)]);}
 private async idle(tx:Connection,id:string){if((await tx.query("SELECT id FROM generation_jobs WHERE document_id=$1 AND status IN ('queued','running')",[id])).length)throw new HttpError(409,'方案正在生成，请等待本批章节完成后编辑');}
 async create(projectId:string,input:{templateId?:string}={}){
  const project=await this.projects.get(projectId),context=await this.projects.getContext(projectId);
  if(!context.confirmed||project.confirmedRevision!==context.revision)throw new HttpError(409,'请先确认项目理解和锁定事实');
  const template=(await this.templates()).find(t=>t.id===(input.templateId??standardTemplate.id));if(!template)throw new HttpError(400,'请选择有效模板');
  const snapshot={...context,structuredFacts:await this.structured.productFacts(context.products)},id=randomUUID();
  await this.db.transaction(async tx=>{
   const current=(await tx.query('SELECT context_revision,confirmed_revision FROM projects WHERE id=$1 FOR UPDATE',[projectId]))[0];if(current.context_revision!==context.revision||current.confirmed_revision!==context.revision)throw new HttpError(409,'项目理解已经更新，请重新确认');
   await tx.query('INSERT INTO generated_documents(id,project_id,template_id,template_version,context_revision,context_snapshot,title,output_profile) VALUES($1,$2,$3,$4,$5,$6::jsonb,$7,$8::jsonb)',[id,projectId,template.id,template.version,context.revision,json(snapshot),`${project.name}技术方案`,json({...defaultOutputProfile,companyName:project.companyName})]);
   for(const [order,s] of template.sections.filter(s=>s.condition!=='engineering'||context.engineering).entries())await tx.query('INSERT INTO document_sections(id,document_id,section_order,definition) VALUES($1,$2,$3,$4::jsonb)',[randomUUID(),id,order,json(s)]);
   await this.audit(tx,id,'document_created',null,{templateId:template.id,contextRevision:context.revision});
  });return this.get(id);
 }
 async patch(id:string,input:any){
  const doc=await this.get(id);if(input.revision!==doc.revision)throw new HttpError(409,'方案已更新，请刷新后重试');
  const profile={...doc.outputProfile,...input.outputProfile};
  if(Object.keys(profile).some(k=>k!=='coverLogoAssetId'&&!Object.keys(defaultOutputProfile).includes(k))||['companyName','fontFamily','titleFontFamily','header','footer'].some(k=>typeof profile[k]!=='string'||profile[k].length>300)||!Number.isFinite(profile.fontSize)||profile.fontSize<8||profile.fontSize>18||!Number.isFinite(profile.pageMarginMm)||profile.pageMarginMm<15||profile.pageMarginMm>35)throw new HttpError(400,'输出样式参数无效');
  if(profile.coverLogoAssetId==='')delete profile.coverLogoAssetId;
  if(profile.coverLogoAssetId!==undefined){
   if(!safeId(profile.coverLogoAssetId))throw new HttpError(400,'封面 Logo 需选择本项目图片');
   const asset=(await this.projects.get(doc.projectId)).assets.find(asset=>asset.id===profile.coverLogoAssetId);
   if(!asset||!['image/png','image/jpeg','image/jpg'].includes(asset.mimeType))throw new HttpError(400,'封面 Logo 需选择本项目的 PNG 或 JPEG 图片');
  }
  const title=input.title??doc.title;if(typeof title!=='string'||!title.trim()||title.length>200)throw new HttpError(400,'方案标题无效');
  await this.db.transaction(async tx=>{await this.idle(tx,id);const r=await tx.query('UPDATE generated_documents SET title=$2,output_profile=$3::jsonb,revision=revision+1,updated_at=now() WHERE id=$1 AND revision=$4 RETURNING id',[id,title,json(profile),doc.revision]);if(!r.length)throw new HttpError(409,'方案已更新，请刷新');await this.audit(tx,id,'document_profile_updated',doc.outputProfile,profile);});return this.get(id);
 }
 async plan(id:string,input:any){
  const doc=await this.get(id);if(input.revision!==doc.revision)throw new HttpError(409,'章节计划已更新，请刷新');
  if(!Array.isArray(input.sections)||!input.sections.length||input.sections.length>60)throw new HttpError(400,'章节计划需包含 1–60 个章节');
  const seen=new Set<string>();let lastLevel=0;
  const sections=input.sections.map((raw:any,order:number)=>{
   if(!raw||typeof raw.title!=='string'||!raw.title.trim()||raw.title.length>200||![1,2,3].includes(raw.level)||raw.level>lastLevel+1)throw new HttpError(400,'章节名称或层级无效；第一章须为一级，层级不可跳级');lastLevel=raw.level;
   const old=doc.sections.find(s=>s.id===raw.id);if(raw.id&&!old)throw new HttpError(400,'章节不属于当前方案');
   const sid=old?.id??randomUUID();if(seen.has(sid))throw new HttpError(400,'章节重复');seen.add(sid);
   return {old,id:sid,definition:{...(old??{id:sid,generationMode:'ai',requiredContext:['requirements','products'],retrievalPolicy:{query:raw.title},generationInstruction:'按项目事实和引用资料编写本章，不推测参数。'}),title:raw.title.trim(),level:raw.level,order}};
  });
  await this.db.transaction(async tx=>{
   await this.idle(tx,id);const row=await this.row(id,tx);if(row.revision!==doc.revision)throw new HttpError(409,'章节计划已更新');
   await tx.query('DELETE FROM document_sections WHERE document_id=$1 AND NOT(id=ANY($2::text[]))',[id,[...seen]]);
   for(const s of sections){const {blocks,status,revision,edited,sourceRefs,assetRefs,lockedFactRefs,claims,error,contextTokens,...definition}=s.definition as DocumentSection;
    if(s.old)await tx.query('UPDATE document_sections SET section_order=$2,definition=$3::jsonb,revision=revision+1 WHERE id=$1',[s.id,definition.order,json(definition)]);
    else await tx.query('INSERT INTO document_sections(id,document_id,section_order,definition) VALUES($1,$2,$3,$4::jsonb)',[s.id,id,definition.order,json(definition)]);
   }
   await tx.query("UPDATE generated_documents SET revision=revision+1,status='draft',updated_at=now() WHERE id=$1",[id]);await tx.query('DELETE FROM document_validation_issues WHERE document_id=$1',[id]);await this.audit(tx,id,'document_plan_updated',doc.sections.map(s=>({id:s.id,title:s.title,level:s.level})),input.sections);
  });return this.get(id);
 }
 private async persistSection(tx:Connection,section:DocumentSection){
  await tx.query('DELETE FROM document_blocks WHERE section_id=$1',[section.id]);
  for(const [order,block] of section.blocks.entries())await tx.query('INSERT INTO document_blocks(id,section_id,block_order,content) VALUES($1,$2,$3,$4::jsonb)',[block.id,section.id,order,json(block)]);
  await tx.query('UPDATE document_sections SET status=$2,revision=revision+1,edited=$3,source_refs=$4::jsonb,asset_refs=$5::jsonb,locked_fact_refs=$6::jsonb,claims=$7::jsonb,error=$8,context_tokens=$9 WHERE id=$1',[section.id,section.status,section.edited,json(section.sourceRefs),json(section.assetRefs),json(section.lockedFactRefs),json(section.claims),section.error??null,section.contextTokens??null]);
  await tx.query('DELETE FROM section_source_refs WHERE section_id=$1',[section.id]);
  for(const ref of section.sourceRefs)await tx.query('INSERT INTO section_source_refs(section_id,source_type,source_id,evidence) VALUES($1,$2,$3,$4::jsonb) ON CONFLICT DO NOTHING',[section.id,ref.type,ref.id,json(ref)]);
 }
 async edit(id:string,sectionId:string,input:any){
  const doc=await this.get(id),old=doc.sections.find(s=>s.id===sectionId);if(!old)throw new HttpError(404,'章节不存在');if(input.revision!==old.revision)throw new HttpError(409,'章节已更新，请刷新后再编辑');
  const context=await this.snapshot(id),blocks=cleanBlocks(input.blocks,context);
  // Source evidence is server-owned; an editor cannot invent or alter citations through block JSON.
  for(const [i,b] of blocks.entries())if(b.type==='table'){const raw=input.blocks[i],previous=old.blocks.find(p=>p.id===raw.id);if(previous?.type==='table'){b.sourceRefs=previous.sourceRefs;b.generated=previous.generated&&json(b.rows)===json(previous.rows)&&json(b.columns)===json(previous.columns);}}
  const section={...old,blocks,status:'edited' as const,edited:true,claims:[],error:undefined};
  await this.db.transaction(async tx=>{await this.idle(tx,id);const r=(await tx.query('SELECT revision FROM document_sections WHERE id=$1 FOR UPDATE',[sectionId]))[0];if(r.revision!==old.revision)throw new HttpError(409,'章节已更新，请刷新');await this.persistSection(tx,section);await tx.query("UPDATE generated_documents SET revision=revision+1,status='draft',updated_at=now() WHERE id=$1",[id]);await tx.query('DELETE FROM document_validation_issues WHERE document_id=$1',[id]);await this.audit(tx,id,'section_edited',{sectionId,blocks:old.blocks},{sectionId,blocks});});
  await this.validate(id);return this.get(id);
 }
 async jobs(id:string){await this.row(id);return (await this.db.query('SELECT * FROM generation_jobs WHERE document_id=$1 ORDER BY created_at DESC LIMIT 50',[id])).map(rowJob);}
 private async config(input:any={}):Promise<{settings:LLMConfig;config:GenerationConfig}>{
  if(!input||typeof input!=='object'||Array.isArray(input))throw new HttpError(400,'生成设置需为 JSON 对象');
  const settings=await this.knowledge.settings.config();if(!settings)throw new HttpError(400,'请先在设置中配置 Kimi API');
  if(input.limitsEnabled!==undefined&&typeof input.limitsEnabled!=='boolean')throw new HttpError(400,'额度限制开关须为布尔值');
  const limitsEnabled=input.limitsEnabled===true;
  const model=input.model??'kimi-k3';
  if(!['kimi-k3','kimi-k2.6'].includes(model)||settings.baseUrl.replace(/\/+$/,'')!=='https://api.moonshot.cn/v1')throw new HttpError(400,'当前方案生成支持 Kimi 中国区 kimi-k3、kimi-k2.6');
  const profile=modelProfile(model),maxInput=profile.contextTokens-profile.defaultOutputTokens-1024;
  const config:GenerationConfig={model,temperature:input.temperature??profile.temperature,maxTokens:limitsEnabled?(input.maxTokens??3000):profile.defaultOutputTokens,maxContextTokens:limitsEnabled?(input.maxContextTokens??12000):maxInput,budgetCny:limitsEnabled?(input.budgetCny??10):0,limitsEnabled,...(model==='kimi-k3'?{reasoningEffort:input.reasoningEffort??'max'}:{})};
  if(config.temperature!==profile.temperature)throw new HttpError(400,`${model} 温度固定为 ${profile.temperature}`);
  if(model==='kimi-k3'&&!['low','high','max'].includes(config.reasoningEffort!))throw new HttpError(400,'K3 推理强度须为 low、high 或 max');
  if(!Number.isInteger(config.maxTokens)||config.maxTokens<512||config.maxTokens>profile.defaultOutputTokens||!Number.isInteger(config.maxContextTokens)||config.maxContextTokens<4000||config.maxContextTokens>maxInput||!Number.isFinite(config.budgetCny)||limitsEnabled&&(config.budgetCny<=0||config.budgetCny>100))throw new HttpError(400,`生成设置无效：输出 512–${profile.defaultOutputTokens}，上下文 4000–${maxInput}；启用限制时预算大于 0、最多 100 元`);
  return {settings,config};
 }
 async generate(id:string,input:any){
  const doc=await this.get(id);if((input.expectedRevision??input.revision)!==doc.revision)throw new HttpError(409,'方案内容已更新，请刷新后再生成');if(doc.contextStale)throw new HttpError(409,'项目理解已更新，请确认后新建方案使用新快照');
  const {config}=await this.config(input.config),mode:GenerationMode=input.mode??'regenerate';if(!['regenerate','shorten','expand','formal','technical','rewrite'].includes(mode))throw new HttpError(400,'AI 操作无效');
  const sectionIds=input.sectionIds??doc.sections.filter(s=>!s.edited&&(s.status==='empty'||s.status==='failed')).map(s=>s.id);
  if(!Array.isArray(sectionIds)||!sectionIds.length||sectionIds.length>60||sectionIds.some(id=>!safeId(id)||!doc.sections.some(s=>s.id===id))||new Set(sectionIds).size!==sectionIds.length)throw new HttpError(400,'请选择有效的待生成章节');
  const target=doc.sections.filter(s=>sectionIds.includes(s.id));if(target.some(s=>s.edited)&&input.overwriteEdited!==true)throw new HttpError(409,'所选章节已人工编辑；需再次确认覆盖');
  const sourceIds=input.sourceIds??[];if(!Array.isArray(sourceIds)||sourceIds.length>30||sourceIds.some(id=>!safeId(id)))throw new HttpError(400,'指定来源无效');
  const jobId=randomUUID();
  await this.db.transaction(async tx=>{await this.idle(tx,id);const row=await this.row(id,tx);if(row.revision!==doc.revision||(row.current_context_revision!==doc.contextRevision||row.current_input_revision!==row.context_snapshot.inputRevision||row.project_status==='archived'))throw new HttpError(409,'方案或项目事实已更新');
   await tx.query('INSERT INTO generation_jobs(id,document_id,section_ids,targets,config,mode,source_ids) VALUES($1,$2,$3::jsonb,$4::jsonb,$5::jsonb,$6,$7::jsonb)',[jobId,id,json(sectionIds),json(target.map(s=>({id:s.id,revision:s.revision}))),json(config),mode,json(sourceIds)]);
   await tx.query("UPDATE document_sections SET status='queued',error=null WHERE id=ANY($1::text[])",[sectionIds]);await tx.query("UPDATE generated_documents SET status='generating',updated_at=now() WHERE id=$1",[id]);await tx.query("UPDATE projects SET status='generating' WHERE id=$1",[doc.projectId]);await this.audit(tx,id,'generation_queued',null,{jobId,sectionIds,config,mode,overwriteEdited:input.overwriteEdited===true});
  });this.wake();return (await this.jobs(id)).find(j=>j.id===jobId)!;
 }
 private async drain(){
  while(!this.stopping){
   const job=await this.db.transaction(async tx=>{const r=(await tx.query("SELECT * FROM generation_jobs WHERE status='queued' ORDER BY created_at LIMIT 1 FOR UPDATE SKIP LOCKED"))[0];if(r)await tx.query("UPDATE generation_jobs SET status='running',updated_at=now() WHERE id=$1",[r.id]);return r;});if(!job)return;
   try{await this.process(job);}catch(error){await this.db.query("UPDATE generation_jobs SET status='failed',errors=errors||$2::jsonb,updated_at=now() WHERE id=$1",[job.id,json([{sectionId:'',message:this.knowledge.settings.redact(error instanceof Error?error.message:'生成失败')}])]);}
   finally{await this.db.query("UPDATE document_sections SET status='failed',error=coalesce(error,'本批任务未完成，请重试此章') WHERE document_id=$1 AND status IN ('queued','generating')",[job.document_id]);await this.db.query("UPDATE generated_documents SET status='draft',updated_at=now() WHERE id=$1 AND status='generating'",[job.document_id]);}
  }
 }
 private async reserve(job:any,inputTokens:number){return this.db.transaction(async tx=>{
  // Serialize cross-document budget reservations on a shared row for PostgreSQL as well as PGlite.
  await tx.query("INSERT INTO settings(key,value) VALUES('documentGenerationBudgetLock','true') ON CONFLICT DO NOTHING");await tx.query("SELECT key FROM settings WHERE key='documentGenerationBudgetLock' FOR UPDATE");
  const total=Number((await tx.query('SELECT coalesce(sum(reserved_cny),0) AS total FROM generation_jobs'))[0].total),cost=reservation(job.config,inputTokens);
  if(job.config.limitsEnabled===false){await tx.query('UPDATE generation_jobs SET reserved_cny=reserved_cny+$2 WHERE id=$1',[job.id,cost]);return true;}
  if(total+cost>cumulativeGenerationBudgetCny)return false;
  return !!(await tx.query('UPDATE generation_jobs SET reserved_cny=reserved_cny+$2 WHERE id=$1 AND reserved_cny+$2<=($3::double precision)+0.000000001 RETURNING id',[job.id,cost,job.config.budgetCny])).length;
 });}
 private async process(job:any){
  const context=await this.snapshot(job.document_id),{settings,config}=await this.config({...job.config,limitsEnabled:job.config.limitsEnabled!==false}),provider=this.providerFactory({...settings,...config,requestTimeoutMs:modelProfile(config.model).requestTimeoutMs});let exhausted=false;
  // Independent chapters share an immutable snapshot. Bound provider concurrency while reserving each call atomically.
  for(let offset=0;offset<job.targets.length&&!this.stopping&&!exhausted;offset+=3){
   await Promise.all(job.targets.slice(offset,offset+3).map(async(target:any)=>{
   if(this.stopping||exhausted)return;
   const doc=await this.get(job.document_id),section=doc.sections.find(s=>s.id===target.id);
   try{
    if(!section||section.revision!==target.revision||doc.contextStale)throw new Error('章节或项目事实已更改，请按最新版本重试');
    await this.db.query("UPDATE document_sections SET status='generating' WHERE id=$1",[section.id]);
    const ai=['ai','mixed'].includes(section.generationMode);
    const sc=ai?await buildSectionContext(section,context,this.retriever,this.structured,job.config.maxContextTokens,{mode:job.mode,sourceIds:job.source_ids,limitsEnabled:job.config.limitsEnabled!==false,previous:job.mode!=='regenerate'?section.blocks.map(blockText).join('\n'):undefined}):{prompt:'',tokens:0,sources:[],facts:section.requiredContext.includes('products')?(context.structuredFacts??[]):[],factIds:[],assetIds:[],context};
    const fixed=deterministicBlocks(section,sc);let result={blocks:[] as DocumentBlock[],sourceRefs:[] as SourceRef[],assetRefs:[] as string[],lockedFactRefs:[] as string[],claims:[] as DocumentSection['claims']};
    if(ai){
     if(!await this.reserve(job,sc.tokens)){exhausted=true;return;}
     const response=await provider.generate({system:generationSystem,prompt:sc.prompt,responseFormat:'json_object'});
     const usage=response.usage;if(usage&&Number.isFinite(usage.inputTokens)&&Number.isFinite(usage.outputTokens)&&usage.inputTokens>=0&&usage.outputTokens>=0)await this.db.query('UPDATE generation_jobs SET estimated_cost_cny=estimated_cost_cny+$2,input_tokens=input_tokens+$3,output_tokens=output_tokens+$4 WHERE id=$1',[job.id,estimatedModelCost(config.model,usage.inputTokens,usage.outputTokens),usage.inputTokens,usage.outputTokens]);
     result=parseGeneration(response.content,sc);
    }
    const references=[...result.sourceRefs,...fixed.flatMap(b=>b.type==='table'?b.sourceRefs:[]),...context.assets.filter(a=>fixed.some(b=>b.type==='asset'&&b.assetId===a.id)).map(a=>asSource(a.sourceRef))];
    const next:DocumentSection={...section,...result,blocks:[...result.blocks,...fixed],sourceRefs:[...new Map(references.map(r=>[r.type+':'+r.id,r])).values()],assetRefs:[...new Set([...result.assetRefs,...fixed.filter(b=>b.type==='asset').map(b=>b.assetId)])],status:'generated',edited:false,error:undefined,contextTokens:sc.tokens};
    await this.db.transaction(async tx=>{const row=await this.row(job.document_id,tx),current=(await tx.query('SELECT revision FROM document_sections WHERE id=$1 FOR UPDATE',[section.id]))[0];if(row.current_context_revision!==context.revision||row.current_input_revision!==context.inputRevision||current.revision!==target.revision)throw new Error('生成期间事实或章节已更新，结果未覆盖原内容');await this.persistSection(tx,next);await tx.query('UPDATE generated_documents SET revision=revision+1,updated_at=now() WHERE id=$1',[doc.id]);await tx.query('UPDATE generation_jobs SET processed=processed+1,updated_at=now() WHERE id=$1',[job.id]);});
   }catch(error){const message=this.knowledge.settings.redact(error instanceof Error?error.message:'本章生成失败');await this.db.query("UPDATE document_sections SET status='failed',error=$2 WHERE id=$1",[target.id,message]);await this.db.query('UPDATE generation_jobs SET failed=failed+1,errors=errors||$2::jsonb,updated_at=now() WHERE id=$1',[job.id,json([{sectionId:target.id,message}])]);}
   }));
  }
  const row=(await this.db.query('SELECT * FROM generation_jobs WHERE id=$1',[job.id]))[0];const status=exhausted?'budget_exhausted':this.stopping?'interrupted':row.failed?(row.processed?'partially_failed':'failed'):'completed';
  await this.db.query('UPDATE generation_jobs SET status=$2,updated_at=now() WHERE id=$1',[job.id,status]);
  await this.db.query("UPDATE document_sections SET status='failed',error=$2 WHERE document_id=$1 AND status IN ('queued','generating')",[job.document_id,exhausted?'预算预留已达上限，已保留完成章节，请调整预算后重试':'任务已中断，请重试未完成章节']);
  await this.db.query("UPDATE generated_documents SET status='generated',updated_at=now() WHERE id=$1",[job.document_id]);await this.db.query("UPDATE projects SET status=CASE WHEN confirmed_revision=context_revision THEN 'generated' ELSE 'draft' END WHERE id=$1",[context.projectId]);await this.validate(job.document_id);
 }
 async validate(id:string){
  const doc=await this.get(id),context=await this.snapshot(id),issues=validateSections(doc.sections,context,doc.contextStale);
  if(context.structuredFacts){const current=await this.structured.productFacts(context.products);if(json(current.map(f=>[f.id,f.value,f.unit]))!==json(context.structuredFacts.map(f=>[f.id,f.value,f.unit])))issues.push({id:randomUUID(),sectionId:doc.sections[0]?.id??'',severity:'error',type:'stale_context',message:'权威产品参数已更新或移除；此方案保留原快照，请新建方案使用最新参数。',sourceRefs:[]});}
  await this.db.transaction(async tx=>{const row=await this.row(id,tx);if(row.revision!==doc.revision)throw new HttpError(409,'方案内容已更新，请重新校验');await tx.query('DELETE FROM document_validation_issues WHERE document_id=$1',[id]);for(const issue of issues)await tx.query('INSERT INTO document_validation_issues(id,document_id,section_id,issue) VALUES($1,$2,$3,$4::jsonb)',[issue.id,id,issue.sectionId||null,json(issue)]);if(!issues.length){await tx.query("UPDATE generated_documents SET status='validated' WHERE id=$1",[id]);await tx.query("UPDATE document_sections SET status='validated' WHERE document_id=$1 AND status IN ('generated','edited','validated')",[id]);}else if(row.status==='validated'){await tx.query("UPDATE generated_documents SET status='generated' WHERE id=$1",[id]);await tx.query("UPDATE document_sections SET status=CASE WHEN edited THEN 'edited' ELSE 'generated' END WHERE document_id=$1 AND status='validated'",[id]);}await this.audit(tx,id,'document_validated',null,{errors:issues.filter(i=>i.severity==='error').length,warnings:issues.filter(i=>i.severity==='warning').length});});return issues;
 }
 async export(id:string){
  await this.db.transaction(tx=>this.idle(tx,id));await this.validate(id);const doc=await this.get(id),assets=new Map<string,{bytes:Buffer;mimeType:string}>();
  const assetIds=new Set(doc.sections.flatMap(s=>s.blocks.filter(b=>b.type==='asset').map(b=>b.assetId)));if(doc.outputProfile.coverLogoAssetId)assetIds.add(doc.outputProfile.coverLogoAssetId);
  for(const assetId of assetIds){const result=await this.projects.downloadAsset(doc.projectId,assetId);assets.set(assetId,{bytes:Buffer.from(result.bytes),mimeType:result.asset.mimeType});}
  const buffer=await exportDocument(doc,{assets});await this.audit(this.db,id,'document_exported',null,{revision:doc.revision,issueCount:doc.issues.length});return {buffer,filename:`${doc.title}.docx`,issueCount:doc.issues.length};
 }
}
