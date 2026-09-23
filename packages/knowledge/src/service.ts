import { randomUUID } from 'node:crypto';
import type { Classification, ParsedDocument, SourceFile, ChunkDraft, ObjectStorage, LLMConfig, LLMProvider } from '../../core/src/types.js';
import type { Connection, Database } from './database.js';
import { SettingsStore } from './settings.js';
import { getDocument, getClassification, getRegistries, saveClassification, scoped } from './repository.js';
import { indexText } from './search.js';
import { retrieveConfirmedExamples } from './examples.js';
import { parseDocument } from '../../parsers/src/index.js';
import { classifyDocument, reviewReasons } from '../../classification/src/index.js';
import { chunkDocument } from '../../ingestion/src/chunking.js';
import { filenameTitle } from './titles.js';
import { CorpusContextBuilder, compactClassificationContext } from '../../refinement/src/context.js';
import { normalizedContentHash } from '../../deduplication/src/detector.js';
import { saveSourceReference, retireSourceReferences } from '../../deduplication/src/references.js';

export class HttpError extends Error { constructor(public statusCode:number,message:string) {super(message);} }
export class KnowledgeService {
 readonly settings: SettingsStore;
 private timer?: ReturnType<typeof setInterval>;
 private current?: Promise<void>;
 private stopping = false;
 onDocumentIndexed?: (documentId:string)=>Promise<unknown>;
 constructor(readonly db:Database,dataDir:string,readonly storage:ObjectStorage,private providerFactory:(config:LLMConfig)=>LLMProvider,llmDisabled=false) {this.settings=new SettingsStore(db,dataDir,llmDisabled);}
 async start() {
  await this.settings.init();
  await this.db.query("UPDATE ingestion_jobs SET status='queued',error=NULL,updated_at=now() WHERE status='running'");
  this.timer=setInterval(()=>this.wake(),750);this.timer.unref(); this.wake();
 }
 wake() {
  if(this.stopping || this.current) return;
  // Jobs are claimed atomically. Two workers overlap remote classification without
  // opening another embedded database or duplicating a model request for a job.
  this.current=Promise.allSettled([this.drain(),this.drain()]).then(()=>{/* job failures are persisted per document */}).finally(()=>{this.current=undefined;});
 }
 async close() {this.stopping=true;clearInterval(this.timer);await this.current;await this.db.close();}
 async upload(file:SourceFile,options:{duplicate:'skip'|'keep';sourceId?:string;documentId?:string;sourceDocumentId?:string}) {
  const sourceId=options.sourceId || 'manual';
  const key=`originals/${file.contentHash.slice(0,2)}/${file.contentHash}`;
  // Originals are written before committing metadata; a committed job always has bytes.
  await this.storage.put(key,file.buffer);
  const result=await this.db.transaction(async tx=>{
   const source=await tx.query("SELECT id FROM knowledge_sources WHERE id=$1 AND organization_id='default' AND workspace_id='default'",[sourceId]);
   if(!source[0]) throw new HttpError(400,'未知知识来源');
   const origin=options.sourceDocumentId||file.meta.sourcePath||file.meta.filename;
   let doc: any;
   // Source identity survives a crash between document ingestion and the connector's resource-map write.
   // Manual "keep another copy" uploads do not provide sourceDocumentId and retain their existing behavior.
   if(options.sourceDocumentId){
    // Look up the current origin before the connector's cached canonical document.
    // An exact match may have linked this resource to a different source's document.
    doc=(await tx.query(`SELECT d.*,r.source_path AS identity_source_path,r.source_url AS identity_source_uri,
     r.content_hash AS identity_content_hash,r.filename AS identity_filename,r.source_metadata AS identity_metadata
     FROM document_source_references r JOIN documents d ON d.id=r.document_id
     WHERE ${scoped} AND r.source_id=$1 AND r.source_document_id=$2 AND r.removed=false
     ORDER BY r.discovered_at DESC,r.id LIMIT 1`,[sourceId,origin]))[0];
    if(!doc)
    doc=(await tx.query(`SELECT d.*,sd.source_path AS identity_source_path,sd.source_uri AS identity_source_uri,
     v.content_hash AS identity_content_hash,v.filename AS identity_filename,v.source_metadata AS identity_metadata
     FROM documents d JOIN source_documents sd ON sd.id=d.source_document_id LEFT JOIN document_versions v ON v.id=d.active_version_id
     WHERE ${scoped} AND sd.source_id=$1 AND sd.source_document_id=$2 ORDER BY d.updated_at DESC,d.id LIMIT 1`,[sourceId,options.sourceDocumentId]))[0];
    const fingerprint=file.meta.metadata?.contentFingerprint;
    const sameContent=doc&&(doc.identity_content_hash===file.contentHash||typeof fingerprint==='string'&&fingerprint.length>0&&doc.identity_metadata?.contentFingerprint===fingerprint);
    const sameLocation=doc&&doc.identity_filename===file.meta.filename&&(doc.identity_source_path??null)===(file.meta.sourcePath||null)&&(doc.identity_source_uri??null)===(file.meta.sourceUri||null);
    if(sameContent&&sameLocation&&doc.status!=='failed'&&doc.status!=='archived'){
     await saveSourceReference(tx,doc.id,sourceId,origin,file,key);
     await tx.query('UPDATE source_documents SET remote_version=$1,modified_at=$2,removed_from_source=false WHERE id=$3 AND source_id=$4 AND source_document_id=$5',[file.meta.version||null,file.meta.modifiedAt||null,doc.source_document_id,sourceId,origin]);
     return {filename:file.meta.filename,status:'duplicate' as const,documentId:doc.id,message:'来源内容已入库，已复用当前版本和处理任务'};
    }
   }
   if(options.documentId&&!doc) {
    const found=await tx.query(`SELECT d.* FROM documents d WHERE ${scoped} AND d.id=$1`,[options.documentId]);
    if(!found[0]) throw new HttpError(404,'资料不存在'); doc=found[0];
   } else if(!doc&&file.meta.sourcePath && options.duplicate!=='keep') {
    const found=await tx.query(`SELECT d.* FROM documents d JOIN source_documents sd ON sd.id=d.source_document_id WHERE ${scoped} AND sd.source_id=$1 AND sd.source_document_id=$2 ORDER BY d.created_at DESC LIMIT 1`,[sourceId,file.meta.sourcePath]);
    doc=found[0];
   }
   if(doc&&options.sourceDocumentId&&!['archived','failed'].includes(doc.status)){
    const current=await tx.query('SELECT content_hash FROM document_versions WHERE id=$1',[doc.active_version_id]);
    const primary=await tx.query('SELECT source_id,source_document_id FROM source_documents WHERE id=$1',[doc.source_document_id]);
    if(current[0]?.content_hash===file.contentHash&&(primary[0]?.source_id!==sourceId||primary[0]?.source_document_id!==origin)){
     await saveSourceReference(tx,doc.id,sourceId,origin,file,key);
     return {filename:file.meta.filename,status:'duplicate' as const,documentId:doc.id,message:'完全相同的来源已恢复，已复用已有资料'};
    }
   }
   if(doc&&options.duplicate!=='keep'&&!options.documentId&&!options.sourceDocumentId&&!['archived','failed','superseded'].includes(doc.status)){
    const current=await tx.query('SELECT content_hash FROM document_versions WHERE id=$1',[doc.active_version_id]);
    if(current[0]?.content_hash===file.contentHash){await saveSourceReference(tx,doc.id,sourceId,origin,file,key);return {filename:file.meta.filename,status:'duplicate' as const,documentId:doc.id,message:'完全相同的内容已存在，已保留此来源'};}
   }
   // Only current, visible copies are eligible. A match in archived history must
   // never silently point an incoming file at different current content.
   if((options.duplicate!=='keep'||options.sourceDocumentId)&&!(!options.sourceDocumentId&&options.documentId)) {
    const existing=await tx.query(`SELECT coalesce(d.canonical_document_id,d.id) AS id FROM document_versions v JOIN documents d ON d.id=v.document_id
     JOIN documents canonical ON canonical.id=coalesce(d.canonical_document_id,d.id)
     WHERE ${scoped} AND v.id=d.active_version_id AND v.content_hash=$1
     AND d.status NOT IN ('archived','failed','superseded') AND canonical.status NOT IN ('archived','failed','superseded')
     AND canonical.organization_id='default' AND canonical.workspace_id='default' AND canonical.scope='global'
     AND (d.canonical_document_id IS NULL OR EXISTS(SELECT 1 FROM document_duplicate_groups g
      JOIN document_duplicate_members m ON m.group_id=g.id WHERE g.status='confirmed' AND g.operation='merge'
       AND g.canonical_document_id=canonical.id AND m.document_id=d.id
       AND NOT EXISTS(SELECT 1 FROM document_duplicate_members stale JOIN documents current ON current.id=stale.document_id
        WHERE stale.group_id=g.id AND stale.version_id<>current.active_version_id)))
     AND ($2::text IS NULL OR d.id<>$2) ORDER BY d.created_at,d.id LIMIT 1`,[file.contentHash,doc?.id??null]);
    if(existing[0]) {
     if(options.sourceDocumentId)await retireSourceReferences(tx,sourceId,origin);
     await saveSourceReference(tx,existing[0].id,sourceId,origin,file,key);
     if(doc&&options.sourceDocumentId)await tx.query(`UPDATE documents SET status='superseded',updated_at=now() WHERE id=$1
      AND canonical_document_id IS NULL AND NOT EXISTS(SELECT 1 FROM document_source_references r JOIN documents rd ON rd.id=r.document_id
       WHERE (rd.id=$1 OR rd.canonical_document_id=$1) AND r.removed=false)`,[doc.id]);
     await tx.query("INSERT INTO audit_events(id,document_id,version_id,action,next_value) SELECT $1,id,active_version_id,'source_linked',$3::jsonb FROM documents WHERE id=$2",[randomUUID(),existing[0].id,JSON.stringify({sourceId,sourceDocumentId:origin,filename:file.meta.filename,contentHash:file.contentHash})]);
     return {filename:file.meta.filename,status:'duplicate' as const,documentId:existing[0].id,message:'完全相同的内容已存在，已关联此来源，未重复解析或调用模型'};
    }
   }
   if(doc&&options.sourceDocumentId){
    const others=await tx.query(`SELECT 1 FROM document_source_references r JOIN documents rd ON rd.id=r.document_id
     WHERE (rd.id=$1 OR rd.canonical_document_id=$1) AND r.removed=false
     AND NOT(r.source_id=$2 AND r.source_document_id=$3) LIMIT 1`,[doc.id,sourceId,origin]);
    // A remote edit changes one origin, not all copies that happened to match it.
    if(others.length||doc.canonical_document_id||doc.status==='superseded'){await retireSourceReferences(tx,sourceId,origin);doc=undefined;}
   }
   if(doc?.canonical_document_id&&!options.sourceDocumentId)throw new HttpError(409,'此资料已合并，请先撤销合并再更新版本');
   if(doc?.status==='superseded'&&!options.sourceDocumentId)throw new HttpError(409,'此资料已确认为历史版本，请先撤销版本关系再更新');
   const documentId=doc?.id || randomUUID(); const versionId=randomUUID();
   if(!doc) {
    const sourceDocumentId=randomUUID();
    await tx.query('INSERT INTO source_documents(id,source_id,source_document_id,source_path,source_uri,remote_version,content_hash,modified_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8)',[sourceDocumentId,sourceId,options.sourceDocumentId||file.meta.sourcePath||file.meta.filename,file.meta.sourcePath||null,file.meta.sourceUri||null,file.meta.version||null,file.contentHash,file.meta.modifiedAt||null]);
    await tx.query("INSERT INTO documents(id,organization_id,workspace_id,source_document_id,title,canonical_title,title_source,status) VALUES($1,'default','default',$2,$3,$3,'filename','uploaded')",[documentId,sourceDocumentId,filenameTitle(file.meta.filename)]);
   } else {
    await tx.query("UPDATE document_versions SET status='superseded' WHERE document_id=$1 AND status='active'",[documentId]);
    // Confirmations describe a particular version. A changed source must be judged
    // again; the previous classification and examples remain available in history.
    await tx.query("UPDATE documents SET user_overrides='{}'::jsonb WHERE id=$1",[documentId]);
    await tx.query("UPDATE refinement_proposals SET status='stale' WHERE document_id=$1 AND status='pending'",[documentId]);
    if(!doc.title_user)await tx.query("UPDATE documents SET title=$1,canonical_title=$1,title_source='filename',title_confidence=NULL,title_reasoning=NULL WHERE id=$2",[filenameTitle(file.meta.filename),documentId]);
    await tx.query('UPDATE source_documents SET content_hash=$1,remote_version=$2,modified_at=$3,source_path=$4,source_uri=$5,removed_from_source=false WHERE id=$6',[file.contentHash,file.meta.version||null,file.meta.modifiedAt||null,file.meta.sourcePath||null,file.meta.sourceUri||null,doc.source_document_id]);
   }
   const count=await tx.query('SELECT coalesce(max(version_number),0)::int+1 AS number FROM document_versions WHERE document_id=$1',[documentId]);
   await tx.query('INSERT INTO document_versions(id,document_id,version_number,filename,mime_type,content_hash,object_key,size_bytes,source_metadata) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb)',[versionId,documentId,count[0].number,file.meta.filename,file.meta.mimeType||null,file.contentHash,key,file.buffer.length,JSON.stringify(file.meta.metadata||{})]);
   if(options.sourceDocumentId)await retireSourceReferences(tx,sourceId,origin);
   await saveSourceReference(tx,documentId,sourceId,origin,file,key);
   await tx.query("UPDATE documents SET active_version_id=$1,status='uploaded',updated_at=now() WHERE id=$2",[versionId,documentId]);
   await tx.query('INSERT INTO ingestion_jobs(id,document_id,version_id) VALUES($1,$2,$3)',[randomUUID(),documentId,versionId]);
   await tx.query("INSERT INTO audit_events(id,document_id,version_id,action,next_value) VALUES($1,$2,$3,'upload',$4::jsonb)",[randomUUID(),documentId,versionId,JSON.stringify({filename:file.meta.filename,contentHash:file.contentHash,versionNumber:count[0].number})]);
   return {filename:file.meta.filename,status:'queued' as const,documentId};
  });
  this.wake();return result;
 }
 private async drain() {
  while(!this.stopping) {
   const rows=await this.db.transaction(async tx=>{
    const found=await tx.query("SELECT * FROM ingestion_jobs WHERE status='queued' ORDER BY created_at,id LIMIT 1 FOR UPDATE SKIP LOCKED");
    if(found[0]) await tx.query("UPDATE ingestion_jobs SET status='running',attempts=attempts+1,updated_at=now() WHERE id=$1",[found[0].id]);
    return found;
   });
   if(!rows[0]) break;
   try {await this.process(rows[0]); await this.db.query("UPDATE ingestion_jobs SET status='completed',updated_at=now(),error=NULL WHERE id=$1",[rows[0].id]);}
   catch(error) {
    const message=this.settings.redact(error instanceof Error ? error.message : '处理失败');
    await this.db.transaction(async tx=>{
     await tx.query("UPDATE ingestion_jobs SET status='failed',error=$1,updated_at=now() WHERE id=$2",[message,rows[0].id]);
     await tx.query('UPDATE document_versions SET error=$1 WHERE id=$2',[message,rows[0].version_id]);
     await tx.query("UPDATE documents SET status='failed',updated_at=now() WHERE id=$1 AND active_version_id=$2 AND status NOT IN ('archived','superseded')",[rows[0].document_id,rows[0].version_id]);
    });
   }
  }
 }
 private async state(documentId:string,versionId:string,status:string) {
  await this.db.query("UPDATE documents SET status=$1,updated_at=now() WHERE id=$2 AND active_version_id=$3 AND status NOT IN ('archived','superseded')",[status,documentId,versionId]);
 }
 private async process(job:any) {
  const rows=await this.db.query(`SELECT v.*,d.active_version_id,d.status AS document_status,sd.source_path,sd.source_id,s.type AS source_type FROM document_versions v JOIN documents d ON d.id=v.document_id JOIN source_documents sd ON sd.id=d.source_document_id JOIN knowledge_sources s ON s.id=sd.source_id WHERE ${scoped} AND v.id=$1`,[job.version_id]);
  const version=rows[0];if(!version) throw new Error('原始版本不存在');
  if(version.active_version_id!==job.version_id || ['archived','superseded'].includes(version.document_status))return;
  const file:SourceFile={buffer:await this.storage.get(version.object_key),contentHash:version.content_hash,meta:{sourceId:version.source_id,sourceType:version.source_type,filename:version.filename,mimeType:version.mime_type,sourcePath:version.source_path}};
  await this.state(job.document_id,job.version_id,'parsing');
  const parsed=await parseDocument(file);
  await this.db.query('UPDATE document_versions SET parsed_document=$1::jsonb,parse_status=$2,parse_warnings=$3::jsonb,error=NULL,parsed_title=$5,normalized_content_hash=$6 WHERE id=$4',[JSON.stringify(parsed),parsed.parseStatus,JSON.stringify(parsed.parseWarnings),job.version_id,parsed.title||null,normalizedContentHash(parsed)]);
  if(parsed.parseStatus==='failed' || !parsed.plainText.trim()) throw new Error(parsed.parseWarnings.join('；') || '无法提取文本；原文件已保留，请检查格式或使用 OCR 后重试');
  await this.state(job.document_id,job.version_id,'parsed');
  await this.state(job.document_id,job.version_id,'classifying');
  const examples=await retrieveConfirmedExamples(this.db,parsed.plainText.slice(0,12000),job.document_id);
  const config=await this.settings.config();
  const currentDocument=await getDocument(this.db,job.document_id);
  if(!currentDocument||currentDocument.activeVersionId!==job.version_id||['archived','superseded'].includes(currentDocument.status))return;
  const corpus=currentDocument?await new CorpusContextBuilder(this.db).build(currentDocument,parsed):undefined;
  const output=await classifyDocument(file.meta,parsed,await getRegistries(this.db),examples,config ? this.providerFactory(config) : undefined,{corpusContext:corpus?compactClassificationContext(corpus):undefined});
  const usage=(output as typeof output & {usage?:{inputTokens:number;outputTokens:number}}).usage;
  if(usage) {parsed.metadata.llmUsage=usage;await this.db.query('UPDATE document_versions SET parsed_document=$1::jsonb WHERE id=$2',[JSON.stringify(parsed),job.version_id]);}
  const settings=await this.settings.get();
  await this.state(job.document_id,job.version_id,'indexing');
  await this.db.transaction(async tx=>{
   const docs=await tx.query('SELECT user_overrides,title_user,canonical_title,active_version_id,status FROM documents WHERE id=$1',[job.document_id]);
   if(docs[0].active_version_id!==job.version_id||['archived','superseded'].includes(docs[0].status)) return;
   const classification={...output.classification,...docs[0].user_overrides} as Classification;
   const reasons=reviewReasons(classification,settings.reviewThreshold);
   const warnings=[...parsed.parseWarnings,...output.warnings];
   const low=Object.entries(classification).filter(([,v])=>v && v.confidence<settings.autoAcceptThreshold).map(([key])=>key);
   if(low.length) warnings.push(`低于自动接受阈值的字段：${low.join('、')}`);
   await saveClassification(tx,job.version_id,classification);
   await tx.query("UPDATE document_versions SET summary=CASE WHEN summary_source IN ('user','ai') AND ai_summary IS NOT NULL THEN ai_summary ELSE $1 END,extractive_summary=$1,review_reasons=$2::jsonb,parse_warnings=$3::jsonb WHERE id=$4",[output.summary,JSON.stringify(reasons),JSON.stringify(warnings),job.version_id]);
   const chunks=chunkDocument(parsed,classification,{targetTokens:settings.chunkTargetTokens,overlapTokens:settings.chunkOverlapTokens});
   const summaryRows=await tx.query('SELECT coalesce(ai_summary,extractive_summary) AS summary FROM document_versions WHERE id=$1',[job.version_id]);
   await this.writeChunks(tx,job.document_id,job.version_id,chunks,classification,`${docs[0].canonical_title} ${summaryRows[0].summary}`);
   if(docs[0].status!=='archived') await tx.query('UPDATE documents SET status=$1,updated_at=now() WHERE id=$2',[reasons.length?'needs_review':'active',job.document_id]);
  });
  // Suggestions cannot make a successful ingestion fail. A full scan can retry.
  if(this.onDocumentIndexed)await this.onDocumentIndexed(job.document_id).catch(()=>{});
 }
 private async writeChunks(tx:Connection,documentId:string,versionId:string,chunks:ChunkDraft[],classification:Classification,title:string) {
  await tx.query('DELETE FROM knowledge_chunks WHERE version_id=$1',[versionId]);
  const registries=await getRegistries(tx);
  const labels=[...registries.documentTypes,...registries.applications,...registries.topics];
  const values=[classification.documentType.value,...classification.applications.value,...classification.topics.value,...classification.products.value];
  const tags=values.map(v=>{const item=labels.find(i=>i.key===v);return item ? `${v} ${item.label} ${item.aliases.join(' ')}` : v;}).join(' ');
  for(const chunk of chunks) await tx.query("INSERT INTO knowledge_chunks(id,document_id,version_id,chunk_order,heading_path,text,summary,topics,products,metadata,search_vector) VALUES($1,$2,$3,$4,$5::jsonb,$6,$7,$8::jsonb,$9::jsonb,$10::jsonb,to_tsvector('simple',$11))",[randomUUID(),documentId,versionId,chunk.order,JSON.stringify(chunk.headingPath),chunk.text,chunk.summary,JSON.stringify(chunk.topics),JSON.stringify(chunk.products),JSON.stringify(chunk.metadata),indexText(`${title} ${tags} ${chunk.headingPath.join(' ')} ${chunk.text}`)]);
 }
 async reindexMetadata(tx:Connection,documentId:string,settings:{chunkTargetTokens:number;chunkOverlapTokens:number}={chunkTargetTokens:800,chunkOverlapTokens:100}) {
  const doc=await getDocument(tx,documentId);if(!doc?.classification)return;
  const rows=await tx.query('SELECT parsed_document FROM document_versions WHERE id=$1',[doc.activeVersionId]);
  const parsed=rows[0]?.parsed_document as ParsedDocument|undefined;if(!parsed?.plainText)return;
  await this.writeChunks(tx,doc.id,doc.activeVersionId,chunkDocument(parsed,doc.classification,{targetTokens:settings.chunkTargetTokens,overlapTokens:settings.chunkOverlapTokens}),doc.classification,`${doc.title} ${doc.summary}`);
 }
 async edit(id:string,input:Record<string,unknown>) {
  const allowed=['title','documentType','authority','applications','topics','products'];
  if(!Object.keys(input).some(k=>allowed.includes(k))) throw new HttpError(400,'请提供需要修改的字段');
  const settings=await this.settings.get();
  await this.db.transaction(async tx=>{
   const document=await getDocument(tx,id);if(!document) throw new HttpError(404,'资料不存在');
   if(!['active','needs_review','failed','archived'].includes(document.status)) throw new HttpError(409,'资料正在处理中，请稍后修改');
   if(!document.classification) throw new HttpError(409,'请先完成解析，再修改分类');
   const classification=structuredClone(document.classification); const changes:Record<string,unknown>={};
   const registry=await getRegistries(tx);
   for(const field of ['documentType','authority','applications','topics','products'] as const) if(input[field]!==undefined) {
    let value=input[field];
    if(field==='documentType' && (typeof value!=='string' || !registry.documentTypes.some(v=>v.key===value))) throw new HttpError(400,'文档类型不存在，请先在设置中创建');
    if(field==='authority' && (typeof value!=='string' || !['authoritative','reference','style_only','unknown'].includes(value))) throw new HttpError(400,'资料权威级别无效');
    if(['applications','topics','products'].includes(field) && (!Array.isArray(value)||value.length>100||value.some(v=>typeof v!=='string'||!v.trim()||v.length>200))) throw new HttpError(400,'标签应为字符串列表');
    if(field==='applications'||field==='topics') {
     const normalized=(v:string)=>v.normalize('NFKC').replace(/[\s_-]/g,'').toLowerCase();
     value=[...new Set((value as string[]).map(v=>{
      const item=registry[field].find(item=>[item.key,item.label,...item.aliases].some(alias=>normalized(alias)===normalized(v)));
      if(!item)throw new HttpError(400,'应用领域或主题尚未注册，请先在设置中创建');return item.key;
     }))];
    } else if(field==='products') value=[...new Set((value as string[]).map(v=>v.trim()))];
    const classified={value,confidence:1,source:'user',reasoning:'用户确认'};
    (classification as any)[field]=classified;changes[field]=classified;
   }
   if(input.title!==undefined) {if(typeof input.title!=='string'||!input.title.trim()||input.title.length>500) throw new HttpError(400,'标题需为 1–500 字');await tx.query("UPDATE documents SET title=$1,canonical_title=$1,title_user=true,title_source='user',title_confidence=1,title_reasoning='用户编辑标题' WHERE id=$2",[input.title.trim(),id]);}
   for(const field of Object.keys(input).filter(k=>allowed.includes(k)))await tx.query("UPDATE refinement_proposals SET status='stale' WHERE document_id=$1 AND field=$2 AND status='pending'",[id,field==='documentType'?'document_type':field]);
   const overrides=await tx.query('SELECT user_overrides FROM documents WHERE id=$1',[id]);
   await tx.query('UPDATE documents SET user_overrides=$1::jsonb,updated_at=now() WHERE id=$2',[JSON.stringify({...overrides[0].user_overrides,...changes}),id]);
   await saveClassification(tx,document.activeVersionId,classification);
   const reasons=reviewReasons(classification,settings.reviewThreshold);
   await tx.query('UPDATE document_versions SET review_reasons=$1::jsonb WHERE id=$2',[JSON.stringify(reasons),document.activeVersionId]);
   const parsedRows=await tx.query('SELECT parsed_document FROM document_versions WHERE id=$1',[document.activeVersionId]);
   const parsed=parsedRows[0].parsed_document as ParsedDocument|null;
   if(parsed?.plainText) await this.writeChunks(tx,id,document.activeVersionId,chunkDocument(parsed,classification,{targetTokens:settings.chunkTargetTokens,overlapTokens:settings.chunkOverlapTokens}),classification,`${String(input.title||document.title)} ${document.summary}`);
   if(document.status!=='archived') await tx.query('UPDATE documents SET status=$1 WHERE id=$2',[reasons.length?'needs_review':'active',id]);
   await tx.query("INSERT INTO audit_events(id,document_id,version_id,action,previous_value,next_value) VALUES($1,$2,$3,'user_edit',$4::jsonb,$5::jsonb)",[randomUUID(),id,document.activeVersionId,JSON.stringify({title:document.title,classification:document.classification}),JSON.stringify({title:input.title||document.title,classification})]);
   if(Object.keys(changes).length) {
    const summary=`${input.title||document.title}\n${document.summary}\n${parsed?.plainText.slice(0,1500)||''}`.slice(0,2200);
    await tx.query("INSERT INTO confirmed_examples(id,organization_id,workspace_id,document_id,version_id,text_summary,confirmed_fields,search_vector) VALUES($1,'default','default',$2,$3,$4,$5::jsonb,to_tsvector('simple',$6))",[randomUUID(),id,document.activeVersionId,summary,JSON.stringify({...overrides[0].user_overrides,...changes}),indexText(summary)]);
   }
  });
  return getDocument(this.db,id);
 }
 async archive(id:string) {
  await this.db.transaction(async tx=>{
   const doc=await getDocument(tx,id);if(!doc)throw new HttpError(404,'资料不存在');
   await tx.query("UPDATE documents SET status='archived',updated_at=now() WHERE id=$1",[id]);
   await tx.query("UPDATE refinement_proposals SET status='stale' WHERE document_id=$1 AND status='pending'",[id]);
   await tx.query("UPDATE document_versions SET status='archived' WHERE id=$1",[doc.activeVersionId]);
   await tx.query("INSERT INTO audit_events(id,document_id,version_id,action,previous_value,next_value) VALUES($1,$2,$3,'archive',$4::jsonb,$5::jsonb)",[randomUUID(),id,doc.activeVersionId,JSON.stringify({status:doc.status}),JSON.stringify({status:'archived'})]);
  });
 }
 /** Removing a connector resource detaches only that origin; another source can
  * keep the canonical knowledge available. All downloaded originals survive. */
 async detachSource(sourceId:string,sourceDocumentId:string,documentId:string) {
  await this.db.transaction(async tx=>{
   const doc=await getDocument(tx,documentId);if(!doc)return;
   const canonicalId=doc.canonicalDocumentId||doc.id;
   await retireSourceReferences(tx,sourceId,sourceDocumentId);
   await tx.query('UPDATE source_documents SET removed_from_source=true WHERE source_id=$1 AND source_document_id=$2',[sourceId,sourceDocumentId]);
   const remaining=await tx.query(`SELECT 1 FROM document_source_references r JOIN documents d ON d.id=r.document_id
    WHERE (d.id=$1 OR d.canonical_document_id=$1) AND r.removed=false LIMIT 1`,[canonicalId]);
   if(!remaining.length){
    await tx.query("UPDATE document_versions SET status='archived' WHERE id IN (SELECT active_version_id FROM documents WHERE id=$1 OR canonical_document_id=$1)",[canonicalId]);
    await tx.query("UPDATE documents SET status='archived',updated_at=now() WHERE id=$1 OR canonical_document_id=$1",[canonicalId]);
    await tx.query("UPDATE refinement_proposals SET status='stale' WHERE document_id IN (SELECT id FROM documents WHERE id=$1 OR canonical_document_id=$1) AND status='pending'",[canonicalId]);
   }
   await tx.query("INSERT INTO audit_events(id,document_id,version_id,action,next_value) VALUES($1,$2,$3,'source_detached',$4::jsonb)",[randomUUID(),documentId,doc.activeVersionId,JSON.stringify({sourceId,sourceDocumentId})]);
  });
 }
 async refreshSource(sourceId:string,sourceDocumentId:string,documentId:string,remoteVersion:string|null,modifiedAt:string|null,sourceUrl:string) {
  await this.db.transaction(async tx=>{
   await tx.query('UPDATE document_source_references SET remote_version=$1,source_url=$2 WHERE source_id=$3 AND source_document_id=$4 AND document_id=$5 AND removed=false',[remoteVersion,sourceUrl,sourceId,sourceDocumentId,documentId]);
   await tx.query('UPDATE source_documents SET remote_version=$1,modified_at=$2,source_uri=$3 WHERE id=(SELECT source_document_id FROM documents WHERE id=$4) AND source_id=$5 AND source_document_id=$6',[remoteVersion,modifiedAt,sourceUrl,documentId,sourceId,sourceDocumentId]);
  });
 }
 async rebuild(id:string) {
  await this.db.transaction(async tx=>{
   const doc=await getDocument(tx,id);if(!doc)throw new HttpError(404,'资料不存在');
   if(['archived','superseded'].includes(doc.status)||doc.canonicalDocumentId)throw new HttpError(409,'已归档、历史或已合并资料不能重建，请先撤销对应关系');
   const jobs=await tx.query("SELECT id FROM ingestion_jobs WHERE version_id=$1 AND status IN ('queued','running')",[doc.activeVersionId]);
   if(jobs.length)throw new HttpError(409,'资料已在处理队列中');
   await tx.query('INSERT INTO ingestion_jobs(id,document_id,version_id) VALUES($1,$2,$3)',[randomUUID(),id,doc.activeVersionId]);
   await tx.query("UPDATE documents SET status='uploaded',updated_at=now() WHERE id=$1",[id]);
   await tx.query("INSERT INTO audit_events(id,document_id,version_id,action) VALUES($1,$2,$3,'rebuild')",[randomUUID(),id,doc.activeVersionId]);
  });this.wake();
 }
}
