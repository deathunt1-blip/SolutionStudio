import type { Database } from './database.js';
import {filters,getDocument,chunkRecord} from './repository.js';
import {queryText} from './search.js';
import {duplicateRetrievalBuckets} from '../../deduplication/src/retrieval.js';
export async function searchKnowledge(db:Database,q:Record<string,string>={},options:{mode?:'and'|'or';sourceIds?:string[]}={}) {
  const page=Math.max(1,Math.min(100000,Number.parseInt(q.page)||1)),pageSize=Math.max(1,Math.min(100,Number.parseInt(q.pageSize)||30));const f=filters(q,0,true);
  // Search always uses the current version. Explicit status supports archived inspection.
  const expression=queryText(q.q||'',options.mode);let match='';let rank='1.0';
  if(expression) {f.values.push(expression);const p=`$${f.values.length}`;match=` AND c.search_vector @@ to_tsquery('simple',${p})`;rank=`ts_rank_cd(c.search_vector,to_tsquery('simple',${p}))`;}
  else if(q.q?.trim()) return {items:[],total:0};
  if(options.sourceIds?.length){f.values.push(options.sourceIds);match+=` AND (c.id=ANY($${f.values.length}::text[]) OR d.id=ANY($${f.values.length}::text[]))`;}
  const buckets=q.includeDuplicates==='1'?{documentIds:[],buckets:[]}:await duplicateRetrievalBuckets(db);
  f.values.push(buckets.documentIds,buckets.buckets);
  const bucketJoin=`LEFT JOIN unnest($${f.values.length-1}::text[],$${f.values.length}::text[]) AS bucket(document_id,bucket_key) ON bucket.document_id=d.id`;
  const from=`FROM knowledge_chunks c JOIN documents d ON d.id=c.document_id AND d.active_version_id=c.version_id JOIN document_versions v ON v.id=c.version_id JOIN source_documents sd ON sd.id=d.source_document_id JOIN knowledge_sources s ON s.id=sd.source_id ${bucketJoin} WHERE ${f.where}${match}`;
  const score=`(${rank} * CASE (SELECT value#>>'{}' FROM classification_results WHERE version_id=v.id AND field='authority') WHEN 'authoritative' THEN 1.2 WHEN 'style_only' THEN 0.6 ELSE 1.0 END * (0.85+0.15/(1+extract(epoch FROM (now()-v.created_at))/31536000)))`;
  const cte=`WITH matched AS (SELECT c.*,${score} AS score,v.created_at AS version_created_at,
   coalesce(bucket.bucket_key,'document:'||d.id) AS retrieval_bucket,CASE WHEN bucket.bucket_key IS NULL THEN 3 ELSE 1 END AS bucket_limit ${from}),
   ranked AS (SELECT *,row_number() OVER(PARTITION BY retrieval_bucket ORDER BY score DESC,version_created_at DESC,chunk_order,id) AS bucket_rank FROM matched),
   eligible AS (SELECT * FROM ranked WHERE ${q.includeDuplicates==='1'?'true':'bucket_rank<=bucket_limit'})`;
  const count=await db.query(`${cte} SELECT count(*)::int AS total FROM eligible`,f.values);
  const rows=await db.query(`${cte} SELECT * FROM eligible ORDER BY score DESC,version_created_at DESC,chunk_order,id LIMIT $${f.values.length+1} OFFSET $${f.values.length+2}`,[...f.values,pageSize,(page-1)*pageSize]);
  const cache=new Map();const items=[];
  for(const row of rows){if(!cache.has(row.document_id))cache.set(row.document_id,await getDocument(db,row.document_id));items.push({document:cache.get(row.document_id),chunk:chunkRecord(row),score:Number(row.score)});}
  return {items,total:count[0].total};
}
