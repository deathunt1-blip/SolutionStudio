import { randomUUID } from 'node:crypto';
import type { Connection, Database } from '../../knowledge/src/database.js';
import { filters, scoped } from '../../knowledge/src/repository.js';
import { HttpError } from '../../knowledge/src/service.js';
import { LexicalDuplicateDetector, generateCandidatePairs, normalizedContentHash } from './detector.js';
import type { DedupDocument, DuplicateAssessment, DuplicateDetector } from './types.js';

type ScanOptions = { documentIds?: string[]; source?: string; filters?: Record<string,string> };
type Snapshot = { documentId:string; versionId:string; status:string; canonicalDocumentId:string|null };
const relations = ['exact_duplicate','content_duplicate','near_duplicate','possible_version','similar'] as const;
const date = (value:unknown) => value instanceof Date ? value.toISOString() : String(value);
const pairKey = (a:string,b:string) => JSON.stringify([a,b].sort());
const snapshot = (rows:any[]):Snapshot[] => rows.map(r=>({documentId:r.id,versionId:r.active_version_id,status:r.status,canonicalDocumentId:r.canonical_document_id??null})).sort((a,b)=>a.documentId.localeCompare(b.documentId));
// PostgreSQL jsonb may reorder object keys. Compare owned fields, not serialization order.
const sameSnapshot = (left:Snapshot[],right:Snapshot[]) => {
 const byId=new Map(right.map(row=>[row.documentId,row]));
 return left.length===right.length && left.every(row=>{
  const other=byId.get(row.documentId);
  return !!other && row.versionId===other.versionId && row.status===other.status && row.canonicalDocumentId===other.canonicalDocumentId;
 });
};

/** Local deterministic suggestions only. All document mutations require explicit confirmation. */
export class DeduplicationService {
 constructor(readonly db:Database,readonly detector:DuplicateDetector=new LexicalDuplicateDetector()) {}

 private async loadDocuments() {
  const rows = await this.db.query(`SELECT d.id,coalesce(nullif(d.canonical_title,''),d.title) AS title,d.active_version_id,d.created_at,d.status,
   v.filename,v.content_hash,v.normalized_content_hash,v.parsed_document,
   (SELECT c.value FROM classification_results c WHERE c.version_id=v.id AND c.field='documentType') AS document_type,
   (SELECT coalesce(jsonb_agg(p.product),'[]') FROM document_products p WHERE p.version_id=v.id) AS products,
   (SELECT coalesce(jsonb_agg(t.topic),'[]') FROM document_topics t WHERE t.version_id=v.id) AS topics
   FROM documents d JOIN document_versions v ON v.id=d.active_version_id
   WHERE ${scoped} AND d.canonical_document_id IS NULL AND d.status NOT IN ('archived','superseded','failed') ORDER BY d.id`);
  const documents:DedupDocument[]=[];
  for(const row of rows) {
   const parsed=row.parsed_document;
   let normalized=row.normalized_content_hash;
   if(!normalized && parsed && typeof parsed.plainText==='string') {
    normalized=normalizedContentHash({plainText:parsed.plainText,tables:Array.isArray(parsed.tables)?parsed.tables:[]});
    if(normalized) await this.db.query('UPDATE document_versions SET normalized_content_hash=$2 WHERE id=$1 AND normalized_content_hash IS NULL',[row.active_version_id,normalized]);
   }
   documents.push({id:row.id,title:row.title,filename:row.filename,contentHash:row.content_hash,normalizedContentHash:normalized,
    parsedDocument:parsed??undefined,documentType:row.document_type??undefined,products:row.products,topics:row.topics});
  }
  return {rows,documents};
 }

 async detectDocument(documentId:string) { return this.scan({documentIds:[documentId]}); }

