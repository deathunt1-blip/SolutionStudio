import {afterAll,beforeAll,describe,expect,it,vi} from 'vitest';
import {createHash,randomUUID} from 'node:crypto';
import {mkdtemp,readFile,readdir,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve,sep} from 'node:path';
import {createApp} from '../apps/server/src/app.js';
import type {KnowledgeService} from '../packages/knowledge/src/service.js';
import {LocalSecretStore} from '../packages/connections/src/secrets.js';
import {StructuredService} from '../packages/structured/src/service.js';
import type {RemoteResource,RemoteSourceAdapter,SourceListing,StructuredSourceData} from '../packages/core/src/sources.js';

const secret='test-app-secret-'+randomUUID(),token='test-tenant-token-'+randomUUID();
type RemoteState={items:RemoteResource[];complete:boolean;errors:SourceListing['errors'];texts:Map<string,string>;data:Map<string,StructuredSourceData>;fail:Set<string>;fetches:Map<string,number>;listError?:string};
const states=new Map<string,RemoteState>();let testError:string|undefined;
const stateFor=(config:Record<string,unknown>)=>{const state=states.get(String(config.rootUrl));if(!state)throw Error('Mock root missing');return state;};
const adapter:RemoteSourceAdapter={
 type:'mock_remote',async test(){if(testError)throw Error(testError);return{title:'Mock accessible root'};},
 async list(config){const state=stateFor(config);if(state.listError)throw Error(state.listError);return {items:structuredClone(state.items),complete:state.complete,errors:structuredClone(state.errors)};},
 async fetchDocument(resource,config){const state=stateFor(config);state.fetches.set(resource.id,(state.fetches.get(resource.id)??0)+1);if(state.fail.has(resource.id))throw Error(`Mock denied ${secret} Bearer ${token}`);const buffer=Buffer.from(state.texts.get(resource.id)??`# 机器人产品说明书\n\n提供机器人部署与软件配置操作说明。\n资源标识：${resource.id}`);return {buffer,contentHash:createHash('sha256').update(buffer).digest('hex'),meta:{sourceId:'mock',sourceType:'mock_remote',filename:resource.title+'.md',mimeType:'text/markdown'}};},
 async fetchDataset(resource,config){const state=stateFor(config);state.fetches.set(resource.id,(state.fetches.get(resource.id)??0)+1);if(state.fail.has(resource.id))throw Error(`Mock denied ${secret} Bearer ${token}`);return structuredClone(state.data.get(resource.id)!);},
};
function resource(id:string,kind:RemoteResource['kind']='document'):RemoteResource{return{id,title:'机器人资料 '+id,kind,objectType:kind==='dataset'?'sheet':'file',remoteToken:id,remoteUrl:'https://sample.feishu.cn/file/'+id,remoteVersion:'revision-1',path:['产品资料','机器人',id]};}
const removeTemp=async(directory:string)=>{if(!resolve(directory).startsWith(resolve(tmpdir())+sep+'studio-source-'))throw Error('Unsafe test cleanup target');await rm(directory,{recursive:true,force:true});};

