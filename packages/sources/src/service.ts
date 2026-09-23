import {randomUUID} from 'node:crypto';
import type {Database} from '../../knowledge/src/database.js';
import {HttpError,KnowledgeService} from '../../knowledge/src/service.js';
import type {RemoteResource} from '../../core/src/sources.js';
import type {SourceFile} from '../../core/src/types.js';
import type {ConnectionService} from '../../connections/src/service.js';
import type {StructuredService} from '../../structured/src/service.js';
const date=(v:unknown)=>v?v instanceof Date?v.toISOString():String(v):undefined;
const job=(r:any)=>({id:r.id,sourceId:r.source_id,status:r.status,discovered:r.discovered,added:r.added,updated:r.updated,unchanged:r.unchanged,removed:r.removed,failed:r.failed,unsupported:r.unsupported,errors:r.errors,startedAt:date(r.started_at),completedAt:date(r.completed_at)});
export class SourceSyncService {
 private current?:Promise<void>;private timer?:ReturnType<typeof setInterval>;private stopping=false;
 constructor(private db:Database,private knowledge:KnowledgeService,private connections:ConnectionService,private structured:StructuredService,private prepareDocument?:(file:SourceFile)=>Promise<SourceFile>){}
 async start(){await this.db.query("UPDATE source_sync_jobs SET status='partial',completed_at=now(),errors=errors||$1::jsonb WHERE status='running'",[JSON.stringify([{message:'服务中断；已完成内容保留，可重新同步。'}])]);this.timer=setInterval(()=>this.wake(),700);this.timer.unref();this.wake();}
 async close(){this.stopping=true;clearInterval(this.timer);await this.current;}
 private wake(){if(this.stopping||this.current)return;this.current=this.drain().catch(()=>{}).finally(()=>{this.current=undefined;});}
 async list(){const rows=await this.db.query("SELECT s.*,(SELECT count(*)::int FROM source_resources r WHERE r.source_id=s.id AND r.status<>'removed') AS resource_count,(SELECT json_build_object('processing',count(DISTINCT d.id) FILTER (WHERE d.status IN ('discovered','uploaded','parsing','parsed','classifying','indexing')),'failed',count(DISTINCT d.id) FILTER (WHERE d.status='failed'),'needsReview',count(DISTINCT d.id) FILTER (WHERE d.status='needs_review')) FROM source_resources r JOIN documents d ON d.id=r.document_id WHERE r.source_id=s.id AND r.status<>'removed') AS ingestion FROM knowledge_sources s WHERE s.organization_id='default' AND s.workspace_id='default' AND s.type IN ('feishu_wiki','feishu_sheet') ORDER BY s.name");const result=[];for(const r of rows)result.push({...this.source(r),resourceCount:r.resource_count,ingestion:r.ingestion,lastJob:(await this.jobs(r.id))[0]});return result;}
 private source(r:any){return {id:r.id,name:r.name,type:r.type,mode:r.mode,status:r.status,sourceOfTruth:r.source_of_truth,config:r.config};}
 async get(id:string){const row=(await this.db.query("SELECT * FROM knowledge_sources WHERE id=$1 AND organization_id='default' AND workspace_id='default' AND type IN ('feishu_wiki','feishu_sheet')",[id]))[0];if(!row)throw new HttpError(404,'同步来源不存在');return this.source(row);}
 async create(input:{name:string;rootUrl:string;connectionId:string;mode:'wiki'|'sheet';recursive?:boolean;authorityHint?:string}){await this.connections.get(input.connectionId);const id=randomUUID();const config={rootUrl:input.rootUrl,connectionId:input.connectionId,mode:input.mode,recursive:input.recursive!==false,syncMode:'manual',authorityHint:input.authorityHint||'none'};await this.db.query("INSERT INTO knowledge_sources(id,organization_id,workspace_id,type,name,mode,source_of_truth,config) VALUES($1,'default','default',$2,$3,'mirror','remote',$4::jsonb)",[id,'feishu_'+input.mode,input.name,JSON.stringify(config)]);return this.get(id);}
 async update(id:string,input:{name?:string;rootUrl?:string;mode?:'wiki'|'sheet';recursive?:boolean;authorityHint?:string;status?:'ready'|'disabled'}){const source=await this.get(id);if((await this.jobs(id)).some(j=>['queued','running'].includes(j.status)))throw new HttpError(409,'请等待当前同步完成再编辑来源');const config={...source.config};for(const field of ['rootUrl','mode','recursive','authorityHint'] as const)if(input[field]!==undefined)config[field]=input[field];await this.db.query('UPDATE knowledge_sources SET name=$1,config=$2::jsonb,status=$3,type=$4 WHERE id=$5',[input.name??source.name,JSON.stringify(config),input.status??source.status,'feishu_'+config.mode,id]);return this.get(id);}
 async jobs(sourceId:string){return (await this.db.query('SELECT * FROM source_sync_jobs WHERE source_id=$1 ORDER BY started_at DESC LIMIT 50',[sourceId])).map(job);}
 async resources(id:string){await this.get(id);return this.db.query('SELECT remote_id AS "remoteId",kind,resource,document_id AS "documentId",dataset_id AS "datasetId",status,last_error AS error FROM source_resources WHERE source_id=$1 ORDER BY remote_id',[id]);}
 async enqueue(sourceId:string,retryFailed=false){const source=await this.get(sourceId);if(source.status==='disabled')throw new HttpError(409,'来源已停用');await this.connections.adapter(source.config.connectionId);const active=(await this.jobs(sourceId)).find(j=>['queued','running'].includes(j.status));if(active)return active;const id=randomUUID();try{await this.db.query('INSERT INTO source_sync_jobs(id,source_id,retry_failed) VALUES($1,$2,$3)',[id,sourceId,retryFailed]);}catch(error){const pending=(await this.jobs(sourceId)).find(j=>['queued','running'].includes(j.status));if(pending)return pending;throw error;}this.wake();return job((await this.db.query('SELECT * FROM source_sync_jobs WHERE id=$1',[id]))[0]);}
 private async drain(){while(!this.stopping){const rows=await this.db.query("SELECT * FROM source_sync_jobs WHERE status='queued' ORDER BY started_at LIMIT 1");if(!rows.length)return;const run=rows[0];await this.db.query("UPDATE source_sync_jobs SET status='running' WHERE id=$1",[run.id]);try{await this.process(run);}catch(error){await this.db.query("UPDATE source_sync_jobs SET status='failed',failed=failed+1,errors=errors||$1::jsonb,completed_at=now() WHERE id=$2",[JSON.stringify([{message:this.safe(error)}]),run.id]);}}}
 private safe(error:unknown){return this.connections.redact(error instanceof Error?error.message:'同步失败');}
 private async upsert(sourceId:string,r:RemoteResource,state:{documentId?:string;datasetId?:string;hash?:string;status:string;error?:string}){
  await this.db.query(`INSERT INTO source_resources(source_id,remote_id,kind,resource,document_id,dataset_id,content_hash,remote_version,status,last_error) VALUES($1,$2,$3,$4::jsonb,$5,$6,$7,$8,$9,$10)
   ON CONFLICT(source_id,remote_id) DO UPDATE SET kind=excluded.kind,resource=excluded.resource,document_id=coalesce(excluded.document_id,source_resources.document_id),dataset_id=coalesce(excluded.dataset_id,source_resources.dataset_id),content_hash=coalesce(excluded.content_hash,source_resources.content_hash),remote_version=excluded.remote_version,status=excluded.status,last_error=excluded.last_error,updated_at=now()`,[sourceId,r.id,r.kind,JSON.stringify(r),state.documentId??null,state.datasetId??null,state.hash??null,r.remoteVersion??null,state.status,state.error??null]);
 }
 private async process(run:any){
  const source=await this.get(run.source_id);if(source.status==='disabled')throw new HttpError(409,'来源已停用');const adapter=await this.connections.adapter(source.config.connectionId),listing=await adapter.list(source.config);
  const prior=await this.db.query('SELECT r.*,d.status AS document_status FROM source_resources r LEFT JOIN documents d ON d.id=r.document_id WHERE r.source_id=$1',[source.id]),byId=new Map(prior.map(r=>[r.remote_id,r]));
  const count={discovered:listing.items.length,added:0,updated:0,unchanged:0,removed:0,failed:listing.errors.length,unsupported:0};const errors=listing.errors.map(e=>({...e,message:this.connections.redact(e.message)}));
  const seen=new Set([...listing.items.map(r=>r.id),...listing.errors.map(e=>e.resourceId).filter(Boolean)]);
  const persist=async()=>this.db.query('UPDATE source_sync_jobs SET discovered=$1,added=$2,updated=$3,unchanged=$4,removed=$5,failed=$6,unsupported=$7,errors=$8::jsonb WHERE id=$9',[count.discovered,count.added,count.updated,count.unchanged,count.removed,count.failed,count.unsupported,JSON.stringify(errors),run.id]);
  await persist();
  for(const resource of listing.items){
   if(this.stopping){errors.push({message:'服务停止，剩余资源未同步；本次不判断删除。'});count.failed++;listing.complete=false;break;}
   const old=byId.get(resource.id);
   try{
    if(resource.kind==='unsupported'){
     if(old?.document_id&&old.document_status!=='archived')await this.knowledge.detachSource(source.id,resource.id,old.document_id);
     if(old?.dataset_id)await this.structured.remove(old.dataset_id);
     await this.upsert(source.id,resource,{status:'unsupported'});count.unsupported++;continue;
    }
    if(run.retry_failed&&old&&old.status!=='failed'&&old.status!=='removed'&&old.document_status!=='failed'){count.unchanged++;continue;}
    if(resource.kind==='dataset'){
     const data=await adapter.fetchDataset(resource,source.config);const saved=await this.structured.save(source.id,data);
     await this.upsert(source.id,resource,{datasetId:saved.id,status:'active'});if(saved.change==='unchanged')count.unchanged++;else if(old?.dataset_id)count.updated++;else count.added++;
    }else{
     // A revision permits a cheap skip. With no trustworthy revision, compare content bytes.
     if(old?.status==='active'&&old.document_status!=='failed'&&resource.remoteVersion?.startsWith('docx:')&&old.remote_version===resource.remoteVersion&&JSON.stringify(old.resource.path)===JSON.stringify(resource.path)&&old.resource.title===resource.title&&old.resource.remoteUrl===resource.remoteUrl){count.unchanged++;continue;}
     let file=await adapter.fetchDocument(resource,source.config);
     const fingerprint=typeof file.meta.metadata?.contentFingerprint==='string'?file.meta.metadata.contentFingerprint:file.contentHash;
     if(old?.status==='active'&&old.document_status!=='failed'&&old.content_hash===fingerprint&&old.resource.title===resource.title&&old.resource.remoteUrl===resource.remoteUrl&&JSON.stringify(old.resource.path)===JSON.stringify(resource.path)){
      // Remote revisions may advance without changing content. Preserve the local version and refresh remote tracking only.
      await this.upsert(source.id,resource,{status:'active',hash:fingerprint});
      if(old.document_id)await this.knowledge.refreshSource(source.id,resource.id,old.document_id,resource.remoteVersion??null,resource.modifiedAt??null,resource.remoteUrl);
      count.unchanged++;continue;
     }
     if(this.prepareDocument)file=await this.prepareDocument(file);
     file.meta.sourcePath=resource.path.join('/');file.meta.sourceUri=resource.remoteUrl;file.meta.version=resource.remoteVersion??file.meta.version;file.meta.modifiedAt=resource.modifiedAt??file.meta.modifiedAt;
     file.meta.metadata={...file.meta.metadata,provider:'feishu',remote_token:resource.remoteToken,remote_url:resource.remoteUrl,remote_version:file.meta.version,remote_modified_at:file.meta.modifiedAt,remote_path:resource.path};
     const result=await this.knowledge.upload(file,{duplicate:'skip',sourceId:source.id,documentId:old?.document_id,sourceDocumentId:resource.id});
     await this.upsert(source.id,resource,{documentId:result.documentId,hash:fingerprint,status:'active'});if(result.status==='duplicate')count.unchanged++;else if(old?.document_id)count.updated++;else count.added++;
    }
   }catch(error){const message=this.safe(error);errors.push({resourceId:resource.id,message});count.failed++;await this.upsert(source.id,resource,{status:'failed',error:message});}
   finally{await persist();}
  }
  // Incomplete enumeration or retry-only runs can never infer remote deletions.
  if(listing.complete&&!listing.errors.length&&!run.retry_failed&&!this.stopping){for(const old of prior){if(seen.has(old.remote_id)||old.status==='removed')continue;if(old.document_id)await this.knowledge.detachSource(source.id,old.remote_id,old.document_id);if(old.dataset_id)await this.structured.remove(old.dataset_id);await this.db.query("UPDATE source_resources SET status='removed',updated_at=now() WHERE source_id=$1 AND remote_id=$2",[source.id,old.remote_id]);count.removed++;}}
  await persist();await this.db.query('UPDATE source_sync_jobs SET status=$1,completed_at=now() WHERE id=$2',[count.failed||!listing.complete?'partial':'completed',run.id]);
 }
}
