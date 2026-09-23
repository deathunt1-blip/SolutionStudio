import type {FastifyInstance} from 'fastify';
import JSZip from 'jszip';
import {createHash} from 'node:crypto';
import {Readable} from 'node:stream';
import type {KnowledgeService} from '../../../packages/knowledge/src/service.js';
import {HttpError} from '../../../packages/knowledge/src/service.js';
import type {ProjectService} from '../../../packages/projects/src/service.js';

async function imageBytes(file:JSZip.JSZipObject):Promise<Buffer>{
 const chunks:Buffer[]=[];let size=0;const stream=new Readable().wrap(file.nodeStream('nodebuffer'));
 try{for await(const chunk of stream){size+=chunk.length;if(size>20*1024*1024)throw new HttpError(413,'图片超过 20 MB');chunks.push(Buffer.from(chunk));}return Buffer.concat(chunks);}finally{stream.destroy();}
}

/** Embedded original Office images, never an arbitrary storage key supplied by the client. */
export async function registerImageRoutes(app:FastifyInstance,knowledge:KnowledgeService,projects:ProjectService){
 const catalog=async(documentId:string)=>{
  const row=(await knowledge.db.query("SELECT d.id,d.active_version_id,v.filename,v.object_key FROM documents d JOIN document_versions v ON v.id=d.active_version_id WHERE d.id=$1 AND d.scope='global' AND d.status='active' AND d.canonical_document_id IS NULL AND d.organization_id='default' AND d.workspace_id='default'",[documentId]))[0];
  if(!row)throw new HttpError(404,'参考资料不可用');
  if(!/\.(docx|pptx|xlsx)$/i.test(row.filename))return [];
  const zip=await JSZip.loadAsync(await knowledge.storage.get(row.object_key));
  const files=Object.values(zip.files).filter(f=>!f.dir&&/^(?:word|ppt|xl)\/media\/[^/]+\.(?:png|jpe?g)$/i.test(f.name)).slice(0,100);
  return files.map(file=>({id:createHash('sha256').update(row.active_version_id+file.name).digest('hex').slice(0,32),filename:file.name.split('/').pop()!,mimeType:/\.png$/i.test(file.name)?'image/png':'image/jpeg',file,versionId:row.active_version_id}));
 };
 app.get('/api/documents/:id/images',async(r:any)=>({items:(await catalog(r.params.id)).map(({file,...item})=>({...item,url:`/api/documents/${r.params.id}/images/${item.id}`}))}));
 app.get('/api/documents/:id/images/:imageId',async(r:any,reply)=>{const item=(await catalog(r.params.id)).find(i=>i.id===r.params.imageId);if(!item)throw new HttpError(404,'图片不可用或来源版本已更新');const bytes=await imageBytes(item.file);return reply.header('X-Content-Type-Options','nosniff').type(item.mimeType).send(bytes);});
 app.post('/api/projects/:id/knowledge-images',async(r:any)=>{const {documentId,imageId}=r.body??{};if(typeof documentId!=='string'||typeof imageId!=='string')throw new HttpError(400,'请选择资料中的图片');await projects.get(r.params.id);const item=(await catalog(documentId)).find(i=>i.id===imageId);if(!item)throw new HttpError(404,'图片不可用或来源版本已更新');const asset=await projects.addAsset(r.params.id,{filename:item.filename,buffer:await imageBytes(item.file),mimeType:item.mimeType});await knowledge.db.query('UPDATE project_assets SET source_ref=$2::jsonb WHERE id=$1',[asset.id,JSON.stringify({type:'knowledge_chunk',id:imageId,label:item.filename,versionId:item.versionId,documentId})]);return {asset:{...asset,sourceRef:{type:'knowledge_chunk',id:imageId,label:item.filename,versionId:item.versionId}}};});
}
