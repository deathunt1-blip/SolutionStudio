import {createHash,randomUUID} from 'node:crypto';
import {mkdir,readFile,rename,unlink,writeFile} from 'node:fs/promises';
import {dirname,isAbsolute,resolve} from 'node:path';
import {z} from 'zod';
import type {EvaluationManifest,EvaluationLabels,EvaluationContext} from './types.js';

const hash=z.string().regex(/^[a-f0-9]{64}$/);
const id=z.string().min(1).max(200);
const labelSchema=z.object({documentId:id,contentHash:hash,filename:z.string().min(1),documentType:id,
 authority:z.enum(['authoritative','reference','style_only','unknown']),
 applications:z.array(id).max(100).optional(),topics:z.array(id).max(100).optional(),products:z.array(z.string().min(1).max(200)).max(100).optional(),
 notes:z.string().max(10000).optional(),labeledBy:z.string().trim().min(1).max(200),labeledAt:z.iso.datetime(),origin:z.literal('human')}).strict();
const manifestSchema=z.object({schemaVersion:z.literal(1),datasetId:id,createdAt:z.iso.datetime(),documents:z.array(z.object({id,path:z.string().min(1),filename:z.string().min(1),contentHash:hash,sourceDocumentId:id.optional()}).strict()).min(1)}).strict();
const labelsSchema=z.object({schemaVersion:z.literal(1),datasetId:id,labels:z.array(labelSchema)}).strict();
export const contentHash=(value:Uint8Array|string)=>createHash('sha256').update(value).digest('hex');
export const objectHash=(value:unknown)=>contentHash(JSON.stringify(value));
export async function readJson<T=unknown>(path:string):Promise<T>{return JSON.parse(await readFile(path,'utf8')) as T;}
export async function writeJsonAtomic(path:string,value:unknown){
 const destination=resolve(path);await mkdir(dirname(destination),{recursive:true});
 const temporary=`${destination}.${randomUUID()}.tmp`;
 try{await writeFile(temporary,JSON.stringify(value,null,2)+'\n',{flag:'wx',mode:0o600});await rename(temporary,destination);}
 finally{await unlink(temporary).catch(error=>{if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;});}
}
export async function loadManifest(path:string):Promise<EvaluationManifest>{
 const manifest=manifestSchema.parse(await readJson(path));
 if(new Set(manifest.documents.map(doc=>doc.id)).size!==manifest.documents.length)throw new Error('评测清单存在重复 documentId');
 return {...manifest,documents:manifest.documents.map(doc=>({...doc,path:isAbsolute(doc.path)?doc.path:resolve(dirname(path),doc.path)}))};
}
export async function loadLabels(path:string,manifest?:EvaluationManifest):Promise<EvaluationLabels>{
 const labels=labelsSchema.parse(await readJson(path));
 if(new Set(labels.labels.map(label=>label.documentId)).size!==labels.labels.length)throw new Error('人工标注存在重复 documentId');
 if(manifest){
  if(labels.datasetId!==manifest.datasetId)throw new Error('人工标注不属于当前数据集');
  for(const label of labels.labels){const doc=manifest.documents.find(doc=>doc.id===label.documentId);if(!doc||doc.contentHash!==label.contentHash)throw new Error('人工标注与当前文件版本不一致');}
 }
 return labels;
}
export async function loadContext(path:string):Promise<EvaluationContext>{
 const context=await readJson<EvaluationContext>(path);
 const registry=z.array(z.object({key:id,label:z.string(),aliases:z.array(z.string())}).strict());
 const field=z.object({value:z.unknown(),confidence:z.number().min(0).max(1),source:z.enum(['ai','rule','user','metadata']),reasoning:z.string().optional()}).strict();
 z.object({schemaVersion:z.literal(1),createdAt:z.iso.datetime(),registries:z.object({documentTypes:registry,applications:registry,topics:registry}).strict(),
 examples:z.array(z.object({id,documentId:id,textSummary:z.string(),confirmedFields:z.record(z.string(),field),createdAt:z.string(),contentHashes:z.array(hash).min(1)}).strict()),
 thresholds:z.object({review:z.number().min(0).max(1),autoAccept:z.number().min(0).max(1)}).strict()}).strict().parse(context);
 if(context.thresholds.review>context.thresholds.autoAccept)throw new Error('评测阈值顺序无效');
 return context;
}
export function cliOptions(args:string[]){
 const values=new Map<string,string|boolean>();
 for(let i=0;i<args.length;i++){const arg=args[i]!;if(!arg.startsWith('--'))throw new Error(`不支持的位置参数：${arg}`);const next=args[i+1];values.set(arg.slice(2),next&&!next.startsWith('--')?args[++i]!:true);}
 return values;
}
