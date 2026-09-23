import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { FeishuClient, FeishuSourceAdapter, parseFeishuUrl } from '../packages/source-adapters/src/feishu/index.js';
import type { RemoteResource } from '../packages/core/src/sources.js';

const cleanups:(()=>Promise<void>)[]=[];
afterEach(async()=>{await Promise.all(cleanups.splice(0).map(clean=>clean()));});
const credentials={appId:'cli_test',appSecret:'secret-never-return'};
const config={rootUrl:'https://company.feishu.cn/wiki/root',mode:'wiki',recursive:true};
const sheetConfig={rootUrl:'https://company.feishu.cn/sheets/spread?sheet=tab1',mode:'sheet'};
const ok=(res:ServerResponse,data:unknown)=>{res.setHeader('content-type','application/json');res.end(JSON.stringify({code:0,data}));};
type Handler=(url:URL,req:IncomingMessage,res:ServerResponse,body:unknown)=>boolean|Promise<boolean>;
async function mock(handler:Handler,overrides:Record<string,unknown>={}){
  let authCount=0;const requests:{method:string;path:string;authorization?:string;body:unknown}[]=[];
  const server=createServer(async(req,res)=>{
    try{let raw='';for await(const chunk of req)raw+=chunk;const body=raw?JSON.parse(raw):undefined;const url=new URL(req.url!,'http://127.0.0.1');
      requests.push({method:req.method!,path:url.pathname+url.search,authorization:req.headers.authorization,body});
      if(url.pathname==='/open-apis/auth/v3/tenant_access_token/internal'){authCount++;res.setHeader('content-type','application/json');res.end(JSON.stringify({code:0,tenant_access_token:`tenant-secret-${authCount}`,expire:7200}));return;}
      if(url.pathname.startsWith('/open-apis/docx/v1/documents/')){
        if(url.pathname.endsWith('/blocks')){if(typeof overrides.blockHandler==='function'){await overrides.blockHandler(url,req,res);return;}ok(res,{has_more:false});return;}
        ok(res,{document:{revision_id:typeof overrides.docxRevision==='function'?overrides.docxRevision():42}});return;
      }
      if(await handler(url,req,res,body))return;
      res.writeHead(404);res.end(JSON.stringify({code:404,msg:'unexpected mock endpoint'}));
    }catch{res.writeHead(500);res.end();}
  });
  await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));const address=server.address();if(!address || typeof address==='string')throw new Error('mock listen failed');
  cleanups.push(()=>new Promise<void>((resolve,reject)=>{server.closeAllConnections();server.close(error=>error?reject(error):resolve());}));
  const options={baseUrl:`http://127.0.0.1:${address.port}/open-apis`,minIntervalMs:0,retryBaseMs:0,exportPollMs:0,...overrides};
  return {adapter:new FeishuSourceAdapter(credentials,options),client:new FeishuClient(credentials,options),requests,get authCount(){return authCount;}};
}
const node=(nodeToken:string,extra:Record<string,unknown>={})=>({node_token:nodeToken,obj_token:`obj${nodeToken}`,obj_type:'docx',space_id:'space1',title:nodeToken,has_child:false,obj_edit_time:'1700000000',...extra});
const resource=(extra:Partial<RemoteResource>={}):RemoteResource=>({id:'feishu:docx:doc1',title:'产品文档',kind:'document',objectType:'docx',remoteToken:'doc1',remoteUrl:'https://company.feishu.cn/wiki/root',remoteVersion:'42',path:['资料','产品文档'],...extra});
function docx(text='产品说明',exportStamp='export-1'):Buffer {
  const files={'[Content_Types].xml':'<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>',
    '_rels/.rels':'<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>',
    'word/document.xml':`<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>${text}</w:t></w:r></w:p></w:body></w:document>`,'docProps/core.xml':exportStamp};
  const entries:Buffer[]=[],directory:Buffer[]=[];let offset=0;
  const crc=(data:Buffer)=>{let value=0xffffffff;for(const byte of data){value^=byte;for(let bit=0;bit<8;bit++)value=value&1?0xedb88320^(value>>>1):value>>>1;}return (value^0xffffffff)>>>0;};
  for(const [name,text]of Object.entries(files)){
    const filename=Buffer.from(name),data=Buffer.from(text),checksum=crc(data),local=Buffer.alloc(30),central=Buffer.alloc(46);
    local.writeUInt32LE(0x04034b50);local.writeUInt16LE(20,4);local.writeUInt32LE(checksum,14);local.writeUInt32LE(data.length,18);local.writeUInt32LE(data.length,22);local.writeUInt16LE(filename.length,26);
    central.writeUInt32LE(0x02014b50);central.writeUInt16LE(20,4);central.writeUInt16LE(20,6);central.writeUInt32LE(checksum,16);central.writeUInt32LE(data.length,20);central.writeUInt32LE(data.length,24);central.writeUInt16LE(filename.length,28);central.writeUInt32LE(offset,42);
    entries.push(local,filename,data);directory.push(central,filename);offset+=local.length+filename.length+data.length;
  }
  const cd=Buffer.concat(directory),end=Buffer.alloc(22);end.writeUInt32LE(0x06054b50);end.writeUInt16LE(Object.keys(files).length,8);end.writeUInt16LE(Object.keys(files).length,10);end.writeUInt32LE(cd.length,12);end.writeUInt32LE(offset,16);return Buffer.concat([...entries,cd,end]);
}
function sheetHandler(url:URL,_req:IncomingMessage,res:ServerResponse){
  if(url.pathname==='/open-apis/sheets/v3/spreadsheets/spread'){ok(res,{spreadsheet:{title:'产品参数表'}});return true;}
  if(url.pathname==='/open-apis/sheets/v3/spreadsheets/spread/sheets/query'){ok(res,{sheets:[{sheet_id:'tab1',title:'产品',grid_properties:{row_count:504,column_count:3}},{sheet_id:'tab2',title:'版本',grid_properties:{row_count:2,column_count:2}}]});return true;}
  return false;
}