describe('Source sync lifecycle and API security using a mock adapter',()=>{
 let app:Awaited<ReturnType<typeof createApp>>,directory:string,knowledge:KnowledgeService,connectionId:string;
 beforeAll(async()=>{
  directory=await mkdtemp(join(tmpdir(),'studio-source-'));app=await createApp({dataDir:directory,llmDisabled:true,adapterFactory:(_provider,credentials)=>{expect(credentials.appSecret).toBe(secret);return adapter;},providerFactory:()=>{throw Error('Unexpected model call');}});knowledge=(app as any).knowledge;
  const created=await app.inject({method:'POST',url:'/api/connections',payload:{name:'Integration mock',appId:'cli_test_app',appSecret:secret}});expect(created.statusCode).toBe(200);expect(created.body).not.toContain(secret);connectionId=created.json().connection.id;
 },30000);
 afterAll(async()=>{await app?.close();if(directory)await removeTemp(directory);});
 async function makeSource(items:RemoteResource[],mode:'wiki'|'sheet'='wiki'){
  const rootUrl=`https://sample.feishu.cn/${mode==='wiki'?'wiki':'sheets'}/${randomUUID()}`,state:RemoteState={items,complete:true,errors:[],texts:new Map(),data:new Map(),fail:new Set(),fetches:new Map()};states.set(rootUrl,state);
  const response=await app.inject({method:'POST',url:'/api/sources',payload:{name:'Test source',rootUrl,connectionId}});expect(response.statusCode).toBe(200);return {source:response.json().source,state};
 }
 async function run(sourceId:string,retryFailed=false){
  const started=await app.inject({method:'POST',url:`/api/sources/${sourceId}/sync`,payload:{retryFailed}});expect(started.statusCode).toBe(202);const id=started.json().job.id;
  for(let i=0;i<400;i++){const rows=(await app.inject(`/api/sources/${sourceId}/jobs`)).json().items;const job=rows.find((r:any)=>r.id===id);if(job&&['completed','partial','failed'].includes(job.status))return job;await new Promise(r=>setTimeout(r,20));}throw Error('Sync job timed out');
 }
 async function resources(sourceId:string){return (await app.inject(`/api/sources/${sourceId}/resources`)).json().items as any[];}
 async function document(id:string){for(let i=0;i<400;i++){const response=await app.inject('/api/documents/'+id),detail=response.json();if(['active','needs_review','failed','archived'].includes(detail.document.status))return detail;await new Promise(r=>setTimeout(r,20));}throw Error('Document ingestion timed out');}
 it('imports, skips unchanged, versions changes and archives removals while preserving original bytes and provenance',async()=>{
  const remote=resource('document-lifecycle'),{source,state}=await makeSource([remote]);state.texts.set(remote.id,'# 机器人部署说明\n\n第一版部署步骤和配置参数。');
  expect(await run(source.id)).toMatchObject({status:'completed',added:1});const entry=(await resources(source.id))[0],first=await document(entry.documentId);expect(first.versions).toHaveLength(1);const firstId=first.versions[0].id;
  expect(first.versions[0].sourceMetadata).toMatchObject({provider:'feishu',remote_token:remote.remoteToken,remote_url:remote.remoteUrl,remote_path:remote.path});expect(first.document.sourcePath).toBe(remote.path.join('/'));
  expect(await run(source.id)).toMatchObject({unchanged:1,added:0,updated:0});expect((await document(entry.documentId)).versions).toHaveLength(1);
  state.texts.set(remote.id,'# 机器人部署说明\n\n第二版更新机器人校准步骤及软件配置。');state.items[0].remoteVersion='revision-2';
  expect(await run(source.id)).toMatchObject({updated:1,added:0});const changed=await document(entry.documentId);expect(changed.versions).toHaveLength(2);expect(changed.document.versionNumber).toBe(2);
  expect((await app.inject(`/api/documents/${entry.documentId}/original?versionId=${firstId}`)).body).toContain('第一版');
  state.items=[];expect(await run(source.id)).toMatchObject({removed:1,status:'completed'});const archived=await document(entry.documentId);expect(archived.document.status).toBe('archived');expect(archived.versions).toHaveLength(2);
  expect((await knowledge.db.query('SELECT removed_from_source FROM source_documents WHERE id=(SELECT source_document_id FROM documents WHERE id=$1)',[entry.documentId]))[0].removed_from_source).toBe(true);
  expect((await app.inject(`/api/documents/${entry.documentId}/original?versionId=${firstId}`)).body).toContain('第一版');
  state.items=[remote];expect(await run(source.id)).toMatchObject({updated:1});expect((await document(entry.documentId)).document.status).not.toBe('archived');
 },20000);
 it('compares actual content when a remote revision changes but bytes remain unchanged',async()=>{
  const remote=resource('same-content'),{source,state}=await makeSource([remote]);await run(source.id);const entry=(await resources(source.id))[0];await document(entry.documentId);
  state.items[0].remoteVersion='revision-only-change';expect(await run(source.id)).toMatchObject({unchanged:1,updated:0});expect((await document(entry.documentId)).versions).toHaveLength(1);
  expect((await knowledge.db.query('SELECT remote_version FROM source_documents WHERE id=(SELECT source_document_id FROM documents WHERE id=$1)',[entry.documentId]))[0].remote_version).toBe('revision-only-change');
 },15000);
 it('recovers document identity after the connector mapping is lost without duplicate versions or model jobs',async()=>{
  const remote=resource('crash-after-ingest'),{source,state}=await makeSource([remote]);await run(source.id);const first=(await resources(source.id))[0];await document(first.documentId);
  const counts=async()=>({documents:(await knowledge.db.query('SELECT count(*)::int AS count FROM documents d JOIN source_documents sd ON sd.id=d.source_document_id WHERE sd.source_id=$1',[source.id]))[0].count,versions:(await knowledge.db.query('SELECT count(*)::int AS count FROM document_versions WHERE document_id=$1',[first.documentId]))[0].count,jobs:(await knowledge.db.query('SELECT count(*)::int AS count FROM ingestion_jobs WHERE document_id=$1',[first.documentId]))[0].count});
  const before=await counts();await knowledge.db.query('DELETE FROM source_resources WHERE source_id=$1',[source.id]);expect(await run(source.id)).toMatchObject({unchanged:1,added:0});expect((await resources(source.id))[0].documentId).toBe(first.documentId);expect(await counts()).toEqual(before);
  await knowledge.db.query('DELETE FROM source_resources WHERE source_id=$1',[source.id]);state.texts.set(remote.id,'# 更新的机器人说明\n\n这次实质新增控制器接口和部署参数。');await run(source.id);const changed=await document(first.documentId);expect((await resources(source.id))[0].documentId).toBe(first.documentId);expect(changed.versions).toHaveLength(2);expect(await counts()).toEqual({documents:1,versions:2,jobs:2});
 },15000);
 it('uses a stable content fingerprint for source recovery while preserving manual keep-copy and failed retry semantics',async()=>{
  const {source}=await makeSource([]),identity='stable-fingerprint-source';
  const file=(text:string,path='Products/reference')=>{const buffer=Buffer.from(text);return{buffer,contentHash:createHash('sha256').update(buffer).digest('hex'),meta:{sourceId:source.id,sourceType:'mock_remote',filename:'产品说明.md',sourcePath:path,sourceUri:'https://sample.feishu.cn/docx/stable-source',metadata:{contentFingerprint:'stable-semantic-content'}}};};
  const first=await knowledge.upload(file('# 产品说明\n\n同一份产品内容。'),{duplicate:'keep',sourceId:source.id,sourceDocumentId:identity});await document(first.documentId);
  const recovered=await knowledge.upload(file('# 产品说明\r\n\r\n同一份产品内容。'),{duplicate:'keep',sourceId:source.id,sourceDocumentId:identity});expect(recovered).toMatchObject({documentId:first.documentId,status:'duplicate'});expect((await document(first.documentId)).versions).toHaveLength(1);expect((await knowledge.db.query('SELECT count(*)::int AS count FROM ingestion_jobs WHERE document_id=$1',[first.documentId]))[0].count).toBe(1);
  const moved=await knowledge.upload(file('# 产品说明\n\n同一份产品内容。','Products/new-location'),{duplicate:'keep',sourceId:source.id,sourceDocumentId:identity});expect(moved.documentId).toBe(first.documentId);expect((await document(first.documentId)).versions).toHaveLength(2);
  await knowledge.db.query("UPDATE documents SET status='failed' WHERE id=$1",[first.documentId]);const retry=await knowledge.upload(file('# 产品说明\n\n同一份产品内容。','Products/new-location'),{duplicate:'keep',sourceId:source.id,sourceDocumentId:identity});expect(retry.status).toBe('queued');expect((await document(first.documentId)).versions).toHaveLength(3);
  const copyOne=await knowledge.upload(file('# 人工复制\n\n允许保留多个副本。'),{duplicate:'keep'}),copyTwo=await knowledge.upload(file('# 人工复制\n\n允许保留多个副本。'),{duplicate:'keep'});expect(copyOne.documentId).not.toBe(copyTwo.documentId);
 },15000);
 it('archives previously supported resources when they become unsupported and restores their original identities',async()=>{
  const doc=resource('unsupported-transition-doc'),sheet=resource('unsupported-transition-sheet','dataset'),{source,state}=await makeSource([doc,sheet]);state.data.set(sheet.id,{remoteId:sheet.id,title:'切换格式测试',sourceUrl:sheet.remoteUrl,rows:[['型号','数值'],['UNSUPPORTED-TEST',16]]});await run(source.id);const original=await resources(source.id),docId=original.find(r=>r.remoteId===doc.id).documentId,datasetId=original.find(r=>r.remoteId===sheet.id).datasetId;const oldVersion=(await document(docId)).versions[0].id;
  const suggestion=(await app.inject({method:'POST',url:`/api/datasets/${datasetId}/suggest`,payload:{useAi:false}})).json();expect((await app.inject({method:'POST',url:`/api/datasets/${datasetId}/mapping`,payload:{...suggestion.suggestedMapping,isProductTable:true}})).statusCode).toBe(200);
  state.items=state.items.map(item=>({...item,kind:'unsupported',objectType:'slides'}));expect(await run(source.id)).toMatchObject({unsupported:2});expect((await document(docId)).document.status).toBe('archived');expect((await app.inject('/api/datasets/'+datasetId)).json().dataset.status).toBe('removed');expect((await app.inject('/api/facts?q=UNSUPPORTED-TEST')).json().items).toHaveLength(0);expect((await app.inject(`/api/documents/${docId}/original?versionId=${oldVersion}`)).statusCode).toBe(200);
  expect((await app.inject('/api/search?q='+encodeURIComponent(doc.title))).json().items.every((item:any)=>item.document.id!==docId)).toBe(true);
  state.items=[doc,sheet];expect(await run(source.id)).toMatchObject({updated:2});const restored=await resources(source.id);expect(restored.find(r=>r.remoteId===doc.id).documentId).toBe(docId);expect(restored.find(r=>r.remoteId===sheet.id).datasetId).toBe(datasetId);expect((await document(docId)).document.status).not.toBe('archived');expect((await document(docId)).versions).toHaveLength(2);expect((await app.inject('/api/facts?q=UNSUPPORTED-TEST')).json().items).toHaveLength(2);
 },15000);
 it('downloads the original source blob or processed copy from the explicitly selected document version',async()=>{
  const sourceOriginal1=Buffer.from('source-encrypted-original-v1'),sourceOriginal2=Buffer.from('source-encrypted-original-v2'),key1='test-source-original/'+randomUUID(),key2='test-source-original/'+randomUUID();await knowledge.storage.put(key1,sourceOriginal1);await knowledge.storage.put(key2,sourceOriginal2);
  const file=(text:string,originalObjectKey:string)=>{const buffer=Buffer.from(text);return{buffer,contentHash:createHash('sha256').update(buffer).digest('hex'),meta:{sourceId:'manual',sourceType:'manual',filename:'处理后的版本.md',metadata:{originalObjectKey}}};};
  const first=await knowledge.upload(file('# 解密后的第一版\n\n机器人安装说明。',key1),{duplicate:'keep'}),oldVersion=(await document(first.documentId)).versions[0].id;await knowledge.upload(file('# 解密后的第二版\n\n机器人安装步骤更新。',key2),{duplicate:'keep',documentId:first.documentId});const latest=await document(first.documentId),newVersion=latest.versions[0].id;
  const oldCopy=await app.inject(`/api/documents/${first.documentId}/original?versionId=${oldVersion}`),oldSource=await app.inject(`/api/documents/${first.documentId}/original?versionId=${oldVersion}&sourceOriginal=1`),newCopy=await app.inject(`/api/documents/${first.documentId}/original?versionId=${newVersion}`),newSource=await app.inject(`/api/documents/${first.documentId}/original?versionId=${newVersion}&sourceOriginal=1`);
  expect(oldCopy.body).toContain('第一版');expect(oldSource.rawPayload).toEqual(sourceOriginal1);expect(newCopy.body).toContain('第二版');expect(newSource.rawPayload).toEqual(sourceOriginal2);expect((await app.inject(`/api/documents/${first.documentId}/original?versionId=nonexistent&sourceOriginal=1`)).statusCode).toBe(404);
 },15000);
 it('never infers deletions after partial enumeration or listing failures',async()=>{
  const one=resource('partial-one'),two=resource('partial-two'),{source,state}=await makeSource([one,two]);await run(source.id);const entries=await resources(source.id);for(const entry of entries)await document(entry.documentId);
  state.items=[one];state.complete=false;state.errors=[{resourceId:two.id,message:'Page 2 unavailable'}];expect(await run(source.id)).toMatchObject({status:'partial',removed:0,failed:1});expect((await resources(source.id)).every(r=>r.status==='active')).toBe(true);
  state.complete=true;expect(await run(source.id)).toMatchObject({status:'partial',removed:0});
  state.listError='Listing service temporarily failed';expect(await run(source.id)).toMatchObject({status:'failed',removed:0});
  for(const entry of entries)expect((await document(entry.documentId)).document.status).not.toBe('archived');
 },20000);
 it('does not use the unchanged-revision shortcut when a remote URL or path changes',async()=>{
  const remote=resource('provenance-change');remote.remoteVersion='docx:unchanged';remote.objectType='docx';const {source,state}=await makeSource([remote]);await run(source.id);const entry=(await resources(source.id))[0];await document(entry.documentId);
  expect(await run(source.id)).toMatchObject({unchanged:1});expect(state.fetches.get(remote.id)).toBe(1);
  state.items[0].remoteUrl='https://sample.feishu.cn/docx/newlocation';state.items[0].path=['新版产品资料',remote.id];expect(await run(source.id)).toMatchObject({updated:1});const updated=await document(entry.documentId);
  expect(state.fetches.get(remote.id)).toBe(2);expect(updated.versions).toHaveLength(2);expect(updated.versions[0].sourceMetadata.remote_url).toBe(state.items[0].remoteUrl);expect(updated.document.sourcePath).toBe(state.items[0].path.join('/'));
 },15000);
 it('continues after one item fails, redacts persisted errors and retries only failures without deletion',async()=>{
  const one=resource('retry-one'),two=resource('retry-two'),unsupported=resource('unsupported','unsupported'),{source,state}=await makeSource([one,two,unsupported]);state.fail.add(two.id);
  expect(await run(source.id)).toMatchObject({status:'partial',added:1,failed:1,unsupported:1});let entries=await resources(source.id);expect(entries.find(r=>r.remoteId===two.id).status).toBe('failed');expect(JSON.stringify(entries)).not.toContain(secret);expect(JSON.stringify(entries)).not.toContain(token);const successful=entries.find(r=>r.remoteId===one.id);await document(successful.documentId);
  const persisted=JSON.stringify(await knowledge.db.query('SELECT * FROM source_sync_jobs WHERE source_id=$1',[source.id]));expect(persisted).not.toContain(secret);expect(persisted).not.toContain(token);
  state.fail.delete(two.id);state.items=[two];expect(await run(source.id,true)).toMatchObject({status:'completed',added:1,removed:0});entries=await resources(source.id);expect(entries.find(r=>r.remoteId===one.id).status).toBe('active');expect(state.fetches.get(one.id)).toBe(1);expect(state.fetches.get(two.id)).toBe(2);
  expect((await document(successful.documentId)).versions).toHaveLength(1);
 },15000);
 it('reports downstream ingestion failures and retries them despite an unchanged remote revision',async()=>{
  const remote=resource('downstream-failure');remote.remoteVersion='docx:unchanged-failed';const {source}=await makeSource([remote]);await run(source.id);const entry=(await resources(source.id))[0];await document(entry.documentId);
  await knowledge.db.query("UPDATE documents SET status='failed' WHERE id=$1",[entry.documentId]);const failedSource=(await app.inject('/api/sources')).json().items.find((item:any)=>item.id===source.id);expect(failedSource.ingestion.failed).toBe(1);
  expect(await run(source.id,true)).toMatchObject({updated:1,unchanged:0});const recovered=await document(entry.documentId);expect(recovered.versions).toHaveLength(2);const recoveredSource=(await app.inject('/api/sources')).json().items.find((item:any)=>item.id===source.id);expect(recoveredSource.ingestion.failed).toBe(0);expect(recoveredSource.ingestion.processing).toBe(0);expect(recoveredSource.ingestion.needsReview).toBe(recovered.document.status==='needs_review'?1:0);
 },15000);
 it('routes sheets into structured datasets and retains confirmed facts and history across source deletion',async()=>{
  const remote=resource('dataset-sync','dataset'),{source,state}=await makeSource([remote],'sheet');state.data.set(remote.id,{remoteId:remote.id,title:'机器人参数表',sourceUrl:remote.remoteUrl,version:'sheet-1',sheetId:'tab1',rows:[['型号','温度 (°C)'],['ROBOT-31',23]]});
  expect(await run(source.id)).toMatchObject({added:1});const entry=(await resources(source.id))[0];expect(entry.documentId).toBeNull();const saved=(await app.inject('/api/datasets/'+entry.datasetId)).json().dataset;expect(saved.status).toBe('pending_mapping');
  const suggestion=(await app.inject({method:'POST',url:`/api/datasets/${entry.datasetId}/suggest`,payload:{useAi:false}})).json();expect(suggestion.method).toBe('rule');
  const mapping={...suggestion.suggestedMapping,isProductTable:true,productKey:'col_1',title:'机器人已确认参数表'};const confirmed=await app.inject({method:'POST',url:`/api/datasets/${entry.datasetId}/mapping`,payload:mapping});expect(confirmed.statusCode).toBe(200);
  expect((await app.inject('/api/facts?q=ROBOT-31')).json().items).toHaveLength(2);expect(await run(source.id)).toMatchObject({unchanged:1});
  state.data.get(remote.id)!.rows[1][1]=24;state.data.get(remote.id)!.version='sheet-2';expect(await run(source.id)).toMatchObject({updated:1});
  const changed=(await app.inject('/api/datasets/'+entry.datasetId)).json().dataset;expect(changed.title).toBe('机器人已确认参数表');expect(changed.factHistory.some((h:any)=>h.before?.value===23&&h.after?.value===24&&h.sourceRevision==='sheet-2')).toBe(true);
  state.items=[];expect(await run(source.id)).toMatchObject({removed:1});expect((await app.inject('/api/facts?q=ROBOT-31')).json().items).toHaveLength(0);expect((await app.inject('/api/datasets/'+entry.datasetId)).json().dataset.versions.length).toBeGreaterThan(2);
 },15000);
 it('keeps secrets encrypted on disk and absent from SQL, success and error API responses',async()=>{
  const contents=await readFile(join(directory,'source-secrets.enc.json'),'utf8');expect(contents).not.toContain(secret);expect(contents).not.toContain(token);
  const sqlRows=await knowledge.db.query('SELECT * FROM external_connections');expect(JSON.stringify(sqlRows)).not.toContain(secret);expect(JSON.stringify(sqlRows)).not.toContain(token);expect(sqlRows[0].secret_ref).toBeTruthy();
  const connections=await app.inject('/api/connections');expect(connections.body).not.toContain(secret);expect(connections.body).not.toContain('secret_ref');expect(connections.body).not.toContain('secretRef');
  testError=`Permission failure: ${secret}, Bearer ${token}`;const failed=await app.inject({method:'POST',url:`/api/connections/${connectionId}/test`,payload:{rootUrl:'https://sample.feishu.cn/wiki/testroot'}});testError=undefined;expect(failed.statusCode).toBe(400);expect(failed.body).not.toContain(secret);expect(failed.body).not.toContain(token);expect(failed.body).toContain('已隐藏');
  expect(JSON.stringify(await knowledge.db.query('SELECT * FROM external_connections'))).not.toContain(secret);
  const tested=await app.inject({method:'POST',url:`/api/connections/${connectionId}/test`,payload:{rootUrl:'https://sample.feishu.cn/wiki/testroot'}});expect(tested.statusCode).toBe(200);expect(tested.json().ok).toBe(true);
  const bad=await app.inject({method:'POST',url:'/api/connections',payload:{name:'Bad',appId:'bad',appSecret:secret,unexpected:secret}});expect(bad.statusCode).toBe(400);expect(bad.body).not.toContain(secret);
 });
 it('previews a user-selected header without mutation and confirms the newly read columns with exact row provenance',async()=>{
  const structured=new StructuredService(knowledge.db),raw:StructuredSourceData={remoteId:randomUUID(),title:'多个参数区域',sourceUrl:'https://sample.feishu.cn/sheets/headerpreview',rows:[['旧型号','旧参数'],['OLD','旧数据'],[],['型号','温度 (°C)'],['ROBOT-HEADER',21]]};
  const saved=await structured.save('header-preview',raw),before=await structured.get(saved.id);
  const response=await app.inject({method:'POST',url:`/api/datasets/${saved.id}/preview`,payload:{headerRow:4}});expect(response.statusCode).toBe(200);const preview=response.json();
  expect(preview.headerRow).toBe(4);expect(preview.fields.map((field:any)=>field.sourceHeader)).toEqual(['型号','温度 (°C)']);expect(preview.suggestedProductKey).toBe('col_1');expect(preview.records[0]).toMatchObject({rowIndex:5,values:{col_1:'ROBOT-HEADER',col_2:21},sourceRef:{rowIndex:5}});
  const afterPreview=await structured.get(saved.id);expect(afterPreview.version).toBe(before.version);expect(afterPreview.mapping).toBeNull();expect(afterPreview.versions).toEqual(before.versions);expect(afterPreview.factHistory).toEqual(before.factHistory);
  const confirmed=await app.inject({method:'POST',url:`/api/datasets/${saved.id}/mapping`,payload:{headerRow:preview.headerRow,fields:preview.fields,productKey:preview.suggestedProductKey,isProductTable:true,authority:'authoritative'}});expect(confirmed.statusCode).toBe(200);expect(confirmed.json().dataset.records).toHaveLength(1);expect(confirmed.json().dataset.preview.headerRow).toBe(4);
  raw.rows[4][1]=22;await structured.save('header-preview',raw);const afterSync=await structured.get(saved.id);expect(afterSync.mapping?.authority).toBe('authoritative');expect(afterSync.preview.headerRow).toBe(4);expect(afterSync.records[0].rowIndex).toBe(5);
 });
 it('returns actionable 400 validation errors and 404 for missing datasets',async()=>{
  const structured=new StructuredService(knowledge.db),saved=await structured.save('header-errors',{remoteId:randomUUID(),title:'验证参数表',sourceUrl:'https://sample.feishu.cn/sheets/errorcases',rows:[['型号','数值'],['E1',1]]});
  for(const headerRow of [0,99]){const response=await app.inject({method:'POST',url:`/api/datasets/${saved.id}/preview`,payload:{headerRow}});expect(response.statusCode).toBe(400);expect(response.body).not.toContain('服务器处理失败');}
  const preview=(await app.inject({method:'POST',url:`/api/datasets/${saved.id}/preview`,payload:{headerRow:1}})).json();const mapping={headerRow:1,fields:preview.fields,productKey:'col_1',isProductTable:true,authority:'reference'};
  const stale=await app.inject({method:'POST',url:`/api/datasets/${saved.id}/mapping`,payload:{...mapping,fields:preview.fields.map((field:any)=>({...field,sourceHeader:'已失效的表头'}))}});expect(stale.statusCode).toBe(400);expect(stale.body).toContain('表头已变化');
  expect((await app.inject('/api/datasets/missing-dataset')).statusCode).toBe(404);expect((await app.inject({method:'POST',url:'/api/datasets/missing-dataset/preview',payload:{headerRow:1}})).statusCode).toBe(404);expect((await app.inject({method:'POST',url:'/api/datasets/missing-dataset/mapping',payload:mapping})).statusCode).toBe(404);
 });
 it('keeps unexpected database failures as generic 500 responses instead of exposing them as validation details',async()=>{
  const query=knowledge.db.query,spy=vi.spyOn(knowledge.db,'query');spy.mockImplementation(async<T>(sql:string,values?:unknown[]):Promise<T[]>=>{if(sql==='SELECT * FROM structured_datasets WHERE id=$1')throw Error('private database connection details '+secret);return query<T>(sql,values);});
  try{const response=await app.inject('/api/datasets/test-infrastructure-error');expect(response.statusCode).toBe(500);expect(response.json().message).toBe('服务器处理失败，请稍后重试');expect(response.body).not.toContain(secret);expect(response.body).not.toContain('private database');}finally{spy.mockRestore();}
 });
 it('validates resource URLs, blocks remote API overrides and requires testing after re-enabling a connection',async()=>{
  for(const rootUrl of ['http://127.0.0.1/private','https://evil.test/wiki/x','https://sample.feishu.cn/wiki/x/../../x']){const response=await app.inject({method:'POST',url:'/api/sources',payload:{name:'invalid',connectionId,rootUrl}});expect(response.statusCode).toBe(400);}
  expect((await app.inject({method:'POST',url:'/api/sources',payload:{name:'invalid',connectionId,rootUrl:'https://sample.feishu.cn/wiki/x',baseUrl:'http://127.0.0.1/private'}})).statusCode).toBe(400);
  const disabled=await app.inject({method:'PATCH',url:'/api/connections/'+connectionId,payload:{status:'disabled'}});expect(disabled.json().connection.status).toBe('disabled');
  expect((await app.inject({method:'POST',url:`/api/connections/${connectionId}/test`,payload:{rootUrl:'https://sample.feishu.cn/wiki/testroot'}})).statusCode).toBe(400);
  const enabled=await app.inject({method:'PATCH',url:'/api/connections/'+connectionId,payload:{status:'connected'}});expect(enabled.json().connection.status).toBe('error');
 });
});

