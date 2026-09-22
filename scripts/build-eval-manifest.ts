import {access,mkdir,writeFile} from 'node:fs/promises';
import {basename,dirname,extname,isAbsolute,relative,resolve} from 'node:path';
import {LocalFolderAdapter} from '../packages/source-adapters/src/index.js';
import {initialRegistries} from '../packages/knowledge/src/database.js';
import {cliOptions,readJson} from '../packages/evaluation/src/data.js';
import type {EvaluationContext,EvaluationManifest,EvaluationLabels} from '../packages/evaluation/src/types.js';

const args=cliOptions(process.argv.slice(2));
if(args.has('help')||!args.has('root')){
 console.log('npm run eval:manifest -- --root <folder> [--limit 60] [--source-manifest paths.json] [--library-url http://127.0.0.1:4310] [--output evaluation-data/manifest.json] [--dataset-id internal_phase01_v1]');
 process.exit(args.has('help')?0:1);
}
const root=resolve(String(args.get('root'))),output=resolve(String(args.get('output')||'evaluation-data/manifest.json'));
const limit=Number(args.get('limit')||60);if(!Number.isInteger(limit)||limit<1||limit>1000)throw new Error('limit 必须是 1–1000');
const datasetId=String(args.get('dataset-id')||`phase01-${new Date().toISOString().slice(0,10)}`);
if(!/^[\w.-]{1,150}$/.test(datasetId))throw new Error('dataset-id 只能使用字母、数字、下划线、点和连字符');
const labelsPath=resolve(dirname(output),'labels.json'),contextPath=resolve(dirname(output),'context.json');
for(const file of [output,labelsPath,contextPath]){try{await access(file);}catch{continue;}throw new Error('目标评测数据集已存在；请选择新的 --output 目录，以保留已有标注。');}
const adapter=new LocalFolderAdapter();
const files=(await adapter.listDocuments({root})).filter(file=>Number(file.metadata?.bytes)>0&&Number(file.metadata?.bytes)<=40*1024*1024);
let selected=files.sort((a,b)=>a.sourceId.localeCompare(b.sourceId,'zh'));
if(args.has('source-manifest')){
 const names=await readJson<unknown>(String(args.get('source-manifest')));
 if(!Array.isArray(names)||names.some(name=>typeof name!=='string'))throw new Error('source-manifest 必须是相对路径数组');
 selected=names.map(name=>{const match=files.find(file=>file.sourceId===name);if(!match)throw new Error('源清单中的文件不存在或格式不受支持');return match;});
}else{
 // Round robin across formats keeps a deterministic, modest local sample.
 const buckets=new Map<string,typeof files>();for(const file of selected){const extension=extname(file.filename).toLowerCase();buckets.set(extension,[...(buckets.get(extension)||[]),file]);}
 selected=[];while([...buckets.values()].some(bucket=>bucket.length)){for(const bucket of buckets.values()){const file=bucket.shift();if(file)selected.push(file);}}
}
let context:EvaluationContext={schemaVersion:1,createdAt:new Date().toISOString(),registries:initialRegistries,examples:[],thresholds:{review:0.6,autoAccept:0.85}};
const liveDocuments:{id:string;contentHash:string}[]=[];
if(args.has('library-url')){
 const url=new URL(String(args.get('library-url')));
 if(!['127.0.0.1','localhost','[::1]'].includes(url.hostname)||!['http:','https:'].includes(url.protocol)||url.username||url.password||url.search||url.hash)throw new Error('library-url 必须为本机工作台地址');
 const get=async(route:string)=>{const response=await fetch(new URL(route,url),{redirect:'error',signal:AbortSignal.timeout(30000)});if(!response.ok)throw new Error(`工作台只读导出失败（HTTP ${response.status}），请先启动最新版服务`);return response.json();};
 context=await get('/api/evaluation/context');
 for(let page=1;;page++){const batch=await get(`/api/documents?page=${page}&pageSize=100`);liveDocuments.push(...batch.items);if(liveDocuments.length>=batch.total)break;}
}
const manifest:EvaluationManifest={schemaVersion:1,datasetId,createdAt:new Date().toISOString(),documents:[]};
const hashes=new Set<string>();
for(const item of selected){
 if(manifest.documents.length>=limit)break;
 const file=await adapter.fetchDocument(item.sourceId,{root});if(hashes.has(file.contentHash))continue;
 hashes.add(file.contentHash);
 const sourcePath=resolve(root,item.sourcePath||item.sourceId),rel=relative(root,sourcePath);
 if(!rel||rel.startsWith('..')||isAbsolute(rel))throw new Error('源文件路径超出指定目录');
 const sourceDocument=liveDocuments.find(doc=>doc.contentHash===file.contentHash);
 manifest.documents.push({id:`doc_${String(manifest.documents.length+1).padStart(3,'0')}`,path:sourcePath,filename:basename(sourcePath),contentHash:file.contentHash,...sourceDocument?{sourceDocumentId:sourceDocument.id}:{}});
}
if(!manifest.documents.length)throw new Error('未找到可用资料');
const labels:EvaluationLabels={schemaVersion:1,datasetId,labels:[]};
await mkdir(dirname(output),{recursive:true});
// Exclusive creation: a rerun must never replace a human's existing labels.
for(const[file,value]of [[contextPath,context],[labelsPath,labels],[output,manifest]] as const)await writeFile(file,JSON.stringify(value,null,2)+'\n',{flag:'wx',mode:0o600});
console.log(JSON.stringify({datasetId,documents:manifest.documents.length,uniqueHashes:hashes.size,confirmedExamples:context.examples.length,humanLabels:0,manifest:output,labels:labelsPath,context:contextPath,modelRequests:0},null,2));