 async scan(options:ScanOptions={}) {
  const {rows,documents}=await this.loadDocuments();
  const versions=new Map(rows.map(row=>[row.id,row.active_version_id]));
  let selected=new Set(documents.map(doc=>doc.id));
  if(options.documentIds) selected=new Set(options.documentIds.filter(id=>versions.has(id)));
  if(options.source || options.filters) {
   const input={...options.filters,...(options.source?{source:options.source}:{})};
   // Source references include exact duplicates attached to another origin's canonical document.
   const {source,...rest}=input;const f=filters(rest);
   const values=[...f.values];let sourceClause='';
   if(source) {values.push(source);sourceClause=` AND EXISTS(SELECT 1 FROM document_source_references dr JOIN knowledge_sources ds ON ds.id=dr.source_id WHERE dr.document_id=d.id AND NOT dr.removed AND (ds.id=$${values.length} OR ds.type=$${values.length}))`;}
   const matching=await this.db.query(`SELECT d.id FROM documents d JOIN document_versions v ON v.id=d.active_version_id JOIN source_documents sd ON sd.id=d.source_document_id JOIN knowledge_sources s ON s.id=sd.source_id WHERE ${f.where}${sourceClause}`,values);
   const allowed=new Set(matching.map(row=>row.id));selected=new Set([...selected].filter(id=>allowed.has(id)));
  }
  const generated=generateCandidatePairs(documents,{focusDocumentIds:[...selected]});
  const byId=new Map(documents.map(doc=>[doc.id,doc]));
  const counts=Object.fromEntries(relations.map(relation=>[relation,0])) as Record<typeof relations[number],number>;
  let created=0,updated=0,groupLimited=false;
  for(const [leftId,rightId] of generated.pairs) {
   const left=byId.get(leftId)!,right=byId.get(rightId)!;
   const assessment=await this.detector.compare(left,right);
   if(assessment.relation==='none')continue;
   counts[assessment.relation]++;
   const result=await this.saveProposal(left,right,versions,assessment,byId);
   if(result.startsWith('created'))created++;else if(result.startsWith('updated'))updated++;
   if(result.endsWith('_limited'))groupLimited=true;
  }
  return {scanned:selected.size,candidates:generated.pairs.length,created,updated,counts,truncated:generated.truncated||groupLimited,groupLimited,candidateStats:generated.stats};
 }

