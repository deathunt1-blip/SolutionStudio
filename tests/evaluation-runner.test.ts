import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initialRegistries } from '../packages/knowledge/src/database.js';
import { contentHash, readJson, writeJsonAtomic } from '../packages/evaluation/src/data.js';
import { createEvaluationExampleRetriever } from '../packages/evaluation/src/examples.js';
import { costForTokens, runEvaluation, type RunEvaluationOptions } from '../packages/evaluation/src/runner.js';
import type { EvaluationContext, EvaluationLabels, EvaluationManifest, EvaluationRun } from '../packages/evaluation/src/types.js';
import type { LLMProvider, LLMRequest } from '../packages/core/src/types.js';

const folders:string[]=[];
afterEach(async()=>{await Promise.all(folders.splice(0).map(folder=>rm(folder,{recursive:true,force:true})));});
const timestamp='2026-09-22T00:00:00.000Z';
const classification={documentType:{value:'solution',confidence:0.92,evidence:'技术方案'},authority:{value:'reference',confidence:0.91,evidence:'历史项目方案'},applications:{value:['robotics'],confidence:0.8},topics:{value:['camera'],confidence:0.8},products:{value:[],confidence:0.9},language:{value:'zh',confidence:0.99}};
function fakeModel() {
 const requests:LLMRequest[]=[];
 const provider:LLMProvider={async generate(request){requests.push(request);return {content:JSON.stringify({classification}),usage:{inputTokens:500,outputTokens:140}};}};
 return {provider,requests};
}
async function fixture(includeBroken=false) {
 const directory=await mkdtemp(join(tmpdir(),'solution-evaluation-test-'));folders.push(directory);
 const manifest:EvaluationManifest={schemaVersion:1,datasetId:'synthetic-test',createdAt:timestamp,documents:[]};
 for(let index=1;index<=2;index++) {
  const filename=`技术方案${index}.txt`,text=`技术方案\n机器人相机部署历史项目方案，仅供参考。第 ${index} 个测试文件。`;
  const path=join(directory,filename);await writeFile(path,text);
  manifest.documents.push({id:`document-${index}`,sourceDocumentId:`source-${index}`,filename,path,contentHash:contentHash(text)});
 }
 if(includeBroken) {
  const path=join(directory,'unreadable.pdf');await writeFile(path,'not a pdf');
  manifest.documents.push({id:'broken',filename:'unreadable.pdf',path,contentHash:contentHash('not a pdf')});
 }
 const labels:EvaluationLabels={schemaVersion:1,datasetId:manifest.datasetId,labels:manifest.documents.map(doc=>({documentId:doc.id,filename:doc.filename,contentHash:doc.contentHash,documentType:'solution',authority:'reference',labeledBy:'Synthetic fixture author',labeledAt:timestamp,origin:'human'}))};
 const confirmedFields={documentType:{value:'solution',confidence:1,source:'user' as const},authority:{value:'reference' as const,confidence:1,source:'user' as const}};
 const examples=[
  {id:'self',documentId:'source-1',contentHashes:[manifest.documents[0]!.contentHash]},
  {id:'renamed-duplicate',documentId:'renamed-source',contentHashes:[manifest.documents[0]!.contentHash]},
  {id:'dataset-other-document',documentId:'source-2',contentHashes:[manifest.documents[1]!.contentHash]},
  {id:'outside-dataset',documentId:'source-outside',contentHashes:[contentHash('external document')]},
 ].map(example=>({...example,textSummary:'机器人相机部署历史项目技术方案',confirmedFields,createdAt:timestamp}));
 const context:EvaluationContext={schemaVersion:1,createdAt:timestamp,registries:structuredClone(initialRegistries),examples,thresholds:{review:0.6,autoAccept:0.85}};
 const paths={manifest:join(directory,'manifest.json'),labels:join(directory,'labels.json'),context:join(directory,'context.json'),output:join(directory,'result.json')};
 await Promise.all([writeJsonAtomic(paths.manifest,manifest),writeJsonAtomic(paths.labels,labels),writeJsonAtomic(paths.context,context)]);
 const options:RunEvaluationOptions={...paths,provider:'synthetic',budgetCny:5,temperature:0,maxTokens:3000};
 return {directory,manifest,labels,context,options};
}

