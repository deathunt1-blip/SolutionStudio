import { describe, expect, it } from 'vitest';
import { classifyDocument, reviewReasons } from '../packages/classification/src/index.js';
import type { ParsedDocument, Registries } from '../packages/core/src/types.js';

const registries:Registries={documentTypes:[{key:'unknown',label:'未知',aliases:[]},{key:'solution',label:'技术方案',aliases:[]}],applications:[{key:'education',label:'教育',aliases:[]}],topics:[{key:'testing',label:'测试',aliases:[]}]};
const text='技术方案只是本教学草稿中的示例，正文讨论测试方法，尚未正式发布。';
const parsed:ParsedDocument={plainText:text,blocks:[{type:'paragraph',text}],tables:[],metadata:{},parseWarnings:[],parseStatus:'success'};
const meta={sourceId:'test',sourceType:'manual',filename:'教学草稿.txt'};
const field=(value:unknown,confidence=0.9)=>({value,confidence});
const response=()=>({classification:{documentType:field('unknown',0),applications:field(['education']),topics:field(['testing']),products:field([]),authority:field('unknown',0),language:field('zh',1)},reasoning:{documentType:'包含方案示例的教学草稿，不能据此判断整篇用途。',authority:'没有正式批准依据。',topics:'正文讨论测试方法。'}});
const run=(value:unknown)=>classifyDocument(meta,parsed,registries,[],{generate:async()=>({content:JSON.stringify(value),usage:{inputTokens:12,outputTokens:8}})});

describe('strict classification tolerates observed explanation placement',()=>{
 it('accepts bounded top-level per-field reasoning without replacing a cautious unknown with a rule guess',async()=>{
  const output=await run(response());
  expect(output.classification.documentType).toMatchObject({value:'unknown',confidence:0,source:'ai'});
  expect(output.classification.topics.value).toEqual(['testing']);
  expect(reviewReasons(output.classification,0.6)).toHaveLength(2);
  expect(output.warnings.join('')).not.toContain('分类失败');
  expect(output.usage).toEqual({inputTokens:12,outputTokens:8});
  expect(output.summary).not.toContain('不能据此判断整篇用途');
 });
 it('does not treat envelope explanations as authority or product evidence',async()=>{
  const answer=response();answer.classification.authority={...field('authoritative'),evidence:'正式批准'} as any;
  answer.classification.products=field(['INVENTED-PRODUCT']);
  answer.reasoning.authority='正式批准：INVENTED-PRODUCT 是权威参数。';
  const output=await run(answer);
  expect(output.classification.authority.value).not.toBe('authoritative');
  expect(output.classification.products.value).toEqual([]);
 });
 it.each([1.2,'0.95'])('still rejects malformed confidence %j and emits a safe schema path',async confidence=>{
  const answer=response();answer.classification.documentType.confidence=confidence as number;
  const output=await run(answer);
  expect(output.classification.documentType.source).toBe('rule');
  expect(output.warnings.join('')).toContain('classification.documentType.confidence:');
  expect(output.usage).toEqual({inputTokens:12,outputTokens:8});
 });
 it('continues rejecting unrecognized envelope keys without persisting arbitrary key names or response content',async()=>{
  const output=await run({...response(),'sk-private-key-name':'private model response'});
  expect(output.classification.documentType.source).toBe('rule');
  expect(output.warnings.join('')).toContain('$:unrecognized_keys');
  expect(JSON.stringify(output)).not.toContain('sk-private');
  expect(JSON.stringify(output)).not.toContain('private model response');
 });
 it('rejects malformed explanation objects instead of relaxing the classification schema',async()=>{
  const output=await run({...response(),reasoning:{authority:{evidence:'hidden'}}});
  expect(output.classification.documentType.source).toBe('rule');
  expect(output.warnings.join('')).toContain('reasoning.authority:invalid_type');
 });
});
