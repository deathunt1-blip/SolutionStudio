import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { HttpError } from '../../../packages/knowledge/src/service.js';
import type { DeduplicationService } from '../../../packages/deduplication/src/service.js';

const relation=z.enum(['exact_duplicate','content_duplicate','near_duplicate','possible_version','similar']);
const idSchema=z.string().min(1).max(200);
const scanSchema=z.object({documentIds:z.array(idSchema).min(1).max(10000).optional(),source:z.string().min(1).max(200).optional(),filters:z.record(z.string().max(40),z.string().max(1000)).optional()}).strict();
function parse<T>(schema:z.ZodType<T>,value:unknown):T {const result=schema.safeParse(value);if(!result.success)throw new HttpError(400,'去重请求参数无效，请检查范围或主资料选择');return result.data;}

export async function registerDeduplicationRoutes(app:FastifyInstance,service:DeduplicationService) {
 const id=(request:any)=>parse(idSchema,request.params.id);
 app.post('/api/duplicates/scan',async request=>service.scan(parse(scanSchema,request.body||{})));
 app.get('/api/duplicates',async request=>service.list(parse(z.object({status:z.enum(['suggested','confirmed','dismissed']).optional(),relation:relation.optional(),documentId:idSchema.optional(),page:z.coerce.number().int().min(1).max(100000).default(1),pageSize:z.coerce.number().int().min(1).max(100).default(30)}).strict(),request.query||{})));
 app.get('/api/duplicates/:id',async request=>service.detail(id(request)));
 app.get('/api/documents/:id/sources',async request=>service.sourceReferences(id(request)));
 app.post('/api/duplicates/:id/merge',async request=>service.merge(id(request),parse(z.object({canonicalDocumentId:idSchema}).strict(),request.body).canonicalDocumentId));
 app.post('/api/duplicates/:id/confirm-version',async request=>service.confirmVersion(id(request),parse(z.object({canonicalDocumentId:idSchema}).strict(),request.body).canonicalDocumentId));
 app.post('/api/duplicates/:id/dismiss',async request=>{parse(z.object({}).strict(),request.body||{});return service.dismiss(id(request));});
 app.post('/api/duplicates/:id/undo',async request=>{parse(z.object({}).strict(),request.body||{});return service.undo(id(request));});
}
