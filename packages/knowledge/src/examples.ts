import type { ConfirmedExample } from '../../core/src/types.js';
import type { Connection } from './database.js';
import { scoped } from './repository.js';
import { queryText } from './search.js';
import { duplicateRetrievalBuckets } from '../../deduplication/src/retrieval.js';

/** Shared production FTS retrieval. Additional exclusions are used only by isolated evaluation. */
export async function retrieveConfirmedExamples(db:Connection,text:string,excludeId:string,additionalExcludedIds:string[]=[]):Promise<ConfirmedExample[]> {
 const query=queryText(text.slice(0,3000),'or');
 if(!query)return [];
 const exclusion=additionalExcludedIds.length ? ' AND NOT (e.id = ANY($3::text[]))' : '';
 const rows=await db.query(`SELECT e.* FROM confirmed_examples e JOIN documents d ON d.id=e.document_id WHERE ${scoped} AND e.organization_id='default' AND e.workspace_id='default' AND e.scope='global' AND d.status IN ('active','needs_review') AND d.canonical_document_id IS NULL AND e.version_id=d.active_version_id AND e.document_id<>$1${exclusion} AND e.search_vector @@ to_tsquery('simple',$2) ORDER BY ts_rank_cd(e.search_vector,to_tsquery('simple',$2)) DESC,e.created_at DESC LIMIT 30`,additionalExcludedIds.length ? [excludeId,query,additionalExcludedIds] : [excludeId,query]);
 const buckets=await duplicateRetrievalBuckets(db),bucketById=new Map(buckets.documentIds.map((id,index)=>[id,buckets.buckets[index]])),seen=new Set<string>();
 return rows.filter(r=>{const key=bucketById.get(r.document_id)??r.document_id;if(seen.has(key))return false;seen.add(key);return true;}).slice(0,5).map(r=>({id:r.id,documentId:r.document_id,textSummary:r.text_summary,confirmedFields:r.confirmed_fields,createdAt:String(r.created_at)}));
}
