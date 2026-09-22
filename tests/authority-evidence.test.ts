import {describe,expect,it} from 'vitest';
import {classifyDocument} from '../packages/classification/src/index.js';
import {hasCurrentAuthorityEvidence} from '../packages/classification/src/authority.js';
import {initialRegistries} from '../packages/knowledge/src/database.js';
import type {ParsedDocument,LLMProvider} from '../packages/core/src/types.js';
describe('Authority requires current-document publication evidence',()=>{
 it('rejects cited standard numbers, quoted approval and negative draft publication',()=>{
  expect(hasCurrentAuthorityEvidence('产品技术标准\n规范性引用文件\nGB/T 12345 正式发布')).toBe(false);
  expect(hasCurrentAuthorityEvidence('产品手册\n草案 尚未正式发布')).toBe(false);
  expect(hasCurrentAuthorityEvidence('根据已批准文件进行编写')).toBe(false);
  expect(hasCurrentAuthorityEvidence('产品手册\n正式发布：2026-09-22','正式发布：2026-09-22')).toBe(true);
 });
 it('neither rules nor rejected AI evidence fall back to authoritative from a reference list',async()=>{
  const parsed:ParsedDocument={title:'产品标准',plainText:'产品标准\n规范性引用文件\nGB/T 12345-2020\n本文定义相机接口。',blocks:[],tables:[],metadata:{},parseStatus:'success',parseWarnings:[]};
  const meta={filename:'产品标准.md',sourceId:'manual',sourceType:'manual'};
  const local=await classifyDocument(meta,parsed,initialRegistries,[]);expect(local.classification.authority.value).toBe('unknown');
  const f=(value:unknown,evidence?:string)=>({value,confidence:0.99,...(evidence?{evidence}:{})});
  const provider:LLMProvider={generate:async()=>({content:JSON.stringify({classification:{documentType:f('standard','产品标准'),authority:f('authoritative','GB/T 12345-2020'),applications:f([]),topics:f([]),products:f([]),language:f('zh')}})})};
  const result=await classifyDocument(meta,parsed,initialRegistries,[],provider,{trace:true,corpusContext:JSON.stringify({similar:[{title:'正式产品手册',authority:'authoritative',source:'user'}]})});
  expect(result.classification.authority.value).toBe('unknown');expect(result.classification.authority.confidence).toBe(0);expect(result.warnings.join()).toContain('送人工确认');
  expect(Buffer.byteLength(result.trace!.prompt!+result.trace!.systemPrompt!,'utf8')).toBeLessThanOrEqual(7900);
 });
});