describe('Feishu URL boundary',()=>{
  it.each([['wiki','wiki'],['sheets','sheet'],['doc','doc'],['docx','docx'],['file','file']])('parses %s without fetching the shared URL',(path,type)=>{
    expect(parseFeishuUrl(`https://company.feishu.cn/${path}/Abc_123-x?tracking=ignored#section`)).toMatchObject({type,token:'Abc_123-x',origin:'https://company.feishu.cn',url:`https://company.feishu.cn/${path}/Abc_123-x`});
  });
  it('parses selected sheet and rejects invalid token parameters',()=>{
    expect(parseFeishuUrl(sheetConfig.rootUrl).sheetId).toBe('tab1');
    expect(()=>parseFeishuUrl('https://company.feishu.cn/sheets/abc?sheet=../../private')).toThrow();
  });
  it.each(['http://company.feishu.cn/wiki/abc','https://feishu.cn.evil.com/wiki/abc','https://feishu.cn@127.0.0.1/wiki/abc','https://localhost/wiki/abc','file:///etc/passwd','https://company.feishu.cn:444/wiki/abc','https://company.feishu.cn/wiki/a%2fb','https://company.feishu.cn/wiki/abc/extra','https://company.feishu.cn/wiki/%2e%2e'])('rejects unsafe URL %s',(url)=>expect(()=>parseFeishuUrl(url)).toThrow());
  it('restricts API transport overrides to official or local mock hosts',()=>expect(()=>new FeishuClient(credentials,{baseUrl:'https://attacker.example/open-apis'})).toThrow());
});

