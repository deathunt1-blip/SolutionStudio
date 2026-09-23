import {afterAll,beforeAll,expect,test} from 'vitest';
import {mkdtemp,readdir,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {openDatabase,type Database} from '../packages/knowledge/src/database.js';
import {KnowledgeService} from '../packages/knowledge/src/service.js';
import {LocalObjectStorage} from '../packages/knowledge/src/storage.js';
import {KnowledgeEnrichmentService} from '../packages/knowledge-enrichment/src/service.js';
import type {LLMProvider} from '../packages/core/src/types.js';

let directory:string,db:Database,knowledge:KnowledgeService,service:KnowledgeEnrichmentService,storage:LocalObjectStorage,calls=0;
const provider:LLMProvider={generate:async request=>{calls++;return {content:calls===1?'invalid original response':JSON.stringify({documentTags:{},sections:JSON.parse(request.prompt).sections.map((s:any)=>({order:s.order,summary:'部署说明',sectionRole:'deployment',tags:{},reusable:true,blueprint:{purpose:'解释安装标定过程',recommendedStructure:['安装','标定']}})),aliases:[]}),usage:{inputTokens:20,outputTokens:30}};}};
beforeAll(async()=>{directory=await mkdtemp(join(tmpdir(),'studio-local-cache-'));db=await openDatabase(directory);storage=new LocalObjectStorage(join(directory,'objects'));knowledge=new KnowledgeService(db,directory,storage,()=>provider);await knowledge.settings.init();await knowledge.settings.patch({llm:{apiKey:'synthetic-test-key',model:'kimi-k3'}});service=new KnowledgeEnrichmentService(knowledge,{providerFactory:()=>provider});await service.start();},30000);
afterAll(async()=>{await service?.close();await db?.close();await rm(directory,{recursive:true,force:true});},30000);
async function completed(documentId:string){const batch=await service.createBatch({documentIds:[documentId]});for(let i=0;i<400;i++){const result=await service.getBatch(batch.id);if(!['queued','running'].includes(result.batch.status))return result;await new Promise(resolve=>setTimeout(resolve,10));}throw Error('Fixture enrichment did not finish');}

test('an explicit retry replaces an invalid exact-request lookup, preserves both raw responses and then reuses without rebilling',async()=>{
 const id=randomUUID(),version=randomUUID(),source=randomUUID(),parsed={plainText:'相机部署\n交叉观察并完成安装标定。',blocks:[{type:'heading',text:'相机部署',level:1},{type:'paragraph',text:'交叉观察并完成安装标定。'}],tables:[],metadata:{},parseStatus:'success',parseWarnings:[]};
 await db.query("INSERT INTO source_documents(id,source_id,source_document_id,content_hash) VALUES($1,'manual',$1,$1)",[source]);await db.query("INSERT INTO documents(id,organization_id,workspace_id,source_document_id,title,canonical_title,status,scope,active_version_id) VALUES($1,'default','default',$2,'缓存回归','缓存回归','active','global',$3)",[id,source,version]);await db.query("INSERT INTO document_versions(id,document_id,version_number,filename,content_hash,object_key,size_bytes,parse_status,parsed_document) VALUES($1,$2,1,'cache.txt',$2,'unused-fixture',1,'success',$3::jsonb)",[version,id,JSON.stringify(parsed)]);
 const first=await completed(id);expect(first.batch.status).toBe('failed');expect(first.batch.inputTokens).toBe(20);
 const retry=await completed(id);expect(retry.batch.status).toBe('completed');expect(calls).toBe(2);expect(retry.batch.inputTokens).toBe(20);
 const reused=await completed(id);expect(reused.batch.status).toBe('completed');expect(reused.batch.inputTokens).toBe(0);expect(reused.batch.estimatedCostCny).toBe(0);expect(calls).toBe(2);
 const base=join(directory,'objects','enrichment-responses',version),files=(await readdir(base,{recursive:true})).filter(name=>name.endsWith('.json'));expect(files).toHaveLength(3);const originals=await Promise.all(files.filter(name=>name.includes('/')||name.includes('\\')).map(name=>readFile(join(base,name),'utf8')));expect(originals).toHaveLength(2);expect(originals.some(value=>JSON.parse(value).response.content==='invalid original response')).toBe(true);
});
test('cache replacement cannot overwrite an uploaded original or leave temporary files',async()=>{
 await storage.put('originals/report.docx',Buffer.from('original'));await expect(storage.put('originals/report.docx',Buffer.from('changed'))).rejects.toThrow('immutable original');await expect(storage.replaceCache('originals/report.docx',Buffer.from('changed'))).rejects.toThrow('Only an enrichment');expect(Buffer.from(await storage.get('originals/report.docx')).toString()).toBe('original');expect((await readdir(join(directory,'objects'),{recursive:true})).some(name=>name.endsWith('.tmp'))).toBe(false);
 for(const version of ['.','..','../outside','..\\outside'])await expect(storage.replaceCache(`enrichment-responses/${version}/${'a'.repeat(64)}.json`,Buffer.from('changed'))).rejects.toThrow('Only an enrichment');
});
