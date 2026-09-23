import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { HttpError, type KnowledgeService } from '../../../packages/knowledge/src/service.js';
import { documentSelect, filters } from '../../../packages/knowledge/src/repository.js';
import type { KnowledgeEnrichmentService } from '../../../packages/knowledge-enrichment/src/service.js';
import { retrieveSections } from '../../../packages/knowledge-enrichment/src/retrieval.js';
import { tagDimensions } from '../../../packages/knowledge-enrichment/src/types.js';

const ids=z.array(z.string().min(1).max(200)).min(1).max(1000);
function parsed<T>(schema:z.ZodType<T>,input:unknown):T{const result=schema.safeParse(input);if(!result.success)throw new HttpError(400,'请求参数无效，请检查资料范围和整理设置');return result.data;}
const quality=z.object({quality:z.enum(['normal','good','preferred'])}).strict();
const list=z.array(z.string().max(200)).max(100);
export async function registerEnrichmentRoutes(app:FastifyInstance,knowledge:KnowledgeService,enrichment:KnowledgeEnrichmentService){
 const id=(request:any)=>String(request.params.id);
 app.post('/api/enrichment/batches',async(request,reply)=>{
  const input=parsed(z.object({documentIds:ids.optional(),selection:z.object({mode:z.enum(['all','filtered','first10']),filters:z.record(z.string().max(40),z.string().max(1000)).optional()}).strict().optional(),budgetCny:z.number().finite().positive().nullable().optional()}).strict(),request.body);
  if(Boolean(input.documentIds)===Boolean(input.selection))throw new HttpError(400,'请选择一种资料范围');
  let documentIds=input.documentIds;
  if(input.selection){const query=input.selection.mode==='all'?{}:input.selection.filters??{},f=filters(query);const rows=await knowledge.db.query(`SELECT found.id FROM (${documentSelect} WHERE ${f.where} AND d.status IN ('active','needs_review') AND d.canonical_document_id IS NULL AND v.parse_status IN ('success','partial') ORDER BY d.updated_at DESC,d.id LIMIT ${input.selection.mode==='first10'?10:1001}) found`,f.values);if(rows.length>1000)throw new HttpError(400,'单批最多 1000 份，请使用筛选缩小范围');documentIds=rows.map(row=>String(row.id));}
  return reply.code(202).send({batch:await enrichment.createBatch({documentIds:documentIds!,budgetCny:input.budgetCny})});
 });
 app.get('/api/enrichment/batches',async()=>({items:await enrichment.listBatches()}));
 app.get('/api/enrichment/batches/:id',async request=>enrichment.getBatch(id(request)));
 app.post('/api/enrichment/batches/:id/cancel',async request=>enrichment.cancelBatch(id(request)));
 app.get('/api/documents/:id/enrichment',async request=>enrichment.listSections(id(request)));
 app.patch('/api/documents/:id/reference-quality',async request=>enrichment.setDocumentQuality(id(request),parsed(quality,request.body).quality));
 app.patch('/api/knowledge-sections/:id/reference-quality',async request=>enrichment.setSectionQuality(id(request),parsed(quality,request.body).quality));
 app.get('/api/enrichment/aliases',async()=>({items:await enrichment.listAliases()}));
 app.post('/api/enrichment/aliases/:id/accept',async request=>({items:await enrichment.decideAlias(id(request),true,parsed(z.object({dimension:z.enum(tagDimensions).optional()}).strict(),request.body??{}).dimension)}));
 app.post('/api/enrichment/aliases/:id/reject',async request=>({items:await enrichment.decideAlias(id(request),false)}));
 app.get('/api/enrichment/taxonomy',async()=>enrichment.registry());
 app.post('/api/knowledge-sections/search',async request=>{
  const input=parsed(z.object({role:z.string().min(1).max(100),query:z.string().max(3000).optional(),products:list.optional(),sourceIds:ids.optional(),limit:z.number().int().min(1).max(30).optional(),fingerprint:z.object({applications:list.optional(),targetObjects:list.optional(),scenarios:list.optional(),topics:list.optional(),modules:list.optional(),products:list.optional(),environment:list.optional(),constraints:list.optional()}).strict().optional()}).strict(),request.body);
  return {items:await retrieveSections(knowledge.db,input)};
 });
}