describe('Feishu HTTP authentication and errors',()=>{
  it('single-flights authentication and caches token across concurrent requests',async()=>{
    const api=await mock((_url,_req,res)=>{ok(res,{title:'root'});return true;});
    await Promise.all([api.client.json('/wiki/v2/example'),api.client.json('/wiki/v2/example'),api.client.json('/wiki/v2/example')]);
    expect(api.authCount).toBe(1);expect(api.requests.filter(req=>req.authorization).every(req=>req.authorization==='Bearer tenant-secret-1')).toBe(true);
  });
  it('refreshes expired token exactly once without returning credentials or response messages',async()=>{
    // A real Feishu error envelope, including hostile echoed secret text.
    const retry=await mock((_url,req,res)=>{res.setHeader('content-type','application/json');res.end(JSON.stringify(req.headers.authorization==='Bearer tenant-secret-1'?{code:99991663,msg:credentials.appSecret}:{code:0,data:{title:'ok'}}));return true;});
    expect(await retry.client.json('/wiki/v2/example')).toEqual({title:'ok'});expect(retry.authCount).toBe(2);
    const denied=await mock((_url,_req,res)=>{res.setHeader('content-type','application/json');res.end(JSON.stringify({code:99991663,msg:`${credentials.appSecret} tenant-secret-2`}));return true;});
    await expect(denied.client.json('/wiki/v2/example')).rejects.toThrow('99991663');expect(denied.authCount).toBe(2);
    try{await denied.client.json('/wiki/v2/example');}catch(error){expect(String(error)).not.toContain(credentials.appSecret);expect(String(error)).not.toContain('tenant-secret');}
  });
  it('retries 429 and 5xx, and stops at a bounded retry count',async()=>{
    let attempt=0;const api=await mock((_url,_req,res)=>{attempt++;if(attempt<=2){res.writeHead(attempt===1?429:503);res.end();}else ok(res,{done:true});return true;});
    expect(await api.client.json('/wiki/v2/example')).toEqual({done:true});expect(attempt).toBe(3);
    const failed=await mock((_url,_req,res)=>{res.writeHead(503);res.end('server-body-secret');return true;},{maxRetries:2});
    await expect(failed.client.json('/wiki/v2/example')).rejects.toThrow('HTTP 503');expect(failed.requests.filter(req=>req.authorization)).toHaveLength(3);
  });
  it('rejects oversized response bodies and follows no redirects',async()=>{
    const api=await mock((_url,_req,res)=>{res.setHeader('content-type','application/json');res.end(JSON.stringify({code:0,data:{long:'x'.repeat(2000)}}));return true;},{maxJsonBytes:500});
    await expect(api.client.json('/wiki/v2/example')).rejects.toThrow('大小上限');
    const redirect=await mock((_url,_req,res)=>{res.writeHead(302,{location:'http://169.254.169.254/latest/meta-data'});res.end();return true;},{maxRetries:0});
    await expect(redirect.client.json('/wiki/v2/example')).rejects.toThrow('无法连接');expect(redirect.requests).toHaveLength(2);
  });
});

describe('Feishu recursive discovery',()=>{
  it('includes the root, paginates children, walks unsupported folders, and keeps full paths',async()=>{
    const api=await mock((url,_req,res)=>{
      if(url.pathname.endsWith('/get_node')){ok(res,{node:node('root',{title:'产品资料',has_child:true})});return true;}
      if(url.pathname.endsWith('/nodes')){
        if(url.searchParams.get('parent_node_token')==='nested'){ok(res,{items:[node('leaf',{title:'说明书'})],has_more:false});return true;}
        if(url.searchParams.get('page_token')==='page2'){ok(res,{items:[node('other')],has_more:false});return true;}
        ok(res,{items:[node('nested',{title:'K系列',has_child:true,obj_type:'mindnote'})],has_more:true,page_token:'page2'});return true;
      }return false;
    });
    const result=await api.adapter.list(config);expect(result.complete).toBe(true);expect(result.items).toHaveLength(4);
    expect(result.items.find(item=>item.remoteToken==='objnested')?.kind).toBe('unsupported');expect(result.items.find(item=>item.remoteToken==='objleaf')?.path).toEqual(['产品资料','K系列','说明书']);
    expect(result.items[0].metadata).toMatchObject({provider:'feishu',nodeToken:'root'});expect(result.items[0].modifiedAt).toBe('2023-11-14T22:13:20.000Z');
  });
  it('retains successful siblings and marks inaccessible subtrees incomplete',async()=>{
    const api=await mock((url,_req,res)=>{
      if(url.pathname.endsWith('/get_node')){ok(res,{node:node('root',{has_child:true})});return true;}
      if(url.searchParams.get('parent_node_token')==='root'){ok(res,{items:[node('bad',{has_child:true}),node('good')],has_more:false});return true;}
      res.writeHead(403);res.end(JSON.stringify({code:131006,msg:credentials.appSecret}));return true;
    });
    const result=await api.adapter.list(config);expect(result.complete).toBe(false);expect(result.items).toHaveLength(3);expect(result.errors).toHaveLength(1);expect(JSON.stringify(result.errors)).not.toContain(credentials.appSecret);
  });
  it('marks broken pagination and malformed success responses incomplete',async()=>{
    const api=await mock((url,_req,res)=>{if(url.pathname.endsWith('/get_node'))ok(res,{node:node('root',{has_child:true})});else ok(res,{items:[],has_more:true});return true;});
    expect((await api.adapter.list(config)).complete).toBe(false);
    const malformed=await mock((url,_req,res)=>{if(url.pathname.endsWith('/get_node'))ok(res,{node:node('root',{has_child:true})});else ok(res,{});return true;});
    expect((await malformed.adapter.list(config)).complete).toBe(false);
  });
  it('accepts omitted items only on a terminal empty page, including stale has_child',async()=>{
    const api=await mock((url,_req,res)=>{if(url.pathname.endsWith('/get_node'))ok(res,{node:node('root',{has_child:true})});else ok(res,{has_more:false,page_token:''});return true;});
    const result=await api.adapter.list(config);expect(result.complete).toBe(true);expect(result.items).toHaveLength(1);expect(result.errors).toEqual([]);
  });
  it('connection test verifies root permission and ignores source-config transport fields',async()=>{
    const api=await mock((url,_req,res)=>{expect(url.pathname).toContain('/get_node');ok(res,{node:node('root',{title:'授权知识库'})});return true;});
    expect(await api.adapter.test({...config,baseUrl:'http://evil.example'})).toEqual({title:'授权知识库'});
    const denied=await mock((_url,_req,res)=>{res.writeHead(403);res.end(JSON.stringify({code:131006}));return true;});
    await expect(denied.adapter.test(config)).rejects.toThrow('HTTP 403');
  });
});

