import { createHash, randomUUID } from 'node:crypto';
import type { LLMConfig, LLMProvider, ParsedDocument } from '../../core/src/types.js';
import type { Connection } from '../../knowledge/src/database.js';
import { HttpError, type KnowledgeService } from '../../knowledge/src/service.js';
import { getDocument, getRegistries } from '../../knowledge/src/repository.js';
import { indexText } from '../../knowledge/src/search.js';
import { KimiProvider } from '../../llm/src/index.js';
import { estimatedModelCost, modelProfile } from '../../llm/src/models.js';
import { enrichSections, parseEnrichmentResponse } from './engine.js';
import { extractSections } from './sections.js';
import { sectionRecord } from './retrieval.js';
import { normalizeTag, projectStages, sectionRoles, type TagAlias } from './taxonomy.js';
import {tagDimensions,type AliasSuggestion,type EnrichmentBatch,type EnrichmentItem,type ReferenceQuality,type SoftTags,type TagDimension} from './types.js';

const json=JSON.stringify;
export function enrichmentCacheKey(versionId:string,config:LLMConfig,request:{system:string;prompt:string;responseFormat?:string}) {
 const hash=createHash('sha256').update(json({versionId,model:config.model,baseUrl:config.baseUrl.replace(/\/+$/,''),temperature:config.temperature,maxTokens:config.maxTokens,reasoningEffort:config.reasoningEffort??null,system:request.system,prompt:request.prompt,responseFormat:request.responseFormat??null})).digest('hex');
 return `enrichment-responses/${versionId}/${hash}.json`;
}
const date=(value:unknown)=>value instanceof Date?value.toISOString():String(value);
const quality=(value:unknown):ReferenceQuality=>{if(!['normal','good','preferred'].includes(String(value)))throw new HttpError(400,'请选择普通、优质参考或首选参考');return value as ReferenceQuality;};
const batchRecord=(row:any):EnrichmentBatch=>({id:row.id,status:row.status,total:row.total,processed:Number(row.processed??0),failed:Number(row.failed??0),running:Number(row.running??0),budgetCny:row.budget_cny===null?null:Number(row.budget_cny),reservedCny:Number(row.reserved_cny),estimatedCostCny:Number(row.estimated_cost_cny),inputTokens:Number(row.input_tokens),outputTokens:Number(row.output_tokens),model:row.model,createdAt:date(row.created_at),updatedAt:date(row.updated_at)});
const itemRecord=(row:any):EnrichmentItem=>({id:row.id,documentId:row.document_id,versionId:row.version_id,documentTitle:row.document_title,status:row.status,sectionCount:row.section_count,error:row.error??undefined,inputTokens:Number(row.input_tokens),outputTokens:Number(row.output_tokens)});
const batchSelect=`SELECT b.*,(SELECT count(*) FROM knowledge_enrichment_items i WHERE i.batch_id=b.id AND i.status='completed') AS processed,
 (SELECT count(*) FROM knowledge_enrichment_items i WHERE i.batch_id=b.id AND i.status IN ('failed','stale','cancelled')) AS failed,
 (SELECT count(*) FROM knowledge_enrichment_items i WHERE i.batch_id=b.id AND i.status='running') AS running FROM knowledge_enrichment_batches b`;

