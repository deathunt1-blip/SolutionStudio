import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { HttpError } from '../../../packages/knowledge/src/service.js';
import type { ProjectService } from '../../../packages/projects/src/service.js';
import type { ProjectRequirements } from '../../../packages/projects/src/types.js';

const name=z.string().trim().min(1).max(300),idSchema=z.string().min(1).max(200);
const item=z.object({id:z.string().max(200),key:z.string().max(200).optional(),value:z.unknown(),sourceInputId:z.string().max(200),sourceChunkId:z.string().max(200).optional(),evidence:z.string().max(2000),confidence:z.number().min(0).max(1),confirmedByUser:z.boolean()});
const question=z.object({id:z.string().max(200),key:z.string().max(200),question:z.string().max(1000),sourceInputId:z.string().max(200).optional(),resolved:z.boolean().optional()});
const requirements=z.object({projectName:z.string().max(300).optional(),customerName:z.string().max(300).optional(),application:z.string().max(300).optional(),goals:z.array(item).max(100),performance:z.object({accuracy:item.optional(),frameRate:item.optional(),latency:item.optional(),coverage:item.optional(),range:item.optional(),cameraCount:item.optional()}).strict(),interfaces:z.array(item).max(100),protocols:z.array(item).max(100),environment:z.array(item).max(100),installationConstraints:z.array(item).max(100),specialRequirements:z.array(item).max(100),acceptanceCriteria:z.array(item).max(100),unresolved:z.array(question).max(100)}).strict();
function parse<T>(schema:z.ZodType<T>,value:unknown):T {const result=schema.safeParse(value);if(!result.success)throw new HttpError(400,'项目参数无效，请检查名称、上下文版本或事实内容');return result.data;}
export async function registerProjectRoutes(app:FastifyInstance,service:ProjectService) {
 const id=(request:any)=>parse(idSchema,request.params.id);
 app.get('/api/projects',async()=>({items:await service.list()}));
 app.post('/api/projects',async request=>({project:await service.create(parse(z.object({name,customerName:z.string().max(300).optional(),description:z.string().max(10000).optional(),companyName:name.optional()}).strict(),request.body))}));
 app.get('/api/projects/:id',async request=>({project:await service.get(id(request))}));
 app.patch('/api/projects/:id',async request=>({project:await service.update(id(request),parse(z.object({name:name.optional(),customerName:z.string().max(300).optional(),description:z.string().max(10000).optional(),companyName:name.optional(),status:z.enum(['draft','archived']).optional()}).strict(),request.body))}));
 app.post('/api/projects/:id/inputs',async request=>{
  const projectId=id(request);await service.get(projectId);const files:{filename:string;bytes:Uint8Array;mimeType:string}[]=[];let size=0;
  for await(const part of request.parts()){if(part.type!=='file')continue;const bytes=await part.toBuffer();size+=bytes.length;if(size>200*1024*1024||files.length>=20)throw new HttpError(413,'单次项目导入最多 20 份、合计 200 MB');files.push({filename:part.filename,bytes,mimeType:part.mimetype});}
  if(!files.length)throw new HttpError(400,'请选择项目资料');const items=[];let context=await service.getContext(projectId);for(const file of files){const result=await service.addInput(projectId,file);items.push(result.input);context=result.context;}return {items,context};
 });
 app.post('/api/projects/:id/text',async request=>{const result=await service.addText(id(request),parse(z.object({title:name.optional(),text:z.string().trim().min(1).max(100000)}).strict(),request.body));return {items:[result.input],context:result.context};});
 app.get('/api/projects/:id/context',async request=>({context:await service.getContext(id(request))}));
 app.post('/api/projects/:id/parse-context',async request=>({context:await service.rebuildContext(id(request),parse(z.object({useAI:z.boolean().optional(),limitsEnabled:z.boolean().optional(),model:z.enum(['kimi-k3','kimi-k2.6']).optional()}).strict(),request.body||{}))}));
 app.patch('/api/projects/:id/context',async request=>{const input=parse(z.object({revision:z.number().int().min(1),summary:z.string().max(10000).optional(),requirements:requirements.optional(),products:z.array(z.string().trim().min(1).max(100)).max(100).optional(),facts:z.array(z.object({key:z.string().min(1).max(200),label:name,value:z.unknown(),unit:z.string().max(50).optional()}).strict()).max(200).optional(),resolvedQuestionIds:z.array(idSchema).max(100).optional()}).strict(),request.body);return {context:await service.patchContext(id(request),{...input,requirements:input.requirements as ProjectRequirements|undefined})};});
 app.post('/api/projects/:id/confirm-context',async request=>({context:await service.confirmContext(id(request),parse(z.object({revision:z.number().int().min(1)}).strict(),request.body).revision)}));
 app.get('/api/projects/:id/assets/:assetId',async(request,reply)=>{const {asset,bytes}=await service.downloadAsset(id(request),parse(idSchema,(request.params as any).assetId));reply.header('Cache-Control','private, no-store').header('X-Content-Type-Options','nosniff');return reply.type(asset.mimeType).send(Buffer.from(bytes));});
 app.get('/api/projects/:id/inputs/:inputId/original',async(request,reply)=>{const {input,bytes,mimeType}=await service.downloadInput(id(request),parse(idSchema,(request.params as any).inputId));return reply.type(mimeType).header('Cache-Control','private, no-store').header('Content-Disposition',`attachment; filename*=UTF-8''${encodeURIComponent(input.filename)}`).send(Buffer.from(bytes));});
}
