import {afterAll,beforeAll,describe,expect,test,vi} from 'vitest';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {createApp} from '../apps/server/src/app.js';
import type {DocumentEngine} from '../packages/document-engine/src/service.js';
import type {ProjectService} from '../packages/projects/src/service.js';
import type {GeneratedDocument} from '../packages/document-engine/src/types.js';
import {claimEvidenceProblems} from '../packages/document-engine/src/claim-evidence.js';

describe('manual section evidence is server-owned, current and revision protected',()=>{
 let directory:string,app:Awaited<ReturnType<typeof createApp>>,engine:DocumentEngine,projects:ProjectService,calls=0;
 beforeAll(async()=>{directory=await mkdtemp(join(tmpdir(),'studio-manual-sources-'));app=await createApp({dataDir:directory,providerFactory:()=>({generate:async()=>{calls++;throw Error('No model calls for manual evidence');}})});engine=(app as any).documentEngine;projects=(app as any).projects;await engine.close();await (app as any).knowledge.settings.patch({llm:{apiKey:'synthetic-test-key',baseUrl:'https://api.moonshot.cn/v1',model:'kimi-k3'}});},30000);
 afterAll(async()=>{await app?.close();await rm(directory,{recursive:true,force:true});},30000);
 async function proposal(){
  const p=await projects.create({name:'MC4000 运动检测',description:'建设目标：进行位姿检测。'});await projects.confirmContext(p.id,(await projects.getContext(p.id)).revision);let doc=await engine.create(p.id);
  doc=await engine.plan(doc.id,{revision:doc.revision,sections:[{title:'项目概述',level:1}]});
  await engine.db.query("UPDATE generated_documents SET context_snapshot=jsonb_set(context_snapshot,'{products}',$2::jsonb) WHERE id=$1",[doc.id,JSON.stringify(['MC4000'])]);
  doc=await engine.edit(doc.id,doc.sections[0].id,{revision:doc.sections[0].revision,blocks:[{type:'paragraph',text:'MC4000 的视场角为 53°×53°。'}]});
  await engine.db.query('UPDATE document_sections SET claims=$2::jsonb WHERE id=$1',[doc.sections[0].id,JSON.stringify([{text:'MC4000 的视场角为 53°×53°。',kind:'capability',factIds:[],sourceIds:['old-model-citation']}])]);
  await engine.validate(doc.id);return engine.get(doc.id);
 }
 async function source(options:{model?:string;authority?:string;documentType?:string;scope?:string;projectId?:string;status?:string;canonical?:string}={}){
  const id=randomUUID(),version=randomUUID(),chunk=randomUUID(),origin=randomUUID(),model=options.model??'MC4000',title=`${model} 规格书`,text=`${model} 的视场角为 53°×53°。`;
  await engine.db.transaction(async tx=>{
   await tx.query("INSERT INTO source_documents(id,source_id,source_document_id,content_hash) VALUES($1,'manual',$1,$1)",[origin]);
   await tx.query("INSERT INTO documents(id,organization_id,workspace_id,source_document_id,title,canonical_title,status,active_version_id,scope,project_id,canonical_document_id) VALUES($1,'default','default',$2,$3,$3,$4,$5,$6,$7,$8)",[id,origin,title,options.status??'active',version,options.scope??'global',options.projectId??null,options.canonical??null]);
   await tx.query("INSERT INTO document_versions(id,document_id,version_number,filename,content_hash,object_key,size_bytes,parse_status) VALUES($1,$2,1,'fixture.docx',$1,$1,1,'success')",[version,id]);
   for(const [field,value] of Object.entries({authority:options.authority??'authoritative',documentType:options.documentType??'product_document',products:[model]}))await tx.query("INSERT INTO classification_results(version_id,field,value,confidence,source) VALUES($1,$2,$3::jsonb,1,'user')",[version,field,JSON.stringify(value)]);
   await tx.query("INSERT INTO knowledge_chunks(id,document_id,version_id,chunk_order,heading_path,text,summary,topics,products,metadata,search_vector) VALUES($1,$2,$3,0,'[]',$4,'','[]',$5::jsonb,'{}',to_tsvector('simple',$4))",[chunk,id,version,text,JSON.stringify([model])]);
  });return {id,version,chunk,text};
 }
 const payload=(doc:GeneratedDocument,sourceIds:string[])=>({revision:doc.sections[0].revision,documentRevision:doc.revision,sourceIds});
 const add=(doc:GeneratedDocument,sourceIds:string[])=>engine.addSectionSources(doc.id,doc.sections[0].id,payload(doc,sourceIds));
 const endpoint=(doc:GeneratedDocument)=>`/api/generated-documents/${doc.id}/sections/${doc.sections[0].id}/sources`;
 test('adds authoritative selected-product evidence to an edited introduction without changing body, claims or protection',async()=>{
  const doc=await proposal(),manual=await source();expect(doc.issues.some(issue=>issue.type==='unsupported_claim')).toBe(true);
  const response=await app.inject({method:'POST',url:endpoint(doc),payload:payload(doc,[manual.chunk])});expect(response.statusCode).toBe(200);
  const result:GeneratedDocument=response.json().document,s=result.sections[0];
  expect(s.blocks).toEqual(doc.sections[0].blocks);expect(s.claims).toEqual(doc.sections[0].claims);expect(s.edited).toBe(true);expect(s.revision).toBe(doc.sections[0].revision+1);expect(result.revision).toBe(doc.revision+1);
  expect(s.sourceRefs).toEqual([expect.objectContaining({id:manual.chunk,versionId:manual.version,evidence:manual.text,authority:'authoritative',use:'fact_evidence',manualEvidence:true})]);
  expect(result.issues.filter(issue=>issue.type==='unsupported_claim')).toEqual([]);expect(calls).toBe(0);
  expect(await engine.db.query("SELECT id FROM audit_events WHERE generated_document_id=$1 AND action='section_sources_added'",[doc.id])).toHaveLength(1);
 });
 test('historical text may be appended for writing but cannot prove a capability',async()=>{
  const doc=await proposal(),history=await source({authority:'reference',documentType:'solution'}),result=await add(doc,[history.chunk]);
  expect(result.sections[0].sourceRefs[0]).toMatchObject({use:'writing_reference',manualEvidence:true});expect(result.issues.some(issue=>issue.type==='unsupported_claim')).toBe(true);
 });
 test('rejects forged evidence fields, source objects and duplicate IDs instead of trusting the client',async()=>{
  const doc=await proposal(),manual=await source();
  for(const invalid of [{...payload(doc,[manual.chunk]),sourceRefs:[{id:manual.chunk,evidence:'伪造',authority:'authoritative',manualEvidence:true}]},{...payload(doc,[manual.chunk]),evidence:'伪造'},{...payload(doc,[manual.chunk]),sourceIds:[{id:manual.chunk}]},payload(doc,[manual.chunk,manual.chunk])]){
   expect((await app.inject({method:'POST',url:endpoint(doc),payload:invalid})).statusCode).toBe(400);
  }expect((await engine.get(doc.id)).revision).toBe(doc.revision);
 });
 test('requires every selected source to be current, canonical, scoped and model compatible; partial selection is atomic',async()=>{
  const doc=await proposal(),good=await source(),otherProject=await projects.create({name:'另一个项目'});
  const invalid=[await source({model:'MC400'}),await source({documentType:'standard'}),await source({authority:'style_only'}),await source({status:'archived'}),await source({canonical:good.id}),await source({scope:'project',projectId:otherProject.id})];
  const old=await source();await engine.db.query('UPDATE documents SET active_version_id=$2 WHERE id=$1',[old.id,good.version]);invalid.push(old);
  for(const item of invalid)await expect(add(doc,[good.chunk,item.chunk])).rejects.toMatchObject({statusCode:422});
  expect((await engine.get(doc.id)).sections[0].sourceRefs).toEqual([]);expect((await engine.get(doc.id)).revision).toBe(doc.revision);
 });
 test('rechecks archival after retrieval inside the write transaction',async()=>{
  const doc=await proposal(),manual=await source(),original=engine.retriever.retrieve.bind(engine.retriever);
  const spy=vi.spyOn(engine.retriever,'retrieve').mockImplementationOnce(async(...args)=>{const found=await original(...args);await engine.db.query("UPDATE documents SET status='archived' WHERE id=$1",[manual.id]);return found;});
  try{await expect(add(doc,[manual.chunk])).rejects.toMatchObject({statusCode:409});expect((await engine.get(doc.id)).revision).toBe(doc.revision);}finally{spy.mockRestore();}
 });
 test('simultaneous adds accept one revision only and a stale section write cannot overwrite its references',async()=>{
  const doc=await proposal(),manual=await source(),results=await Promise.allSettled([add(doc,[manual.chunk]),add(doc,[manual.chunk])]);
  expect(results.filter(result=>result.status==='fulfilled')).toHaveLength(1);expect(results.filter(result=>result.status==='rejected')).toEqual([expect.objectContaining({reason:expect.objectContaining({statusCode:409})})]);
  await expect(engine.edit(doc.id,doc.sections[0].id,{revision:doc.sections[0].revision,blocks:doc.sections[0].blocks})).rejects.toMatchObject({statusCode:409});
 });
 test('cannot append during a generation job or to an outdated project snapshot',async()=>{
  const doc=await proposal(),manual=await source();await engine.generate(doc.id,{expectedRevision:doc.revision,sectionIds:[doc.sections[0].id],overwriteEdited:true,config:{limitsEnabled:false}});
  await expect(add(doc,[manual.chunk])).rejects.toMatchObject({statusCode:409});expect((await engine.get(doc.id)).sections[0].sourceRefs).toEqual([]);
  const stale=await proposal();await engine.db.query('UPDATE projects SET input_revision=input_revision+1 WHERE id=$1',[stale.projectId]);await expect(add(stale,[manual.chunk])).rejects.toMatchObject({statusCode:409});
 });
 test('manual evidence flags do not upgrade customer requirements, standards or another product',async()=>{
  const doc=await proposal(),context=(await engine.db.query('SELECT context_snapshot FROM generated_documents WHERE id=$1',[doc.id]))[0].context_snapshot,claim=doc.sections[0].claims;
  const base={type:'knowledge_chunk' as const,id:'manual',label:'MC4000 规格书',evidence:'MC4000 的视场角为 53°×53°。',authority:'authoritative',use:'fact_evidence' as const,manualEvidence:true as const};
  expect(claimEvidenceProblems(claim,context,[base])).toEqual([]);
  for(const source of [{...base,label:'MC4000 技术标准'},{...base,label:'MC400 规格书',evidence:'MC400 的视场角为 53°×53°。'},{...base,labelKind:'requirement' as const},{...base,use:'writing_reference' as const}])expect(claimEvidenceProblems(claim,context,[source])).toHaveLength(1);
 });
});
