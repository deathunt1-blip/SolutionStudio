import { randomUUID } from 'node:crypto';
import { mkdir, open, readFile, readdir, stat, unlink } from 'node:fs/promises';
import { dirname, extname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { LLMConfig, LLMProvider, ParsedDocument, SourceFile } from '../../core/src/types.js';
import { CLASSIFICATION_VERSION, PROMPT_VERSION, RULE_VERSION, classifyDocument, reviewReasons } from '../../classification/src/index.js';
import { parseDocument } from '../../parsers/src/index.js';
import { KimiProvider } from '../../llm/src/index.js';
import { contentHash, loadContext, loadLabels, loadManifest, objectHash, readJson, writeJsonAtomic } from './data.js';
import { createEvaluationExampleRetriever } from './examples.js';
import { evaluationReportPaths, writeEvaluationReports } from './reporting.js';
import type { EvaluationResult, EvaluationRun } from './types.js';

export interface RunEvaluationOptions {
 manifest:string; labels:string; context:string; output:string;
 provider?:'rules'|'kimi'|'synthetic'; resume?:boolean; limit?:number; repeat?:number;
 examples?:'with'|'without'; isolateEvaluation?:boolean; allowUnlabeled?:boolean;
 model?:string; temperature?:number; maxTokens?:number; baseUrl?:string; apiKey?:string;
 budgetCny?:number; prices?:{inputPerMillionCny:number;outputPerMillionCny:number};
 signal?:AbortSignal;
}
export interface EvaluationDependencies {
 /** Injection is restricted to explicitly synthetic runs, which cannot be reported as Kimi results. */
 provider?:LLMProvider;
 onProgress?:(run:EvaluationRun,result:EvaluationResult)=>void;
}
const repositoryRoot=fileURLToPath(new URL('../../../',import.meta.url));
const numeric=(value:unknown,name:string,min:number,max:number,integer=false)=>{
 const number=Number(value);
 if(!Number.isFinite(number)||number<min||number>max||(integer&&!Number.isInteger(number)))throw new Error(`${name} 参数无效`);
 return number;
};
const exists=async(path:string)=>{try{await stat(path);return true;}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return false;throw error;}};
function safeUsage(usage:EvaluationResult['usage']):usage is NonNullable<EvaluationResult['usage']> {
 return Boolean(usage&&Number.isSafeInteger(usage.inputTokens)&&Number.isSafeInteger(usage.outputTokens)&&usage.inputTokens>=0&&usage.outputTokens>=0);
}
export const costForTokens=(inputTokens:number,outputTokens:number,prices:EvaluationRun['prices'])=>(inputTokens*prices.inputPerMillionCny+outputTokens*prices.outputPerMillionCny)/1_000_000;

/** Include actual source contents, rather than trusting manually bumped version strings. */
export async function evaluationCodeHash() {
 const paths:string[]=[];
 async function collect(directory:string) {
  for(const entry of await readdir(resolve(repositoryRoot,directory),{withFileTypes:true})) {
   const relative=`${directory}/${entry.name}`;
   if(entry.isDirectory())await collect(relative);
   else if(entry.name.endsWith('.ts'))paths.push(relative);
  }
 }
 await collect('packages');
 paths.push('package-lock.json');
 const contents=await Promise.all(paths.sort().map(async path=>[path,contentHash(await readFile(resolve(repositoryRoot,path)))]));
 return objectHash({contents,node:process.versions.node,icu:process.versions.icu});
}