/** Durable, explicitly requested soft enrichment. Never changes source text, authority or product facts. */
export class KnowledgeEnrichmentService {
 readonly db;
 private timer?:ReturnType<typeof setInterval>;
 private current?:Promise<void>;
 private stopping=false;
 private providerFactory:(config:LLMConfig)=>LLMProvider;
 constructor(readonly knowledge:KnowledgeService,options:{providerFactory?:(config:LLMConfig)=>LLMProvider}={}){this.db=knowledge.db;this.providerFactory=options.providerFactory??(config=>new KimiProvider(config));}
 async start(){
  const registries=await getRegistries(this.db);
  await this.db.transaction(async tx=>{
   // A billed in-flight request is never silently replayed on restart.
   await tx.query("UPDATE knowledge_enrichment_items SET status='failed',error='服务中断；已保留原索引与费用预留。请重新选择未完成资料。',updated_at=now() WHERE status='running'");
   for(const [dimension,items] of [['applications',registries.applications.map(item=>[item.key,item.label])],['section_role',sectionRoles],['project_stage',projectStages]] as const)for(const [value,label] of items)await tx.query('INSERT INTO knowledge_tag_registry(dimension,value,label) VALUES($1,$2,$3) ON CONFLICT DO NOTHING',[dimension,value,label]);
   for(const row of await tx.query("SELECT id FROM knowledge_enrichment_batches WHERE status IN ('queued','running')"))await this.finishBatch(tx,row.id);
  });
  this.stopping=false;this.timer=setInterval(()=>this.wake(),700);this.timer.unref();this.wake();
 }
 async close(){this.stopping=true;clearInterval(this.timer);await this.current;}
 async stop(){return this.close();}
 wake(){if(this.stopping||this.current)return;this.current=Promise.allSettled([this.drain(),this.drain()]).then(()=>{}).finally(()=>{this.current=undefined;});}
 private async config(){const settings=await this.knowledge.settings.config();if(!settings)throw new HttpError(400,'请先在设置中配置 Kimi API');const profile=modelProfile('kimi-k3');return {...settings,model:'kimi-k3',temperature:profile.temperature,maxTokens:profile.defaultOutputTokens,requestTimeoutMs:profile.requestTimeoutMs,reasoningEffort:'max' as const};}
 async createBatch(input:{documentIds:string[];budgetCny?:number|null}) {
  if(!Array.isArray(input.documentIds)||!input.documentIds.length||input.documentIds.length>1000||input.documentIds.some(id=>typeof id!=='string'||!id||id.length>200))throw new HttpError(400,'请选择 1–1000 份资料');
  if(input.budgetCny!==null&&input.budgetCny!==undefined&&(!Number.isFinite(input.budgetCny)||input.budgetCny<=0))throw new HttpError(400,'可选预算必须大于 0');
  await this.config();const id=randomUUID(),ids=[...new Set(input.documentIds)];
  await this.db.transaction(async tx=>{
   const rows=await tx.query(`SELECT d.id,d.active_version_id FROM documents d JOIN document_versions v ON v.id=d.active_version_id WHERE d.id=ANY($1::text[]) AND d.organization_id='default' AND d.workspace_id='default' AND d.scope='global' AND d.status IN ('active','needs_review') AND d.canonical_document_id IS NULL AND v.parse_status IN ('success','partial')`,[ids]);
   if(rows.length!==ids.length)throw new HttpError(409,'所选资料包含未解析、已归档或重复副本，请重新选择');
   if((await tx.query("SELECT id FROM knowledge_enrichment_items WHERE document_id=ANY($1::text[]) AND status IN ('queued','running')",[ids])).length)throw new HttpError(409,'部分资料已经在深度整理队列中');
   await tx.query('INSERT INTO knowledge_enrichment_batches(id,total,budget_cny) VALUES($1,$2,$3)',[id,ids.length,input.budgetCny??null]);
   for(const row of rows)await tx.query('INSERT INTO knowledge_enrichment_items(id,batch_id,document_id,version_id) VALUES($1,$2,$3,$4)',[randomUUID(),id,row.id,row.active_version_id]);
  });this.wake();return (await this.getBatch(id)).batch;
 }
 async listBatches(){return (await this.db.query(`${batchSelect} ORDER BY b.created_at DESC LIMIT 50`)).map(batchRecord);}
 async getBatch(id:string){const row=(await this.db.query(`${batchSelect} WHERE b.id=$1`,[id]))[0];if(!row)throw new HttpError(404,'深度整理任务不存在');return {batch:batchRecord(row),items:(await this.db.query('SELECT i.*,coalesce(d.canonical_title,d.title) AS document_title FROM knowledge_enrichment_items i JOIN documents d ON d.id=i.document_id WHERE i.batch_id=$1 ORDER BY i.created_at,i.id',[id])).map(itemRecord)};}
 async cancelBatch(id:string){await this.getBatch(id);await this.db.transaction(async tx=>{await tx.query("UPDATE knowledge_enrichment_items SET status='cancelled',error='用户取消尚未开始的资料',updated_at=now() WHERE batch_id=$1 AND status='queued'",[id]);await this.finishBatch(tx,id);});return this.getBatch(id);}
 private async finishBatch(tx:Connection,id:string){const rows=await tx.query('SELECT status,count(*)::int AS count FROM knowledge_enrichment_items WHERE batch_id=$1 GROUP BY status',[id]);const counts=Object.fromEntries(rows.map(row=>[row.status,row.count]));let status:string;if(counts.running)status='running';else if(counts.queued)status='queued';else if(counts.failed||counts.stale)status=counts.completed?'partially_failed':'failed';else if(counts.cancelled)status=counts.completed?'partially_failed':'cancelled';else status='completed';await tx.query('UPDATE knowledge_enrichment_batches SET status=$2,updated_at=now() WHERE id=$1',[id,status]);}
 async drain(){
  while(!this.stopping){
   const item=await this.db.transaction(async tx=>{const row=(await tx.query("SELECT i.* FROM knowledge_enrichment_items i JOIN knowledge_enrichment_batches b ON b.id=i.batch_id WHERE i.status='queued' AND b.status IN ('queued','running') ORDER BY i.created_at,i.id LIMIT 1 FOR UPDATE OF i SKIP LOCKED"))[0];if(row){await tx.query("UPDATE knowledge_enrichment_items SET status='running',updated_at=now() WHERE id=$1",[row.id]);await tx.query("UPDATE knowledge_enrichment_batches SET status='running',updated_at=now() WHERE id=$1",[row.batch_id]);}return row;});
   if(!item)break;
   try {await this.process(item);}catch(error){await this.db.query("UPDATE knowledge_enrichment_items SET status='failed',error=$2,updated_at=now() WHERE id=$1",[item.id,this.knowledge.settings.redact(error instanceof Error?error.message:'深度整理失败')]);}
   await this.db.transaction(tx=>this.finishBatch(tx,item.batch_id));
  }
 }
 private async process(item:any){
  const doc=await getDocument(this.db,item.document_id);if(!doc||doc.activeVersionId!==item.version_id||!['active','needs_review'].includes(doc.status)||doc.canonicalDocumentId)throw new Error('资料版本或状态已改变，请重新整理当前版本');
  const row=(await this.db.query('SELECT parsed_document FROM document_versions WHERE id=$1',[item.version_id]))[0],parsed=row?.parsed_document as ParsedDocument;
  if(!parsed?.plainText)throw new Error('资料没有可整理的原始正文');
  const sections=extractSections(parsed,doc.title);if(!sections.length)throw new Error('资料没有可识别的章节正文');
  const aliases=await this.db.query<TagAlias>('SELECT dimension,alias,canonical FROM knowledge_tag_aliases'),config=await this.config(),base=this.providerFactory(config);
  const provider:LLMProvider={generate:async request=>{
   const cacheKey=enrichmentCacheKey(item.version_id,config,request);
   try{
    const cached=JSON.parse(Buffer.from(await this.knowledge.storage.get(cacheKey)).toString('utf8'));
    if(cached.versionId===item.version_id&&cached.documentId===item.document_id&&typeof cached.response?.content==='string'){
     parseEnrichmentResponse(cached.response.content,JSON.parse(request.prompt).sections,aliases);
     // Usage belongs to the original paid request. A cache hit must not bill it again.
     return {content:cached.response.content};
    }
   }catch{/* Missing or still-invalid cache: this explicitly requested item may make one fresh model call. */}
   const reserve=3*estimatedModelCost(config.model,Buffer.byteLength(request.system+request.prompt,'utf8')+1024,config.maxTokens);
   await this.db.transaction(async tx=>{const batch=(await tx.query('SELECT * FROM knowledge_enrichment_batches WHERE id=$1 FOR UPDATE',[item.batch_id]))[0];if(batch.budget_cny!==null&&Number(batch.reserved_cny)+reserve>Number(batch.budget_cny))throw new Error('本批可选预算不足以覆盖下一次请求，尚未发送；可取消预算限制后重新整理剩余资料');await tx.query('UPDATE knowledge_enrichment_batches SET reserved_cny=reserved_cny+$2,updated_at=now() WHERE id=$1',[item.batch_id,reserve]);await tx.query('UPDATE knowledge_enrichment_items SET reserved_cny=reserved_cny+$2 WHERE id=$1',[item.id,reserve]);});
   const response=await base.generate(request);
   if(response.usage){const {inputTokens,outputTokens}=response.usage,cost=estimatedModelCost(config.model,inputTokens,outputTokens);await this.db.transaction(async tx=>{await tx.query('UPDATE knowledge_enrichment_batches SET input_tokens=input_tokens+$2,output_tokens=output_tokens+$3,estimated_cost_cny=estimated_cost_cny+$4,reserved_cny=reserved_cny-$5+$4,updated_at=now() WHERE id=$1',[item.batch_id,inputTokens,outputTokens,cost,reserve]);await tx.query('UPDATE knowledge_enrichment_items SET input_tokens=input_tokens+$2,output_tokens=output_tokens+$3,estimated_cost_cny=estimated_cost_cny+$4,reserved_cny=reserved_cny-$5+$4 WHERE id=$1',[item.id,inputTokens,outputTokens,cost,reserve]);});}
   // Keep the exact private response even when downstream schema validation fails.
   // Its key contains the immutable source version and full request/config hash, never the API key.
   const payload=Buffer.from(json({documentId:item.document_id,versionId:item.version_id,model:config.model,createdAt:new Date().toISOString(),response}));
   // Preserve every billed response before replacing the request lookup. Invalid
   // old responses must not prevent a later explicit retry from becoming reusable.
   const historyKey=cacheKey.replace(/\.json$/,`/${createHash('sha256').update(payload).digest('hex')}.json`);
   await this.knowledge.storage.put(historyKey,payload);
   if(this.knowledge.storage.replaceCache)await this.knowledge.storage.replaceCache(cacheKey,payload);else await this.knowledge.storage.put(cacheKey,payload);
   return response;
  }};
  const result=await enrichSections(provider,{title:doc.title,sections,aliases});
  await this.db.transaction(async tx=>{
   const current=(await tx.query('SELECT active_version_id,status,canonical_document_id FROM documents WHERE id=$1 FOR UPDATE',[doc.id]))[0];
   if(!current||current.active_version_id!==item.version_id||!['active','needs_review'].includes(current.status)||current.canonical_document_id)throw new Error('整理期间资料版本或状态已改变，结果未应用');
   await tx.query("INSERT INTO document_enrichments(document_id,version_id,tags,model) VALUES($1,$2,$3::jsonb,$4) ON CONFLICT(document_id) DO UPDATE SET version_id=excluded.version_id,tags=excluded.tags,model=excluded.model,updated_at=now()",[doc.id,item.version_id,json(result.documentTags),config.model]);
   for(const dimension of ['applications','project_stage'] as const)for(const tag of result.documentTags[dimension]??[])if(tag.confidence>=.8)await tx.query('INSERT INTO knowledge_tag_registry(dimension,value,label) VALUES($1,$2,$2) ON CONFLICT DO NOTHING',[dimension,tag.value]);
   const old=await tx.query('SELECT id,section_order FROM knowledge_sections WHERE version_id=$1',[item.version_id]),byOrder=new Map(old.map(section=>[section.section_order,section.id]));
   for(const draft of sections){const enriched=result.sections.find(section=>section.order===draft.order)!;const id=byOrder.get(draft.order)??randomUUID();
    await tx.query("INSERT INTO knowledge_tag_registry(dimension,value,label) VALUES('section_role',$1,$1) ON CONFLICT DO NOTHING",[enriched.sectionRole]);
    await tx.query(`INSERT INTO knowledge_sections(id,document_id,version_id,section_order,title,heading_path,level,text,summary,section_role,tags,reusable,blueprint,search_vector)
     VALUES($1,$2,$3,$4,$5,$6::jsonb,$7,$8,$9,$10,$11::jsonb,$12,$13::jsonb,to_tsvector('simple',$14))
     ON CONFLICT(version_id,section_order) DO UPDATE SET title=excluded.title,heading_path=excluded.heading_path,level=excluded.level,text=excluded.text,summary=excluded.summary,section_role=excluded.section_role,tags=excluded.tags,reusable=excluded.reusable,blueprint=excluded.blueprint,search_vector=excluded.search_vector,updated_at=now()`,[id,doc.id,item.version_id,draft.order,draft.title,json(draft.headingPath),draft.level,draft.text,enriched.summary,enriched.sectionRole,json(enriched.tags),enriched.reusable,json(enriched.blueprint),indexText(`${doc.title}\n${draft.headingPath.join(' ')}\n${draft.text}\n${enriched.summary}`)]);
   }
   await tx.query('DELETE FROM knowledge_sections WHERE version_id=$1 AND section_order>=$2',[item.version_id,sections.length]);
   for(const proposal of result.aliases??[]){const canonical=normalizeTag(proposal.dimension,proposal.canonical,aliases);const candidates=[...new Set(proposal.aliases.map(alias=>alias.trim()).filter(alias=>alias&&normalizeTag(proposal.dimension,alias,aliases)!==canonical))];if(!candidates.length)continue;const exists=await tx.query("SELECT id FROM knowledge_alias_suggestions WHERE dimension=$1 AND canonical=$2 AND aliases=$3::jsonb AND status IN ('pending','accepted')",[proposal.dimension,canonical,json(candidates)]);if(!exists.length)await tx.query('INSERT INTO knowledge_alias_suggestions(id,dimension,canonical,aliases,confidence,reason) VALUES($1,$2,$3,$4::jsonb,$5,$6)',[randomUUID(),proposal.dimension,canonical,json(candidates),proposal.confidence,proposal.reason]);}
   await tx.query("UPDATE knowledge_enrichment_items SET status='completed',section_count=$2,error=$3,updated_at=now() WHERE id=$1",[item.id,sections.length,result.warnings?.length?result.warnings.join('；').slice(0,2000):null]);
  });
 }
 async listSections(documentId:string){const doc=await getDocument(this.db,documentId);if(!doc)throw new HttpError(404,'资料不存在');const enrichment=(await this.db.query('SELECT * FROM document_enrichments WHERE document_id=$1 AND version_id=$2',[documentId,doc.activeVersionId]))[0];return {documentId,title:doc.title,versionId:doc.activeVersionId,quality:(enrichment?.quality??'normal') as ReferenceQuality,tags:(enrichment?.tags??{}) as SoftTags,enrichedAt:enrichment?.model?date(enrichment.updated_at):null,sections:(await this.db.query('SELECT s.*,$2::text AS authority FROM knowledge_sections s WHERE document_id=$1 AND version_id=$3 ORDER BY section_order',[documentId,doc.classification?.authority.value??'unknown',doc.activeVersionId])).map(sectionRecord)};}
 async setDocumentQuality(documentId:string,value:unknown){const document=await getDocument(this.db,documentId);if(!document)throw new HttpError(404,'资料不存在');await this.db.query("INSERT INTO document_enrichments(document_id,version_id,quality) VALUES($1,$2,$3) ON CONFLICT(document_id) DO UPDATE SET quality=excluded.quality,tags=CASE WHEN document_enrichments.version_id=excluded.version_id THEN document_enrichments.tags ELSE '{}'::jsonb END,model=CASE WHEN document_enrichments.version_id=excluded.version_id THEN document_enrichments.model ELSE '' END,version_id=excluded.version_id,updated_at=now()",[documentId,document.activeVersionId,quality(value)]);return this.listSections(documentId);}
 async setSectionQuality(sectionId:string,value:unknown){const rows=await this.db.query("UPDATE knowledge_sections s SET quality=$2,updated_at=now() FROM documents d WHERE s.id=$1 AND d.id=s.document_id AND d.active_version_id=s.version_id AND d.scope='global' AND d.organization_id='default' AND d.workspace_id='default' RETURNING s.document_id",[sectionId,quality(value)]);if(!rows.length)throw new HttpError(404,'当前资料章节不存在');return this.listSections(rows[0].document_id);}
 async listAliases(){return (await this.db.query('SELECT * FROM knowledge_alias_suggestions ORDER BY created_at DESC LIMIT 200')).map(row=>({id:row.id,dimension:row.dimension,canonical:row.canonical,aliases:row.aliases,confidence:row.confidence,reason:row.reason,status:row.status})) as AliasSuggestion[];}
 async decideAlias(id:string,accept:boolean,dimension?:TagDimension){await this.db.transaction(async tx=>{const proposal=(await tx.query("SELECT * FROM knowledge_alias_suggestions WHERE id=$1 AND status='pending' FOR UPDATE",[id]))[0];if(!proposal)throw new HttpError(409,'标签建议不存在或已处理');if(accept){
   const selected=dimension??proposal.dimension;if(!tagDimensions.includes(selected))throw new HttpError(400,'请为这个同义标签建议选择归并维度');
   const known=await tx.query<TagAlias>('SELECT dimension,alias,canonical FROM knowledge_tag_aliases'),canonical=normalizeTag(selected,proposal.canonical,known);
   for(const alias of proposal.aliases){const existing=known.find(item=>item.dimension===selected&&item.alias===alias);if(existing&&existing.canonical!==canonical)throw new HttpError(409,'这个标签已有其他归并结果，请先检查现有标签');if(normalizeTag(selected,alias,known)===canonical)continue;await tx.query('INSERT INTO knowledge_tag_aliases(dimension,alias,canonical) VALUES($1,$2,$3) ON CONFLICT(dimension,alias) DO NOTHING',[selected,alias,canonical]);}
   await tx.query('INSERT INTO knowledge_tag_registry(dimension,value,label) VALUES($1,$2,$2) ON CONFLICT DO NOTHING',[selected,canonical]);
   await tx.query('UPDATE knowledge_alias_suggestions SET dimension=$2,canonical=$3 WHERE id=$1',[id,selected,canonical]);
  }await tx.query('UPDATE knowledge_alias_suggestions SET status=$2,updated_at=now() WHERE id=$1',[id,accept?'accepted':'rejected']);});return this.listAliases();}
 async registry(){return {items:await this.db.query('SELECT dimension,value,label FROM knowledge_tag_registry ORDER BY dimension,label'),aliases:await this.db.query('SELECT dimension,alias,canonical FROM knowledge_tag_aliases')};}
}