 private async saveProposal(left:DedupDocument,right:DedupDocument,versions:Map<string,any>,assessment:DuplicateAssessment,documents:Map<string,DedupDocument>) {
  return this.db.transaction(async tx=>{
   let groupLimited=false;
   let key=assessment.relation==='exact_duplicate' && left.contentHash?`exact:${left.contentHash}`:
    assessment.relation==='content_duplicate' && left.normalizedContentHash?`content:${left.normalizedContentHash}`:pairKey(left.id,right.id);
   let group:Record<string,any>|undefined=(await tx.query('SELECT * FROM document_duplicate_groups WHERE pair_key=$1 FOR UPDATE',[key]))[0];
   if(group) {
    const existing=await tx.query(`SELECT m.document_id,m.version_id,d.active_version_id FROM document_duplicate_members m JOIN documents d ON d.id=m.document_id
     WHERE m.group_id=$1 AND ($2::boolean OR m.document_id=ANY($3::text[]) OR m.version_id<>d.active_version_id)`,[group.id,key.startsWith('content:'),[left.id,right.id]]);
    const alreadyBoth=existing.some(row=>row.document_id===left.id)&&existing.some(row=>row.document_id===right.id);
    if(group.status!=='suggested') {
     if(alreadyBoth)return 'unchanged';
     // Membership of a confirmed/dismissed operation is immutable. A new arrival remains visible as a separate proposal.
     key=pairKey(left.id,right.id);group=(await tx.query('SELECT * FROM document_duplicate_groups WHERE pair_key=$1 FOR UPDATE',[key]))[0];
    } else if(key.startsWith('exact:')||key.startsWith('content:')) {
     if(existing.some(row=>row.active_version_id!==row.version_id)) {
      // Keep the former proposal as stale history; a fresh scan builds a current hash cohort.
      await tx.query('UPDATE document_duplicate_groups SET pair_key=$2 WHERE id=$1',[group.id,`stale:${group.id}`]);group=undefined;
     } else if(assessment.relation==='content_duplicate' && !alreadyBoth) {
      // Bound metadata cross-checks too: candidate blocking alone would not bound one huge content cohort.
      // Further members remain visible in separate pair proposals rather than creating an unbounded all-pairs pass.
      let compatible=existing.length<64;groupLimited=!compatible;
      for(const prior of compatible?existing:[]) {
       const document=documents.get(prior.document_id);
       if(!document){compatible=false;break;}
       for(const added of [left,right])if(added.id!==document.id && !existing.some(row=>row.document_id===added.id)) {
        const checked=await this.detector.compare(document,added);
        if(!['exact_duplicate','content_duplicate'].includes(checked.relation)){compatible=false;break;}
       }
       if(!compatible)break;
      }
      if(!compatible){key=pairKey(left.id,right.id);group=(await tx.query('SELECT * FROM document_duplicate_groups WHERE pair_key=$1 FOR UPDATE',[key]))[0];}
     }
    }
   }
   if(group && group.status!=='suggested')return 'unchanged';
   const created=!group;
   if(!group) {
    // The choice is a reversible proposal. Dates/version labels only affect the initial radio selection.
    const versionRank=(doc:DedupDocument)=>{const text=`${doc.title||''} ${doc.filename||''}`;const years=[...text.matchAll(/\b(20\d{2})\b/g)].map(x=>Number(x[1]));const version=text.match(/(?:\bv|版本)\s*(\d+(?:\.\d+)?)/i);return Math.max(0,...years)*1000+(version?Number(version[1]):0);};
    const canonical=versionRank(right)>versionRank(left)?right.id:left.id;
    const id=randomUUID();
    await tx.query(`INSERT INTO document_duplicate_groups(id,pair_key,canonical_document_id,relation,score,reasons,differences)
      VALUES($1,$2,$3,$4,$5,$6::jsonb,$7::jsonb) ON CONFLICT(pair_key) DO NOTHING`,[id,key,canonical,assessment.relation,assessment.score,JSON.stringify(assessment.reasons),JSON.stringify(assessment.differences||[])]);
    group=(await tx.query('SELECT * FROM document_duplicate_groups WHERE pair_key=$1 FOR UPDATE',[key]))[0];
    if(group.status!=='suggested')return 'unchanged';
   }
   await tx.query(`UPDATE document_duplicate_groups SET relation=$2,score=$3,reasons=$4::jsonb,differences=$5::jsonb,updated_at=now() WHERE id=$1`,[group.id,assessment.relation,assessment.score,JSON.stringify(assessment.reasons),JSON.stringify(assessment.differences||[])]);
   for(const document of [left,right]) await tx.query(`INSERT INTO document_duplicate_members(group_id,document_id,version_id) VALUES($1,$2,$3)
    ON CONFLICT(group_id,document_id) DO UPDATE SET version_id=excluded.version_id`,[group.id,document.id,versions.get(document.id)]);
   return `${created?'created':'updated'}${groupLimited?'_limited':''}`;
  });
 }

 async list(options:{status?:string;relation?:string;documentId?:string;page?:number;pageSize?:number}={}) {
  const page=Math.max(1,Math.min(100000,Math.floor(options.page||1))),pageSize=Math.max(1,Math.min(100,Math.floor(options.pageSize||30)));
  const values:unknown[]=[];const clauses=[`NOT EXISTS(SELECT 1 FROM document_duplicate_members m JOIN documents d ON d.id=m.document_id WHERE m.group_id=g.id AND NOT (${scoped}))`];
  for(const [key,column] of [['status','status'],['relation','relation']] as const) if(options[key]) {values.push(options[key]);clauses.push(`g.${column}=$${values.length}`);}
  if(options.documentId) {values.push(options.documentId);clauses.push(`EXISTS(SELECT 1 FROM document_duplicate_members m WHERE m.group_id=g.id AND m.document_id=$${values.length})`);}
  const where=clauses.join(' AND ');
  const total=(await this.db.query(`SELECT count(*)::int AS count FROM document_duplicate_groups g WHERE ${where}`,values))[0].count;
  values.push(pageSize,(page-1)*pageSize);
  const rows=await this.db.query(`SELECT g.id FROM document_duplicate_groups g WHERE ${where} ORDER BY g.updated_at DESC,g.id LIMIT $${values.length-1} OFFSET $${values.length}`,values);
  const items=[];for(const row of rows)items.push(await this.detail(row.id));
  return {items,total,page,pageSize};
 }

