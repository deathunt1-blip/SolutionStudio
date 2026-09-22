import {afterEach,describe,expect,it} from 'vitest';
import {mkdtemp,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {contentHash,loadLabels,loadManifest,writeJsonAtomic} from '../packages/evaluation/src/data.js';
import {classifyDocument} from '../packages/classification/src/index.js';
import {initialRegistries} from '../packages/knowledge/src/database.js';
import type {LLMRequest,ParsedDocument} from '../packages/core/src/types.js';

const temporary:string[]=[];
afterEach(async()=>{for(const directory of temporary.splice(0))await rm(directory,{recursive:true,force:true});});
describe('evaluation data and production trace',()=>{
 it('resolves manifest paths relative to the manifest and rejects stale or automatic labels',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'studio-eval-data-'));temporary.push(dir);
  const hash=contentHash('original'),manifestPath=join(dir,'manifest.json'),labelsPath=join(dir,'labels.json');
  await writeJsonAtomic(manifestPath,{schemaVersion:1,datasetId:'fixture',createdAt:new Date().toISOString(),documents:[{id:'a',path:'source.md',filename:'source.md',contentHash:hash}]});
  const manifest=await loadManifest(manifestPath);expect(manifest.documents[0]!.path).toBe(join(dir,'source.md'));
  const label={documentId:'a',contentHash:hash,filename:'source.md',documentType:'solution',authority:'reference',origin:'human',labeledBy:'synthetic test fixture',labeledAt:new Date().toISOString()};
  await writeJsonAtomic(labelsPath,{schemaVersion:1,datasetId:'fixture',labels:[label]});
  expect((await loadLabels(labelsPath,manifest)).labels).toHaveLength(1);
  await writeJsonAtomic(labelsPath,{schemaVersion:1,datasetId:'fixture',labels:[{...label,contentHash:contentHash('changed')}]});
  await expect(loadLabels(labelsPath,manifest)).rejects.toThrow('版本');
  await writeJsonAtomic(labelsPath,{schemaVersion:1,datasetId:'fixture',labels:[{...label,origin:'ai'}]});
  await expect(loadLabels(labelsPath,manifest)).rejects.toThrow();
  await writeFile(labelsPath,'not json');await expect(loadLabels(labelsPath,manifest)).rejects.toThrow();
 });
 it('captures the exact submitted bounded fingerprint and model evidence only when explicitly requested',async()=>{
  const parsed:ParsedDocument={plainText:'技术方案\n历史项目部署，仅供参考。',blocks:[{type:'paragraph',text:'历史项目部署，仅供参考。'}],tables:[],metadata:{},parseStatus:'success',parseWarnings:[]};
  const meta={sourceId:'synthetic',sourceType:'manual',filename:'技术方案.md'};
  let submitted:LLMRequest|undefined;
  const provider={generate:async(request:LLMRequest)=>{submitted=request;return{content:JSON.stringify({classification:{documentType:{value:'solution',confidence:.9,evidence:'技术方案'},authority:{value:'reference',confidence:.9,evidence:'历史项目部署'},applications:{value:[],confidence:.9},topics:{value:[],confidence:.9},products:{value:[],confidence:.9},language:{value:'zh',confidence:1}}})};}};
  const examples=[{id:'example',documentId:'different',textSummary:'历史项目部署',confirmedFields:{},createdAt:new Date().toISOString()}];
  const normal=await classifyDocument(meta,parsed,initialRegistries,examples,provider);expect(normal.trace).toBeUndefined();
  const traced=await classifyDocument(meta,parsed,initialRegistries,examples,provider,{trace:true});
  expect(traced.classification).toEqual(normal.classification);
  expect(traced.trace!.prompt).toBe(submitted!.prompt);expect(traced.trace!.systemPrompt).toBe(submitted!.system);
  expect(submitted!.prompt.endsWith(traced.trace!.fingerprint)).toBe(true);
  expect(traced.trace!.usedConfirmedExamples).toEqual(['example']);
  expect(traced.trace!.evidence).toContain('历史项目部署');expect(traced.trace!.ruleDecision.documentType.value).toBe('solution');
 });
});
