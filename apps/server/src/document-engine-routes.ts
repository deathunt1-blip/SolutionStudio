import type {FastifyInstance} from 'fastify';
import type {DocumentEngine} from '../../../packages/document-engine/src/service.js';
import {HttpError} from '../../../packages/knowledge/src/service.js';
const params=(r:any)=>r.params as Record<string,string>;
const body=(r:any)=>{if(!r.body||typeof r.body!=='object'||Array.isArray(r.body))throw new HttpError(400,'请求应为 JSON 对象');return r.body as Record<string,any>;};
export async function registerDocumentEngineRoutes(app:FastifyInstance,engine:DocumentEngine){
 app.get('/api/document-templates',async()=>({items:await engine.templates()}));
 app.get('/api/projects/:id/documents',async r=>({items:await engine.list(params(r).id)}));
 app.post('/api/projects/:id/documents',async r=>({document:await engine.create(params(r).id,body(r))}));
 app.delete('/api/generated-documents/:id',async r=>engine.remove(params(r).id));
 app.post('/api/generated-documents/:id/copy',async r=>({document:await engine.copy(params(r).id)}));
 app.post('/api/generated-documents/:id/save-template',async r=>({template:await engine.saveTemplate(params(r).id,body(r))}));
 app.get('/api/generated-documents/:id/sections/:sectionId/references',async r=>({items:await engine.references(params(r).id,params(r).sectionId)}));
 app.get('/api/generated-documents/:id',async r=>({document:await engine.get(params(r).id)}));
 app.get('/api/generated-documents/:id/assets',async r=>{
  const document=await engine.get(params(r).id);
  const referenced=new Set(document.sections.flatMap(section=>section.blocks.flatMap(block=>block.type==='asset'?[block.assetId]:[])));
  if(document.outputProfile.coverLogoAssetId)referenced.add(document.outputProfile.coverLogoAssetId);
  const assets=await engine.projects.listAssets(document.projectId,true);
  return {items:assets.filter(asset=>asset.projectId===document.projectId&&(!asset.retiredAt||referenced.has(asset.id)))};
 });
 app.patch('/api/generated-documents/:id',async r=>({document:await engine.patch(params(r).id,body(r))}));
 app.patch('/api/generated-documents/:id/plan',async r=>({document:await engine.plan(params(r).id,body(r))}));
 app.patch('/api/generated-documents/:id/sections/:sectionId',async r=>({document:await engine.edit(params(r).id,params(r).sectionId,body(r))}));
 app.post('/api/generated-documents/:id/sections/:sectionId/sources',async r=>({document:await engine.addSectionSources(params(r).id,params(r).sectionId,body(r))}));
 app.post('/api/generated-documents/:id/generate',async(r,reply)=>reply.code(202).send({job:await engine.generate(params(r).id,body(r))}));
 app.get('/api/generated-documents/:id/jobs',async r=>({jobs:await engine.jobs(params(r).id)}));
 app.post('/api/generated-documents/:id/validate',async r=>({issues:await engine.validate(params(r).id)}));
 app.get('/api/generated-documents/:id/export.docx',async(r,reply)=>{const result=await engine.export(params(r).id);reply.header('Content-Disposition',`attachment; filename="proposal.docx"; filename*=UTF-8''${encodeURIComponent(result.filename)}`);reply.header('X-Validation-Issues',String(result.issueCount));return reply.type('application/vnd.openxmlformats-officedocument.wordprocessingml.document').send(result.buffer);});
}