/** Checkpointed offline-first runner, isolated from the production knowledge database. */
export async function runEvaluation(options:RunEvaluationOptions,dependencies:EvaluationDependencies={}):Promise<EvaluationRun> {
 const outputPath=resolve(options.output);
 if(extname(outputPath).toLowerCase()!=='.json')throw new Error('评测输出需使用 .json 扩展名');
 await mkdir(dirname(outputPath),{recursive:true});
 const lockPath=`${outputPath}.lock`;
 let lock;
 try {lock=await open(lockPath,'wx',0o600);}catch(error){if((error as NodeJS.ErrnoException).code==='EEXIST')throw new Error('该评测输出已被锁定；若进程异常退出，请先核实锁中的 PID 已停止，再删除 .lock 文件并 --resume。');throw error;}
 let run:EvaluationRun|undefined;
 let checkpointOwned=false;
 let retriever:Awaited<ReturnType<typeof createEvaluationExampleRetriever>>|undefined;
 const save=async()=>{if(run){run.updatedAt=new Date().toISOString();delete run.metrics;await writeJsonAtomic(outputPath,run);}};
 try {
  await lock.writeFile(JSON.stringify({pid:process.pid,startedAt:new Date().toISOString()}));
  const providerName=options.provider??'rules';
  if(dependencies.provider&&providerName!=='synthetic')throw new Error('测试模型只能用于 synthetic 评测');
  if(providerName==='synthetic'&&!dependencies.provider)throw new Error('synthetic 评测必须显式提供测试模型');
  const model=options.model??(providerName==='rules'?'local-rules':providerName==='synthetic'?'synthetic-test':process.env.CLASSIFICATION_MODEL??process.env.LLM_MODEL??'kimi-k2.6');
  const temperature=numeric(options.temperature??process.env.CLASSIFICATION_TEMPERATURE??process.env.LLM_TEMPERATURE??0.6,'temperature',0,2);
  const maxTokens=numeric(options.maxTokens??process.env.CLASSIFICATION_MAX_TOKENS??process.env.LLM_MAX_TOKENS??3000,'max_tokens',128,3000,true);
  const repeat=numeric(options.repeat??1,'repeat',1,100,true);
  const examplesMode=options.examples??'with';
  if(!['with','without'].includes(examplesMode))throw new Error('examples 参数需为 with 或 without');
  const isolateEvaluation=options.isolateEvaluation??true;
  const budgetCny=numeric(options.budgetCny??(providerName==='rules'?0:NaN),'budget-cny',0,1_000_000);
  if(providerName!=='rules'&&budgetCny<=0)throw new Error('真实或 synthetic 模型评测必须设置正数 --budget-cny');
  const prices=options.prices??{inputPerMillionCny:6.5,outputPerMillionCny:27};
  numeric(prices.inputPerMillionCny,'input price',0,1_000_000);numeric(prices.outputPerMillionCny,'output price',0,1_000_000);
  const baseUrl=(options.baseUrl??process.env.CLASSIFICATION_BASE_URL??process.env.LLM_BASE_URL??'https://api.moonshot.cn/v1').replace(/\/+$/,'');
  if(providerName==='kimi'&&(baseUrl!=='https://api.moonshot.cn/v1'||model!=='kimi-k2.6'))throw new Error('本版付费评测预算仅支持 https://api.moonshot.cn/v1 的 kimi-k2.6');
  if(providerName==='kimi'&&(prices.inputPerMillionCny<6.5||prices.outputPerMillionCny<27))throw new Error('Kimi 预算单价不能低于当前保守计价 6.5 / 27 元每百万 token');
  const [manifest,labels,context,codeHash]=await Promise.all([loadManifest(options.manifest),loadLabels(options.labels),loadContext(options.context),evaluationCodeHash()]);
  if(labels.datasetId!==manifest.datasetId)throw new Error('标注与清单不属于同一数据集');
  const labelMap=new Map(labels.labels.map(label=>[label.documentId,label]));
  for(const label of labels.labels) {
   const document=manifest.documents.find(doc=>doc.id===label.documentId);
   if(!document||label.contentHash!==document.contentHash||label.filename!==document.filename)throw new Error('人工标注与清单中的文件身份不一致');
   if(!context.registries.documentTypes.some(type=>type.key===label.documentType))throw new Error('人工标注的文档类型不在评测注册表中');
  }
  const limit=options.limit===undefined?manifest.documents.length:numeric(options.limit,'limit',1,manifest.documents.length,true);
  const selected=manifest.documents.slice(0,limit);
  if(!options.allowUnlabeled&&selected.some(doc=>!labelMap.has(doc.id)))throw new Error('缺少人工标准答案；请先完成标注，或显式 --allow-unlabeled 仅检查流程（不代表质量达标）');
  // Validate all selected bytes before the first paid request, and again immediately
  // before parsing each file, so an edited source never reuses a previous label.
  for(const document of selected) {
   const info=await stat(document.path);
   if(!info.isFile()||info.size>40*1024*1024)throw new Error('评测文件不存在、不是普通文件或超过 40 MiB');
   if(contentHash(await readFile(document.path))!==document.contentHash)throw new Error('评测文件内容哈希已变化，请重新生成清单并复核标注');
  }
  const [manifestBytes,labelBytes,contextBytes]=await Promise.all([readFile(options.manifest),readFile(options.labels),readFile(options.context)]);
  const identity={manifestHash:contentHash(manifestBytes),labelsHash:contentHash(labelBytes),contextHash:contentHash(contextBytes),codeHash};
  const configurationHash=objectHash({...identity,providerName,model,temperature,maxTokens,repeat,examplesMode,isolateEvaluation,budgetCny,prices,baseUrl,limit,allowUnlabeled:options.allowUnlabeled??false,thresholds:context.thresholds,classificationVersion:CLASSIFICATION_VERSION,promptVersion:PROMPT_VERSION,ruleVersion:RULE_VERSION,selected:selected.map(doc=>({id:doc.id,path:doc.path,contentHash:doc.contentHash}))});
  if(options.resume) {
   if(!await exists(outputPath))throw new Error('--resume 指定的结果不存在');
   run=await readJson<EvaluationRun>(outputPath);
   if(run.schemaVersion!==1||run.configurationHash!==configurationHash||Object.entries(identity).some(([key,value])=>(run as unknown as Record<string,unknown>)[key]!==value))throw new Error('无法恢复：文件、人工标注、上下文、模型参数、预算或代码版本发生变化，请使用新的输出文件');
   if(!Array.isArray(run.documents)||run.plannedResults!==selected.length*repeat||run.plannedDocuments!==selected.length||!Array.isArray(run.reservations)||!Number.isFinite(run.reservedCostCny)||run.reservedCostCny<0||run.reservedCostCny>budgetCny)throw new Error('评测检查点无效');
   const reservationTotal=run.reservations.reduce((sum,entry)=>sum+entry.reservedCny,0);
   if(run.reservations.some(entry=>!Number.isFinite(entry.reservedCny)||entry.reservedCny<0||!selected.some(doc=>doc.id===entry.documentId)||!Number.isInteger(entry.repetition)||entry.repetition<1||entry.repetition>repeat))throw new Error('评测预算账本条目无效');
   if(Math.abs(reservationTotal-run.reservedCostCny)>0.0000001)throw new Error('评测预算账本不一致');
   const keys=new Set<string>();
   for(const result of run.documents) {
    const key=`${result.documentId}:${result.repetition}`;
    if(keys.has(key)||!selected.some(doc=>doc.id===result.documentId&&doc.contentHash===result.contentHash)||!Number.isInteger(result.repetition)||result.repetition<1||result.repetition>repeat)throw new Error('评测结果身份不一致');
    keys.add(key);
   }
   if(run.status==='completed'&&run.documents.length!==run.plannedResults)throw new Error('检查点错误：未完整运行的结果被标记为 completed');
   checkpointOwned=true;
   if(run.status==='completed'){await writeEvaluationReports(run,outputPath);return run;}
  } else {
   for(const path of Object.values(evaluationReportPaths(outputPath)))if(await exists(path))throw new Error('结果文件已存在，请使用 --resume 或新的 --output；不会覆盖已有实验');
   const timestamp=new Date().toISOString();
   run={schemaVersion:1,id:randomUUID(),datasetId:manifest.datasetId,createdAt:timestamp,updatedAt:timestamp,status:'running',provider:providerName,model,temperature,maxTokens,classificationVersion:CLASSIFICATION_VERSION,classificationPromptVersion:PROMPT_VERSION,classificationRuleVersion:RULE_VERSION,thresholds:context.thresholds,gatePolicy:'production-review-threshold',examplesMode,isolateEvaluation,repeat,...identity,configurationHash,budgetCny,reservedCostCny:0,reservations:[],prices,plannedDocuments:selected.length,plannedResults:selected.length*repeat,documents:[]};
   checkpointOwned=true;
  }
  run.status='running';
  await save();
  const llmConfig:LLMConfig={baseUrl,model,temperature,maxTokens,apiKey:options.apiKey??process.env.CLASSIFICATION_API_KEY??process.env.LLM_API_KEY??''};
  const provider=providerName==='rules'?undefined:providerName==='synthetic'?dependencies.provider:new KimiProvider(llmConfig);
  retriever=await createEvaluationExampleRetriever(context,manifest,isolateEvaluation);
  const completed=new Set(run.documents.map(result=>`${result.documentId}:${result.repetition}`));
  const requestReserve=3*costForTokens(7900,maxTokens,prices);
  runLoop:for(const document of selected)for(let repetition=1;repetition<=repeat;repetition++) {
   if(completed.has(`${document.id}:${repetition}`))continue;
   if(options.signal?.aborted){run.status='interrupted';break runLoop;}
   const started=performance.now();
   const bytes=await readFile(document.path);
   if(contentHash(bytes)!==document.contentHash)throw new Error('运行期间文件内容发生变化，评测已停止');
   const file:SourceFile={buffer:bytes,contentHash:document.contentHash,meta:{sourceId:'evaluation',sourceType:'local_folder',filename:document.filename,sourcePath:document.path}};
   let parsed:ParsedDocument;
   const parseStarted=performance.now();
   try{parsed=await parseDocument(file);}catch{parsed={plainText:'',blocks:[],tables:[],metadata:{},parseStatus:'failed',parseWarnings:['解析器未能读取此文件']};}
   const parseMs=performance.now()-parseStarted;
   const result:EvaluationResult={documentId:document.id,filename:document.filename,contentHash:document.contentHash,repetition,parseStatus:parsed.parseStatus,parseWarnings:parsed.parseWarnings,expected:labelMap.get(document.id),finalStatus:'failed',autoAccepted:false,reviewReasons:[],warnings:[],usedConfirmedExamples:[],timings:{parseMs,classifyMs:0,totalMs:performance.now()-started}};
   if(parsed.parseStatus==='failed'||!parsed.plainText.trim()) {
    result.parseStatus='failed';result.error='未提取到可分类文本；请复核文件格式或扫描件';
   } else {
    const examples=examplesMode==='with'?await retriever.retrieve(document,parsed.plainText):[];
    let budgetBlocked=false,aborted=false;
    let reservation:NonNullable<EvaluationRun['reservations']>[number]|undefined;
    const guardedProvider:LLMProvider|undefined=provider?{generate:async request=>{
     if(options.signal?.aborted){aborted=true;throw new Error('evaluation interrupted');}
     if(run!.reservedCostCny+requestReserve>budgetCny+Number.EPSILON){budgetBlocked=true;throw new Error('evaluation budget reached');}
     reservation={documentId:document.id,repetition,reservedCny:requestReserve,startedAt:new Date().toISOString()};
     run!.reservations!.push(reservation);run!.reservedCostCny+=requestReserve;
     // This atomic checkpoint precedes every network invocation.
     // Reservations are never refunded: unknown crashes/retries retain their cost.
     await save();
     return provider.generate(request);
    }}:undefined;
    const classifyStarted=performance.now();
    const output=await classifyDocument(file.meta,parsed,context.registries,examples,guardedProvider,{trace:true});
    result.timings.classifyMs=performance.now()-classifyStarted;
    if(budgetBlocked||aborted){run.status=budgetBlocked?'budget_stopped':'interrupted';break runLoop;}
    if(reservation)reservation.completedAt=new Date().toISOString();
    result.predicted=output.classification;result.warnings=output.warnings;
    result.reviewReasons=reviewReasons(output.classification,context.thresholds.review);
    result.autoAccepted=result.reviewReasons.length===0;result.finalStatus=result.autoAccepted?'active':'needs_review';
    if(output.trace)Object.assign(result,output.trace);
    if(safeUsage(output.usage)){result.usage=output.usage;result.estimatedCostCny=costForTokens(output.usage.inputTokens,output.usage.outputTokens,prices);}
    else if(provider)result.warnings.push('该请求没有可核实的 token 用量；估算费用不完整，保留全部预算预留。');
    const predicted=output.classification.products.value;
    const ground=`${file.meta.filename}\n${parsed.title??''}\n${parsed.plainText}`.toLowerCase();
    result.productGrounding={predicted,ungrounded:predicted.filter(product=>!ground.includes(product.toLowerCase()))};
   }
   result.timings.totalMs=performance.now()-started;
   run.documents.push(result);completed.add(`${document.id}:${repetition}`);
   await save();dependencies.onProgress?.(run,result);
  }
  if(run.documents.length===run.plannedResults)run.status='completed';
  await save();
  await writeEvaluationReports(run,outputPath);
  return run;
 } catch(error) {
  // Never replace a rejected resume checkpoint; its existing evidence is intact.
  if(checkpointOwned&&run?.status==='running'){run.status='interrupted';await save();}
  throw error;
 } finally {
  try {await retriever?.close();}
  finally {await lock.close();await unlink(lockPath);}
 }
}
