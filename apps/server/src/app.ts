import Fastify from 'fastify';
import multipart from '@fastify/multipart';
import fastifyStatic from '@fastify/static';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDatabase, registryTables } from '../../../packages/knowledge/src/database.js';
import { KnowledgeService, HttpError } from '../../../packages/knowledge/src/service.js';
import { LocalObjectStorage } from '../../../packages/knowledge/src/storage.js';
import { getDocument, documentSelect, documentRecord, chunkRecord, getRegistries, filters, scoped } from '../../../packages/knowledge/src/repository.js';
import { queryText } from '../../../packages/knowledge/src/search.js';
import { sourceRegistry, supportedExtensions } from '../../../packages/source-adapters/src/index.js';
import { KimiProvider } from '../../../packages/llm/src/index.js';
import type { Registries, LLMConfig, LLMProvider } from '../../../packages/core/src/types.js';
import { RefinementService } from '../../../packages/refinement/src/service.js';
import { registerRefinementRoutes } from './refinement-routes.js';

const params = (request: any) => request.params as Record<string,string>;
const query = (request: any) => Object.fromEntries(Object.entries(request.query || {}).filter(([,v])=>typeof v==='string')) as Record<string,string>;
const body = (request:any) => {if(!request.body || typeof request.body!=='object' || Array.isArray(request.body)) throw new HttpError(400,'请求内容应为 JSON 对象');return request.body as Record<string,unknown>;};
const pagination=(q:Record<string,string>)=>({page:Math.max(1,Math.min(100000,Number.parseInt(q.page)||1)),pageSize:Math.max(1,Math.min(100,Number.parseInt(q.pageSize)||30))});

