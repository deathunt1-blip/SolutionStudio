import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import Fastify from 'fastify';
import { openDatabase, type Database } from '../packages/knowledge/src/database.js';
import { DeduplicationService } from '../packages/deduplication/src/service.js';
import { registerDeduplicationRoutes } from '../apps/server/src/deduplication-routes.js';
import type { ParsedDocument } from '../packages/core/src/types.js';
import type { DuplicateAssessment } from '../packages/deduplication/src/types.js';

describe('deduplication proposals, provenance and reversible confirmation',()=>{
 let directory:string,db:Database,service:DeduplicationService;
 beforeAll(async()=>{directory=await mkdtemp(path.join(tmpdir(),'solution-dedup-'));db=await openDatabase(directory);service=new DeduplicationService(db);},30000);
 afterAll(async()=>{await db?.close();if(directory)await rm(directory,{recursive:true,force:true});},30000);

 async function seed(options:{hash?:string;body?:string;title?:string;sourceId?:string;status?:string}={}) {
  const id=randomUUID(),version=randomUUID(),source=randomUUID(),hash=options.hash||randomUUID(),title=options.title||`说明 ${id}`;
  const text=options.body||`此资料唯一编号 ${id} 用于核对参数与软件安装流程，原始证据保留且不会自动覆盖。`;
  const parsed:ParsedDocument={plainText:text,blocks:[{type:'paragraph',text}],tables:[],metadata:{},parseStatus:'success',parseWarnings:[]};
  const sourceId=options.sourceId||'manual';
  await db.transaction(async tx=>{
   await tx.query('INSERT INTO source_documents(id,source_id,source_document_id,source_path,content_hash) VALUES($1,$2,$3,$4,$5)',[source,sourceId,id,`${sourceId}/${id}`,hash]);
   await tx.query("INSERT INTO documents(id,organization_id,workspace_id,source_document_id,title,canonical_title,status,active_version_id) VALUES($1,'default','default',$2,$3,$3,$4,$5)",[id,source,title,options.status||'active',version]);
   await tx.query("INSERT INTO document_versions(id,document_id,version_number,filename,content_hash,object_key,size_bytes,parsed_document,parse_status) VALUES($1,$2,1,$3,$4,$5,100,$6::jsonb,'success')",[version,id,`${title}.txt`,hash,`original/${id}`,JSON.stringify(parsed)]);
   await tx.query('INSERT INTO document_source_references(id,document_id,source_id,source_document_id,source_path,filename,content_hash,object_key) VALUES($1,$2,$3,$2,$4,$5,$6,$7)',[randomUUID(),id,sourceId,`${sourceId}/${id}`,`${title}.txt`,hash,`original/${id}`]);
  });
  return {id,version,hash};
 }
 async function pair(left:Awaited<ReturnType<typeof seed>>,right:Awaited<ReturnType<typeof seed>>,relation:DuplicateAssessment['relation']='content_duplicate') {
  const id=randomUUID();
  await db.query('INSERT INTO document_duplicate_groups(id,pair_key,canonical_document_id,relation,score,reasons) VALUES($1,$2,$3,$4,.99,$5::jsonb)',[id,JSON.stringify([left.id,right.id].sort()),left.id,relation,JSON.stringify(['经程序比对'])]);
  for(const member of [left,right])await db.query('INSERT INTO document_duplicate_members(group_id,document_id,version_id) VALUES($1,$2,$3)',[id,member.id,member.version]);
  return id;
 }
 async function newVersion(document:Awaited<ReturnType<typeof seed>>) {
  const id=randomUUID();
  await db.query("INSERT INTO document_versions(id,document_id,version_number,filename,content_hash,object_key,size_bytes,status) VALUES($1,$2,2,'后续版本.txt',$1,'preserved-new-file',1,'active')",[id,document.id]);
  await db.query('UPDATE documents SET active_version_id=$2 WHERE id=$1',[document.id,id]);return id;
 }

 test('scan detects exact and normalized duplicates across sources without changing documents; dismissed proposals stay dismissed',async()=>{
  const unique=randomUUID();const body=`这份跨来源资料的正文与技术参数需要完整保存，编号 ${unique}。`;
  const title='跨来源安装说明';
  const left=await seed({body,hash:unique,title}),exact=await seed({body,hash:unique,title,sourceId:'local-import'}),normalized=await seed({body:body.replace('正文','正文\n'),title,sourceId:'local-import'});
  // Whitespace boundaries may move, but content remains identical after normalization.
  await db.query("UPDATE document_versions SET parsed_document=jsonb_set(parsed_document,'{plainText}',to_jsonb($2::text)) WHERE id=$1",[left.version,`${body}   附录  说明`]);
  await db.query("UPDATE document_versions SET parsed_document=jsonb_set(parsed_document,'{plainText}',to_jsonb($2::text)) WHERE id=$1",[normalized.version,`${body}\n附录\t说明`]);
  const scanned=await service.scan({documentIds:[left.id]});expect(scanned.scanned).toBe(1);expect(scanned.counts.exact_duplicate).toBeGreaterThanOrEqual(1);expect(scanned.counts.content_duplicate).toBeGreaterThanOrEqual(1);
  const groups=await service.list({documentId:left.id});expect(groups.items.some(g=>g.members.some(m=>m.documentId===exact.id)&&g.relation==='exact_duplicate')).toBe(true);
  const content=groups.items.find(g=>g.members.some(m=>m.documentId===normalized.id))!;expect(content.relation).toBe('content_duplicate');
  expect((await db.query('SELECT status,canonical_document_id FROM documents WHERE id=ANY($1::text[])',[[left.id,exact.id,normalized.id]])).every(row=>row.status==='active'&&row.canonical_document_id===null)).toBe(true);
  await service.dismiss(content.id);await service.detectDocument(left.id);expect((await service.detail(content.id)).status).toBe('dismissed');
  expect((await db.query('SELECT normalized_content_hash FROM document_versions WHERE id=$1',[left.version]))[0].normalized_content_hash).toMatch(/^[0-9a-f]{64}$/);
 });

 test('merge changes only canonical relationship, aggregates all original source references and can be undone',async()=>{
  const left=await seed({status:'needs_review'}),right=await seed({sourceId:'local-import'}),id=await pair(left,right);
  const originalVersions=await db.query('SELECT * FROM document_versions WHERE document_id=ANY($1::text[]) ORDER BY id',[[left.id,right.id]]);
  const merged=await service.merge(id,right.id);expect(merged.status).toBe('confirmed');expect(merged.canUndo).toBe(true);expect(merged.canonicalDocumentId).toBe(right.id);
  expect((await db.query('SELECT status,canonical_document_id FROM documents WHERE id=$1',[left.id]))[0]).toMatchObject({status:'needs_review',canonical_document_id:right.id});
  const references=await service.sourceReferences(left.id);expect(references.canonicalDocumentId).toBe(right.id);expect(references.items).toHaveLength(2);expect(references.items.map(r=>r.objectKey).sort()).toEqual([`original/${left.id}`,`original/${right.id}`].sort());
  expect(await db.query('SELECT * FROM document_versions WHERE document_id=ANY($1::text[]) ORDER BY id',[[left.id,right.id]])).toEqual(originalVersions);
  await service.undo(id);expect((await service.detail(id)).status).toBe('suggested');expect((await service.sourceReferences(left.id)).items).toHaveLength(1);
  expect((await db.query('SELECT canonical_document_id,status FROM documents WHERE id=$1',[left.id]))[0]).toMatchObject({canonical_document_id:null,status:'needs_review'});
  expect(await db.query("SELECT id FROM audit_events WHERE document_id=ANY($1::text[]) AND action IN ('dedup_merge','dedup_undo')",[[left.id,right.id]])).toHaveLength(4);
  // Canonical selection can be changed after undo, with another complete reversible operation.
  expect((await service.merge(id,left.id)).canonicalDocumentId).toBe(left.id);await service.undo(id);
 });

 test('version confirmation preserves review requirements, separates version relations and restores statuses on undo',async()=>{
  const old=await seed(),latest=await seed({status:'needs_review'}),id=await pair(old,latest,'possible_version');
  const confirmed=await service.confirmVersion(id,latest.id);expect(confirmed.operation).toBe('version');expect(confirmed.canUndo).toBe(true);
  expect((await db.query('SELECT status FROM documents WHERE id=$1',[old.id]))[0].status).toBe('superseded');
  expect((await db.query('SELECT status,canonical_document_id FROM documents WHERE id=$1',[latest.id]))[0]).toMatchObject({status:'needs_review',canonical_document_id:null});
  expect(await db.query('SELECT * FROM document_version_members m JOIN document_version_groups g ON g.id=m.group_id WHERE g.duplicate_group_id=$1',[id])).toHaveLength(2);
  await service.undo(id);expect((await db.query('SELECT status FROM documents WHERE id=$1',[old.id]))[0].status).toBe('active');
  expect((await db.query('SELECT status FROM document_version_groups WHERE duplicate_group_id=$1',[id]))[0].status).toBe('undone');
 });

 test('stale proposals and concurrent newer versions cannot be overwritten by confirm or undo',async()=>{
  const left=await seed(),right=await seed(),id=await pair(left,right);await newVersion(left);
  expect((await service.detail(id)).stale).toBe(true);await expect(service.merge(id,left.id)).rejects.toMatchObject({statusCode:409});
  const a=await seed(),b=await seed(),confirmed=await pair(a,b);await service.merge(confirmed,a.id);const latest=await newVersion(b);
  expect((await service.detail(confirmed)).canUndo).toBe(false);await expect(service.undo(confirmed)).rejects.toMatchObject({statusCode:409});
  expect((await db.query('SELECT active_version_id,canonical_document_id FROM documents WHERE id=$1',[b.id]))[0]).toMatchObject({active_version_id:latest,canonical_document_id:a.id});
 });

 test('overlapping groups cannot create canonical chains or cycles, and invalid choices do not partially mutate',async()=>{
  const a=await seed(),b=await seed(),c=await seed();const ab=await pair(a,b),ac=await pair(a,c),bc=await pair(b,c);
  await expect(service.merge(ab,c.id)).rejects.toMatchObject({statusCode:400});expect((await service.detail(ab)).status).toBe('suggested');
  await service.merge(ab,a.id);await expect(service.merge(ac,c.id)).rejects.toMatchObject({statusCode:409});await expect(service.merge(bc,b.id)).rejects.toMatchObject({statusCode:409});
  expect((await db.query('SELECT canonical_document_id FROM documents WHERE id=$1',[a.id]))[0].canonical_document_id).toBeNull();
  await service.undo(ab);expect((await service.merge(ac,c.id)).canonicalDocumentId).toBe(c.id);
 });

 test('version/similarity suggestions cannot accidentally be merged as duplicate sources',async()=>{
  const a=await seed(),b=await seed(),id=await pair(a,b,'possible_version');await expect(service.merge(id,a.id)).rejects.toMatchObject({statusCode:400});
  const c=await seed(),d=await seed(),duplicate=await pair(c,d,'exact_duplicate');await expect(service.confirmVersion(duplicate,c.id)).rejects.toMatchObject({statusCode:400});
 });

 test('three exact copies form one hash cohort and preserve three originals through merge and undo',async()=>{
  const hash=randomUUID(),body=`同一份原始资料，需要跨来源合并，技术信息及来源地址应永久保留。${hash}`;
  const a=await seed({hash,body,title:'三来源资料'}),b=await seed({hash,body,title:'三来源资料',sourceId:'local-import'}),c=await seed({hash,body,title:'三来源资料'});
  await service.scan({documentIds:[a.id,b.id,c.id]});
  const groups=(await service.list({documentId:a.id,relation:'exact_duplicate'})).items;
  expect(groups).toHaveLength(1);expect(groups[0].members).toHaveLength(3);
  await service.merge(groups[0].id,c.id);expect((await service.sourceReferences(a.id)).items).toHaveLength(3);
  expect((await db.query('SELECT canonical_document_id FROM documents WHERE id=ANY($1::text[])',[[a.id,b.id]])).every(row=>row.canonical_document_id===c.id)).toBe(true);
  await service.undo(groups[0].id);
  for(const document of [a,b,c])expect((await service.sourceReferences(document.id)).items).toHaveLength(1);
 });

 test('normalized cohorts accept three copies while later arrivals never mutate confirmed membership',async()=>{
  const body=`正文完整相同但导出格式各异；同一个技术知识对象应记录每一份原始来源。编号 ${randomUUID()}`;
  const a=await seed({body,title:'多格式技术说明'}),b=await seed({body,title:'多格式技术说明'}),c=await seed({body,title:'多格式技术说明'});
  await service.scan({documentIds:[a.id,b.id,c.id]});
  const original=(await service.list({documentId:a.id,relation:'content_duplicate'})).items;
  expect(original).toHaveLength(1);expect(original[0].members).toHaveLength(3);
  await service.merge(original[0].id,a.id);
  const later=await seed({body,title:'多格式技术说明'});await service.detectDocument(later.id);
  expect((await service.detail(original[0].id)).members).toHaveLength(3);
  const arrival=(await service.list({documentId:later.id,relation:'content_duplicate'})).items;
  expect(arrival).toHaveLength(1);expect(arrival[0].status).toBe('suggested');
  await expect(service.merge(arrival[0].id,a.id)).rejects.toMatchObject({statusCode:409});
  await service.undo(original[0].id);await service.detectDocument(later.id);
  expect((await service.detail(original[0].id)).members).toHaveLength(4);
 });

 test('source-scoped scan includes attached origins and API validates mutation requests',async()=>{
  const document=await seed();await db.query('INSERT INTO document_source_references(id,document_id,source_id,source_document_id,filename,content_hash,object_key) VALUES($1,$2,\'local-import\',$2,\'来源副本.txt\',$3,\'preserved-source-file\')',[randomUUID(),document.id,document.hash]);
  const scopedResult=await service.scan({documentIds:[document.id],source:'local_folder'});expect(scopedResult.scanned).toBe(1);
  const app=Fastify();app.setErrorHandler((error:any,_request,reply)=>reply.code(error.statusCode||500).send({message:error.message}));await registerDeduplicationRoutes(app,service);
  try {
   expect((await app.inject({method:'POST',url:'/api/duplicates/scan',payload:{unexpected:true}})).statusCode).toBe(400);
   expect((await app.inject({method:'POST',url:'/api/duplicates/missing/merge',payload:{canonicalDocumentId:document.id}})).statusCode).toBe(404);
   const response=await app.inject({method:'GET',url:`/api/documents/${document.id}/sources`});expect(response.statusCode).toBe(200);expect(response.json().items).toHaveLength(2);
   expect((await app.inject({method:'GET',url:'/api/duplicates?pageSize=5000'})).statusCode).toBe(400);
  }finally{await app.close();}
 });

 test('migration backfill retains primary provenance and source removal state on pre-existing databases',async()=>{
  // Execute the backfill statement alone against a row absent from the reference table.
  const document=await seed({sourceId:'local-import'});await db.query('DELETE FROM document_source_references WHERE document_id=$1',[document.id]);
  await db.query('UPDATE source_documents SET removed_from_source=true WHERE id=(SELECT source_document_id FROM documents WHERE id=$1)',[document.id]);
  const migration=await readFile(new URL('../migrations/006_document_deduplication.sql',import.meta.url),'utf8');
  const backfill=migration.match(/INSERT INTO document_source_references[\s\S]+?ON CONFLICT DO NOTHING;/)![0];await db.query(backfill);await db.query(backfill);
  const refs=(await service.sourceReferences(document.id)).items;expect(refs).toHaveLength(1);expect(refs[0]).toMatchObject({documentId:document.id,sourceId:'local-import',objectKey:`original/${document.id}`,removed:true});
 });
});
