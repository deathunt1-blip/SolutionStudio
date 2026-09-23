import {resolveTheme} from './theme.js';
import {renderMermaid} from './diagrams.js';
import {cleanMermaidSource} from './diagram-policy.js';
import {customerFacingProblems} from './customer-facing.js';
import {highRiskClaimProblems} from './claim-policy.js';
import {claimEvidenceProblems} from './claim-evidence.js';
import {inferSectionRole} from '../../knowledge-enrichment/src/taxonomy.js';
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
import {DocumentRetriever,buildSectionContext,generationSystem,asSource,allRequirements} from './context.js';
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
 private readonly current=new Set<Promise<void>>();
 private stopping=false;
 readonly retriever:DocumentRetriever;
 constructor(readonly db:Database,readonly knowledge:KnowledgeService,readonly projects:ProjectService,readonly structured:StructuredService,private providerFactory:(config:LLMConfig)=>LLMProvider){this.retriever=new DocumentRetriever(db,projects);}
 async start(){
  await this.db.transaction(async tx=>{
   await tx.query('INSERT INTO document_templates(id,name,document_type,active_version) VALUES($1,$2,$3,$4) ON CONFLICT(id) DO UPDATE SET active_version=GREATEST(document_templates.active_version,excluded.active_version)',[standardTemplate.id,standardTemplate.name,standardTemplate.documentType,standardTemplate.version]);
   await tx.query('INSERT INTO document_template_versions(template_id,version,definition) VALUES($1,$2,$3::jsonb) ON CONFLICT DO NOTHING',[standardTemplate.id,standardTemplate.version,json(standardTemplate)]);
   const interrupted=await tx.query("UPDATE generation_jobs SET status='interrupted',errors=errors||$1::jsonb,updated_at=now() WHERE status='running' RETURNING document_id",[json([{sectionId:'',message:'服务中断，已保留完成章节与费用预留。请手动重试未完成章节。'}])]);
   if(interrupted.length){const ids=[...new Set(interrupted.map(row=>row.document_id))];await tx.query("UPDATE document_sections SET status='failed',error='服务中断，请手动重试未完成章节' WHERE document_id=ANY($1::text[]) AND status IN ('queued','generating')",[ids]);await tx.query("UPDATE generated_documents SET status='draft',updated_at=now() WHERE id=ANY($1::text[])",[ids]);await tx.query("UPDATE projects p SET status=CASE WHEN p.confirmed_revision=p.context_revision THEN 'context_ready' ELSE 'draft' END WHERE p.id IN (SELECT project_id FROM generated_documents WHERE id=ANY($1::text[])) AND NOT EXISTS(SELECT 1 FROM generation_jobs j JOIN generated_documents d ON d.id=j.document_id WHERE d.project_id=p.id AND j.status IN ('queued','running'))",[ids]);}
   await tx.query("UPDATE document_sections SET status='failed',error='服务中断，请重试此章' WHERE status='generating'");
  });
  this.stopping=false;this.timer=setInterval(()=>this.wake(),500);this.timer.unref();this.wake();
 }
 async close(){this.stopping=true;clearInterval(this.timer);await Promise.allSettled([...this.current]);}
 wake(){
  if(this.stopping)return;
  while(this.current.size<2){
   const task=this.drain().catch(()=>{/* job errors are persisted; next timer may claim pending work */}).finally(()=>{this.current.delete(task);});
   this.current.add(task);
  }
 }
 async templates():Promise<DocumentTemplate[]>{return (await this.db.query('SELECT v.definition FROM document_templates t JOIN document_template_versions v ON v.template_id=t.id AND v.version=t.active_version ORDER BY t.name')).map(r=>r.definition);}
 async list(projectId:string){await this.projects.get(projectId);return Promise.all((await this.db.query('SELECT id FROM generated_documents WHERE project_id=$1 ORDER BY created_at DESC',[projectId])).map(r=>this.get(r.id)));}
 async remove(id:string){await this.row(id);await this.db.transaction(async tx=>{await this.idle(tx,id);await tx.query('DELETE FROM generation_jobs WHERE document_id=$1',[id]);await tx.query('DELETE FROM audit_events WHERE generated_document_id=$1',[id]);await tx.query('DELETE FROM generated_documents WHERE id=$1',[id]);});return {ok:true};}
 async copy(id:string){const original=await this.get(id),row=await this.row(id),copyId=randomUUID();
  await this.db.transaction(async tx=>{await this.idle(tx,id);await tx.query('INSERT INTO generated_documents(id,project_id,template_id,template_version,context_revision,context_snapshot,title,output_profile) VALUES($1,$2,$3,$4,$5,$6::jsonb,$7,$8::jsonb)',[copyId,original.projectId,original.templateId,original.templateVersion,original.contextRevision,json(row.context_snapshot),`${original.title.slice(0,190)}（副本）`,json(original.outputProfile)]);
   for(const old of original.sections){const sid=randomUUID(),{blocks,status,revision,edited,sourceRefs,assetRefs,lockedFactRefs,claims,error,contextTokens,...definition}=old;await tx.query('INSERT INTO document_sections(id,document_id,section_order,definition) VALUES($1,$2,$3,$4::jsonb)',[sid,copyId,old.order,json({...definition,id:sid})]);await this.persistSection(tx,{...old,id:sid,blocks:old.blocks.map(b=>({...b,id:randomUUID()})),status:old.blocks.length?'edited':'empty',edited:!!old.blocks.length});}
   await this.audit(tx,copyId,'document_copied',null,{fromDocumentId:id});
  });return this.get(copyId);
 }
 async references(id:string,sectionId:string){const doc=await this.get(id),section=doc.sections.find(s=>s.id===sectionId);if(!section)throw new HttpError(404,'章节不存在');const context=await this.snapshot(id);return this.retriever.sections({role:inferSectionRole(section.title),fingerprint:context.fingerprint,products:context.products,query:section.title,limit:8});}
 async saveTemplate(id:string,input:any){const doc=await this.get(id);if(typeof input.name!=='string'||!input.name.trim()||input.name.length>100)throw new HttpError(400,'请输入 100 字以内的模板名');const templateId=`custom-${randomUUID()}`,template:DocumentTemplate={id:templateId,name:input.name.trim(),version:1,documentType:doc.documentType,sections:doc.sections.map(({id,title,level,order,generationMode,requiredContext,retrievalPolicy,generationInstruction,fixedContent,condition,assetRoles,tableKind,visualPlan})=>({id:randomUUID(),title,level,order,generationMode,requiredContext,retrievalPolicy,generationInstruction,fixedContent,condition,assetRoles,tableKind,visualPlan}))};await this.db.transaction(async tx=>{await tx.query('INSERT INTO document_templates(id,name,document_type,active_version) VALUES($1,$2,$3,1)',[templateId,template.name,template.documentType]);await tx.query('INSERT INTO document_template_versions(template_id,version,definition) VALUES($1,1,$2::jsonb)',[templateId,json(template)]);});return template;}
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
   for(const [order,s] of template.sections.filter(s=>(s.condition!=='engineering'||context.engineering)&&(s.tableKind!=='requirements'||allRequirements(context).length>0)).entries())await tx.query('INSERT INTO document_sections(id,document_id,section_order,definition) VALUES($1,$2,$3,$4::jsonb)',[randomUUID(),id,order,json(s)]);
   await this.audit(tx,id,'document_created',null,{templateId:template.id,contextRevision:context.revision});
  });return this.get(id);
 }
 async patch(id:string,input:any){
  const doc=await this.get(id);if(input.revision!==doc.revision)throw new HttpError(409,'方案已更新，请刷新后重试');
  const profile={...doc.outputProfile,...input.outputProfile};
  if(Object.keys(profile).some(k=>!['coverLogoAssetId','themeId','brandColor'].includes(k)&&!Object.keys(defaultOutputProfile).includes(k))||['companyName','fontFamily','titleFontFamily','header','footer'].some(k=>typeof profile[k]!=='string'||profile[k].length>300)||!Number.isFinite(profile.fontSize)||profile.fontSize<8||profile.fontSize>18||!Number.isFinite(profile.pageMarginMm)||profile.pageMarginMm<15||profile.pageMarginMm>35)throw new HttpError(400,'输出样式参数无效');
  try{resolveTheme(profile);}catch(error){throw new HttpError(400,error instanceof Error?error.message:'主题设置无效');}
  if(profile.coverLogoAssetId==='')delete profile.coverLogoAssetId;
  if(profile.coverLogoAssetId!==undefined){
   if(!safeId(profile.coverLogoAssetId))throw new HttpError(400,'封面 Logo 需选择本项目图片');
   const asset=(await this.projects.listAssets(doc.projectId,profile.coverLogoAssetId===doc.outputProfile.coverLogoAssetId)).find(asset=>asset.id===profile.coverLogoAssetId);
   if(!asset||!['image/png','image/jpeg','image/jpg'].includes(asset.mimeType))throw new HttpError(400,'封面 Logo 需选择本项目的 PNG 或 JPEG 图片');
  }
  const title=input.title??doc.title;if(typeof title!=='string'||!title.trim()||title.length>200)throw new HttpError(400,'方案标题无效');
  await this.db.transaction(async tx=>{await this.idle(tx,id);await this.checkAssets(tx,doc.projectId,profile.coverLogoAssetId?[profile.coverLogoAssetId]:[],doc.outputProfile.coverLogoAssetId?[doc.outputProfile.coverLogoAssetId]:[]);const r=await tx.query('UPDATE generated_documents SET title=$2,output_profile=$3::jsonb,revision=revision+1,updated_at=now() WHERE id=$1 AND revision=$4 RETURNING id',[id,title,json(profile),doc.revision]);if(!r.length)throw new HttpError(409,'方案已更新，请刷新');await this.audit(tx,id,'document_profile_updated',doc.outputProfile,profile);});return this.get(id);
 }
 async plan(id:string,input:any){
  const doc=await this.get(id);if(input.revision!==doc.revision)throw new HttpError(409,'章节计划已更新，请刷新');
  if(!Array.isArray(input.sections)||!input.sections.length||input.sections.length>60)throw new HttpError(400,'章节计划需包含 1–60 个章节');
  const seen=new Set<string>();let lastLevel=0;
  const sections=input.sections.map((raw:any,order:number)=>{
   if(!raw||typeof raw.title!=='string'||!raw.title.trim()||raw.title.length>200||![1,2,3].includes(raw.level)||raw.level>lastLevel+1)throw new HttpError(400,'章节名称或层级无效；第一章须为一级，层级不可跳级');lastLevel=raw.level;
   if(raw.visualPlan!==undefined&&(!raw.visualPlan||!['none','scenelab','mermaid','knowledge_image','user_upload'].includes(raw.visualPlan.type)||typeof(raw.visualPlan.description??'')!=='string'||(raw.visualPlan.description??'').length>2000))throw new HttpError(400,'配图设置无效');
   const old=doc.sections.find(s=>s.id===raw.id);if(raw.id&&!old)throw new HttpError(400,'章节不属于当前方案');
   const sid=old?.id??randomUUID();if(seen.has(sid))throw new HttpError(400,'章节重复');seen.add(sid);
   return {old,id:sid,definition:{...(old??{id:sid,generationMode:'ai',requiredContext:['requirements','products'],retrievalPolicy:{query:raw.title},generationInstruction:'按项目事实和引用资料编写本章，不推测参数。'}),title:raw.title.trim(),level:raw.level,order,...(raw.visualPlan?{visualPlan:{type:raw.visualPlan.type,description:raw.visualPlan.description??''}}:{})}};
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
 private async checkAssets(tx:Connection,projectId:string,ids:string[],retainedIds:string[]){
  if(!(await tx.query("SELECT id FROM projects WHERE id=$1 AND organization_id='default' AND workspace_id='default' FOR UPDATE",[projectId])).length)throw new HttpError(404,'项目不存在');
  const unique=[...new Set(ids)];if(!unique.length)return;
  const rows=await tx.query('SELECT id FROM project_assets WHERE project_id=$1 AND id=ANY($2::text[]) AND (retired_at IS NULL OR id=ANY($3::text[]))',[projectId,unique,retainedIds]);
  if(rows.length!==unique.length)throw new HttpError(409,'所选图片已被移除或归档，无法添加到此方案；原内容已保留');
 }
 async edit(id:string,sectionId:string,input:any){
  const doc=await this.get(id),old=doc.sections.find(s=>s.id===sectionId);if(!old)throw new HttpError(404,'章节不存在');if(input.revision!==old.revision)throw new HttpError(409,'章节已更新，请刷新后再编辑');
  const retained=old.blocks.filter(b=>b.type==='asset').map(b=>b.assetId),context=await this.snapshot(id);context.assets=(await this.projects.listAssets(doc.projectId,true)).filter(asset=>!asset.retiredAt||retained.includes(asset.id));const blocks=cleanBlocks(input.blocks,context);
  for(const b of blocks)if(b.type==='diagram'){try{await renderMermaid(b.source,'svg');}catch{throw new HttpError(400,'技术图语法无效，请检查 Mermaid 代码；原内容已保留');}}
  // Source evidence is server-owned; an editor cannot invent or alter citations through block JSON.
  for(const [i,b] of blocks.entries())if(b.type==='diagram'){const previous=old.blocks.find(p=>p.id===input.blocks[i].id);if(previous?.type==='diagram'){b.sourceRefs=previous.sourceRefs;b.generatedBy=b.source===previous.source?previous.generatedBy:'user';}}else if(b.type==='table'){const raw=input.blocks[i],previous=old.blocks.find(p=>p.id===raw.id);if(previous?.type==='table'){b.sourceRefs=previous.sourceRefs;b.generated=previous.generated&&json(b.rows)===json(previous.rows)&&json(b.columns)===json(previous.columns);}}
  const section={...old,blocks,status:'edited' as const,edited:true,claims:[],error:undefined};
  await this.db.transaction(async tx=>{await this.idle(tx,id);await this.checkAssets(tx,doc.projectId,blocks.filter(b=>b.type==='asset').map(b=>b.assetId),retained);const r=(await tx.query('SELECT revision FROM document_sections WHERE id=$1 FOR UPDATE',[sectionId]))[0];if(r.revision!==old.revision)throw new HttpError(409,'章节已更新，请刷新');await this.persistSection(tx,section);await tx.query("UPDATE generated_documents SET revision=revision+1,status='draft',updated_at=now() WHERE id=$1",[id]);await tx.query('DELETE FROM document_validation_issues WHERE document_id=$1',[id]);await this.audit(tx,id,'section_edited',{sectionId,blocks:old.blocks},{sectionId,blocks});});
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
  const {config}=await this.config(input.config),mode:GenerationMode=input.mode??'regenerate';if(!['regenerate','shorten','expand','formal','technical','rewrite','diagram'].includes(mode))throw new HttpError(400,'AI 操作无效');
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
   try{await this.process(job);}catch(error){await this.db.transaction(async tx=>{
    // Keep this job active until cleanup is committed, so a new batch cannot
    // queue chapters that the old batch would subsequently mark as failed.
    await tx.query("UPDATE document_sections SET status='failed',error=coalesce(error,'本批任务未完成，请重试此章') WHERE document_id=$1 AND status IN ('queued','generating')",[job.document_id]);
    await tx.query("UPDATE generated_documents SET status='draft',updated_at=now() WHERE id=$1 AND status='generating'",[job.document_id]);
    await tx.query("UPDATE generation_jobs SET status='failed',errors=errors||$2::jsonb,updated_at=now() WHERE id=$1",[job.id,json([{sectionId:'',message:this.knowledge.settings.redact(error instanceof Error?error.message:'生成失败')}])]);
    await tx.query("UPDATE projects p SET status=CASE WHEN EXISTS(SELECT 1 FROM generation_jobs j JOIN generated_documents d ON d.id=j.document_id WHERE d.project_id=p.id AND j.status IN ('queued','running')) THEN 'generating' WHEN p.confirmed_revision=p.context_revision THEN 'context_ready' ELSE 'draft' END WHERE p.id=(SELECT project_id FROM generated_documents WHERE id=$1)",[job.document_id]);
   });}
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
  let cursor=0;
  const worker=async()=>{while(!this.stopping&&!exhausted){
   const target=job.targets[cursor++];if(!target)return;
   const doc=await this.get(job.document_id),section=doc.sections.find(s=>s.id===target.id);
   try{
    if(!section||section.revision!==target.revision||doc.contextStale)throw new Error('章节或项目事实已更改，请按最新版本重试');
    await this.db.query("UPDATE document_sections SET status='generating' WHERE id=$1",[section.id]);
    const ai=job.mode==='diagram'||['ai','mixed'].includes(section.generationMode);
    const sc=ai?await buildSectionContext(section,context,this.retriever,this.structured,job.config.maxContextTokens,{mode:job.mode,sourceIds:job.source_ids,limitsEnabled:job.config.limitsEnabled!==false,previous:job.mode!=='regenerate'?section.blocks.map(blockText).join('\n'):undefined}):{prompt:'',tokens:0,sources:[],facts:section.requiredContext.includes('products')?(context.structuredFacts??[]):[],factIds:[],assetIds:[],context};
    const fixed=job.mode==='diagram'?[]:deterministicBlocks(section,sc);let result={blocks:[] as DocumentBlock[],sourceRefs:[] as SourceRef[],assetRefs:[] as string[],lockedFactRefs:[] as string[],claims:[] as DocumentSection['claims']};
    if(ai){
     if(!await this.reserve(job,sc.tokens)){exhausted=true;return;}
     const request=async(system:string,prompt:string,jsonResponse=true)=>{const response=await provider.generate({system,prompt,...(jsonResponse?{responseFormat:'json_object' as const}:{})});const usage=response.usage;if(usage&&Number.isFinite(usage.inputTokens)&&Number.isFinite(usage.outputTokens)&&usage.inputTokens>=0&&usage.outputTokens>=0)await this.db.query('UPDATE generation_jobs SET estimated_cost_cny=estimated_cost_cny+$2,input_tokens=input_tokens+$3,output_tokens=output_tokens+$4 WHERE id=$1',[job.id,estimatedModelCost(config.model,usage.inputTokens,usage.outputTokens),usage.inputTokens,usage.outputTokens]);return response;};
     if(job.mode==='diagram'){
      const response=await request('根据当前章节与项目事实绘制技术关系图。仅输出 Mermaid source，不要 Markdown 围栏、JSON、解释或配置。用 flowchart LR/TD 或 sequenceDiagram。采用简洁中文节点；未知型号只用功能角色，不添加未经确认的设备数量、参数和网络协议。禁止链接、脚本和外部图片。图中不得写来源名称。',sc.prompt,false);
      const source=cleanMermaidSource(response.content);await renderMermaid(source,'svg');
      result={blocks:[...section.blocks.filter(b=>b.type!=='diagram'),{id:randomUUID(),type:'diagram',diagramType:'mermaid',source,caption:section.title+'示意图',generatedBy:'ai',sourceRefs:sc.sources}],sourceRefs:[...section.sourceRefs,...sc.sources],assetRefs:section.assetRefs,lockedFactRefs:section.lockedFactRefs,claims:section.claims};
     }else{
      const response=await request(generationSystem,sc.prompt);result=parseGeneration(response.content,sc);
      const problemsFor=(draft:typeof result)=>[...customerFacingProblems(draft.blocks,sc.sources),...highRiskClaimProblems(draft.blocks),...claimEvidenceProblems(draft.claims,sc.context,sc.sources,sc.facts)];
      let problems=problemsFor(result);
      if(problems.length){
       if(!await this.reserve(job,sc.tokens))throw new Error('本章需要修订客户表达，但已达到所设额度；原内容保留');
       const repair=await request(generationSystem,sc.prompt+'\n请修订以下草稿中的内部语言、不当技术承诺及能力证据问题，直接写成客户方案。保留已核实事实，不编造未知值；缺少能力依据时删去该项目承诺，通用机理保留其适用条件并归类principle，不得仅改标签规避检查；重新返回完整 JSON。\n草稿：'+JSON.stringify({content:result.blocks,claims:result.claims})+'\n问题：'+JSON.stringify(problems));result=parseGeneration(repair.content,sc);problems=problemsFor(result);
      }
      if(problems.length)throw new Error('本章客户表达检查未通过：'+problems.map(p=>p.message).join('；'));
     }
    }
    if(job.mode==='diagram'&&[...customerFacingProblems(result.blocks.filter(b=>b.type==='diagram'),sc.sources),...highRiskClaimProblems(result.blocks.filter(b=>b.type==='diagram'))].length)throw new Error('技术图含内部字段、审查语言或不当技术承诺，请重试');
    const references=[...result.sourceRefs,...fixed.flatMap(b=>b.type==='table'?b.sourceRefs:[]),...context.assets.filter(a=>fixed.some(b=>b.type==='asset'&&b.assetId===a.id)).map(a=>asSource(a.sourceRef))];
    const next:DocumentSection={...section,...result,blocks:[...result.blocks,...fixed],sourceRefs:[...new Map(references.map(r=>[r.type+':'+r.id,r])).values()],assetRefs:[...new Set([...result.assetRefs,...fixed.filter(b=>b.type==='asset').map(b=>b.assetId)])],status:'generated',edited:false,error:undefined,contextTokens:sc.tokens};
    await this.db.transaction(async tx=>{await this.checkAssets(tx,doc.projectId,next.blocks.filter(b=>b.type==='asset').map(b=>b.assetId),section.blocks.filter(b=>b.type==='asset').map(b=>b.assetId));const row=await this.row(job.document_id,tx),current=(await tx.query('SELECT revision FROM document_sections WHERE id=$1 FOR UPDATE',[section.id]))[0];if(row.current_context_revision!==context.revision||row.current_input_revision!==context.inputRevision||current.revision!==target.revision)throw new Error('生成期间事实或章节已更新，结果未覆盖原内容');await this.persistSection(tx,next);await tx.query('UPDATE generated_documents SET revision=revision+1,updated_at=now() WHERE id=$1',[doc.id]);await tx.query('UPDATE generation_jobs SET processed=processed+1,updated_at=now() WHERE id=$1',[job.id]);});
   }catch(error){const message=this.knowledge.settings.redact(error instanceof Error?error.message:'本章生成失败');await this.db.query("UPDATE document_sections SET status='failed',error=$2 WHERE id=$1",[target.id,message]);await this.db.query('UPDATE generation_jobs SET failed=failed+1,errors=errors||$2::jsonb,updated_at=now() WHERE id=$1',[job.id,json([{sectionId:target.id,message}])]);}
  }};
  // A persistence failure must not release this document's worker slot while
  // sibling model requests are still in flight, including during shutdown.
  const outcomes=await Promise.allSettled(Array.from({length:Math.min(3,job.targets.length)},()=>worker()));
  const rejected=outcomes.find((outcome):outcome is PromiseRejectedResult=>outcome.status==='rejected');if(rejected)throw rejected.reason;
  const row=(await this.db.query('SELECT * FROM generation_jobs WHERE id=$1',[job.id]))[0];const status=exhausted?'budget_exhausted':this.stopping?'interrupted':row.failed?(row.processed?'partially_failed':'failed'):'completed';
  await this.db.transaction(async tx=>{
   await tx.query("UPDATE document_sections SET status='failed',error=$2 WHERE document_id=$1 AND status IN ('queued','generating')",[job.document_id,exhausted?'预算预留已达上限，已保留完成章节，请调整预算后重试':'任务已中断，请重试未完成章节']);
   await tx.query("UPDATE generated_documents SET status='generated',updated_at=now() WHERE id=$1",[job.document_id]);
  });
  await this.validate(job.document_id);
  // The terminal job state is the edit/generate lock boundary. No writes for
  // this batch may follow it, including validation or failure cleanup.
  await this.db.transaction(async tx=>{
   await tx.query('UPDATE generation_jobs SET status=$2,updated_at=now() WHERE id=$1',[job.id,status]);
   await tx.query("UPDATE projects p SET status=CASE WHEN EXISTS(SELECT 1 FROM generation_jobs j JOIN generated_documents d ON d.id=j.document_id WHERE d.project_id=p.id AND j.status IN ('queued','running')) THEN 'generating' WHEN p.confirmed_revision=p.context_revision THEN 'generated' ELSE 'draft' END WHERE p.id=$1",[context.projectId]);
  });
 }
 async validate(id:string){
  const doc=await this.get(id),context=await this.snapshot(id);context.assets=await this.projects.listAssets(doc.projectId,true);const issues=validateSections(doc.sections,context,doc.contextStale);
  if(context.structuredFacts){const current=await this.structured.productFacts(context.products);if(json(current.map(f=>[f.id,f.value,f.unit]))!==json(context.structuredFacts.map(f=>[f.id,f.value,f.unit])))issues.push({id:randomUUID(),sectionId:doc.sections[0]?.id??'',severity:'error',type:'stale_context',message:'权威产品参数已更新或移除；此方案保留原快照，请新建方案使用最新参数。',sourceRefs:[]});}
  await this.db.transaction(async tx=>{const row=await this.row(id,tx);if(row.revision!==doc.revision)throw new HttpError(409,'方案内容已更新，请重新校验');await tx.query('DELETE FROM document_validation_issues WHERE document_id=$1',[id]);for(const issue of issues)await tx.query('INSERT INTO document_validation_issues(id,document_id,section_id,issue) VALUES($1,$2,$3,$4::jsonb)',[issue.id,id,issue.sectionId||null,json(issue)]);if(!issues.length){await tx.query("UPDATE generated_documents SET status='validated' WHERE id=$1",[id]);await tx.query("UPDATE document_sections SET status='validated' WHERE document_id=$1 AND status IN ('generated','edited','validated')",[id]);}else if(row.status==='validated'){await tx.query("UPDATE generated_documents SET status='generated' WHERE id=$1",[id]);await tx.query("UPDATE document_sections SET status=CASE WHEN edited THEN 'edited' ELSE 'generated' END WHERE document_id=$1 AND status='validated'",[id]);}await this.audit(tx,id,'document_validated',null,{errors:issues.filter(i=>i.severity==='error').length,warnings:issues.filter(i=>i.severity==='warning').length});});return issues;
 }
 async export(id:string){
  await this.db.transaction(tx=>this.idle(tx,id));await this.validate(id);const doc=await this.get(id),assets=new Map<string,{bytes:Buffer;mimeType:string}>();
  if(doc.issues.some(issue=>['customer_facing','prohibited_claim'].includes(issue.type)&&issue.severity==='error'))throw new HttpError(422,'正文包含内部工作语言、来源名称或不当技术承诺，请先处理客户表达校验问题后导出');
  const assetIds=new Set(doc.sections.flatMap(s=>s.blocks.filter(b=>b.type==='asset').map(b=>b.assetId)));if(doc.outputProfile.coverLogoAssetId)assetIds.add(doc.outputProfile.coverLogoAssetId);
  for(const assetId of assetIds){const result=await this.projects.downloadAsset(doc.projectId,assetId);assets.set(assetId,{bytes:Buffer.from(result.bytes),mimeType:result.asset.mimeType});}
  const buffer=await exportDocument(doc,{assets});await this.audit(this.db,id,'document_exported',null,{revision:doc.revision,issueCount:doc.issues.length});return {buffer,filename:`${doc.title}.docx`,issueCount:doc.issues.length};
 }
}