export async function createApp(options:{dataDir?:string;databaseUrl?:string;llmDisabled?:boolean;providerFactory?:(config:LLMConfig)=>LLMProvider}={}) {
 const dataDir=path.resolve(options.dataDir || process.env.DATA_DIR || 'data');
 const db=await openDatabase(dataDir,options.databaseUrl ?? process.env.DATABASE_URL);
 const providerFactory=options.providerFactory??((config:LLMConfig)=>new KimiProvider(config));
 const service=new KnowledgeService(db,dataDir,new LocalObjectStorage(path.join(dataDir,'objects')),providerFactory,options.llmDisabled);
 const refinement=new RefinementService(db,service,providerFactory);
 const app=Fastify({logger:false,bodyLimit:2*1024*1024});
 app.decorate('knowledge',service);
 app.decorate('refinement',refinement);
 app.addHook('onClose',async()=>{await refinement.close();await service.close();});
 app.addHook('onRequest',async(request,reply)=>{
  const host=request.hostname.toLowerCase();
  const trusted=new Set(['localhost','127.0.0.1','::1','[::1]',...(process.env.TRUSTED_HOSTS||'').split(',').map(v=>v.trim().toLowerCase()).filter(Boolean)]);
  if(!trusted.has(host)) return reply.code(403).send({message:'未授权的主机名，请配置 TRUSTED_HOSTS'});
  if(!['GET','HEAD','OPTIONS'].includes(request.method)) {
   const origin=request.headers.origin;
   if(origin) {
    let parsed:URL;try{parsed=new URL(origin);}catch{return reply.code(403).send({message:'请求来源无效'});}
    const same=parsed.host.toLowerCase()===request.headers.host?.toLowerCase();
    const dev=['http://127.0.0.1:4311','http://localhost:4311'].includes(parsed.origin);
    if(!same&&!dev) return reply.code(403).send({message:'跨站写入请求已阻止'});
   }
  }
 });
 app.setErrorHandler((error:any,_request,reply)=>{
  const status=Number(error.statusCode)||500;
  reply.code(status>=400&&status<600?status:500).send({message:status<500 ? service.settings.redact(String(error.message||'请求无效')) : '服务器处理失败，请稍后重试'});
 });
 await app.register(multipart,{limits:{files:100,fileSize:80*1024*1024,fields:10,parts:110}});
 app.get('/api/health',async()=>({status:'ok',database:db.kind}));
 app.get('/api/stats',async()=>{
  const rows=await db.query(`SELECT count(*)::int AS total,count(*) FILTER(WHERE status='active')::int AS active,count(*) FILTER(WHERE status='needs_review')::int AS review,count(*) FILTER(WHERE status='failed')::int AS failed,count(*) FILTER(WHERE status IN ('discovered','uploaded','parsing','parsed','classifying','indexing'))::int AS processing FROM documents d WHERE ${scoped}`);
  const counts=await db.query(`SELECT (SELECT count(*)::int FROM knowledge_chunks c JOIN documents d ON d.id=c.document_id WHERE ${scoped} AND d.active_version_id=c.version_id) AS chunks,(SELECT count(*)::int FROM confirmed_examples e JOIN documents d ON d.id=e.document_id WHERE ${scoped}) AS examples`);
  return {total:rows[0].total,active:rows[0].active,needsReview:rows[0].review,failed:rows[0].failed,processing:rows[0].processing,chunks:counts[0].chunks,confirmedExamples:counts[0].examples};
 });
 app.post('/api/upload',async(request,reply)=>{
  const fields:Record<string,string>={};const files:{filename:string;buffer:Buffer;mimeType:string}[]=[];let bytes=0;
  for await(const part of request.parts()) {
   if(part.type==='field') {fields[part.fieldname]=String(part.value);continue;}
   const buffer=await part.toBuffer();bytes+=buffer.length;
   if(bytes>300*1024*1024) throw new HttpError(413,'单次上传总大小不能超过 300 MB');
   files.push({filename:part.filename,buffer,mimeType:part.mimetype});
  }
  if(!files.length) throw new HttpError(400,'请选择至少一个文件');
  if(fields.documentId&&files.length>1) throw new HttpError(400,'更新版本时每次只能上传一个文件');
  const results=[];
  for(const file of files) {
   if(!supportedExtensions.has(path.extname(file.filename).toLowerCase())) {results.push({filename:file.filename,status:'error',message:'暂不支持此格式，请上传 DOCX、PDF、XLSX、XLS、CSV、MD 或 TXT'});continue;}
   if(!file.buffer.length) {results.push({filename:file.filename,status:'error',message:'文件为空'});continue;}
   try {
    const source=await sourceRegistry.get('manual').fetchDocument(fields.sourceId||'manual',{filename:file.filename,buffer:file.buffer,sourcePath:fields.sourcePath||file.filename});
    source.meta.mimeType=file.mimeType;
    results.push(await service.upload(source,{duplicate:query(request).duplicate==='keep'?'keep':'skip',sourceId:fields.sourceId,documentId:fields.documentId}));
   } catch(error) {results.push({filename:file.filename,status:'error',message:service.settings.redact(error instanceof HttpError?error.message:'文件导入失败，请重试')});}
  }
  return reply.code(202).send({results});
 });
 app.get('/api/documents',async request=>{
  const q=query(request);const {page,pageSize}=pagination(q);const f=filters(q);
  const count=await db.query(`SELECT count(*)::int AS total FROM (${documentSelect} WHERE ${f.where}) found`,f.values);
  const rows=await db.query(`${documentSelect} WHERE ${f.where} ORDER BY d.updated_at DESC,d.id LIMIT $${f.values.length+1} OFFSET $${f.values.length+2}`,[...f.values,pageSize,(page-1)*pageSize]);
  return {items:rows.map(documentRecord),total:count[0].total,page,pageSize};
 });
 app.get('/api/search',async request=>{
  const q=query(request);const {page,pageSize}=pagination(q);const f=filters(q,0,true);
  // Search always uses the current version. Explicit status supports archived inspection.
  const expression=queryText(q.q||'');let match='';let rank='1.0';
  if(expression) {f.values.push(expression);const p=`$${f.values.length}`;match=` AND c.search_vector @@ to_tsquery('simple',${p})`;rank=`ts_rank_cd(c.search_vector,to_tsquery('simple',${p}))`;}
  else if(q.q?.trim()) return {items:[],total:0};
  const from=`FROM knowledge_chunks c JOIN documents d ON d.id=c.document_id AND d.active_version_id=c.version_id JOIN document_versions v ON v.id=c.version_id JOIN source_documents sd ON sd.id=d.source_document_id JOIN knowledge_sources s ON s.id=sd.source_id WHERE ${f.where}${match}`;
  const count=await db.query(`SELECT count(*)::int AS total ${from}`,f.values);
  const rows=await db.query(`SELECT c.*,(${rank} * CASE (SELECT value#>>'{}' FROM classification_results WHERE version_id=v.id AND field='authority') WHEN 'authoritative' THEN 1.2 WHEN 'style_only' THEN 0.6 ELSE 1.0 END * (0.85+0.15/(1+extract(epoch FROM (now()-v.created_at))/31536000))) AS score ${from} ORDER BY score DESC,v.created_at DESC,c.chunk_order LIMIT $${f.values.length+1} OFFSET $${f.values.length+2}`,[...f.values,pageSize,(page-1)*pageSize]);
  const cache=new Map();const items=[];
  for(const row of rows){if(!cache.has(row.document_id))cache.set(row.document_id,await getDocument(db,row.document_id));items.push({document:cache.get(row.document_id),chunk:chunkRecord(row),score:Number(row.score)});}
  return {items,total:count[0].total};
 });
 app.get('/api/documents/:id',async request=>{
  const document=await getDocument(db,params(request).id);if(!document)throw new HttpError(404,'资料不存在');
  const chunks=await db.query('SELECT * FROM knowledge_chunks WHERE version_id=$1 ORDER BY chunk_order',[document.activeVersionId]);
  const versions=await db.query('SELECT id,version_number AS "versionNumber",status,created_at AS "createdAt",content_hash AS "contentHash" FROM document_versions WHERE document_id=$1 ORDER BY version_number DESC',[document.id]);
  const audit=await db.query('SELECT id,action,modified_by AS "modifiedBy",modified_at AS "modifiedAt",previous_value AS "previousValue",next_value AS "nextValue" FROM audit_events WHERE document_id=$1 ORDER BY modified_at DESC LIMIT 100',[document.id]);
  const parsed=await db.query('SELECT parsed_document FROM document_versions WHERE id=$1',[document.activeVersionId]);
  return {document,chunks:chunks.map(chunkRecord),versions,audit,parsed:parsed[0]?.parsed_document||null};
 });
 app.get('/api/documents/:id/original',async(request,reply)=>{
  const doc=await getDocument(db,params(request).id);if(!doc)throw new HttpError(404,'资料不存在');
  const rows=await db.query('SELECT * FROM document_versions WHERE document_id=$1 AND id=$2',[doc.id,query(request).versionId||doc.activeVersionId]);
  if(!rows[0])throw new HttpError(404,'版本不存在');
  const data=await service.storage.get(rows[0].object_key);
  reply.header('Content-Disposition',`attachment; filename="download${path.extname(rows[0].filename).replace(/[^.a-zA-Z0-9]/g,'')}"; filename*=UTF-8''${encodeURIComponent(rows[0].filename)}`);
  reply.header('X-Content-Type-Options','nosniff');return reply.type('application/octet-stream').send(Buffer.from(data));
 });
 app.patch('/api/documents/:id',async request=>({document:await service.edit(params(request).id,body(request))}));
 app.post('/api/documents/:id/archive',async request=>{await service.archive(params(request).id);return{ok:true};});
 app.post('/api/documents/:id/rebuild',async request=>{await service.rebuild(params(request).id);return{ok:true};});
 app.get('/api/registries',async()=>getRegistries(db));
 // Private local snapshot for isolated evaluation; never exports credentials.
 app.get('/api/evaluation/context',async()=>{
  const settings=await service.settings.get();
  const rows=await db.query(`SELECT e.*,ARRAY(SELECT DISTINCT v.content_hash FROM document_versions v WHERE v.document_id=e.document_id) AS content_hashes FROM confirmed_examples e JOIN documents d ON d.id=e.document_id WHERE ${scoped} AND e.organization_id='default' AND e.workspace_id='default' AND e.scope='global' AND d.status<>'archived' ORDER BY e.created_at,e.id`);
  return {schemaVersion:1,createdAt:new Date().toISOString(),registries:await getRegistries(db),thresholds:{review:settings.reviewThreshold,autoAccept:settings.autoAcceptThreshold},examples:rows.map(row=>({id:row.id,documentId:row.document_id,textSummary:row.text_summary,confirmedFields:row.confirmed_fields,createdAt:new Date(row.created_at).toISOString(),contentHashes:row.content_hashes}))};
 });
 app.post('/api/registries/:kind',async request=>{
  const table=registryTables[params(request).kind as keyof Registries];if(!table)throw new HttpError(404,'分类目录不存在');
  const input=body(request);const key=input.key;const label=input.label;const aliases=input.aliases??[];
  if(typeof key!=='string'||!/^[\p{L}\p{N}_-]{1,100}$/u.test(key)||typeof label!=='string'||!label.trim()||label.length>100||!Array.isArray(aliases)||aliases.length>100||aliases.some(v=>typeof v!=='string'||!v.trim()||v.length>100))throw new HttpError(400,'分类标识、名称或别名无效');
  const found=await db.query(`SELECT key FROM ${table} WHERE key=$1`,[key]);if(found.length)throw new HttpError(409,'此分类标识已存在');
  await db.query(`INSERT INTO ${table}(key,label,aliases) VALUES($1,$2,$3::jsonb)`,[key,label.trim(),JSON.stringify(aliases)]);
  return{key,label:label.trim(),aliases};
 });
 app.delete('/api/registries/:kind/:key',async request=>{
  const {kind,key}=params(request);const table=registryTables[kind as keyof Registries];if(!table)throw new HttpError(404,'分类目录不存在');
  if(key==='unknown')throw new HttpError(400,'未知类型必须保留');
  const used=kind==='documentTypes'?await db.query("SELECT 1 FROM classification_results WHERE field='documentType' AND value=to_jsonb($1::text) LIMIT 1",[key]):await db.query(`SELECT 1 FROM ${kind==='applications'?'document_applications':'document_topics'} WHERE ${kind==='applications'?'application':'topic'}=$1 LIMIT 1`,[key]);
  if(used.length)throw new HttpError(409,'此分类已被资料使用，不能删除');
  await db.query(`DELETE FROM ${table} WHERE key=$1`,[key]);return{ok:true};
 });
 app.get('/api/settings',async()=>service.settings.get());
 app.patch('/api/settings',async request=>{try{return await service.settings.patch(body(request));}catch(error){throw new HttpError(400,error instanceof Error?error.message:'设置无效');}});
 app.post('/api/settings/test-llm',async()=>{
  const config=await service.settings.config();if(!config)return{ok:false,message:'尚未配置 API Key'};
  try{await new KimiProvider({...config,maxTokens:256}).generate({system:'Reply with OK only.',prompt:'Connection check.'});return{ok:true,message:'模型连接正常'};}
  catch(error){return{ok:false,message:service.settings.redact(error instanceof Error?error.message:'模型连接失败')};}
 });
 app.get('/api/jobs',async()=>({items:await db.query(`SELECT j.id,j.document_id AS "documentId",v.filename,j.status,j.error,j.created_at AS "createdAt",j.updated_at AS "updatedAt" FROM ingestion_jobs j JOIN documents d ON d.id=j.document_id JOIN document_versions v ON v.id=j.version_id WHERE ${scoped} ORDER BY j.created_at DESC LIMIT 200`)}));
 await registerRefinementRoutes(app,service,refinement);
 const dist=fileURLToPath(new URL('../../../dist/',import.meta.url));
 if(existsSync(path.join(dist,'index.html'))) {
  await app.register(fastifyStatic,{root:dist,prefix:'/'});
  app.setNotFoundHandler((request,reply)=>request.url.startsWith('/api/')?reply.code(404).send({message:'接口不存在'}):reply.sendFile('index.html'));
 }
 await service.start();
 await refinement.start();
 return app;
}