describe('Feishu documents and structured sheets',()=>{
  it.each(['doc','docx'])('exports native %s as docx and retains remote provenance',async(objectType)=>{
    let polls=0;const api=await mock((url,_req,res,body)=>{
      if(url.pathname==='/open-apis/drive/v1/export_tasks'){expect(body).toEqual({file_extension:'docx',token:'doc1',type:objectType});ok(res,{ticket:'ticket1'});return true;}
      if(url.pathname.endsWith('/ticket1')){polls++;ok(res,{result:polls===1?{job_status:2}:{job_status:0,file_token:'export1',file_name:'官方产品说明'}});return true;}
      if(url.pathname.endsWith('/export1/download')){res.writeHead(200,{'content-type':'application/octet-stream'});res.end(docx());return true;}return false;
    });
    const file=await api.adapter.fetchDocument(resource({objectType}),config);expect(file.meta.filename).toBe('官方产品说明.docx');expect(file.meta.mimeType).toContain('wordprocessingml');
    expect(file.meta.metadata).toMatchObject({provider:'feishu',remote_token:'doc1',remote_version:objectType==='docx'?'docx:42':'42',remote_path:['资料','产品文档']});expect(file.contentHash).toHaveLength(64);expect(file.meta.metadata?.contentFingerprint).toHaveLength(64);
  });
  it('detects same-second document changes using the official revision instead of modification time',async()=>{
    let revision=5;const api=await mock((url,_req,res)=>{if(url.pathname.endsWith('/get_node')){ok(res,{node:node('root')});return true;}return false;},{docxRevision:()=>revision});
    const before=(await api.adapter.list(config)).items[0];revision=6;const after=(await api.adapter.list(config)).items[0];
    expect(before.modifiedAt).toBe(after.modifiedAt);expect(before.remoteVersion).toBe('docx:5');expect(after.remoteVersion).toBe('docx:6');
  });
  it('ignores volatile export metadata but changes the semantic fingerprint when content changes',async()=>{
    let counter=0;let text='172 fps';const api=await mock((url,_req,res)=>{
      if(url.pathname==='/open-apis/drive/v1/export_tasks'){ok(res,{ticket:'ticket1'});return true;}
      if(url.pathname.endsWith('/ticket1')){ok(res,{result:{job_status:0,file_token:'export1'}});return true;}
      if(url.pathname.endsWith('/export1/download')){res.writeHead(200,{'content-type':'application/octet-stream'});res.end(docx(text,`export-${++counter}`));return true;}return false;
    });
    const legacy=resource({objectType:'doc',remoteVersion:undefined});const before=await api.adapter.fetchDocument(legacy,config);const same=await api.adapter.fetchDocument(legacy,config);text='180 fps';const changed=await api.adapter.fetchDocument(legacy,config);
    expect(before.contentHash).not.toBe(same.contentHash);expect(before.meta.metadata?.contentFingerprint).toBe(same.meta.metadata?.contentFingerprint);expect(before.meta.metadata?.contentFingerprint).not.toBe(changed.meta.metadata?.contentFingerprint);
  });
  it('rejects exports whose document revision changes during download',async()=>{
    let revision=0;const api=await mock((url,_req,res)=>{
      if(url.pathname==='/open-apis/drive/v1/export_tasks'){ok(res,{ticket:'ticket1'});return true;}
      if(url.pathname.endsWith('/ticket1')){ok(res,{result:{job_status:0,file_token:'export1'}});return true;}
      if(url.pathname.endsWith('/export1/download')){res.writeHead(200,{'content-type':'application/octet-stream'});res.end(docx());return true;}return false;
    },{docxRevision:()=>++revision});
    await expect(api.adapter.fetchDocument(resource(),config)).rejects.toThrow('导出期间发生修改');
  });
  it('downloads files with original MIME/name and blocks oversized downloads',async()=>{
    const api=await mock((_url,_req,res)=>{res.writeHead(200,{'content-type':'application/pdf','content-disposition':"attachment; filename*=UTF-8''%E8%A7%84%E6%A0%BC%E4%B9%A6.pdf"});res.end('%PDF-1.7');return true;});
    const file=await api.adapter.fetchDocument(resource({objectType:'file'}),config);expect(file.meta.filename).toBe('规格书.pdf');expect(file.meta.mimeType).toBe('application/pdf');
    const large=await mock((_url,_req,res)=>{res.writeHead(200,{'content-type':'application/pdf'});res.end('x'.repeat(100));return true;},{maxDownloadBytes:10});
    await expect(large.adapter.fetchDocument(resource({objectType:'file'}),config)).rejects.toThrow('大小上限');
  });
  it('enumerates selected/all tabs and reads real row positions across batch boundaries',async()=>{
    const api=await mock((url,req,res)=>{
      if(sheetHandler(url,req,res))return true;
      if(url.pathname.includes('/values/')){const range=decodeURIComponent(url.pathname.split('/values/')[1]);
        ok(res,{revision:7,valueRange:{range,values:range.includes('A501')?[[],['K18',180,'fps']]:[['型号','帧率','单位'],[],['K17',172,'fps']]}});return true;}return false;
    });
    const selected=await api.adapter.list(sheetConfig);expect(selected.complete).toBe(true);expect(selected.items).toHaveLength(1);expect(selected.items[0].id).toBe('feishu:sheet:spread:tab1');
    expect((await api.adapter.list({...sheetConfig,rootUrl:'https://company.feishu.cn/sheets/spread'})).items).toHaveLength(2);
    const dataset=await api.adapter.fetchDataset(selected.items[0],sheetConfig);expect(dataset.rows[1]).toEqual([]);expect(dataset.rows[2]).toEqual(['K17',172,'fps']);expect(dataset.rows[501]).toEqual(['K18',180,'fps']);expect(dataset.rows).toHaveLength(502);
    expect(dataset).toMatchObject({version:'7',sheetId:'tab1',spreadsheetToken:'spread',metadata:{rowStart:1}});
  });
  it('rejects a mixed-revision sheet rather than importing inconsistent facts',async()=>{
    let reads=0;const api=await mock((url,req,res)=>{if(sheetHandler(url,req,res))return true;if(url.pathname.includes('/values/')){ok(res,{revision:++reads,valueRange:{values:[['value']]}});return true;}return false;});
    const [sheet]=(await api.adapter.list(sheetConfig)).items;await expect(api.adapter.fetchDataset(sheet,sheetConfig)).rejects.toThrow('读取期间发生修改');
  });
  it('surfaces unsupported resource types without exporting them',async()=>{
    const api=await mock(()=>false);await expect(api.adapter.fetchDocument(resource({kind:'unsupported',objectType:'bitable'}),config)).rejects.toThrow('不是可导入文档');expect(api.requests).toHaveLength(0);
  });
  it('enumerates only file-block attachments within the chosen document, across all block pages',async()=>{
    const api=await mock((url,_req,res)=>{if(url.pathname.endsWith('/get_node')){ok(res,{node:node('root',{title:'产品资料'})});return true;}return false;},
      {blockHandler:(url:URL,_req:IncomingMessage,res:ServerResponse)=>{
        expect(url.searchParams.get('document_revision_id')).toBe('42');
        if(url.searchParams.has('page_token'))ok(res,{items:[{block_id:'blk2',block_type:23,file:{name:'产品演示.pptx',token:'media2'}},{block_id:'blk3',block_type:23,file:{name:'资料包.rar',token:'media3'}}],has_more:false});
        else ok(res,{items:[{block_id:'blk1',block_type:23,file:{name:'产品规格.pdf',token:'media1'}},{block_id:'text1',block_type:2,text:{elements:[{text_run:{content:'其他表格',text_element_style:{link:{url:'https://company.feishu.cn/sheets/outside'}}}}]}}],has_more:true,page_token:'next'});
      }});
    const result=await api.adapter.list(config);expect(result.complete).toBe(true);expect(result.items).toHaveLength(4);
    const attachment=result.items.find(item=>item.remoteToken==='media1')!;expect(attachment).toMatchObject({id:'feishu:attachment:objroot:blk1',title:'产品规格.pdf',objectType:'attachment',kind:'document',path:['产品资料','产品规格.pdf'],remoteVersion:'media:media1',metadata:{parentDocumentToken:'objroot',blockId:'blk1',originalFilename:'产品规格.pdf'}});
    expect(attachment.remoteUrl).toBe('https://company.feishu.cn/wiki/root#blk1');expect(result.items.filter(item=>item.kind==='unsupported')).toHaveLength(2);
    expect(api.requests.some(request=>request.path.includes('outside'))).toBe(false);
  });
  it('keeps logical attachment identity when the file token is replaced',async()=>{
    let token='before';const api=await mock((url,_req,res)=>{if(url.pathname.endsWith('/get_node')){ok(res,{node:node('root')});return true;}return false;},
      {blockHandler:(_url:URL,_req:IncomingMessage,res:ServerResponse)=>ok(res,{items:[{block_id:'stableblock',block_type:23,file:{name:'manual.docx',token}}],has_more:false})});
    const before=(await api.adapter.list(config)).items.find(item=>item.objectType==='attachment')!;token='after';const after=(await api.adapter.list(config)).items.find(item=>item.objectType==='attachment')!;
    expect(before.id).toBe(after.id);expect(before.remoteVersion).not.toBe(after.remoteVersion);
  });
  it('downloads attachment media bytes with block filename and parent provenance',async()=>{
    const api=await mock((url,_req,res)=>{expect(url.pathname).toBe('/open-apis/drive/v1/medias/media1/download');res.writeHead(200,{'content-type':'application/octet-stream'});res.end('%PDF-1.7');return true;});
    const file=await api.adapter.fetchDocument(resource({objectType:'attachment',remoteToken:'media1',title:'文件',metadata:{originalFilename:'规格书.pdf',mimeType:'application/pdf',parentDocumentToken:'doc1',blockId:'block1'}}),config);
    expect(file.meta).toMatchObject({filename:'规格书.pdf',mimeType:'application/pdf',metadata:{parentDocumentToken:'doc1',blockId:'block1',remote_token:'media1'}});expect(new TextDecoder().decode(file.buffer)).toBe('%PDF-1.7');
  });
  it('retains successful attachment pages and forbids removal after later permission failure',async()=>{
    const api=await mock((url,_req,res)=>{if(url.pathname.endsWith('/get_node')){ok(res,{node:node('root')});return true;}return false;},
      {blockHandler:(url:URL,_req:IncomingMessage,res:ServerResponse)=>{
        if(url.searchParams.has('page_token')){res.writeHead(403);res.end(JSON.stringify({code:99991672,msg:credentials.appSecret}));}
        else ok(res,{items:[{block_id:'okblock',block_type:23,file:{name:'有效.pdf',token:'media1'}}],has_more:true,page_token:'next'});
      }});
    const result=await api.adapter.list(config);expect(result.complete).toBe(false);expect(result.items.some(item=>item.remoteToken==='media1')).toBe(true);expect(result.errors).toHaveLength(1);expect(JSON.stringify(result.errors)).not.toContain(credentials.appSecret);
  });
  it('marks an attachment listing incomplete when its parent revision changes',async()=>{
    let revision=0;const api=await mock((url,_req,res)=>{if(url.pathname.endsWith('/get_node')){ok(res,{node:node('root')});return true;}return false;},{docxRevision:()=>++revision});
    const result=await api.adapter.list(config);expect(result.complete).toBe(false);expect(result.errors[0].message).toContain('附件枚举期间发生修改');
  });
});