describe('Local secret encryption integrity',()=>{
 let directory:string;
 beforeAll(async()=>{directory=await mkdtemp(join(tmpdir(),'studio-source-crypto-'));});
 afterAll(async()=>{vi.unstubAllEnvs();if(directory)await removeTemp(directory);});
 it('persists secrets with random nonces, reloads them and rejects tampering or the wrong master key',async()=>{
  const key='21'.repeat(32),store=new LocalSecretStore(directory,key),first=await store.put(secret),second=await store.put(secret),text=await readFile(join(directory,'source-secrets.enc.json'),'utf8'),entries=JSON.parse(text);expect(text).not.toContain(secret);expect(entries[first].iv).not.toBe(entries[second].iv);expect(entries[first].data).not.toBe(entries[second].data);
  expect(await new LocalSecretStore(directory,key).get(first)).toBe(secret);await expect(new LocalSecretStore(directory,'22'.repeat(32)).get(first)).rejects.toThrow('无法解密');
  entries[first].data=Buffer.from('tampered').toString('base64');await writeFile(join(directory,'source-secrets.enc.json'),JSON.stringify(entries));await expect(store.get(first)).rejects.toThrow('无法解密');expect(await store.get(second)).toBe(secret);
 });
 it('requires an external key in production and does not write a master key beside ciphertext',async()=>{
  vi.stubEnv('NODE_ENV','production');const store=new LocalSecretStore(join(directory,'production'),'');await expect(store.put('fake secret only')).rejects.toThrow('生产环境');
  const configured=new LocalSecretStore(join(directory,'production'),'ab'.repeat(32));const ref=await configured.put('fake secret only');expect(await configured.get(ref)).toBe('fake secret only');expect(await readdir(join(directory,'production'))).not.toContain('source-master.key');vi.unstubAllEnvs();
 });
});
