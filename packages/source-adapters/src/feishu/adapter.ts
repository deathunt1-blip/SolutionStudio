import { createHash } from 'node:crypto';
import mammoth from 'mammoth';
import type { SourceFile } from '../../../core/src/types.js';
import type { RemoteResource, RemoteSourceAdapter, SourceListing, StructuredSourceData } from '../../../core/src/sources.js';
import { FeishuClient, type FeishuClientOptions, type FeishuCredentials } from './client.js';
import { feishuToken, parseFeishuUrl, type ParsedFeishuUrl } from './url.js';

type Json=Record<string,unknown>;
const object=(value:unknown):Json=>{if(!value || typeof value!=='object' || Array.isArray(value))throw new Error('飞书返回的数据结构无效');return value as Json;};
const string=(value:unknown,fallback='')=>typeof value==='string'?value:fallback;
const safeMessage=(error:unknown)=>error instanceof Error?error.message:'飞书资源读取失败';
const pause=(ms:number)=>new Promise<void>(resolve=>setTimeout(resolve,ms));
const modified=(value:unknown)=>{const n=Number(value);return Number.isFinite(n)&&n>0?new Date(n*1000).toISOString():undefined;};
const hash=(bytes:Uint8Array)=>createHash('sha256').update(bytes).digest('hex');
const attachmentMime:Record<string,string>={'.pdf':'application/pdf','.docx':'application/vnd.openxmlformats-officedocument.wordprocessingml.document','.xlsx':'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet','.xls':'application/vnd.ms-excel','.csv':'text/csv','.md':'text/markdown','.txt':'text/plain'};
function columnName(index:number){let result='';for(let n=index;n>0;n=Math.floor((n-1)/26))result=String.fromCharCode(65+(n-1)%26)+result;return result;}

