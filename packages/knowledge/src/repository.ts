import type { Classification, DocumentRecord, KnowledgeChunk, Registries } from '../../core/src/types.js';
import type { Connection } from './database.js';
import { registryTables } from './database.js';
import { queryText } from './search.js';

export const scoped = "d.organization_id='default' AND d.workspace_id='default' AND d.scope='global'";
export const documentSelect = `SELECT d.id,d.title,d.status,d.scope,d.created_at,d.updated_at,d.active_version_id,
 v.filename,v.version_number,v.content_hash,v.summary,v.parse_status,v.parse_warnings,v.review_reasons,v.error,
 s.id AS source_id,s.type AS source_type,sd.source_path,
 (SELECT count(*)::int FROM knowledge_chunks c WHERE c.version_id=v.id) AS chunk_count,
 (SELECT jsonb_object_agg(cr.field,jsonb_build_object('value',cr.value,'confidence',cr.confidence,'source',cr.source,'reasoning',cr.reasoning)) FROM classification_results cr WHERE cr.version_id=v.id) AS classification
 FROM documents d JOIN document_versions v ON v.id=d.active_version_id JOIN source_documents sd ON sd.id=d.source_document_id JOIN knowledge_sources s ON s.id=sd.source_id`;
const date = (v: any) => v instanceof Date ? v.toISOString() : String(v);
export function documentRecord(r: any): DocumentRecord {
 return {id:r.id,title:r.title,filename:r.filename,status:r.status,scope:r.scope,sourceId:r.source_id,sourceType:r.source_type,sourcePath:r.source_path ?? undefined,activeVersionId:r.active_version_id,versionNumber:r.version_number,contentHash:r.content_hash,summary:r.summary,classification:r.classification,reviewReasons:r.review_reasons || [],parseStatus:r.parse_status,parseWarnings:r.parse_warnings || [],createdAt:date(r.created_at),updatedAt:date(r.updated_at),chunkCount:Number(r.chunk_count),error:r.error || undefined};
}
export function chunkRecord(r: any): KnowledgeChunk { return {id:r.id,documentId:r.document_id,versionId:r.version_id,order:r.chunk_order,headingPath:r.heading_path,text:r.text,summary:r.summary,topics:r.topics,products:r.products,metadata:r.metadata}; }
export async function getDocument(db: Connection,id:string) { const rows = await db.query(`${documentSelect} WHERE ${scoped} AND d.id=$1`,[id]); return rows[0] ? documentRecord(rows[0]) : undefined; }
export async function getClassification(db:Connection,versionId:string): Promise<Classification|null> {
 const rows = await db.query('SELECT field,value,confidence,source,reasoning FROM classification_results WHERE version_id=$1',[versionId]);
 return rows.length ? Object.fromEntries(rows.map(r => [r.field,{value:r.value,confidence:r.confidence,source:r.source,reasoning:r.reasoning}])) as unknown as Classification : null;
}
export async function getRegistries(db:Connection): Promise<Registries> {
 const result = {} as Registries;
 for (const [kind,table] of Object.entries(registryTables)) result[kind as keyof Registries] = await db.query(`SELECT key,label,aliases FROM ${table} ORDER BY label`);
 return result;
}
export async function saveClassification(db:Connection,versionId:string,classification:Classification) {
 await db.query('DELETE FROM classification_results WHERE version_id=$1',[versionId]);
 for (const [field,value] of Object.entries(classification)) if (value) await db.query('INSERT INTO classification_results(version_id,field,value,confidence,source,reasoning) VALUES($1,$2,$3::jsonb,$4,$5,$6) ON CONFLICT(version_id,field) DO UPDATE SET value=excluded.value,confidence=excluded.confidence,source=excluded.source,reasoning=excluded.reasoning,updated_at=now()', [versionId,field,JSON.stringify(value.value),value.confidence,value.source,value.reasoning || null]);
 for (const [table,column,values] of [['document_applications','application',classification.applications.value],['document_topics','topic',classification.topics.value],['document_products','product',classification.products.value]] as [string,string,string[]][]) {
  await db.query(`DELETE FROM ${table} WHERE version_id=$1`,[versionId]);
  for (const value of [...new Set(values)]) await db.query(`INSERT INTO ${table}(version_id,${column}) VALUES($1,$2)`,[versionId,value]);
 }
}
export function filters(input: Record<string,string>, startIndex=0, search=false) {
 const clauses = [scoped]; const values: unknown[] = [];
 const arg = (v:unknown) => { values.push(v); return `$${values.length+startIndex}`; };
 if (input.status) clauses.push(`d.status=${arg(input.status)}`); else if(search) clauses.push("d.status='active'");
 if(input.source) { const p=arg(input.source); clauses.push(`(s.id=${p} OR s.type=${p})`); }
 for (const [key,field] of [['documentType','documentType'],['authority','authority']]) if(input[key]) clauses.push(`EXISTS(SELECT 1 FROM classification_results f WHERE f.version_id=v.id AND f.field='${field}' AND f.value=to_jsonb(${arg(input[key])}::text))`);
 for (const [key,table,col] of [['application','document_applications','application'],['topic','document_topics','topic'],['product','document_products','product']]) if(input[key]) clauses.push(`EXISTS(SELECT 1 FROM ${table} f WHERE f.version_id=v.id AND f.${col}=${arg(input[key])})`);
 if(input.q && !search) { const raw=arg(`%${input.q}%`); const fts=queryText(input.q); const ftsParam=fts ? arg(fts) : undefined; clauses.push(`(d.title ILIKE ${raw} OR v.filename ILIKE ${raw}${ftsParam ? ` OR EXISTS(SELECT 1 FROM knowledge_chunks f WHERE f.version_id=v.id AND f.search_vector @@ to_tsquery('simple',${ftsParam}))`:''})`); }
 return {where:clauses.join(' AND '),values};
}