describe('isolated evaluation runner',()=>{
 it('uses PostgreSQL FTS and excludes self, duplicate content, and all dataset examples',async()=>{
  const {manifest,context}=await fixture();
  const isolated=await createEvaluationExampleRetriever(context,manifest,true);
  try {expect((await isolated.retrieve(manifest.documents[0]!,'机器人相机部署历史项目技术方案')).map(example=>example.id)).toEqual(['outside-dataset']);}
  finally{await isolated.close();}
  const deliberateExperiment=await createEvaluationExampleRetriever(context,manifest,false);
  try {
   const ids=(await deliberateExperiment.retrieve(manifest.documents[0]!,'机器人相机部署历史项目技术方案')).map(example=>example.id);
   expect(ids).toContain('dataset-other-document');expect(ids).toContain('outside-dataset');
   expect(ids).not.toContain('self');expect(ids).not.toContain('renamed-duplicate');
   expect(await deliberateExperiment.retrieve(manifest.documents[0]!,'unrelated culinary vocabulary')).toEqual([]);
  } finally {await deliberateExperiment.close();}
 },20_000);

 it('runs the parser, classifier, trace, production gate and 1-based repeats; parse failures spend nothing',async()=>{
  const {options}=await fixture(true);const fake=fakeModel();
  const run=await runEvaluation({...options,repeat:3},{provider:fake.provider});
  expect(run.status).toBe('completed');expect(run.documents).toHaveLength(9);expect(fake.requests).toHaveLength(6);
  expect(run.documents.filter(result=>result.parseStatus==='failed')).toHaveLength(3);
  expect(run.documents.filter(result=>result.parseStatus==='failed').every(result=>!result.usage&&!result.predicted)).toBe(true);
  const result=run.documents[0]!;
  expect(result.repetition).toBe(1);expect(result.finalStatus).toBe('active');expect(result.autoAccepted).toBe(true);
  expect(result.usedConfirmedExamples).toEqual(['outside-dataset']);expect(result.prompt).toContain(result.fingerprint);
  expect(result.prompt).toBe(fake.requests[0]!.prompt);expect(result.systemPrompt).toBe(fake.requests[0]!.system);
  expect(result.ruleDecision).toBeDefined();expect(result.aiDecision).toBeDefined();expect(result.usage?.inputTokens).toBe(500);
  expect(run.gatePolicy).toBe('production-review-threshold');expect(run.reservations).toHaveLength(6);
 },30_000);

 it('resumes completed document/repetition pairs without additional model calls',async()=>{
  const {options}=await fixture();const fake=fakeModel(),controller=new AbortController();
  const first=await runEvaluation({...options,signal:controller.signal},{provider:fake.provider,onProgress:()=>controller.abort()});
  expect(first.status).toBe('interrupted');expect(first.documents).toHaveLength(1);expect(fake.requests).toHaveLength(1);
  const resumed=await runEvaluation({...options,resume:true},{provider:fake.provider});
  expect(resumed.status).toBe('completed');expect(resumed.documents).toHaveLength(2);expect(fake.requests).toHaveLength(2);
  await runEvaluation({...options,resume:true},{provider:fake.provider});expect(fake.requests).toHaveLength(2);
 },20_000);

 it('refuses changed labels, config, context and source bytes without overwriting the checkpoint',async()=>{
  const {options,labels,context,manifest}=await fixture();const fake=fakeModel();
  await runEvaluation(options,{provider:fake.provider});
  const original=await readFile(options.output,'utf8');
  labels.labels[0]!.notes='Human changed the annotation';await writeJsonAtomic(options.labels,labels);
  await expect(runEvaluation({...options,resume:true},{provider:fake.provider})).rejects.toThrow('无法恢复');
  expect(await readFile(options.output,'utf8')).toBe(original);
  delete labels.labels[0]!.notes;await writeJsonAtomic(options.labels,labels);
  await expect(runEvaluation({...options,resume:true,temperature:0.6},{provider:fake.provider})).rejects.toThrow('无法恢复');
  context.thresholds.review=0.65;await writeJsonAtomic(options.context,context);
  await expect(runEvaluation({...options,resume:true},{provider:fake.provider})).rejects.toThrow('无法恢复');
  context.thresholds.review=0.6;await writeJsonAtomic(options.context,context);
  await writeFile(manifest.documents[0]!.path,'changed content');
  await expect(runEvaluation({...options,resume:true},{provider:fake.provider})).rejects.toThrow('内容哈希');
  expect(await readFile(options.output,'utf8')).toBe(original);expect(fake.requests).toHaveLength(2);
 },20_000);

 it('retains unknown crash reservations and stops before the next request when the budget is insufficient',async()=>{
  const {options}=await fixture();options.budgetCny=0.8;
  const fake=fakeModel(),controller=new AbortController();
  await runEvaluation({...options,signal:controller.signal},{provider:fake.provider,onProgress:()=>controller.abort()});
  const checkpoint=await readJson<EvaluationRun>(options.output);
  const reserve=3*costForTokens(7900,3000,checkpoint.prices);
  checkpoint.reservations!.push({documentId:'document-2',repetition:1,reservedCny:reserve,startedAt:timestamp});
  checkpoint.reservedCostCny+=reserve;
  await writeJsonAtomic(options.output,checkpoint);
  const resumed=await runEvaluation({...options,resume:true},{provider:fake.provider});
  expect(resumed.status).toBe('budget_stopped');expect(resumed.documents).toHaveLength(1);
  expect(fake.requests).toHaveLength(1);expect(resumed.reservedCostCny).toBeCloseTo(reserve*2);
  const report=await readJson<EvaluationRun>(options.output);
  const metrics=report.metrics as {methodology:{warnings:string[];targetAssessment:string};counts:{plannedDocuments:number;documents:number}};
  expect(metrics.methodology.warnings.some(warning=>warning.includes('budget_stopped'))).toBe(true);
  expect(metrics.methodology.targetAssessment).toContain('not automatically passed');
  expect(metrics.counts.documents).toBeLessThan(metrics.counts.plannedDocuments);
 },20_000);

 it('requires genuine human label provenance and explicit unlabeled opt-in; rules mode is offline',async()=>{
  const {options,labels}=await fixture();labels.labels=[];await writeJsonAtomic(options.labels,labels);
  await expect(runEvaluation({...options,provider:'rules'})).rejects.toThrow('缺少人工标准答案');
  const run=await runEvaluation({...options,provider:'rules',allowUnlabeled:true});
  expect(run.provider).toBe('rules');expect(run.reservations).toHaveLength(0);expect(run.reservedCostCny).toBe(0);
  expect(run.documents.every(result=>!result.expected&&!result.usage)).toBe(true);
  const labelBytes=JSON.parse(await readFile(options.labels,'utf8'));labelBytes.labels=[{origin:'ai'}];
  await writeJsonAtomic(options.labels,labelBytes);
  await expect(runEvaluation({...options,provider:'rules',resume:true,allowUnlabeled:true})).rejects.toThrow();
 },20_000);

 it('refuses concurrent runs and fresh output overwrite, including report sidecars',async()=>{
  const {options,directory}=await fixture();
  let entered!:()=>void,release!:()=>void;
  const pending=new Promise<void>(resolve=>{entered=resolve;}),released=new Promise<void>(resolve=>{release=resolve;});
  const first=runEvaluation(options,{provider:{async generate(){entered();await released;return {content:JSON.stringify({classification})};}}});
  await pending;
  await expect(runEvaluation({...options,provider:'rules'})).rejects.toThrow('已被锁定');
  release();await first;
  await expect(runEvaluation({...options,provider:'rules'})).rejects.toThrow('已存在');
  await writeFile(join(directory,'different.md'),'existing experiment');
  await expect(runEvaluation({...options,output:join(directory,'different.json'),provider:'rules'})).rejects.toThrow('已存在');
  expect(await readFile(join(directory,'different.md'),'utf8')).toBe('existing experiment');
 },20_000);
});