/** Provider-only implementation. It never opens a local database or writes remote business data. */
export class FeishuSourceAdapter implements RemoteSourceAdapter {
  readonly type='feishu';
  private readonly client:FeishuClient;
  constructor(credentials:FeishuCredentials,options:FeishuClientOptions={}) {this.client=new FeishuClient(credentials,options);}
  private config(config:Record<string,unknown>):ParsedFeishuUrl {
    if(typeof config.rootUrl!=='string')throw new Error('请填写飞书来源链接');
    const parsed=parseFeishuUrl(config.rootUrl);
    if(config.mode==='wiki' && parsed.type!=='wiki')throw new Error('知识库来源需要 Wiki 链接');
    if(config.mode==='sheet' && parsed.type!=='sheet')throw new Error('表格来源需要 Sheets 链接');
    if(config.mode!=='wiki' && config.mode!=='sheet')throw new Error('飞书来源模式无效');
    if(config.includeNodeTypes!==undefined && (!Array.isArray(config.includeNodeTypes) || !config.includeNodeTypes.every(v=>typeof v==='string')))throw new Error('飞书节点类型配置无效');
    return parsed;
  }
  private async root(parsed:ParsedFeishuUrl):Promise<Json> {
    return object((await this.client.json(`/wiki/v2/spaces/get_node?token=${feishuToken(parsed.token)}`)).node);
  }
  private async documentVersion(token:string):Promise<string> {
    const doc=object((await this.client.json(`/docx/v1/documents/${feishuToken(token)}`)).document);
    if(!Number.isSafeInteger(doc.revision_id) || Number(doc.revision_id)<0)throw new Error('飞书未返回可靠的文档版本，未跳过该文档');
    return `docx:${doc.revision_id}`;
  }
  private async attachments(parent:RemoteResource,result:SourceListing):Promise<void> {
    const documentToken=feishuToken(parent.remoteToken);const revision=parent.remoteVersion;
    if(!revision?.startsWith('docx:'))throw new Error('缺少可靠的文档版本，未枚举页内附件');
    let pageToken:string|undefined;const seenPages=new Set<string>();let pages=0;
    do {
      if(++pages>1000)throw new Error('飞书页内附件枚举超过安全上限，未执行删除判断');
      const params=new URLSearchParams({page_size:'500',document_revision_id:revision.slice(5)});if(pageToken)params.set('page_token',pageToken);
      const page=await this.client.json(`/docx/v1/documents/${documentToken}/blocks?${params}`);
      const items=page.items===undefined&&page.has_more===false?[]:page.items;
      if(!Array.isArray(items)||typeof page.has_more!=='boolean')throw new Error('飞书文档块列表不完整，未执行删除判断');
      for(const item of items){
        const block=object(item);if(block.block_type!==23)continue;
        try {
          const file=object(block.file);const token=feishuToken(file.token);const blockId=feishuToken(block.block_id);
          const filename=string(file.name).replaceAll('\\','/').split('/').pop()?.replace(/[\x00-\x1f]/g,'').trim();
          if(!filename)throw new Error('飞书附件缺少文件名');
          const extension=/\.[^.]+$/.exec(filename)?.[0].toLowerCase() ?? '';
          result.items.push({id:`feishu:attachment:${documentToken}:${blockId}`,title:filename,kind:attachmentMime[extension]?'document':'unsupported',objectType:'attachment',remoteToken:token,
            remoteUrl:`${parent.remoteUrl}#${blockId}`,remoteVersion:`media:${token}`,modifiedAt:parent.modifiedAt,path:[...parent.path,filename],
            metadata:{provider:'feishu',parentDocumentToken:documentToken,parentDocumentUrl:parent.remoteUrl,parentDocumentRevision:revision,blockId,originalFilename:filename,mimeType:attachmentMime[extension],extension}});
        }catch(error){result.complete=false;result.errors.push({resourceId:parent.id,message:safeMessage(error)});}
      }
      if(!page.has_more)break;
      if(typeof page.page_token!=='string'||!page.page_token||seenPages.has(page.page_token))throw new Error('飞书附件分页结果不完整，未执行删除判断');
      pageToken=page.page_token;seenPages.add(pageToken);
    }while(true);
    if(await this.documentVersion(documentToken)!==revision)throw new Error('飞书文档在附件枚举期间发生修改，未执行删除判断');
  }
  private async sheetInfo(token:string):Promise<{title:string;tabs:Json[]}> {
    const info=object((await this.client.json(`/sheets/v3/spreadsheets/${feishuToken(token)}`)).spreadsheet);
    const result=await this.client.json(`/sheets/v3/spreadsheets/${feishuToken(token)}/sheets/query`);
    if(!Array.isArray(result.sheets))throw new Error('飞书未返回完整工作表列表');
    return {title:string(info.title,'飞书电子表格'),tabs:result.sheets.map(object)};
  }
  async test(config:Record<string,unknown>):Promise<{title:string}> {
    const parsed=this.config(config);
    if(parsed.type==='wiki'){const node=await this.root(parsed);feishuToken(node.node_token);return {title:string(node.title,'飞书知识库')};}
    const info=await this.sheetInfo(parsed.token);
    const tab=parsed.sheetId?info.tabs.find(v=>v.sheet_id===parsed.sheetId):info.tabs[0];
    if(!tab)throw new Error('指定的飞书工作表不存在或没有权限');
    await this.client.json(`/sheets/v2/spreadsheets/${parsed.token}/values/${encodeURIComponent(`${feishuToken(tab.sheet_id)}!A1:A1`)}?valueRenderOption=ToString`);
    return {title:parsed.sheetId?`${info.title} / ${string(tab.title)}`:info.title};
  }
  private resource(node:Json,parsed:ParsedFeishuUrl,path:string[]):RemoteResource {
    const objectType=string(node.obj_type);const remoteToken=feishuToken(node.obj_token);const nodeToken=feishuToken(node.node_token);
    const timestamp=modified(node.obj_edit_time);
    return {id:`feishu:${objectType}:${remoteToken}`,title:string(node.title,remoteToken),objectType,remoteToken,
      kind:['doc','docx','file','pdf'].includes(objectType)?'document':objectType==='sheet'?'dataset':'unsupported',
      remoteUrl:`${parsed.origin}/wiki/${nodeToken}`,modifiedAt:timestamp,path,
      metadata:{provider:'feishu',nodeToken,parentNodeToken:node.parent_node_token,spaceId:node.space_id,objectType}};
  }
  private async sheets(token:string,parsed:ParsedFeishuUrl,path:string[],selected?:string,version?:string,modifiedAt?:string):Promise<RemoteResource[]> {
    const info=await this.sheetInfo(token);const tabs=selected?info.tabs.filter(tab=>tab.sheet_id===selected):info.tabs;
    if(selected && !tabs.length)throw new Error('指定的飞书工作表不存在或没有权限');
    return tabs.map(tab=>{
      const sheetId=feishuToken(tab.sheet_id);const title=string(tab.title,sheetId);const grid=tab.grid_properties?object(tab.grid_properties):{};
      return {id:`feishu:sheet:${token}:${sheetId}`,title:`${info.title} / ${title}`,kind:tab.resource_type && tab.resource_type!=='sheet'?'unsupported':'dataset',objectType:'sheet',remoteToken:token,
        remoteUrl:`${parsed.origin}/sheets/${token}?sheet=${sheetId}`,remoteVersion:version,modifiedAt,path:[...path,title],
        metadata:{provider:'feishu',spreadsheetToken:token,sheetId,rowCount:grid.row_count,columnCount:grid.column_count,resourceType:tab.resource_type ?? 'sheet',rowStart:1}} satisfies RemoteResource;
    });
  }
  async list(config:Record<string,unknown>):Promise<SourceListing> {
    const parsed=this.config(config);const result:SourceListing={items:[],complete:true,errors:[]};
    const fail=(error:unknown,resourceId?:string)=>{result.complete=false;result.errors.push({resourceId,message:safeMessage(error)});};
    if(parsed.type==='sheet'){
      try{result.items=await this.sheets(parsed.token,parsed,[],parsed.sheetId);}catch(error){fail(error);}return result;
    }
    let root:Json;try{root=await this.root(parsed);}catch(error){fail(error);return result;}
    const queue:{node:Json;parents:string[]}[]=[{node:root,parents:[]}];const seen=new Set<string>();
    let pages=0;
    while(queue.length){
      const {node,parents}=queue.shift()!;let nodeToken:string;let path:string[];let resource:RemoteResource;
      try{nodeToken=feishuToken(node.node_token);if(seen.has(nodeToken))continue;seen.add(nodeToken);path=[...parents,string(node.title,nodeToken)];resource=this.resource(node,parsed,path);}
      catch(error){fail(error);continue;}
      const included=!config.includeNodeTypes || (config.includeNodeTypes as string[]).includes(resource.objectType);
      if(included){
        if(resource.objectType==='sheet'){
          try{result.items.push(...await this.sheets(resource.remoteToken,parsed,path, nodeToken===parsed.token?parsed.sheetId:undefined,resource.remoteVersion,resource.modifiedAt));}
          catch(error){fail(error,resource.id);}
        }else {
          if(resource.objectType==='docx'){
            try{resource.remoteVersion=await this.documentVersion(resource.remoteToken);}catch(error){fail(error,resource.id);}
          }
          result.items.push(resource);
          if(resource.objectType==='docx' && resource.remoteVersion){
            try{await this.attachments(resource,result);}catch(error){fail(error,resource.id);}
          }
        }
      }
      if(config.recursive===false || node.has_child===false)continue;
      let pageToken:string|undefined;const seenPages=new Set<string>();
      try{do{
        if(++pages>10_000 || seen.size>50_000)throw new Error('知识库枚举超过安全上限，未执行删除判断');
        const query=new URLSearchParams({parent_node_token:nodeToken,page_size:'50'});if(pageToken)query.set('page_token',pageToken);
        const page=await this.client.json(`/wiki/v2/spaces/${feishuToken(node.space_id)}/nodes?${query}`);
        // The official API omits items for an empty terminal page.
        const items=page.items===undefined && page.has_more===false?[]:page.items;
        if(!Array.isArray(items) || typeof page.has_more!=='boolean')throw new Error('飞书未返回完整节点列表，未执行删除判断');
        for(const child of items){try{queue.push({node:object(child),parents:path});}catch(error){fail(error,resource.id);}}
        if(!page.has_more)break;
        if(typeof page.page_token!=='string' || !page.page_token || seenPages.has(page.page_token))throw new Error('飞书节点分页结果不完整，未执行删除判断');
        pageToken=page.page_token;seenPages.add(pageToken);
      }while(true);}catch(error){fail(error,resource.id);}
    }
    // Wiki shortcuts can reference the same underlying object. Preserve its first source path.
    result.items=result.items.filter((item,index,all)=>all.findIndex(candidate=>candidate.id===item.id)===index);return result;
  }
  private provenance(resource:RemoteResource){return {...resource.metadata,provider:'feishu',remote_token:resource.remoteToken,remote_url:resource.remoteUrl,remote_version:resource.remoteVersion,remote_modified_at:resource.modifiedAt,remote_path:resource.path};}
  async fetchDocument(resource:RemoteResource,config:Record<string,unknown>):Promise<SourceFile> {
    this.config(config);const token=feishuToken(resource.remoteToken);
    if(resource.kind!=='document')throw new Error('该飞书资源不是可导入文档');
    let file:{buffer:Uint8Array;mimeType:string;filename?:string};let exportName:string|undefined;let stableFingerprint:string|undefined;
    let version=resource.remoteVersion;
    if(resource.objectType==='attachment'){
      file=await this.client.download(`/drive/v1/medias/${token}/download`);
      if(file.mimeType==='application/octet-stream' && typeof resource.metadata?.mimeType==='string')file.mimeType=resource.metadata.mimeType;
      file.filename=string(resource.metadata?.originalFilename,file.filename ?? resource.title);
    }else if(resource.objectType==='file' || resource.objectType==='pdf')file=await this.client.download(`/drive/v1/files/${token}/download`);
    else if(resource.objectType==='doc' || resource.objectType==='docx'){
      if(resource.objectType==='docx')version=await this.documentVersion(token);
      const task=await this.client.json('/drive/v1/export_tasks','POST',{file_extension:'docx',token,type:resource.objectType});const ticket=feishuToken(task.ticket);
      let exported:Json|undefined;
      for(let attempt=0;attempt<60;attempt++){
        const result=object((await this.client.json(`/drive/v1/export_tasks/${ticket}?token=${token}`)).result);
        if(result.job_status===0){exported=result;break;}
        if(result.job_status!==1 && result.job_status!==2)throw new Error('飞书文档导出失败，请检查导出权限后重试');
        await pause(this.client.exportPollMs);
      }
      if(!exported)throw new Error('飞书文档导出超时，请稍后重试');
      exportName=string(exported.file_name)||undefined;file=await this.client.download(`/drive/v1/export_tasks/file/${feishuToken(exported.file_token)}/download`);
      file.mimeType='application/vnd.openxmlformats-officedocument.wordprocessingml.document';
      if(resource.objectType==='docx' && await this.documentVersion(token)!==version)throw new Error('飞书文档在导出期间发生修改，请重新同步');
      // ZIP timestamps / export metadata are volatile. Compare rendered content, retaining table
      // boundaries and image-byte hashes, while preserving the original archive SHA for storage.
      try {
        const html=await mammoth.convertToHtml({buffer:Buffer.from(file.buffer)},{convertImage:mammoth.images.imgElement(async image=>({src:`sha256:${hash(Buffer.from(await image.read('base64'),'base64'))}`}))});
        stableFingerprint=hash(Buffer.from(html.value));
      }catch{throw new Error('飞书导出文件不是可读取的 DOCX，请重新导出');}
    }else throw new Error('暂不支持该飞书文档类型');
    let filename=(file.filename ?? exportName ?? resource.title).replaceAll('\\','/').split('/').pop()?.replace(/[\x00-\x1f]/g,'').trim() || '飞书文档';
    if(['doc','docx'].includes(resource.objectType) && !filename.toLowerCase().endsWith('.docx'))filename+='.docx';
    if(file.mimeType==='application/pdf' && !filename.toLowerCase().endsWith('.pdf'))filename+='.pdf';
    return {buffer:file.buffer,contentHash:hash(file.buffer),meta:{sourceId:resource.id,sourceType:config.mode==='wiki'?'feishu_wiki':'feishu_sheet',filename,mimeType:file.mimeType,
      sourceUri:resource.remoteUrl,sourcePath:resource.path.join('/'),version,modifiedAt:resource.modifiedAt,metadata:{...this.provenance(resource),remote_version:version,contentFingerprint:stableFingerprint ?? hash(file.buffer)}}};
  }
  async fetchDataset(resource:RemoteResource,config:Record<string,unknown>):Promise<StructuredSourceData> {
    this.config(config);if(resource.kind!=='dataset' || resource.objectType!=='sheet')throw new Error('该飞书资源不是工作表');
    const token=feishuToken(resource.remoteToken);const sheetId=feishuToken(resource.metadata?.sheetId);
    // Refresh dimensions: a table can grow between listing and download.
    const info=await this.sheetInfo(token);const tab=info.tabs.find(value=>value.sheet_id===sheetId);if(!tab)throw new Error('飞书工作表已不存在或无权访问');
    const grid=object(tab.grid_properties);const rowCount=Number(grid.row_count);const columnCount=Number(grid.column_count);
    if(!Number.isInteger(rowCount)||!Number.isInteger(columnCount)||rowCount<0||columnCount<0)throw new Error('飞书工作表尺寸无效');
    if(rowCount>50_000 || columnCount>1024 || rowCount*columnCount>2_000_000)throw new Error('飞书工作表超过当前读取上限（5 万行、1024 列、200 万单元格）');
    const rows:unknown[][]=Array.from({length:rowCount},()=>[]);let revision:string|undefined;
    for(let startRow=1;startRow<=rowCount;startRow+=500){for(let startColumn=1;startColumn<=columnCount;startColumn+=100){
      const endRow=Math.min(startRow+499,rowCount),endColumn=Math.min(startColumn+99,columnCount);
      const range=`${sheetId}!${columnName(startColumn)}${startRow}:${columnName(endColumn)}${endRow}`;
      const data=await this.client.json(`/sheets/v2/spreadsheets/${token}/values/${encodeURIComponent(range)}?valueRenderOption=ToString&dateTimeRenderOption=FormattedString`);
      const block=object(data.valueRange);if(!Array.isArray(block.values))throw new Error('飞书工作表读取不完整，未导入该表');
      const observed=data.revision ?? block.revision;
      if(observed!==undefined){if(revision!==undefined && revision!==String(observed))throw new Error('工作表在读取期间发生修改，请重新同步');revision=String(observed);}
      if(block.values.length>endRow-startRow+1)throw new Error('飞书工作表返回了不一致的行范围');
      block.values.forEach((row,index)=>{if(!Array.isArray(row)||row.length>endColumn-startColumn+1)throw new Error('飞书工作表返回了不一致的列范围');
        row.forEach((value,column)=>{rows[startRow-1+index][startColumn-1+column]=value;});});
    }}
    // Only trim trailing blank rows. Interior blank rows keep their real spreadsheet row numbers.
    while(rows.length && rows[rows.length-1].every(value=>value==null || value===''))rows.pop();
    return {remoteId:resource.id,title:resource.title,sourceUrl:resource.remoteUrl,version:revision ?? resource.remoteVersion,modifiedAt:resource.modifiedAt,rows,sheetId,spreadsheetToken:token,
      metadata:{...this.provenance(resource),rowStart:1,rowCount:rows.length,columnCount}};
  }
}
