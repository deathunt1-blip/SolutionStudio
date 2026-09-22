import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { HttpError, type KnowledgeService } from '../../../packages/knowledge/src/service.js';
import { documentSelect, filters } from '../../../packages/knowledge/src/repository.js';
import type { RefinementService } from '../../../packages/refinement/src/service.js';

const ids=z.array(z.string().min(1).max(200)).min(1).max(1000);
const selection=z.object({mode:z.enum(['all','filtered','first10']),filters:z.record(z.string().max(40),z.string().max(1000)).optional()}).strict();
const scope={documentIds:ids.optional(),selection:selection.optional()};
const budget=z.number().finite().min(1).max(100);
const field=z.enum(['title','summary','document_type','authority','applications','topics','products']);
function parsed<T>(schema:z.ZodType<T>,input:unknown):T {const result=schema.safeParse(input);if(!result.success)throw new HttpError(400,'请求参数无效，请检查选择范围、操作和预算。');return result.data;}
export async function registerRefinementRoutes(app:FastifyInstance,knowledge:KnowledgeService,refinement:RefinementService) {
 const resolveIds=async(input:{documentIds?:string[];selection?:{mode:string;filters?:Record<string,string>}},eligible=true)=>{
  if(input.documentIds&&input.selection)throw new HttpError(400,'只能指定一种资料选择范围');
  if(input.documentIds)return [...new Set(input.documentIds)];
  if(!input.selection)throw new HttpError(400,'请明确选择资料或整理范围');
  const q=input.selection.mode==='all'?{}:input.selection.filters||{};
  const f=filters(q);
  const limit=input.selection.mode==='first10'?10:1001;
  const rows=await knowledge.db.query(`SELECT found.id FROM (${documentSelect} WHERE ${f.where}${eligible?" AND d.status IN ('active','needs_review')":" AND d.status<>'archived'"} ORDER BY d.updated_at DESC,d.id LIMIT ${limit}) found`,f.values);
  if(rows.length>1000)throw new HttpError(400,'单次最多选择 1000 份，请缩小筛选范围');
  if(!rows.length)throw new HttpError(400,'此范围没有可整理的已解析资料');
  return rows.map(row=>String(row.id));
 };
 app.post('/api/refinement/batches',async(request,reply)=>{
  const input=parsed(z.object({...scope,operations:z.array(z.enum(['title','summary','classification','tags'])).min(1).max(4),includeUserFields:z.boolean().optional(),includeUserTitles:z.boolean().optional(),budgetCny:budget.default(10)}).strict(),request.body);
  const documentIds=await resolveIds(input);const {selection:_,...options}=input;
  return reply.code(202).send({batch:await refinement.createBatch({...options,documentIds})});
 });
 app.get('/api/refinement/batches',async()=>({items:await refinement.listBatches()}));
 const id=(request:any)=>String(request.params.id);
 app.get('/api/refinement/batches/:id',async request=>refinement.getBatch(id(request)));
 app.post('/api/refinement/batches/:id/apply',async request=>refinement.applyBatch(id(request),parsed(z.object({proposalIds:ids.optional(),fields:z.array(field).min(1).max(7).optional(),minConfidence:z.number().min(0).max(1).optional(),edits:z.record(z.string().max(200),z.unknown()).optional()}).strict(),request.body||{})));
 app.post('/api/refinement/batches/:id/reject',async request=>refinement.rejectBatch(id(request),parsed(z.object({proposalIds:ids.optional()}).strict(),request.body||{})));
 app.post('/api/refinement/batches/:id/rollback',async request=>{parsed(z.object({}).strict(),request.body||{});return refinement.rollbackBatch(id(request));});
 app.post('/api/documents/batch-archive',async request=>{
  const input=parsed(z.object(scope).strict(),request.body);return refinement.batchArchive({documentIds:await resolveIds(input,false)});
 });
 app.post('/api/corpus/analyze',async(request,reply)=>{
  const input=parsed(z.object({...scope,budgetCny:budget.default(5)}).strict(),request.body||{});
  const documentIds=await resolveIds(input.documentIds||input.selection?input:{selection:{mode:'all'}});
  return reply.code(202).send({analysis:await refinement.analyzeCorpus({documentIds,budgetCny:input.budgetCny})});
 });
 app.get('/api/corpus/proposals',async()=>{const result=await refinement.listCorpusProposals();return {items:result.proposals,analyses:result.analyses};});
 app.post('/api/corpus/proposals/:id/accept',async request=>refinement.acceptCorpusProposal(id(request),parsed(z.object({name:z.string().trim().min(1).max(200).optional(),description:z.string().max(2000).optional(),canonical:z.string().min(1).max(200).optional(),aliases:z.array(z.string().min(1).max(200)).max(100).optional(),documentIds:ids.optional()}).strict(),request.body||{})));
 app.post('/api/corpus/proposals/:id/reject',async request=>refinement.rejectCorpusProposal(id(request)));
 app.get('/api/groups',async()=>({items:await refinement.listGroups()}));
 app.post('/api/groups',async request=>{const input=parsed(z.object({...scope,name:z.string().trim().min(1).max(200),description:z.string().max(2000).optional()}).strict(),request.body);const {selection:_,...value}=input;return refinement.createGroup({...value,documentIds:input.selection?await resolveIds(input):input.documentIds});});
 app.post('/api/groups/merge',async request=>refinement.mergeGroups(parsed(z.object({sourceIds:ids,targetId:z.string().min(1).max(200)}).strict(),request.body)));
}
