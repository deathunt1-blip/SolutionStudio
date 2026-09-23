import { randomUUID } from 'node:crypto';
import type { Classification, DocumentRecord, LLMConfig, LLMProvider, ParsedDocument } from '../../core/src/types.js';
import type { Connection, Database } from '../../knowledge/src/database.js';
import { getDocument, getClassification, getRegistries, saveClassification, scoped } from '../../knowledge/src/repository.js';
import { KnowledgeService, HttpError } from '../../knowledge/src/service.js';
import { indexText } from '../../knowledge/src/search.js';
import { reviewReasons } from '../../classification/src/index.js';
import { refineDocument, analyzeCorpus as analyzeCards } from './engine.js';
import { buildCorpusCards, CorpusContextBuilder } from './context.js';
import type { RefinementBatch, RefinementEngine, RefinementField, RefinementOperation, RefinementProposal, TaxonomyProposal, KnowledgeGroup } from './types.js';

const operations:RefinementOperation[]=['title','summary','classification','tags'];
const fields:RefinementField[]=['title','summary','document_type','authority','applications','topics','products'];
const classKey=(field:RefinementField)=>field==='document_type'?'documentType':field;
const date=(value:unknown)=>value instanceof Date?value.toISOString():String(value);
const normalized=(value:unknown):unknown=>Array.isArray(value)?value.map(normalized):value && typeof value==='object'?Object.fromEntries(Object.entries(value).sort(([a],[b])=>a.localeCompare(b)).map(([k,v])=>[k,normalized(v)])):value;
const same=(a:unknown,b:unknown)=>JSON.stringify(normalized(a))===JSON.stringify(normalized(b));
const containsProduct=(text:string,term:string)=>{const normalizedTerm=term.normalize('NFKC').trim();const escaped=normalizedTerm.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');return /^[a-z0-9 _.-]+$/i.test(normalizedTerm)?new RegExp(`(?<![a-z0-9])${escaped}(?![a-z0-9])`,'i').test(text.normalize('NFKC')):text.normalize('NFKC').toLowerCase().includes(normalizedTerm.toLowerCase());};
const ids=(value:unknown,max=1000):string[]=>{
 if(!Array.isArray(value)||!value.length||value.length>max||value.some(v=>typeof v!=='string'||!v.trim()||v.length>200))throw new HttpError(400,'请选择 1–1000 份资料');
 return [...new Set(value as string[])];
};
const budget=(value:unknown)=>{const result=value??10;if(typeof result!=='number'||!Number.isFinite(result)||result<=0||result>100)throw new HttpError(400,'本次预算应大于 0 且不超过 100 元');return result;};
// UTF-8 bytes bound tokens conservatively; reserves include provider's three attempts.
export const REFINEMENT_CALL_RESERVATION_CNY=3*((18000+1024)*6.5+3000*27)/1_000_000;
const ownCost=(usage?:{inputTokens:number;outputTokens:number})=>usage?(usage.inputTokens*6.5+usage.outputTokens*27)/1_000_000:0;
const rowBatch=(r:any):RefinementBatch=>({id:r.id,status:r.status,operations:r.operations,documentIds:r.document_ids,includeUserFields:r.include_user_fields,includeUserTitles:r.include_user_titles,total:r.total,processed:r.processed,failed:r.failed,unchanged:r.unchanged,budgetCny:r.budget_cny,reservedCny:r.reserved_cny,estimatedCostCny:r.estimated_cost_cny,inputTokens:Number(r.input_tokens),outputTokens:Number(r.output_tokens),errors:r.errors,warnings:r.warnings??[],createdAt:date(r.created_at),updatedAt:date(r.updated_at)});
const rowProposal=(r:any):RefinementProposal=>({id:r.id,batchId:r.batch_id,documentId:r.document_id,versionId:r.version_id,field:r.field,currentValue:r.current_value,proposedValue:r.proposed_value,...(r.accepted_value!==null&&r.accepted_value!==undefined?{acceptedValue:r.accepted_value}:{}),confidence:r.confidence,reasoning:r.reasoning,evidence:r.evidence,status:r.status,locked:r.locked,documentTitle:r.document_title,filename:r.filename});
const rowAnalysis=(r:any)=>({id:r.id,status:r.status,total:r.total,processed:r.processed,budgetCny:r.budget_cny,reservedCny:r.reserved_cny,estimatedCostCny:r.estimated_cost_cny,inputTokens:Number(r.input_tokens),outputTokens:Number(r.output_tokens),errors:r.errors,warnings:r.warnings??[],createdAt:date(r.created_at),updatedAt:date(r.updated_at)});
const rowTaxonomy=(r:any):TaxonomyProposal=>({id:r.id,analysisId:r.analysis_id,kind:r.kind,name:r.name,description:r.description,documentIds:r.document_ids,canonical:r.canonical||undefined,aliases:r.aliases,confidence:r.confidence,evidence:r.evidence,status:r.status,createdAt:date(r.created_at)});
interface BatchInput {documentIds:string[];operations?:RefinementOperation[];includeUserFields?:boolean;includeUserTitles?:boolean;budgetCny?:number}
interface ApplyInput {proposalIds?:string[];fields?:RefinementField[];minConfidence?:number;edits?:Record<string,unknown>}

/** Durable proposals are separate from production metadata. Only explicit apply writes documents. */
export class RefinementService {
 private timer?:ReturnType<typeof setInterval>;
 private current?:Promise<void>;
 private stopping=false;
 private readonly engine:RefinementEngine;
 constructor(readonly db:Database,readonly knowledge:KnowledgeService,private providerFactory:(config:LLMConfig)=>LLMProvider,engine?:RefinementEngine){this.engine=engine??{refine:refineDocument,analyze:analyzeCards};}
 async start(){
  this.stopping=false;
  // A running request may already be billed. Preserve reservation and never retry it on startup.
  await this.db.query("UPDATE refinement_batches SET status='partially_failed',errors=errors||$1::jsonb,updated_at=now() WHERE status='running'",[JSON.stringify([{documentId:'',message:'服务中断；未完成请求可能已计费。已保留预算预留，需新建批次继续。'}])]);
  await this.db.query("UPDATE corpus_analyses SET status='partially_failed',errors=errors||$1::jsonb,updated_at=now() WHERE status='running'",[JSON.stringify([{message:'服务中断；已保留预算预留，需新建分析继续。'}])]);
  this.timer=setInterval(()=>this.wake(),500);this.timer.unref();this.wake();
 }
 async close(){this.stopping=true;clearInterval(this.timer);await this.current;}
  wake(){if(this.stopping||this.current)return;this.current=Promise.allSettled([this.drain(),this.drain()]).then(()=>{/* each worker claims jobs in a transaction */}).finally(()=>{this.current=undefined;});}
 private async provider(){
  const config=await this.knowledge.settings.config();
  if(!config)throw new HttpError(400,'请先在设置中配置 Kimi API');
  if(config.baseUrl.replace(/\/+$/,'')!=='https://api.moonshot.cn/v1'||config.model!=='kimi-k2.6'||config.maxTokens>3000)throw new HttpError(400,'当前预算规则仅支持 Kimi 中国区 kimi-k2.6，max_tokens 不超过 3000');
  const provider=this.providerFactory(config);
  return {generate:async(request:{system:string;prompt:string})=>{
   if(Buffer.byteLength(request.system+request.prompt,'utf8')>18000)throw new Error('请求超出 18000 字节预算上限，已阻止发送');
   return provider.generate(request);
  }} satisfies LLMProvider;
 }
 private async selectable(tx:Connection,documentIds:string[]){
  const result:DocumentRecord[]=[];
  for(const id of documentIds){const document=await getDocument(tx,id);if(!document)throw new HttpError(404,'所选资料不存在');if(!['active','needs_review'].includes(document.status)||!document.classification)throw new HttpError(409,'只能整理已解析且未归档的资料');result.push(document);}
  return result;
 }
 async createBatch(input:BatchInput){
  const documentIds=ids(input.documentIds),requested=input.operations??operations;
  if(!Array.isArray(requested)||!requested.length||requested.some(v=>!operations.includes(v)))throw new HttpError(400,'整理操作无效');
  const maxCost=budget(input.budgetCny);await this.provider();
  const id=randomUUID();
  await this.db.transaction(async tx=>{
   const documents=await this.selectable(tx,documentIds);
   await tx.query('INSERT INTO refinement_batches(id,operations,document_ids,targets,include_user_fields,include_user_titles,total,budget_cny) VALUES($1,$2::jsonb,$3::jsonb,$4::jsonb,$5,$6,$7,$8)',[id,JSON.stringify([...new Set(requested)]),JSON.stringify(documentIds),JSON.stringify(documents.map(d=>({documentId:d.id,versionId:d.activeVersionId}))),input.includeUserFields===true,input.includeUserTitles===true,documentIds.length,maxCost]);
  });this.wake();return (await this.getBatch(id)).batch;
 }
 async listBatches(){return (await this.db.query('SELECT * FROM refinement_batches ORDER BY created_at DESC')).map(rowBatch);}
 private async staleBatch(tx:Connection,id:string){
  await tx.query("UPDATE refinement_proposals p SET status='stale',updated_at=now() FROM documents d WHERE p.batch_id=$1 AND p.document_id=d.id AND p.status='pending' AND (p.version_id<>d.active_version_id OR d.status='archived')",[id]);
 }
 async getBatch(id:string){
  await this.staleBatch(this.db,id);
  const batches=await this.db.query('SELECT * FROM refinement_batches WHERE id=$1',[id]);if(!batches[0])throw new HttpError(404,'整理批次不存在');
  const rows=await this.db.query('SELECT p.*,d.title AS document_title,v.filename FROM refinement_proposals p JOIN documents d ON d.id=p.document_id JOIN document_versions v ON v.id=p.version_id WHERE p.batch_id=$1 ORDER BY p.created_at,p.document_id,p.field',[id]);
  return {batch:rowBatch(batches[0]),proposals:rows.map(rowProposal)};
 }
 private async drain(){
  while(!this.stopping){
   const job=await this.db.transaction(async tx=>{
    const batches=await tx.query("SELECT * FROM refinement_batches WHERE status='queued' ORDER BY created_at,id LIMIT 1 FOR UPDATE SKIP LOCKED");
    if(batches[0]){await tx.query("UPDATE refinement_batches SET status='running',updated_at=now() WHERE id=$1",[batches[0].id]);return {kind:'batch',row:batches[0]};}
    const analyses=await tx.query("SELECT * FROM corpus_analyses WHERE status='queued' ORDER BY created_at,id LIMIT 1 FOR UPDATE SKIP LOCKED");
    if(analyses[0]){await tx.query("UPDATE corpus_analyses SET status='running',updated_at=now() WHERE id=$1",[analyses[0].id]);return {kind:'corpus',row:analyses[0]};}
   });
   if(!job)break;
   try{if(job.kind==='batch')await this.processBatch(job.row);else await this.processCorpus(job.row);}
   catch(error){const table=job.kind==='batch'?'refinement_batches':'corpus_analyses';await this.db.query(`UPDATE ${table} SET status=CASE WHEN processed>0 THEN 'partially_failed' ELSE 'failed' END,errors=errors||$1::jsonb,updated_at=now() WHERE id=$2`,[JSON.stringify([{documentId:'',message:this.safeError(error)}]),job.row.id]);}
  }
 }
 private safeError(error:unknown){return this.knowledge.settings.redact(error instanceof Error?error.message:'整理失败');}
 private async reserve(table:'refinement_batches'|'corpus_analyses',id:string){
  const rows=await this.db.query(`UPDATE ${table} SET reserved_cny=reserved_cny+$1,updated_at=now() WHERE id=$2 AND reserved_cny+$1<=budget_cny+0.000000001 RETURNING id`,[REFINEMENT_CALL_RESERVATION_CNY,id]);return Boolean(rows.length);
 }
 private currentValue(document:DocumentRecord,field:RefinementField){if(field==='title')return document.title;if(field==='summary')return document.summary;return (document.classification as any)?.[classKey(field)]?.value??null;}
 private locked(document:DocumentRecord,field:RefinementField,batch:any){
  if(field==='title')return ((document as any).titleSource==='user')&&!batch.include_user_titles;
  if(field==='summary')return ((document as any).summarySource==='user')&&!batch.include_user_fields;
  return (document.classification as any)?.[classKey(field)]?.source==='user'&&!batch.include_user_fields;
 }
 private async processBatch(batch:any){
  const provider=await this.provider(),registry=await getRegistries(this.db),context=new CorpusContextBuilder(this.db);
  for(const target of batch.targets as Array<{documentId:string;versionId:string}>){
   if(this.stopping)throw new Error('服务停止；已完成的建议保留，未完成请求不会自动重试');
   let reserved=false;
   try{
    const document=await getDocument(this.db,target.documentId);
    if(!document||document.activeVersionId!==target.versionId||!['active','needs_review'].includes(document.status))throw new Error('资料版本或状态已变化，请重新创建整理批次');
    const rows=await this.db.query('SELECT parsed_document FROM document_versions WHERE id=$1',[target.versionId]);
    const parsed=rows[0]?.parsed_document as ParsedDocument;if(!parsed?.plainText.trim())throw new Error('资料没有可用正文');
    const corpusContext=await context.build(document,parsed);
    if(!await this.reserve('refinement_batches',batch.id)){
     const remaining=batch.targets.length-batch.targets.indexOf(target);
     await this.db.query("UPDATE refinement_batches SET failed=failed+$1,errors=errors||$2::jsonb,status='partially_failed',updated_at=now() WHERE id=$3",[remaining,JSON.stringify([{documentId:target.documentId,message:`已达到本次预算；剩余 ${remaining} 份未发送请求。`}]),batch.id]);return;
    }reserved=true;
    const output=await this.engine.refine({document,parsed,registries:registry,context:corpusContext,operations:batch.operations,includeUserFields:batch.include_user_fields,includeUserTitles:batch.include_user_titles},provider);
    if(output.error){
     await this.db.query('UPDATE refinement_batches SET input_tokens=input_tokens+$1,output_tokens=output_tokens+$2,estimated_cost_cny=estimated_cost_cny+$3 WHERE id=$4',[output.usage?.inputTokens??0,output.usage?.outputTokens??0,ownCost(output.usage),batch.id]);
     throw new Error(output.error);
    }
    await this.db.transaction(async tx=>{
     const latest=await getDocument(tx,target.documentId);let added=0;
     for(const suggestion of output.suggestions){
      const currentValue=this.currentValue(document,suggestion.field);if(same(currentValue,suggestion.proposedValue))continue;
      const lock=this.locked(document,suggestion.field,batch);
      const stale=!latest||latest.activeVersionId!==target.versionId||latest.status==='archived'||!same(this.currentValue(latest,suggestion.field),currentValue);
      await tx.query('INSERT INTO refinement_proposals(id,batch_id,document_id,version_id,field,current_value,proposed_value,confidence,reasoning,evidence,status,locked) VALUES($1,$2,$3,$4,$5,$6::jsonb,$7::jsonb,$8,$9,$10::jsonb,$11,$12) ON CONFLICT(batch_id,document_id,field) DO NOTHING',[randomUUID(),batch.id,target.documentId,target.versionId,suggestion.field,JSON.stringify(currentValue),JSON.stringify(suggestion.proposedValue),suggestion.confidence,suggestion.reasoning,JSON.stringify(suggestion.evidence),stale?'stale':'pending',lock]);added++;
     }
     await tx.query('UPDATE refinement_batches SET processed=processed+1,unchanged=unchanged+$1,input_tokens=input_tokens+$2,output_tokens=output_tokens+$3,estimated_cost_cny=estimated_cost_cny+$4,warnings=warnings||$5::jsonb,updated_at=now() WHERE id=$6',[added?0:1,output.usage?.inputTokens??0,output.usage?.outputTokens??0,ownCost(output.usage),JSON.stringify(output.warnings.map(message=>({documentId:document.id,message:this.knowledge.settings.redact(message)}))),batch.id]);
    });
   }catch(error){await this.db.query('UPDATE refinement_batches SET processed=processed+1,failed=failed+1,errors=errors||$1::jsonb,updated_at=now() WHERE id=$2',[JSON.stringify([{documentId:target.documentId,message:this.safeError(error)+(reserved?'（已保留本次请求的预算预留）':'')}]),batch.id]);}
  }
  await this.db.query("UPDATE refinement_batches SET status=CASE WHEN failed=0 THEN 'completed' WHEN failed>=total THEN 'failed' ELSE 'partially_failed' END,updated_at=now() WHERE id=$1",[batch.id]);
 }
 private async snapshot(tx:Connection,documentId:string){
  const rows=await tx.query(`SELECT d.id,d.active_version_id,d.title,d.canonical_title,d.title_source,d.title_confidence,d.title_reasoning,d.title_user,d.user_overrides,d.status,d.updated_at,
   v.summary,v.ai_summary,v.extractive_summary,v.summary_source,v.review_reasons,v.status AS version_status FROM documents d JOIN document_versions v ON v.id=d.active_version_id WHERE ${scoped} AND d.id=$1 FOR UPDATE OF d`,[documentId]);
  if(!rows[0])throw new HttpError(404,'资料不存在');const row=rows[0];row.updated_at=date(row.updated_at);row.classification=await getClassification(tx,row.active_version_id);return row;
 }
 private async validateValue(tx:Connection,field:RefinementField,value:unknown,document:DocumentRecord){
  if(field==='title'||field==='summary'){if(typeof value!=='string'||!value.trim()||value.length>(field==='title'?500:3000))throw new HttpError(400,'标题或摘要内容无效');return value.trim();}
  const registry=await getRegistries(tx);
  if(field==='document_type'){if(typeof value!=='string'||!registry.documentTypes.some(v=>v.key===value))throw new HttpError(400,'文档类型未注册');return value;}
  if(field==='authority'){if(typeof value!=='string'||!['authoritative','reference','style_only','unknown'].includes(value))throw new HttpError(400,'权威级别无效');return value;}
  if(!Array.isArray(value)||value.length>100||value.some(v=>typeof v!=='string'||!v.trim()||v.length>200))throw new HttpError(400,'标签内容无效');
  if(field==='products'){
   const rows=await tx.query('SELECT parsed_document FROM document_versions WHERE id=$1',[document.activeVersionId]);
   const content=`${document.filename}\n${rows[0]?.parsed_document?.plainText??''}`.normalize('NFKC').toLocaleLowerCase();
   if(value.some(v=>!containsProduct(content,v)))throw new HttpError(400,'产品名称必须能在当前文件中找到证据');
  }else if(value.some(v=>!registry[field].some(item=>item.key===v)))throw new HttpError(400,'应用或主题尚未注册');
  return [...new Set(value.map(v=>v.trim()))];
 }
 async applyBatch(id:string,input:ApplyInput={}){
  if(input.proposalIds!==undefined)ids(input.proposalIds,7000);
  if(input.fields!==undefined&&(!Array.isArray(input.fields)||!input.fields.length||input.fields.some(f=>!fields.includes(f))))throw new HttpError(400,'整理字段无效');
  if(input.minConfidence!==undefined&&(!Number.isFinite(input.minConfidence)||input.minConfidence<0||input.minConfidence>1))throw new HttpError(400,'置信度范围无效');
  const settings=await this.knowledge.settings.get();let applied=0;const conflicts:string[]=[];
  await this.db.transaction(async tx=>{
   const rows=await tx.query('SELECT * FROM refinement_batches WHERE id=$1 FOR UPDATE',[id]);const batch=rows[0];if(!batch)throw new HttpError(404,'整理批次不存在');
   if(['queued','running','rolled_back'].includes(batch.status))throw new HttpError(409,'当前批次状态不能应用建议');
   await this.staleBatch(tx,id);
   const all=await tx.query("SELECT * FROM refinement_proposals WHERE batch_id=$1 AND status='pending' ORDER BY document_id,field",[id]);
   const selected=all.filter(p=>(!input.proposalIds||input.proposalIds.includes(p.id))&&(!input.fields||input.fields.includes(p.field))&&(input.minConfidence===undefined||p.confidence>=input.minConfidence));
   const byDocument=new Map<string,any[]>();for(const p of selected)byDocument.set(p.document_id,[...byDocument.get(p.document_id)??[],p]);
   for(const [documentId,proposals] of byDocument){
    const before=await this.snapshot(tx,documentId),document=await getDocument(tx,documentId);if(!document?.classification)continue;
    const classification=structuredClone(document.classification),changes:Record<string,unknown>={};let changed=0;
    for(const p of proposals){
     const field=p.field as RefinementField;
     if(before.active_version_id!==p.version_id||!['active','needs_review'].includes(document.status)||!same(this.currentValue(document,field),p.current_value)||this.locked(document,field,batch)||p.locked){
      await tx.query("UPDATE refinement_proposals SET status='stale',updated_at=now() WHERE id=$1",[p.id]);conflicts.push(p.id);continue;
     }
     const raw=input.edits&&Object.hasOwn(input.edits,p.id)?input.edits[p.id]:p.proposed_value;
     const value=await this.validateValue(tx,field,raw,document);
     if(field==='title')await tx.query("UPDATE documents SET title=$1,canonical_title=$1,title_source='user',title_user=true,title_confidence=1,title_reasoning='用户接受整理建议' WHERE id=$2",[value,documentId]);
     else if(field==='summary')await tx.query("UPDATE document_versions SET summary=$1,ai_summary=$1,summary_source='user' WHERE id=$2",[value,document.activeVersionId]);
     else{const key=classKey(field);const confirmed={value,confidence:1,source:'user',reasoning:'用户接受整理建议'};(classification as any)[key]=confirmed;changes[key]=confirmed;}
     await tx.query("UPDATE refinement_proposals SET status='accepted',accepted_value=$2::jsonb,updated_at=now() WHERE id=$1",[p.id,JSON.stringify(value)]);changed++;applied++;
    }
    if(!changed)continue;
    const overrides={...before.user_overrides,...changes};
    await tx.query('UPDATE documents SET user_overrides=$1::jsonb,updated_at=now() WHERE id=$2',[JSON.stringify(overrides),documentId]);
    await saveClassification(tx,document.activeVersionId,classification);
    const reasons=reviewReasons(classification,settings.reviewThreshold);
    await tx.query('UPDATE document_versions SET review_reasons=$1::jsonb WHERE id=$2',[JSON.stringify(reasons),document.activeVersionId]);
    await tx.query('UPDATE documents SET status=$1 WHERE id=$2',[reasons.length?'needs_review':'active',documentId]);
    await this.knowledge.reindexMetadata(tx,documentId,settings);
    const exampleIds:string[]=[];
    if(Object.keys(changes).length){
     const fresh=await getDocument(tx,documentId);const exampleId=randomUUID();exampleIds.push(exampleId);
     const parsed=await tx.query('SELECT parsed_document FROM document_versions WHERE id=$1',[document.activeVersionId]);
     const summary=`${fresh?.title}\n${fresh?.summary}\n${parsed[0]?.parsed_document?.plainText?.slice(0,1500)??''}`.slice(0,2200);
     await tx.query("INSERT INTO confirmed_examples(id,organization_id,workspace_id,document_id,version_id,text_summary,confirmed_fields,search_vector) VALUES($1,'default','default',$2,$3,$4,$5::jsonb,to_tsvector('simple',$6))",[exampleId,documentId,document.activeVersionId,summary,JSON.stringify(overrides),indexText(summary)]);
    }
    const after=await this.snapshot(tx,documentId),applyId=randomUUID();
    await tx.query('INSERT INTO refinement_applies(id,batch_id,document_id,version_id,before_value,after_value,example_ids) VALUES($1,$2,$3,$4,$5::jsonb,$6::jsonb,$7::jsonb)',[applyId,id,documentId,document.activeVersionId,JSON.stringify(before),JSON.stringify(after),JSON.stringify(exampleIds)]);
    await tx.query("INSERT INTO audit_events(id,document_id,version_id,action,previous_value,next_value) VALUES($1,$2,$3,'batch_refinement_apply',$4::jsonb,$5::jsonb)",[randomUUID(),documentId,document.activeVersionId,JSON.stringify({batchId:id,applyId,before}),JSON.stringify({batchId:id,applyId,after,exampleIds})]);
   }
   if(applied)await tx.query("UPDATE refinement_batches SET status='applied',updated_at=now() WHERE id=$1",[id]);
  });return {...await this.getBatch(id),applied,conflicts};
 }
 async rejectBatch(id:string,input:{proposalIds?:string[]}={}){
  await this.getBatch(id);if(input.proposalIds!==undefined)ids(input.proposalIds,7000);
  await this.db.query("UPDATE refinement_proposals SET status='rejected',updated_at=now() WHERE batch_id=$1 AND status='pending'"+(input.proposalIds?' AND id=ANY($2::text[])':''),input.proposalIds?[id,input.proposalIds]:[id]);return this.getBatch(id);
 }
 async rollbackBatch(id:string){
  const settings=await this.knowledge.settings.get();let restored=0;
  await this.db.transaction(async tx=>{
   const batches=await tx.query('SELECT status FROM refinement_batches WHERE id=$1 FOR UPDATE',[id]);if(!batches[0])throw new HttpError(404,'批次不存在');if(batches[0].status==='rolled_back')return;
   const events=await tx.query('SELECT * FROM refinement_applies WHERE batch_id=$1 AND rolled_back_at IS NULL ORDER BY applied_at DESC,id DESC',[id]);
   if(!events.length)throw new HttpError(409,'该批次没有可撤销的应用记录');
   for(const event of events){
    const current=await this.snapshot(tx,event.document_id);
    if(!same(current,event.after_value))throw new HttpError(409,'资料在整理后已有修改或新版本，无法安全撤销；未覆盖任何后续修改');
    const before=event.before_value;
    await tx.query('UPDATE documents SET title=$1,canonical_title=$2,title_source=$3,title_confidence=$4,title_reasoning=$5,title_user=$6,user_overrides=$7::jsonb,status=$8,updated_at=$9 WHERE id=$10',[before.title,before.canonical_title,before.title_source,before.title_confidence,before.title_reasoning,before.title_user,JSON.stringify(before.user_overrides),before.status,before.updated_at,event.document_id]);
    await tx.query('UPDATE document_versions SET summary=$1,ai_summary=$2,extractive_summary=$3,summary_source=$4,review_reasons=$5::jsonb,status=$6 WHERE id=$7',[before.summary,before.ai_summary,before.extractive_summary,before.summary_source,JSON.stringify(before.review_reasons),before.version_status,event.version_id]);
    await saveClassification(tx,event.version_id,before.classification);
    await this.knowledge.reindexMetadata(tx,event.document_id,settings);
    for(const exampleId of event.example_ids)await tx.query('DELETE FROM confirmed_examples WHERE id=$1 AND document_id=$2 AND version_id=$3',[exampleId,event.document_id,event.version_id]);
    await tx.query('UPDATE refinement_applies SET rolled_back_at=now() WHERE id=$1',[event.id]);
    await tx.query("INSERT INTO audit_events(id,document_id,version_id,action,previous_value,next_value) VALUES($1,$2,$3,'batch_refinement_rollback',$4::jsonb,$5::jsonb)",[randomUUID(),event.document_id,event.version_id,JSON.stringify({batchId:id,after:current}),JSON.stringify({batchId:id,before})]);restored++;
   }
   await tx.query("UPDATE refinement_batches SET status='rolled_back',updated_at=now() WHERE id=$1",[id]);
   await tx.query("UPDATE refinement_proposals SET status='rejected',updated_at=now() WHERE batch_id=$1 AND status IN ('accepted','pending')",[id]);
  });return {...await this.getBatch(id),restored};
 }
 async analyzeCorpus(input:{documentIds?:string[];budgetCny?:number}={}){
  const maxCost=budget(input.budgetCny);await this.provider();
  const documentIds=input.documentIds?ids(input.documentIds):(await this.db.query(`SELECT d.id FROM documents d WHERE ${scoped} AND d.status IN ('active','needs_review') ORDER BY d.id`)).map(d=>String(d.id));
  if(!documentIds.length)throw new HttpError(400,'当前没有可分析资料');
  await this.selectable(this.db,documentIds);const id=randomUUID();
  await this.db.query('INSERT INTO corpus_analyses(id,document_ids,total,budget_cny) VALUES($1,$2::jsonb,$3,$4)',[id,JSON.stringify(documentIds),documentIds.length,maxCost]);this.wake();return rowAnalysis((await this.db.query('SELECT * FROM corpus_analyses WHERE id=$1',[id]))[0]);
 }
 private async processCorpus(analysis:any){
  const provider=await this.provider(),registry=await getRegistries(this.db),cards=await buildCorpusCards(this.db,analysis.document_ids);
  if(cards.length!==analysis.document_ids.length)throw new Error('部分所选资料已归档或不再可用，请重新选择资料分析');
  for(let offset=0;offset<cards.length;offset+=50){
   if(this.stopping)throw new Error('服务停止；请新建分析继续');
   const part=cards.slice(offset,offset+50);
   const versions:Record<string,string>={};
   for(const card of part){
    const document=await getDocument(this.db,card.id);
    if(!card.versionId||!document||document.activeVersionId!==card.versionId||!['active','needs_review'].includes(document.status))throw new Error('资料卡片建立后源版本或状态已变化，请重新分析');
    versions[card.id]=card.versionId;
   }
   if(!await this.reserve('corpus_analyses',analysis.id))throw new Error('已达到本次预算；剩余资料未发送请求');
   const output=await this.engine.analyze(part,registry,provider);
   if(output.error){
    await this.db.query('UPDATE corpus_analyses SET input_tokens=input_tokens+$1,output_tokens=output_tokens+$2,estimated_cost_cny=estimated_cost_cny+$3 WHERE id=$4',[output.usage?.inputTokens??0,output.usage?.outputTokens??0,ownCost(output.usage),analysis.id]);
    throw new Error(output.error);
   }
   await this.db.transaction(async tx=>{
    for(const suggestion of output.suggestions){
     const versionIds=Object.fromEntries(suggestion.documentIds.map(id=>[id,versions[id]]));
     await tx.query('INSERT INTO taxonomy_proposals(id,analysis_id,kind,name,description,document_ids,canonical,aliases,confidence,evidence,version_ids) VALUES($1,$2,$3,$4,$5,$6::jsonb,$7,$8::jsonb,$9,$10::jsonb,$11::jsonb)',[randomUUID(),analysis.id,suggestion.kind,suggestion.name,suggestion.description,JSON.stringify(suggestion.documentIds),suggestion.canonical??null,JSON.stringify(suggestion.aliases??[]),suggestion.confidence,JSON.stringify(suggestion.evidence??[]),JSON.stringify(versionIds)]);
    }
    await tx.query('UPDATE corpus_analyses SET processed=processed+$1,input_tokens=input_tokens+$2,output_tokens=output_tokens+$3,estimated_cost_cny=estimated_cost_cny+$4,warnings=warnings||$5::jsonb,updated_at=now() WHERE id=$6',[part.length,output.usage?.inputTokens??0,output.usage?.outputTokens??0,ownCost(output.usage),JSON.stringify(output.warnings.map(message=>({message:this.knowledge.settings.redact(message)}))),analysis.id]);
   });
  }
  await this.db.query("UPDATE corpus_analyses SET status='completed',updated_at=now() WHERE id=$1",[analysis.id]);
 }
 private async staleCorpus(tx:Connection,id?:string){
  await tx.query(`UPDATE taxonomy_proposals p SET status='stale',updated_at=now() WHERE p.status='pending'${id?' AND p.id=$1':''} AND EXISTS(SELECT 1 FROM jsonb_each_text(p.version_ids) expected LEFT JOIN documents d ON d.id=expected.key WHERE d.id IS NULL OR d.active_version_id<>expected.value OR d.status='archived' OR d.scope<>'global' OR d.organization_id<>'default' OR d.workspace_id<>'default')`,id?[id]:[]);
 }
 async listCorpusProposals(){await this.staleCorpus(this.db);return {analyses:(await this.db.query('SELECT * FROM corpus_analyses ORDER BY created_at DESC')).map(rowAnalysis),proposals:(await this.db.query('SELECT * FROM taxonomy_proposals ORDER BY created_at DESC')).map(rowTaxonomy)};}
 async rejectCorpusProposal(id:string){const rows=await this.db.query("UPDATE taxonomy_proposals SET status='rejected',updated_at=now() WHERE id=$1 AND status='pending' RETURNING *",[id]);if(!rows[0])throw new HttpError(409,'建议不存在或已经处理');return rowTaxonomy(rows[0]);}
 async acceptCorpusProposal(id:string,edited?:unknown){
  await this.staleCorpus(this.db,id);
  return this.db.transaction(async tx=>{
   const rows=await tx.query('SELECT * FROM taxonomy_proposals WHERE id=$1 FOR UPDATE',[id]);const proposal=rows[0];if(!proposal||proposal.status!=='pending')throw new HttpError(409,'建议不存在或已经处理');
   for(const [documentId,versionId] of Object.entries(proposal.version_ids)){const document=await getDocument(tx,documentId);if(!document||document.activeVersionId!==versionId||document.status==='archived')throw new HttpError(409,'建议依据的资料版本已变化，请重新分析');}
   if(edited!==undefined&&(!edited||typeof edited!=='object'||Array.isArray(edited)))throw new HttpError(400,'编辑内容无效');
   const change=(edited??{}) as Record<string,unknown>;
   if(Object.keys(change).some(k=>!['name','description','canonical','aliases','documentIds'].includes(k)))throw new HttpError(400,'不支持编辑该建议字段');
   const value={...rowTaxonomy(proposal),...change};
   if(typeof value.name!=='string'||!value.name.trim()||value.name.length>200||typeof value.description!=='string'||value.description.length>3000)throw new HttpError(400,'分组名称或描述无效');
   const documents=ids(value.documentIds);await this.selectable(tx,documents);
   if(proposal.kind==='group')await this.createGroupIn(tx,{name:value.name,description:value.description,documentIds:documents});
   else if(proposal.kind==='entity_alias'){
    if(typeof value.canonical!=='string'||!value.canonical.trim()||value.canonical.length>200||!Array.isArray(value.aliases)||value.aliases.some(a=>typeof a!=='string'||!a.trim()||a.length>200))throw new HttpError(400,'实体别名无效');
    const groupId=randomUUID();const existing=await tx.query('SELECT id FROM entity_alias_groups WHERE canonical=$1',[value.canonical]);
    if(!existing[0])await tx.query('INSERT INTO entity_alias_groups(id,canonical) VALUES($1,$2)',[groupId,value.canonical]);
    const target=existing[0]?.id??groupId;
    for(const alias of [...new Set([value.canonical,...value.aliases])]){
     const found=await tx.query('SELECT group_id FROM entity_aliases WHERE alias=$1',[alias]);if(found[0]&&found[0].group_id!==target)throw new HttpError(409,'该别名已属于其他实体，请先核对');
     await tx.query('INSERT INTO entity_aliases(group_id,alias) VALUES($1,$2) ON CONFLICT DO NOTHING',[target,alias]);
    }
   }else if(proposal.kind==='topic_merge'){
    if(typeof value.canonical!=='string'||!Array.isArray(value.aliases)||value.aliases.some(a=>typeof a!=='string'||!a.trim()||a.length>200))throw new HttpError(400,'主题归并内容无效');
    const registry=await getRegistries(tx);const canonical=registry.topics.find(t=>t.key===value.canonical||t.label===value.canonical);
    if(!canonical)throw new HttpError(400,'请将规范主题编辑为一个已注册的主题 key');
    const aliases=[...new Set([...canonical.aliases,...value.aliases])].filter(a=>a!==canonical.key&&a!==canonical.label);
    if(aliases.some(a=>registry.topics.some(t=>t.key!==canonical.key&&[t.key,t.label,...t.aliases].includes(a))))throw new HttpError(409,'建议涉及其他现有主题；请先在设置中核对，避免含义冲突');
    await tx.query('UPDATE topics SET aliases=$1::jsonb WHERE key=$2',[JSON.stringify(aliases),canonical.key]);
   }
   const result=await tx.query("UPDATE taxonomy_proposals SET status='accepted',applied_value=$1::jsonb,updated_at=now() WHERE id=$2 RETURNING *",[JSON.stringify(value),id]);return rowTaxonomy(result[0]);
  });
 }
 async listGroups():Promise<KnowledgeGroup[]>{return (await this.db.query(`SELECT g.*,(SELECT count(*)::int FROM knowledge_group_documents gd JOIN documents d ON d.id=gd.document_id WHERE gd.group_id=g.id AND ${scoped} AND d.status<>'archived') AS document_count FROM knowledge_groups g ORDER BY g.name`)).map(r=>({id:r.id,name:r.name,description:r.description,documentCount:r.document_count,createdAt:date(r.created_at)}));}
 private async createGroupIn(tx:Connection,input:{name:string;description?:string;documentIds?:string[]}){
  if(typeof input.name!=='string'||!input.name.trim()||input.name.length>200||input.description!==undefined&&(typeof input.description!=='string'||input.description.length>3000))throw new HttpError(400,'分组名称或描述无效');
  const documentIds=input.documentIds?.length?ids(input.documentIds):[];if(documentIds.length)await this.selectable(tx,documentIds);
  const existing=await tx.query('SELECT id FROM knowledge_groups WHERE name=$1',[input.name.trim()]);if(existing[0])throw new HttpError(409,'分组名称已存在');
  const id=randomUUID();await tx.query('INSERT INTO knowledge_groups(id,name,description) VALUES($1,$2,$3)',[id,input.name.trim(),input.description??'']);
  for(const documentId of documentIds)await tx.query('INSERT INTO knowledge_group_documents(group_id,document_id) VALUES($1,$2)',[id,documentId]);return {id,name:input.name.trim(),description:input.description??'',documentCount:documentIds.length};
 }
 async createGroup(input:{name:string;description?:string;documentIds?:string[]}){return this.db.transaction(tx=>this.createGroupIn(tx,input));}
 async mergeGroups(input:{sourceIds:string[];targetId:string}){
  const sourceIds=ids(input.sourceIds);if(sourceIds.includes(input.targetId))throw new HttpError(400,'来源分组与目标分组不能相同');
  await this.db.transaction(async tx=>{
   for(const id of [...sourceIds,input.targetId])if(!(await tx.query('SELECT id FROM knowledge_groups WHERE id=$1',[id])).length)throw new HttpError(404,'分组不存在');
   for(const source of sourceIds){await tx.query('INSERT INTO knowledge_group_documents(group_id,document_id) SELECT $1,document_id FROM knowledge_group_documents WHERE group_id=$2 ON CONFLICT DO NOTHING',[input.targetId,source]);await tx.query('DELETE FROM knowledge_groups WHERE id=$1',[source]);}
   await tx.query('UPDATE knowledge_groups SET updated_at=now() WHERE id=$1',[input.targetId]);
  });return (await this.listGroups()).find(g=>g.id===input.targetId)!;
 }
 async batchArchive(input:{documentIds:string[]}){
  const documentIds=ids(input.documentIds);
  await this.db.transaction(async tx=>{
   for(const id of documentIds){
    const document=await getDocument(tx,id);if(!document)throw new HttpError(404,'所选资料不存在');
    await tx.query("UPDATE documents SET status='archived',updated_at=now() WHERE id=$1",[id]);
    await tx.query("UPDATE document_versions SET status='archived' WHERE id=$1",[document.activeVersionId]);
    await tx.query("UPDATE refinement_proposals SET status='stale',updated_at=now() WHERE document_id=$1 AND status='pending'",[id]);
    await tx.query("INSERT INTO audit_events(id,document_id,version_id,action,previous_value,next_value) VALUES($1,$2,$3,'archive',$4::jsonb,$5::jsonb)",[randomUUID(),id,document.activeVersionId,JSON.stringify({status:document.status}),JSON.stringify({status:'archived',batch:true})]);
   }
  });return {archived:documentIds.length};
 }
}