 private async readGroup(db:Connection,id:string,lock=false) {
  const group=(await db.query(`SELECT * FROM document_duplicate_groups WHERE id=$1${lock?' FOR UPDATE':''}`,[id]))[0];
  if(!group)throw new HttpError(404,'重复资料建议不存在');
  const members=await db.query(`SELECT d.*,m.version_id AS snapshot_version_id,v.filename,s.id AS source_id,s.type AS source_type,s.name AS source_name,sd.source_path,sd.source_uri
   FROM document_duplicate_members m JOIN documents d ON d.id=m.document_id JOIN document_versions v ON v.id=d.active_version_id
   JOIN source_documents sd ON sd.id=d.source_document_id JOIN knowledge_sources s ON s.id=sd.source_id
   WHERE m.group_id=$1 AND ${scoped} ORDER BY d.id${lock?' FOR UPDATE OF d':''}`,[id]);
  const count=(await db.query('SELECT count(*)::int AS count FROM document_duplicate_members WHERE group_id=$1',[id]))[0].count;
  if(members.length!==count || members.length<2)throw new HttpError(404,'重复资料建议不在当前知识库');
  return {group,members};
 }

 async detail(id:string) {
  const {group,members}=await this.readGroup(this.db,id);
  const operation=(await this.db.query('SELECT * FROM dedup_operations WHERE group_id=$1 AND undone_at IS NULL',[id]))[0];
  const stale=members.some(member=>member.active_version_id!==member.snapshot_version_id);
  const canUndo=!!operation && sameSnapshot(snapshot(members),operation.after_snapshot.documents);
  return {id:group.id,status:group.status,relation:group.relation,score:group.score,reasons:group.reasons,differences:group.differences,
   canonicalDocumentId:group.canonical_document_id,operation:group.operation??undefined,stale,canUndo,
   members:members.map(member=>({documentId:member.id,title:member.canonical_title||member.title,filename:member.filename,status:member.status,
    versionId:member.active_version_id,snapshotVersionId:member.snapshot_version_id,canonicalDocumentId:member.canonical_document_id??undefined,
    sourceId:member.source_id,sourceName:member.source_name,sourceType:member.source_type,sourcePath:member.source_path??undefined,sourceUrl:member.source_uri??undefined}))};
 }

 async sourceReferences(documentId:string) {
  const original=(await this.db.query(`SELECT d.id,d.canonical_document_id FROM documents d WHERE d.id=$1 AND ${scoped}`,[documentId]))[0];
  if(!original)throw new HttpError(404,'资料不存在');
  const canonicalDocumentId=original.canonical_document_id||original.id;
  const canonical=(await this.db.query(`SELECT d.id FROM documents d WHERE d.id=$1 AND ${scoped}`,[canonicalDocumentId]))[0];
  if(!canonical)throw new HttpError(404,'主资料不在当前知识库');
  const rows=await this.db.query(`SELECT r.*,s.name AS source_name,s.type AS source_type FROM document_source_references r
   JOIN documents d ON d.id=r.document_id JOIN knowledge_sources s ON s.id=r.source_id
   WHERE ${scoped} AND (d.id=$1 OR d.canonical_document_id=$1) ORDER BY r.removed,r.discovered_at,r.id`,[canonicalDocumentId]);
  return {canonicalDocumentId,items:rows.map(r=>({id:r.id,documentId:r.document_id,sourceId:r.source_id,sourceName:r.source_name,sourceType:r.source_type,
   sourceDocumentId:r.source_document_id,sourcePath:r.source_path??undefined,sourceUrl:r.source_url??undefined,remoteVersion:r.remote_version??undefined,
   filename:r.filename,contentHash:r.content_hash,objectKey:r.object_key,sourceMetadata:r.source_metadata,discoveredAt:date(r.discovered_at),removed:r.removed}))};
 }

