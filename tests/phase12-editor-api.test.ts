import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import JSZip from 'jszip';
import { createApp } from '../apps/server/src/app.js';
import type { DocumentEngine } from '../packages/document-engine/src/service.js';
import type { ProjectService } from '../packages/projects/src/service.js';
import type { KnowledgeService } from '../packages/knowledge/src/service.js';
import { renderMermaidPng } from '../packages/document-engine/src/diagrams.js';
import { cleanMermaidSource } from '../packages/document-engine/src/diagram-policy.js';
import { customerFacingProblems } from '../packages/document-engine/src/customer-facing.js';

const diagram='flowchart LR\n A[相机采集] --> B[同步与处理]\n B --> C[位姿数据输出]';
const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a6FEAAAAASUVORK5CYII=','base64');
function multipart(filename:string,bytes:Buffer,mimeType='image/png'){const boundary='studio-'+randomUUID();return {headers:{'content-type':`multipart/form-data; boundary=${boundary}`},payload:Buffer.concat([Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: ${mimeType}\r\n\r\n`),bytes,Buffer.from(`\r\n--${boundary}--\r\n`)])};}

describe('Phase 1.2 editor lifecycle, owned pictures and local Mermaid rendering',()=>{
 let directory:string,app:Awaited<ReturnType<typeof createApp>>,projects:ProjectService,engine:DocumentEngine,knowledge:KnowledgeService;
 beforeAll(async()=>{directory=await mkdtemp(join(tmpdir(),'studio-phase12-editor-'));app=await createApp({dataDir:directory,llmDisabled:true,providerFactory:()=>({generate:async()=>{throw Error('No model requests in editor API tests');}})});projects=(app as any).projects;engine=(app as any).documentEngine;knowledge=(app as any).knowledge;},30000);
 afterAll(async()=>{await app?.close();await rm(directory,{recursive:true,force:true});},30000);
 async function project(name:string){const project=await projects.create({name,description:'建设目标：完成机器人运动检测与位姿数据处理。'});await projects.confirmContext(project.id,(await projects.getContext(project.id)).revision);return project;}
 async function globalDoc(){const id=randomUUID(),version=randomUUID(),source=randomUUID(),zip=new JSZip();zip.file('word/media/image1.png',png);zip.file('word/media/unsafe.svg','<svg/>');zip.file('word/document.xml','<document/>');const bytes=await zip.generateAsync({type:'nodebuffer'}),key=`test/${id}.docx`;await knowledge.storage.put(key,bytes);await knowledge.db.transaction(async tx=>{await tx.query("INSERT INTO source_documents(id,source_id,source_document_id,content_hash) VALUES($1,'manual',$1,$1)",[source]);await tx.query("INSERT INTO documents(id,organization_id,workspace_id,source_document_id,title,status,active_version_id) VALUES($1,'default','default',$2,'全局产品图册','active',$3)",[id,source,version]);await tx.query("INSERT INTO document_versions(id,document_id,version_number,filename,content_hash,object_key,size_bytes,parse_status) VALUES($1,$2,1,'产品图册.docx',$3,$4,$5,'success')",[version,id,createHash('sha256').update(bytes).digest('hex'),key,bytes.length]);});return {id,version};}

 test('renders a real themed Mermaid PNG with readable-size dimensions and keeps script/links out',async()=>{
  const bytes=await renderMermaidPng(diagram);expect(bytes.subarray(0,8).toString('hex')).toBe('89504e470d0a1a0a');expect(bytes.readUInt32BE(16)).toBeGreaterThan(100);expect(bytes.readUInt32BE(20)).toBeGreaterThan(30);expect(bytes.length).toBeGreaterThan(1000);
  for(const source of ['flowchart LR\n click A "https://example.com"','flowchart LR\n A["<script>alert(1)</script>"]','flowchart LR\n A@{ img: "//example.com/pixel.png" }','%%{init:{securityLevel:"loose"}}%%\nflowchart LR\n A-->B'])expect(()=>cleanMermaidSource(source)).toThrow();
 },30000);
 test('customer-facing validation also inspects diagram node labels',()=>{
  const issues=customerFacingProblems([{id:'diagram-check',type:'diagram',diagramType:'mermaid',source:'flowchart LR\n A[engineeringOpticsSource 待确认] --> B[输出]',caption:'系统结构图',generatedBy:'ai',sourceRefs:[]}]);expect(issues).toHaveLength(1);expect(issues[0].message).toContain('engineeringOpticsSource');
 });
 test('export blocks internal working language introduced by manual editing and succeeds after correction',async()=>{
  const p=await project('成稿导出校验'),doc=await engine.create(p.id),section=doc.sections[0];
  await engine.edit(doc.id,section.id,{revision:section.revision,blocks:[{type:'paragraph',text:'知识库检索结果中的指标尚未明确，待确认。'}]});
  const rejected=await app.inject(`/api/generated-documents/${doc.id}/export.docx`);expect(rejected.statusCode).toBe(422);expect(rejected.json().message).toContain('客户表达');
  const current=await engine.get(doc.id);await engine.edit(doc.id,section.id,{revision:current.sections[0].revision,blocks:[{type:'paragraph',text:'系统围绕项目任务组织数据采集、处理与成果交付。'}]});
  const exported=await app.inject(`/api/generated-documents/${doc.id}/export.docx`);expect(exported.statusCode).toBe(200);
  const zip=await JSZip.loadAsync(exported.rawPayload);expect(await zip.file('word/document.xml')!.async('string')).not.toContain('知识库检索');
 });
 test('upload, download, cover and inserted-figure APIs enforce project asset ownership',async()=>{
  const a=await project('图片项目甲'),b=await project('图片项目乙'),doc=await engine.create(a.id),before=(await projects.getContext(a.id)).revision;
  const upload=await app.inject({method:'POST',url:`/api/projects/${a.id}/assets?role=logo`,...multipart('青瞳 Logo.png',png)});expect(upload.statusCode).toBe(200);const asset=upload.json().asset;expect(asset.role).toBe('logo');expect((await projects.getContext(a.id)).revision).toBe(before);
  expect((await app.inject(`/api/projects/${a.id}/assets/${asset.id}`)).rawPayload).toEqual(png);expect((await app.inject(`/api/projects/${b.id}/assets/${asset.id}`)).statusCode).toBe(404);
  const foreign=(await app.inject({method:'POST',url:`/api/projects/${b.id}/assets`,...multipart('foreign.png',png)})).json().asset;
  expect((await app.inject({method:'PATCH',url:`/api/generated-documents/${doc.id}`,payload:{revision:doc.revision,outputProfile:{coverLogoAssetId:foreign.id}}})).statusCode).toBe(400);
  const section=doc.sections[0],foreignEdit=await app.inject({method:'PATCH',url:`/api/generated-documents/${doc.id}/sections/${section.id}`,payload:{revision:section.revision,blocks:[{type:'asset',assetId:foreign.id,caption:'错误项目的图'}]}});expect(foreignEdit.statusCode).toBe(400);
  const ownEdit=await app.inject({method:'PATCH',url:`/api/generated-documents/${doc.id}/sections/${section.id}`,payload:{revision:section.revision,blocks:[{type:'asset',assetId:asset.id,caption:'项目图'}]}});expect(ownEdit.statusCode).toBe(200);expect(ownEdit.json().document.sections[0].blocks[0].assetId).toBe(asset.id);
  const invalid=await app.inject({method:'POST',url:`/api/projects/${a.id}/assets`,...multipart('html.png',Buffer.from('<script>bad</script>'))});expect(invalid.statusCode).toBe(400);
 });
 test('knowledge images are catalogued from active originals, copied into the project and version-pinned',async()=>{
  const global=await globalDoc(),p=await project('图册选用项目'),catalog=await app.inject(`/api/documents/${global.id}/images`);expect(catalog.statusCode).toBe(200);expect(catalog.json().items).toHaveLength(1);const item=catalog.json().items[0];expect(item.versionId).toBe(global.version);expect(item.filename).toBe('image1.png');expect((await app.inject(item.url)).rawPayload).toEqual(png);
  const imported=await app.inject({method:'POST',url:`/api/projects/${p.id}/knowledge-images`,payload:{documentId:global.id,imageId:item.id}});expect(imported.statusCode).toBe(200);const asset=imported.json().asset;expect(asset.projectId).toBe(p.id);expect(asset.sourceRef.versionId).toBe(global.version);
  await knowledge.db.query("UPDATE documents SET status='archived' WHERE id=$1",[global.id]);expect((await app.inject(item.url)).statusCode).toBe(404);expect((await app.inject({method:'POST',url:`/api/projects/${p.id}/knowledge-images`,payload:{documentId:global.id,imageId:item.id}})).statusCode).toBe(404);expect((await app.inject(`/api/projects/${p.id}/assets/${asset.id}`)).rawPayload).toEqual(png);
  expect((await app.inject(`/api/documents/${global.id}/images/../../private-secrets.json`)).statusCode).toBe(404);
 });
 test('document asset listing preserves only its referenced retired images and cover within its owning project',async()=>{
  const p=await project('保留旧稿图片'),other=await project('另一个图片项目');
  const figure=await projects.addAsset(p.id,{filename:'旧正文图.png',buffer:png}),logo=await projects.addAsset(p.id,{filename:'旧封面.png',buffer:png,role:'logo'}),unused=await projects.addAsset(p.id,{filename:'未引用旧图.png',buffer:png}),active=await projects.addAsset(p.id,{filename:'在用图.png',buffer:png}),foreign=await projects.addAsset(other.id,{filename:'别的项目.png',buffer:png});
  let doc=await engine.create(p.id);doc=await engine.edit(doc.id,doc.sections[0].id,{revision:doc.sections[0].revision,blocks:[{type:'asset',assetId:figure.id,caption:'保留正文图'}]});doc=await engine.patch(doc.id,{revision:doc.revision,outputProfile:{coverLogoAssetId:logo.id}});
  await engine.db.query('UPDATE project_assets SET retired_at=now() WHERE id=ANY($1::text[])',[[figure.id,logo.id,unused.id]]);
  const response=await app.inject(`/api/generated-documents/${doc.id}/assets`);expect(response.statusCode).toBe(200);
  const items=response.json().items;expect(items.map((asset:any)=>asset.id).sort()).toEqual([figure.id,logo.id,active.id].sort());expect(items.find((asset:any)=>asset.id===figure.id).retiredAt).toBeTruthy();expect(items.some((asset:any)=>asset.id===foreign.id)).toBe(false);
  expect((await app.inject(figure.url)).rawPayload).toEqual(png);expect((await projects.get(p.id)).assets.map(asset=>asset.id)).toEqual([active.id]);
  const another=await engine.create(p.id);expect((await app.inject(`/api/generated-documents/${another.id}/assets`)).json().items.map((asset:any)=>asset.id)).toEqual([active.id]);
  expect((await app.inject(`/api/generated-documents/${randomUUID()}/assets`)).statusCode).toBe(404);
 });
 test('valid diagrams persist their source and export as PNG while malformed edits preserve previous content',async()=>{
  const p=await project('技术图导出'),doc=await engine.create(p.id),section=doc.sections[0];
  const invalid=await app.inject({method:'PATCH',url:`/api/generated-documents/${doc.id}/sections/${section.id}`,payload:{revision:section.revision,blocks:[{type:'diagram',source:'flowchart LR\n click A "https://external.example"'}]}});expect(invalid.statusCode).toBe(400);expect((await engine.get(doc.id)).sections[0].blocks).toHaveLength(0);
  const edited=await app.inject({method:'PATCH',url:`/api/generated-documents/${doc.id}/sections/${section.id}`,payload:{revision:section.revision,blocks:[{type:'paragraph',text:'系统以模块化结构完成采集、处理与数据输出。'},{type:'diagram',source:diagram,caption:'系统处理流程',sourceRefs:[{type:'user',id:'forged',label:'fake'}],generatedBy:'ai'}]}});expect(edited.statusCode).toBe(200);const body=edited.json().document;expect(body.sections[0].blocks[1].source).toBe(diagram);expect(body.sections[0].blocks[1].generatedBy).toBe('user');expect(body.sections[0].blocks[1].sourceRefs).toEqual([]);
  const exported=await app.inject(`/api/generated-documents/${doc.id}/export.docx`);
  expect(exported.statusCode).toBe(200);
  const zip=await JSZip.loadAsync(exported.rawPayload);
  const images=Object.keys(zip.files).filter(path=>path.startsWith('word/media/')&&!zip.files[path].dir);
  expect(images).toHaveLength(1);
  const bytes=await zip.file(images[0])!.async('nodebuffer');
  expect(bytes.subarray(0,8).toString('hex')).toBe('89504e470d0a1a0a');
  expect(await zip.file('word/document.xml')!.async('string')).toContain('系统处理流程');
 },30000);
 test('copy and delete affect only the selected proposal; project context, private input and global knowledge survive',async()=>{
  const p=await project('方案生命周期'),global=await globalDoc(),input=await projects.addText(p.id,{title:'客户输入',text:'建设目标：机器人运动分析。'});await projects.confirmContext(p.id,input.context.revision);let doc=await engine.create(p.id);doc=await engine.edit(doc.id,doc.sections[0].id,{revision:doc.sections[0].revision,blocks:[{type:'paragraph',text:'方案采用功能模块协作组织数据采集与处理。'}]});
  const context=await projects.getContext(p.id),globalBefore=await knowledge.db.query('SELECT * FROM documents WHERE id=$1',[global.id]),privateBefore=await projects.get(p.id);
  const copied=await app.inject({method:'POST',url:`/api/generated-documents/${doc.id}/copy`,payload:{}});expect(copied.statusCode).toBe(200);const copy=copied.json().document;expect(copy.id).not.toBe(doc.id);expect(copy.sections[0].id).not.toBe(doc.sections[0].id);expect(copy.sections[0].blocks[0].id).not.toBe(doc.sections[0].blocks[0].id);expect(copy.sections[0].blocks[0].text).toBe(doc.sections[0].blocks[0].type==='paragraph'?doc.sections[0].blocks[0].text:'');
  expect((await app.inject({method:'DELETE',url:`/api/generated-documents/${doc.id}`})).statusCode).toBe(200);expect((await app.inject(`/api/generated-documents/${doc.id}`)).statusCode).toBe(404);expect((await app.inject(`/api/generated-documents/${copy.id}`)).statusCode).toBe(200);expect(await projects.getContext(p.id)).toEqual(context);expect((await projects.get(p.id)).inputs).toEqual(privateBefore.inputs);expect(await knowledge.db.query('SELECT * FROM documents WHERE id=$1',[global.id])).toEqual(globalBefore);expect(await knowledge.db.query('SELECT id FROM document_sections WHERE document_id=$1',[doc.id])).toEqual([]);
  const privateRows=await knowledge.db.query('SELECT id FROM documents WHERE project_id=$1',[p.id]);expect(privateRows).toHaveLength(1);expect(privateRows[0].id).toBe(input.input.documentId);
 });
 test('an outline template preserves structure and visual choices without carrying private prose into another project',async()=>{
  const a=await project('目录模板原项目'),b=await project('目录模板新项目');let doc=await engine.create(a.id);
  doc=await engine.plan(doc.id,{revision:doc.revision,sections:[{title:'总体设计',level:1,visualPlan:{type:'mermaid',description:'模块关系'}},{title:'应用流程',level:2,visualPlan:{type:'none'}}]});
  doc=await engine.edit(doc.id,doc.sections[0].id,{revision:doc.sections[0].revision,blocks:[{type:'paragraph',text:'只属于原项目的保密内容。'}]});
  const saved=await app.inject({method:'POST',url:`/api/generated-documents/${doc.id}/save-template`,payload:{name:'模块化技术方案'}});expect(saved.statusCode).toBe(200);
  const created=await app.inject({method:'POST',url:`/api/projects/${b.id}/documents`,payload:{templateId:saved.json().template.id}});expect(created.statusCode).toBe(200);const next=created.json().document;
  expect(next.sections.map((s:any)=>[s.title,s.level,s.visualPlan.type])).toEqual([['总体设计',1,'mermaid'],['应用流程',2,'none']]);expect(next.sections.every((s:any)=>s.blocks.length===0)).toBe(true);expect(JSON.stringify(next)).not.toContain('只属于原项目');expect(next.projectId).toBe(b.id);
 });
});
