import { describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { Classification, DocumentRecord, LLMProvider, LLMRequest, ParsedDocument } from '../packages/core/src/types.js';
import { initialRegistries, openDatabase, type Connection } from '../packages/knowledge/src/database.js';
import { getDocument, saveClassification } from '../packages/knowledge/src/repository.js';
import { indexText } from '../packages/knowledge/src/search.js';
import { analyzeCorpus, isGenericTitle, MAX_PROMPT_BYTES, refineDocument } from '../packages/refinement/src/engine.js';
import { buildCorpusCards, compactClassificationContext, CorpusContextBuilder, documentToCard } from '../packages/refinement/src/context.js';
import { PostgreSQLDocumentSimilarityProvider } from '../packages/refinement/src/similarity.js';
import type { CorpusContext, CorpusDocumentCard, RefinementInput } from '../packages/refinement/src/types.js';

const cv=<T>(value:T,source:'ai'|'user'='ai',confidence=0.95)=>({value,source,confidence});
const classification=(source:'ai'|'user'='ai'):Classification=>({documentType:cv('solution',source),authority:cv('reference' as const,source),applications:cv(['robotics'],source),topics:cv(['camera'],source),products:cv(['K18'],source),language:cv('zh',source)});
const document=(overrides:Partial<DocumentRecord>={}):DocumentRecord=>({id:'current',title:'概述',filename:'三维机器人K18建设方案.docx',status:'active',scope:'global',sourceType:'manual',sourceId:'manual',activeVersionId:'v1',versionNumber:1,contentHash:'hash-current',summary:'三维机器人相机建设方案。',classification:classification(),reviewReasons:[],parseStatus:'success',parseWarnings:[],createdAt:'2026-09-22T00:00:00Z',updatedAt:'2026-09-22T00:00:00Z',chunkCount:1,...overrides});
const parsed=(text='三维机器人相机建设方案。产品 K18 用于机器人动作追踪，包含部署、标定与同步步骤。'):ParsedDocument=>({title:'概述',plainText:text,blocks:[{type:'heading',text:'概述'},{type:'paragraph',text}],tables:[],metadata:{},parseWarnings:[],parseStatus:'success'});
const context=():CorpusContext=>({similar:[],confirmed:[],distribution:{solution:2},groups:[]});
const input=(overrides:Partial<RefinementInput>={}):RefinementInput=>({document:document(),parsed:parsed(),registries:initialRegistries,context:context(),operations:['title','summary','classification','tags'],...overrides});
const proposal=(value:unknown,evidence:string|string[]=[],confidence=0.93)=>({value,confidence,evidence,reasoning:'根据当前文件内容。'});
const model=(answer:unknown)=>({generate:vi.fn(async(_request:LLMRequest)=>({content:JSON.stringify(answer),usage:{inputTokens:100,outputTokens:30}}))});
const goodAnswer=()=>({canonical_title:proposal('三维机器人K18相机建设方案','三维机器人相机建设方案'),summary:proposal('本资料是三维机器人相机建设方案，说明 K18 的用途及部署、标定和同步步骤。','产品 K18 用于机器人动作追踪'),document_type:proposal('solution','建设方案'),authority:proposal('reference','建设方案'),applications:proposal(['robotics']),topics:proposal(['camera','synchronization']),products:proposal(['K18'])});

describe('unified refinement and current-file grounding',()=>{
 it('makes one model request for all fields and preserves a meaningful 三维 title',async()=>{
  const provider=model(goodAnswer()),result=await refineDocument(input(),provider);
  expect(provider.generate).toHaveBeenCalledTimes(1);expect(result.suggestions).toHaveLength(7);
  expect(result.suggestions.find(item=>item.field==='title')?.proposedValue).toBe('三维机器人K18相机建设方案');
  expect(result.usage).toEqual({inputTokens:100,outputTokens:30});expect(result.promptBytes).toBeLessThanOrEqual(MAX_PROMPT_BYTES);
 });
 it('removes known document extensions without truncating version or model suffixes',async()=>{
  for(const [title,expected] of [['相机标定手册 V2.1','相机标定手册 V2.1'],['相机标定手册 V2.1.DOCX','相机标定手册 V2.1'],['相机标定手册 K18.A','相机标定手册 K18.A'],['相机标定手册 K18.A.markdown','相机标定手册 K18.A']]){
   const own=input({document:document({filename:`${expected}.docx`}),parsed:parsed(expected)});
   const result=await refineDocument(own,model({canonical_title:proposal(title,expected)}));
   expect(result.suggestions.find(item=>item.field==='title')?.proposedValue,title).toBe(expected);
  }
 });
 it.each(['概述','项目背景和建设必要性','一、技术方案','使用说明'])('rejects generic heading %s',async title=>{
  const provider=model({canonical_title:proposal(title,'建设方案')});const result=await refineDocument(input(),provider);
  expect(result.suggestions).toEqual([]);expect(isGenericTitle(title)).toBe(true);expect(result.warnings.join('')).toContain('标题');
 });
 it('preserves human titles and fields by default, and permits explicit inclusion',async()=>{
  const original=document({title:'人工规范标题',titleSource:'user',classification:classification('user')});
  const provider=model(goodAnswer());const result=await refineDocument(input({document:original}),provider);
  expect(result.suggestions.map(item=>item.field)).toEqual(['summary']);
  expect((await refineDocument(input({document:original,includeUserFields:true,includeUserTitles:true}),provider)).suggestions).toHaveLength(7);
  expect(original.title).toBe('人工规范标题');expect(original.classification?.authority.source).toBe('user');
 });
 it('does not inherit authoritative status or products from similar confirmed documents',async()=>{
  const card=documentToCard(document({id:'other',contentHash:'other-hash',title:'正式发布的 K99 产品手册',summary:'正式发布：K99 操作手册',classification:{...classification('user'),authority:cv('authoritative','user'),products:cv(['K99'],'user')}}));
  const ctx=context();ctx.similar=[{document:card,score:1,strength:'strong',weight:1}];ctx.confirmed=[card];
  const provider=model({authority:proposal('authoritative','正式发布：K99 操作手册'),products:proposal(['K18','K99'])});
  const result=await refineDocument(input({context:ctx}),provider);
  expect(result.suggestions.find(item=>item.field==='authority')).toBeUndefined();expect(result.suggestions.find(item=>item.field==='products')?.proposedValue).toEqual(['K18']);
  expect(result.warnings.join('')).toContain('不继承');
 });
 it('rejects quoted standards and drafts as authoritative; permits own publication evidence',async()=>{
  const own='方案要求参考 GB/T 12345。\n规范性引用文件\n正式发布的其他手册。';
  expect((await refineDocument(input({parsed:parsed(own)}),model({authority:proposal('authoritative','GB/T 12345')}))).suggestions).toEqual([]);
  const release='K18 产品手册\n正式发布：2026 年产品技术手册。';
  const result=await refineDocument(input({parsed:parsed(release)}),model({authority:proposal('authoritative','正式发布：2026 年产品技术手册。')}));
  expect(result.suggestions[0]?.proposedValue).toBe('authoritative');
  expect((await refineDocument(input({parsed:parsed(`草案，未正式发布。\n${release}`)}),model({authority:proposal('authoritative','正式发布：2026 年产品技术手册。')}))).suggestions).toEqual([]);
 });
 it('does not accept partial product identifiers or invented numeric title/summary facts',async()=>{
  const result=await refineDocument(input({document:document({filename:'K180相机建设方案.docx'}),parsed:parsed('产品 K180 相机建设方案。')}),model({canonical_title:proposal('K999 相机建设方案','相机建设方案'),summary:proposal('K180 相机支持 1000Hz 采样率。','相机建设方案'),products:proposal(['K18','K180'])}));
  expect(result.suggestions.map(item=>item.field)).toEqual(['products']);expect(result.suggestions[0]?.proposedValue).toEqual(['K180']);
 });
 it('a valid generic quote cannot justify inventing a customer name in the title',async()=>{
  const result=await refineDocument(input(),model({canonical_title:proposal('腾讯机器人相机建设方案','机器人相机建设方案')}));
  expect(result.suggestions).toEqual([]);expect(result.warnings.join('')).toContain('对象词');
 });
 it('requires a named institution to occur as a full name, while allowing grounded title recombination',async()=>{
  const own='清华大学与北京大学联合开展三维机器人技术研究。相机型号 K18，提供建设方案。';
  const bad=await refineDocument(input({parsed:parsed(own)}),model({canonical_title:proposal('清华北京大学三维机器人建设方案','三维机器人技术研究')}));
  expect(bad.suggestions).toEqual([]);
  const good=await refineDocument(input({parsed:parsed(own)}),model({canonical_title:proposal('清华大学K18三维机器人建设方案','清华大学与北京大学')}));
  expect(good.suggestions[0]?.proposedValue).toBe('清华大学K18三维机器人建设方案');
 });
 it('filters selected operations after one call and never mutates input',async()=>{
  const original=input({operations:['title']});const snapshot=structuredClone(original),provider=model(goodAnswer());
  expect((await refineDocument(original,provider)).suggestions.map(item=>item.field)).toEqual(['title']);expect(original).toEqual(snapshot);expect(provider.generate).toHaveBeenCalledTimes(1);
 });
 it('requests only a concise canonical_title object for title-only work, leaving combined requests unchanged',async()=>{
  const titleProvider=model({canonical_title:goodAnswer().canonical_title});const result=await refineDocument(input({operations:['title']}),titleProvider);
  const titleRequest=titleProvider.generate.mock.calls[0]![0],instructions=JSON.parse(titleRequest.prompt).instructions as string;
  expect(Object.keys(JSON.parse(instructions.match(/\{.*\}/)![0]))).toEqual(['canonical_title']);
  expect(instructions).not.toContain('一次返回全部可判断字段');expect(instructions).toContain('evidence最多3条');expect(instructions).toContain('每条最多160字符');
  for(const field of ['summary','document_type','authority','applications','topics','products'])expect(instructions).not.toContain(`"${field}"`);
  expect(instructions).toContain('连续逐字引用当前文件名/解析标题/正文');expect(instructions).toContain('泛化章节名');expect(titleRequest.system).toContain('不得虚构客户');
  expect(result.suggestions.map(value=>value.field)).toEqual(['title']);expect(result.promptBytes).toBeLessThanOrEqual(MAX_PROMPT_BYTES);
  const combinedProvider=model(goodAnswer());await refineDocument(input({operations:['title','summary']}),combinedProvider);
  const combined=JSON.parse(combinedProvider.generate.mock.calls[0]![0].prompt).instructions as string;
  expect(combined).toContain('一次返回全部可判断字段');expect(Object.keys(JSON.parse(combined.match(/\{.*\}/)![0]))).toHaveLength(7);
 });
 it('retains current-file grounding and generic-title rejection for title-only requests',async()=>{
  for(const title of ['概述','一、技术方案','腾讯机器人相机建设方案']){
   const result=await refineDocument(input({operations:['title']}),model({canonical_title:proposal(title,'机器人相机建设方案')}));
   expect(result.suggestions,title).toEqual([]);expect(result.warnings.join('')).toContain('标题');
  }
 });
 it('fails closed with usage for malformed output and does not expose provider credentials',async()=>{
  const malformed=model({canonical_title:{value:'标题',confidence:99}});const result=await refineDocument(input(),malformed);
  expect(result.suggestions).toEqual([]);expect(result.usage?.inputTokens).toBe(100);expect(result.warnings.join('')).toContain('结构');
  const throwing:LLMProvider={generate:async()=>{throw new Error('sk-secret-provider-message');}};
  expect(JSON.stringify(await refineDocument(input(),throwing))).not.toContain('sk-secret');
 });
 it('reports safe schema locations and codes without response values or arbitrary keys',async()=>{
  const provider=model({canonical_title:{value:'私密客户名称',confidence:'0.95',source:'ai'},authority:null,'客户私密额外字段':'sk-private-response'});
  const result=await refineDocument(input(),provider),serialized=JSON.stringify(result);
  expect(result.error).toContain('canonical_title.confidence:invalid_type');expect(result.error).toContain('canonical_title:unrecognized_keys');expect(result.error).toContain('authority:invalid_type');
  expect(serialized).not.toContain('私密客户名称');expect(serialized).not.toContain('客户私密额外字段');expect(serialized).not.toContain('sk-private-response');
  expect(result.suggestions).toEqual([]);expect(result.usage).toEqual({inputTokens:100,outputTokens:30});expect(provider.generate).toHaveBeenCalledTimes(1);
  expect(provider.generate.mock.calls[0]?.[0].prompt).toContain('不要复制输入中的source');
 });
 it('accepts observed longer evidence arrays but retains only eight grounded quotes',async()=>{
  const quotes=Array.from({length:16},(_,i)=>`机器人相机配置第${i+1}项`),own=parsed(quotes.join('\n'));
  const provider=model({summary:proposal('本资料说明机器人相机的配置步骤。',quotes)});
  const result=await refineDocument(input({parsed:own}),provider);
  expect(result.error).toBeUndefined();expect(result.suggestions[0]?.evidence).toEqual(quotes.slice(0,8));expect(result.warnings.join('')).toContain('保留前8条');
  expect(provider.generate.mock.calls[0]?.[0].prompt).toContain('evidence最多8条');
  const invalidFirst=await refineDocument(input({parsed:own}),model({summary:proposal('本资料说明机器人相机的配置步骤。',[...Array(8).fill('当前文件不存在的引文'),...quotes])}));
  expect(invalidFirst.suggestions[0]?.evidence).toEqual(quotes.slice(0,8));
 });
 it('still rejects evidence arrays over the bounded compatibility envelope',async()=>{
  const result=await refineDocument(input(),model({summary:proposal('资料摘要',Array(31).fill('建设方案'))}));
  expect(result.suggestions).toEqual([]);expect(result.error).toContain('结构校验失败');expect(result.usage?.inputTokens).toBe(100);
 });
 it('distinguishes JSON parse failures from requests without exposing either response or errors',async()=>{
  const parseFailure:LLMProvider={generate:async()=>({content:'not JSON: private-client-content',usage:{inputTokens:100,outputTokens:10}})};
  const result=await refineDocument(input(),parseFailure);expect(result.error).toBe('响应 JSON 解析失败');expect(JSON.stringify(result)).not.toContain('private-client-content');
  const providerFailure:LLMProvider={generate:async()=>{throw new Error('private-provider-error');}};
  expect((await refineDocument(input(),providerFailure)).error).toBe('AI 请求失败');
 });
 it('keeps huge multilingual metadata within a valid 18000 byte prompt',async()=>{
  const large='机器人相机测量方案'.repeat(10000),ctx=context();
  for(let i=0;i<20;i++){const card=documentToCard(document({id:`neighbor-${i}`,contentHash:`hash-${i}`,title:large,summary:large,classification:classification('user')}));ctx.similar.push({document:card,score:1,strength:'strong',weight:1});ctx.confirmed.push(card);}
  ctx.distribution=Object.fromEntries(Array.from({length:100},(_,i)=>[`${large}${i}`,99]));
  const provider=model(goodAnswer());await refineDocument(input({document:document({filename:large,title:large,summary:large}),parsed:parsed(large),context:ctx,registries:{documentTypes:Array.from({length:100},(_,i)=>({key:`key${i}${large}`,label:large,aliases:[large,large]})),applications:[],topics:[]}}),provider);
  const request=provider.generate.mock.calls[0]?.[0];expect(request).toBeDefined();
  expect(Buffer.byteLength(request!.system+request!.prompt,'utf8')).toBeLessThanOrEqual(MAX_PROMPT_BYTES);expect(()=>JSON.parse(request!.prompt)).not.toThrow();
 });
});

describe('bounded corpus context and analysis',()=>{
 it('queries only current visible versions and group membership using PostgreSQL',async()=>{
  const directory=await mkdtemp(path.join(tmpdir(),'solution-refinement-context-')),db=await openDatabase(directory);
  try{
   for(const id of ['own','strong','weak','private','archived','duplicate']){
    const hash=id==='duplicate'?'own':id;
    await db.query("INSERT INTO source_documents(id,source_id,source_document_id,source_path,content_hash) VALUES($1,'manual',$1,$2,$3)",[id,`C:\\samples\\${id}.md`,hash]);
    await db.query("INSERT INTO documents(id,organization_id,workspace_id,source_document_id,title,status) VALUES($1,'default','default',$1,'机器人相机方案','active')",[id]);
    await db.query("INSERT INTO document_versions(id,document_id,version_number,filename,content_hash,object_key,size_bytes,summary,parse_status) VALUES($1,$2,1,'机器人方案.md',$3,$1,20,'机器人相机同步部署','success')",[`v-${id}`,id,hash]);
    await db.query('UPDATE documents SET active_version_id=$1 WHERE id=$2',[`v-${id}`,id]);
    await saveClassification(db,`v-${id}`,classification(id==='strong'?'user':'ai'));
    await db.query("INSERT INTO knowledge_chunks(id,document_id,version_id,chunk_order,text,search_vector) VALUES($1,$2,$3,0,'机器人相机同步部署',to_tsvector('simple',$4))",[`chunk-${id}`,id,`v-${id}`,indexText('机器人相机同步部署')]);
   }
   await db.query("UPDATE documents SET scope='project',project_id='hidden' WHERE id='private'");
   await db.query("UPDATE documents SET status='archived' WHERE id='archived'");
   await db.query("INSERT INTO knowledge_groups(id,name) VALUES('robotics','机器人')");
   await db.query("INSERT INTO knowledge_group_documents(group_id,document_id) VALUES('robotics','strong')");
   const cards=await buildCorpusCards(db),ctx=await new CorpusContextBuilder(db).build((await getDocument(db,'own'))!,parsed());
   expect(cards.map(card=>card.id)).not.toContain('private');expect(cards.map(card=>card.id)).not.toContain('archived');expect(cards.find(card=>card.id==='strong')?.versionId).toBe('v-strong');
   expect(ctx.similar.map(item=>item.document.id)).toEqual(expect.arrayContaining(['strong','weak']));expect(ctx.similar.map(item=>item.document.id)).not.toContain('duplicate');
   expect(ctx.confirmed.map(card=>card.id)).toEqual(['strong']);expect(ctx.confirmed[0]?.groups).toEqual(['机器人']);expect(ctx.groups[0]?.documentCount).toBe(1);
  }finally{await db.close();if(path.resolve(directory).startsWith(path.resolve(tmpdir())+path.sep+'solution-refinement-context-'))await rm(directory,{recursive:true,force:true});}
 },30000);
 it('requires both current core fields to be user confirmed',()=>{
  expect(documentToCard(document()).userConfirmed).toBe(false);
  expect(documentToCard(document({classification:{...classification(),documentType:cv('solution','user')}})).userConfirmed).toBe(false);
  expect(documentToCard(document({classification:classification('user')})).userConfirmed).toBe(true);
  expect(documentToCard(document({classification:null})).userConfirmed).toBe(false);
 });
 it('combines FTS and metadata while excluding self, same hash, and low-confidence AI',async()=>{
  const own=documentToCard(document()),strong=documentToCard(document({id:'strong',contentHash:'strong',classification:classification('user')})),weak=documentToCard(document({id:'weak',contentHash:'weak'})),low=documentToCard(document({id:'low',contentHash:'low',classification:{...classification(),authority:cv('reference','ai',0.5)}})),duplicate=documentToCard(document({id:'duplicate'}));
  const query=vi.fn(async(_sql:string,_values?:unknown[])=>[{document_id:'weak',rank:1},{document_id:'strong',rank:0.7}]);const db={query} as unknown as Connection;
  const result=await new PostgreSQLDocumentSimilarityProvider(db,[own,strong,weak,low,duplicate]).findSimilar(own,5);
  expect(new Set(result.map(item=>item.document.id))).toEqual(new Set(['strong','weak']));expect(result.find(item=>item.document.id==='strong')?.strength).toBe('strong');expect(result.find(item=>item.document.id==='weak')?.weight).toBe(0.3);
  expect(query.mock.calls[0]?.[0]).toContain('c.version_id=d.active_version_id');
 });
 it('provides bounded ingestion JSON with no inherited authority or products',()=>{
  const ctx=context(),card=documentToCard(document({id:'neighbor',title:'相机技术方案',contentHash:'neighbor',classification:classification('user')}));
  ctx.similar=Array.from({length:8},()=>({document:card,score:1,strength:'strong' as const,weight:1}));
  const output=compactClassificationContext(ctx);expect(Buffer.byteLength(output,'utf8')).toBeLessThanOrEqual(900);expect(JSON.parse(output).similar.length).toBeLessThanOrEqual(5);expect(output).not.toContain('authority');expect(output).not.toContain('K18');
 });
 it('validates referenced documents and grounds entity aliases without registry mutation',async()=>{
  const cards=[documentToCard(document({id:'a',classification:{...classification(),products:cv(['K18'])}})),documentToCard(document({id:'b',contentHash:'b',classification:{...classification(),products:cv(['K18相机'])}}))];
  const registryBefore=structuredClone(initialRegistries),provider=model({suggestions:[{kind:'group',name:'机器人',description:'主题相近',documentIds:['a','b'],confidence:0.9},{kind:'entity_alias',name:'K18',description:'同名词候选，需要确认',documentIds:['a','b'],canonical:'K18',aliases:['K18相机'],confidence:0.8},{kind:'entity_alias',name:'虚构产品',description:'无证据',documentIds:['a','b'],canonical:'K999',aliases:['K18'],confidence:0.99},{kind:'outlier',name:'其他文档',description:'不在本批',documentIds:['outside'],confidence:0.9}]});
  const result=await analyzeCorpus(cards,initialRegistries,provider);expect(result.suggestions.map(item=>item.kind)).toEqual(['group','entity_alias']);expect(result.warnings).toHaveLength(2);expect(initialRegistries).toEqual(registryBefore);expect(provider.generate).toHaveBeenCalledTimes(1);
 });
 it('uses safe indexed diagnostics for malformed corpus suggestions',async()=>{
  const result=await analyzeCorpus([documentToCard(document())],initialRegistries,model({suggestions:[{kind:'outlier',name:'私密资料名',description:'私密描述',documentIds:['current'],confidence:null,'秘密键':'private-value'}]}));
  expect(result.error).toContain('suggestions.0.confidence:invalid_type');expect(result.error).toContain('suggestions.0:unrecognized_keys');expect(result.suggestions).toEqual([]);
  expect(JSON.stringify(result)).not.toContain('私密');expect(JSON.stringify(result)).not.toContain('秘密键');expect(result.usage?.inputTokens).toBe(100);
 });
 it('grounds longer corpus evidence lists before retaining eight quotes in one request',async()=>{
  const quotes=Array.from({length:16},(_,i)=>`机器人相机配置第${i+1}项`),card=documentToCard(document({id:'a',summary:quotes.join('\n')}));
  const provider=model({suggestions:[{kind:'outlier',name:'配置项待核对',description:'需要核对配置项',documentIds:['a'],confidence:0.8,evidence:[...Array(8).fill('卡片中不存在的证据'),...quotes]}]});
  const result=await analyzeCorpus([card],initialRegistries,provider);
  expect(result.error).toBeUndefined();expect(result.suggestions[0]?.evidence).toEqual(quotes.slice(0,8));expect(result.warnings.join('')).toContain('保留前8条');expect(provider.generate).toHaveBeenCalledTimes(1);
  const prompt=provider.generate.mock.calls[0]?.[0].prompt;expect(prompt).toContain('最多8条原文证据');expect(prompt).toContain('每条最多500字符');expect(prompt).toContain('整批最多12项建议');
 });
 it('rejects corpus evidence lists exceeding the 30 quote compatibility bound',async()=>{
  const provider=model({suggestions:[{kind:'outlier',name:'异常项',description:'核对配置',documentIds:['current'],confidence:0.8,evidence:Array(31).fill('建设方案')}]});
  const result=await analyzeCorpus([documentToCard(document())],initialRegistries,provider);
  expect(result.suggestions).toEqual([]);expect(result.error).toContain('suggestions.0.evidence:too_big');expect(provider.generate).toHaveBeenCalledTimes(1);expect(result.usage?.inputTokens).toBe(100);
 });
 it('enforces 50 cards and a complete byte bound even for oversized cards',async()=>{
  const huge='机器人部署标题'.repeat(1000),cards:CorpusDocumentCard[]=Array.from({length:50},(_,i)=>({id:`document-${i}`,title:huge,summary:huge,documentType:huge,authority:'reference',applications:Array(12).fill(huge),topics:Array(15).fill(huge),products:Array(15).fill(huge),groups:Array(8).fill(huge),userConfirmed:false,sourceType:'manual',confidence:0.9}));
  const provider=model({suggestions:[]});const result=await analyzeCorpus(cards,initialRegistries,provider);
  expect(result.promptBytes).toBeLessThanOrEqual(MAX_PROMPT_BYTES);const request=provider.generate.mock.calls[0]?.[0];expect(JSON.parse(request!.prompt).cards).toHaveLength(50);
  await expect(analyzeCorpus([...cards,cards[0]!],initialRegistries,provider)).rejects.toThrow('at most 50');expect(provider.generate).toHaveBeenCalledTimes(1);
 });
});