 async merge(id:string,canonicalDocumentId:string) {return this.confirm(id,canonicalDocumentId,'merge');}
 async confirmVersion(id:string,canonicalDocumentId:string) {return this.confirm(id,canonicalDocumentId,'version');}

 private async confirm(id:string,canonicalDocumentId:string,kind:'merge'|'version') {
  await this.db.transaction(async tx=>{
   const {group,members}=await this.readGroup(tx,id,true);
   if(group.status!=='suggested')throw new HttpError(409,'只能确认待处理建议，请先撤销原操作');
   if(!members.some(member=>member.id===canonicalDocumentId))throw new HttpError(400,'请选择此建议组内的主资料');
   if(members.some(member=>member.active_version_id!==member.snapshot_version_id))throw new HttpError(409,'资料版本已经变化，请重新扫描后确认');
   if(members.some(member=>member.canonical_document_id))throw new HttpError(409,'资料已有主资料关系，请先撤销已有合并');
   if(members.some(member=>!['active','needs_review','superseded'].includes(member.status)))throw new HttpError(409,'资料正在处理或不可用，请等待处理完成');
   const overlap=await tx.query(`SELECT g.id FROM document_duplicate_groups g JOIN document_duplicate_members m ON m.group_id=g.id
    WHERE g.id<>$1 AND g.status='confirmed' AND m.document_id=ANY($2::text[]) LIMIT 1`,[id,members.map(member=>member.id)]);
   const children=await tx.query('SELECT id FROM documents WHERE canonical_document_id=ANY($1::text[]) LIMIT 1',[members.map(member=>member.id)]);
   if(overlap.length||children.length)throw new HttpError(409,'资料属于已确认的关系组，请先撤销该组以避免关联链或循环');
   if(kind==='merge' && !['exact_duplicate','content_duplicate','near_duplicate'].includes(group.relation))throw new HttpError(400,'版本或相似资料不能直接合并来源，请确认版本关系或保持独立');
   if(kind==='version' && ['exact_duplicate','content_duplicate'].includes(group.relation))throw new HttpError(400,'内容完全相同，请使用合并来源');
   const before={documents:snapshot(members),canonicalDocumentId:group.canonical_document_id,status:group.status,operation:group.operation??null};
   for(const member of members) {
    if(kind==='merge')await tx.query('UPDATE documents SET canonical_document_id=$2,updated_at=now() WHERE id=$1',[member.id,member.id===canonicalDocumentId?null:canonicalDocumentId]);
    else {
     // Confirmation establishes chronology, not classification/authority approval.
     const next=member.id===canonicalDocumentId?(member.status==='needs_review'?'needs_review':'active'):'superseded';
     await tx.query('UPDATE documents SET status=$2,updated_at=now() WHERE id=$1',[member.id,next]);
    }
   }
   if(kind==='version') {
    const versionGroupId=randomUUID();
    const versionGroup=(await tx.query(`INSERT INTO document_version_groups(id,duplicate_group_id,canonical_document_id) VALUES($1,$2,$3)
      ON CONFLICT(duplicate_group_id) DO UPDATE SET canonical_document_id=excluded.canonical_document_id,status='confirmed' RETURNING id`,[versionGroupId,id,canonicalDocumentId]))[0];
    for(const member of members)await tx.query(`INSERT INTO document_version_members(group_id,document_id,version_id,similarity) VALUES($1,$2,$3,$4)
      ON CONFLICT(group_id,document_id) DO UPDATE SET version_id=excluded.version_id,similarity=excluded.similarity`,[versionGroup.id,member.id,member.active_version_id,group.score]);
   }
   await tx.query("UPDATE document_duplicate_groups SET status='confirmed',canonical_document_id=$2,operation=$3,updated_at=now() WHERE id=$1",[id,canonicalDocumentId,kind]);
   const afterRows=await tx.query('SELECT id,active_version_id,status,canonical_document_id FROM documents WHERE id=ANY($1::text[]) ORDER BY id',[members.map(member=>member.id)]);
   const after={documents:snapshot(afterRows),canonicalDocumentId,status:'confirmed',operation:kind};
   const operationId=randomUUID();
   await tx.query('INSERT INTO dedup_operations(id,group_id,kind,before_snapshot,after_snapshot) VALUES($1,$2,$3,$4::jsonb,$5::jsonb)',[operationId,id,kind,JSON.stringify(before),JSON.stringify(after)]);
   const beforeById=new Map(before.documents.map(row=>[row.documentId,row])),afterById=new Map(after.documents.map(row=>[row.documentId,row]));
   // Full snapshots live once in dedup_operations; each document's audit stores only its own transition.
   for(const member of members)await tx.query('INSERT INTO audit_events(id,document_id,version_id,action,previous_value,next_value) VALUES($1,$2,$3,$4,$5::jsonb,$6::jsonb)',[randomUUID(),member.id,member.active_version_id,`dedup_${kind}`,JSON.stringify({groupId:id,document:beforeById.get(member.id)}),JSON.stringify({groupId:id,operationId,canonicalDocumentId,document:afterById.get(member.id)})]);
  });
  return this.detail(id);
 }

 async dismiss(id:string) {
  await this.db.transaction(async tx=>{
   const {group,members}=await this.readGroup(tx,id,true);
   if(group.status==='confirmed')throw new HttpError(409,'已确认关系请先撤销后再保持独立');
   if(group.status==='dismissed')return;
   await tx.query("UPDATE document_duplicate_groups SET status='dismissed',updated_at=now() WHERE id=$1",[id]);
   for(const member of members)await tx.query('INSERT INTO audit_events(id,document_id,version_id,action,next_value) VALUES($1,$2,$3,$4,$5::jsonb)',[randomUUID(),member.id,member.active_version_id,'dedup_dismiss',JSON.stringify({groupId:id})]);
  });
  return this.detail(id);
 }

 async undo(id:string) {
  await this.db.transaction(async tx=>{
   const {group,members}=await this.readGroup(tx,id,true);
   const operation=(await tx.query('SELECT * FROM dedup_operations WHERE group_id=$1 AND undone_at IS NULL FOR UPDATE',[id]))[0];
   if(group.status!=='confirmed'||!operation)throw new HttpError(409,'此关系没有可撤销的操作');
   if(!sameSnapshot(snapshot(members),operation.after_snapshot.documents))throw new HttpError(409,'资料在确认后已更新；撤销已停止，避免覆盖新的版本或人工修改');
   const before=operation.before_snapshot;
   const afterById=new Map<string,Snapshot>((operation.after_snapshot.documents as Snapshot[]).map(row=>[row.documentId,row]));
   for(const prior of before.documents as Snapshot[]) {
    await tx.query('UPDATE documents SET status=$2,canonical_document_id=$3,updated_at=now() WHERE id=$1',[prior.documentId,prior.status,prior.canonicalDocumentId]);
    await tx.query('INSERT INTO audit_events(id,document_id,version_id,action,previous_value,next_value) VALUES($1,$2,$3,$4,$5::jsonb,$6::jsonb)',[randomUUID(),prior.documentId,prior.versionId,'dedup_undo',JSON.stringify({groupId:id,document:afterById.get(prior.documentId)}),JSON.stringify({operationId:operation.id,groupId:id,document:prior})]);
   }
   await tx.query('UPDATE document_duplicate_groups SET status=$2,canonical_document_id=$3,operation=$4,updated_at=now() WHERE id=$1',[id,before.status,before.canonicalDocumentId,before.operation]);
   await tx.query("UPDATE document_version_groups SET status='undone' WHERE duplicate_group_id=$1",[id]);
   await tx.query('UPDATE dedup_operations SET undone_at=now() WHERE id=$1',[operation.id]);
  });
  return this.detail(id);
 }
}
