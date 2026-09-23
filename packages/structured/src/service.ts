import {createHash,randomUUID} from 'node:crypto';
import type {Connection,Database} from '../../knowledge/src/database.js';
import type {LLMProvider} from '../../core/src/types.js';
import {cellText,extractRows,inferFields,inspect,suggestMapping,validateMapping} from './inspect.js';
import type {StructuredDataset,StructuredFact,StructuredMapping,StructuredRecord,StructuredSourceData} from './types.js';
import {StructuredError} from './errors.js';
export {StructuredError} from './errors.js';
export {inspect,suggestMapping} from './inspect.js';
export type * from './types.js';

const hash=(value:unknown)=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const timestamp=(value:unknown)=>value instanceof Date?value.toISOString():String(value);
const sourceRef=(raw:StructuredSourceData,rowIndex:number)=>({sourceUrl:raw.sourceUrl,spreadsheetToken:raw.spreadsheetToken,sheetId:raw.sheetId,rowIndex});
const contentHash=(raw:StructuredSourceData)=>hash({title:raw.title,rows:raw.rows,sheetId:raw.sheetId,sourceUrl:raw.sourceUrl});
const isScalarCell=(value:unknown):value is string|number|boolean=>typeof value==='string'||typeof value==='boolean'||typeof value==='number'&&Number.isFinite(value);
function dataset(row:any):StructuredDataset{
 const raw=row.raw_data as StructuredSourceData;
 return {id:row.id,sourceId:row.source_id,remoteId:row.remote_id,title:row.title,summary:row.summary,sourceType:row.source_type,status:row.status,
  schema:row.schema_fields,mapping:row.mapping,records:row.records,preview:inspect(raw,row.mapping?.headerRow),version:row.version,remoteVersion:row.remote_version??undefined,
  modifiedAt:row.modified_at??undefined,contentHash:row.content_hash,syncedAt:timestamp(row.synced_at),warnings:row.warnings,
  provenance:{sourceUrl:raw.sourceUrl,spreadsheetToken:raw.spreadsheetToken,sheetId:raw.sheetId,metadata:raw.metadata}};
}
function buildRecords(id:string,raw:StructuredSourceData,mapping:StructuredMapping|null){
 const preview=inspect(raw,mapping?.headerRow),fields=mapping?.fields??preview.fields,headerRow=mapping?.headerRow??preview.headerRow,{rows,warnings}=extractRows(raw,headerRow,fields);
 const key=mapping?.productKey,counts=new Map<string,number>();
 if(key)for(const row of rows){const k=isScalarCell(row.values[key])?cellText(row.values[key]):'';if(k)counts.set(k,(counts.get(k)??0)+1);}
 const nonScalarCount=rows.reduce((count,row)=>count+Object.values(row.values).filter(value=>value!==null&&typeof value==='object').length,0);
 if(nonScalarCount)warnings.push(`${nonScalarCount} 个单元格包含图片或复合对象，原始数据已保留，不生成文本产品事实。`);
 const invalid=new Set<string>();
 const records:StructuredRecord[]=rows.map(row=>{
  const nonScalarKey=!!key&&row.values[key]!==null&&row.values[key]!==undefined&&!isScalarCell(row.values[key]);
  const productKey=key&&!nonScalarKey?cellText(row.values[key]):'',duplicate=!!productKey&&(counts.get(productKey)??0)>1;
  const stableKey=productKey&&!duplicate?['key',productKey]:['row',row.rowIndex];
  const record={...row,id:`record_${hash([id,stableKey]).slice(0,32)}`,datasetId:id,sourceRef:sourceRef(raw,row.rowIndex)};
  if(mapping?.isProductTable&&(!productKey||duplicate)){invalid.add(record.id);warnings.push(nonScalarKey?`第 ${row.rowIndex} 行产品主键不是文本、数字或布尔值，未生成产品事实。`:!productKey?`第 ${row.rowIndex} 行产品主键为空，未生成产品事实。`:`产品主键“${productKey.slice(0,120)}”重复（第 ${row.rowIndex} 行），未生成事实，请在源表修正。`);}
  return record;
 });
 return {records,invalid,warnings:[...new Set([...preview.warnings,...warnings])]};
}
function factsFor(records:StructuredRecord[],invalid:Set<string>,mapping:StructuredMapping|null,syncedAt:string):StructuredFact[]{
 if(!mapping?.isProductTable||!mapping.productKey)return [];
 const facts:StructuredFact[]=[];
 for(const record of records){
  if(invalid.has(record.id))continue;
  const productKey=cellText(record.values[mapping.productKey]);
  for(const field of mapping.fields){
   const value=record.values[field.key];if(!isScalarCell(value)||value==='')continue;
   const name=field.canonicalName||field.key;
   facts.push({id:`fact_${hash([record.datasetId,record.id,name]).slice(0,32)}`,productKey,field:name,value,unit:field.unit,authority:mapping.authority,sourceDatasetId:record.datasetId,sourceRecordId:record.id,sourceRef:record.sourceRef,updatedAt:syncedAt});
  }
 }
 return facts;
}
const factValue=(fact:StructuredFact)=>({value:fact.value,unit:fact.unit??null,authority:fact.authority});
const fromFact=(row:any):StructuredFact=>({id:row.id,productKey:row.product_key,field:row.field,value:row.value,unit:row.unit??undefined,authority:row.authority,sourceDatasetId:row.source_dataset_id,sourceRecordId:row.source_record_id,sourceRef:row.source_ref,updatedAt:timestamp(row.updated_at),...(row.dataset_title?{datasetTitle:row.dataset_title}:{})});
async function reconcileFacts(tx:Connection,id:string,next:StructuredFact[],revision:string|undefined,syncedAt:string,reason:string){
 const current=(await tx.query('SELECT * FROM structured_facts WHERE source_dataset_id=$1 AND active=true',[id])).map(fromFact),byId=new Map(next.map(f=>[f.id,f]));
 const audit=async(before:StructuredFact|undefined,after:StructuredFact|undefined)=>{
  const fact=after??before!;
  await tx.query('INSERT INTO structured_fact_history(id,fact_id,dataset_id,source_record_id,product_key,field,before_value,after_value,source_ref,source_revision,synced_at,reason) VALUES($1,$2,$3,$4,$5,$6,$7::jsonb,$8::jsonb,$9::jsonb,$10,$11,$12)',
   [randomUUID(),fact.id,id,fact.sourceRecordId,fact.productKey,fact.field,before?JSON.stringify(factValue(before)):null,after?JSON.stringify(factValue(after)):null,JSON.stringify(fact.sourceRef),revision??null,syncedAt,reason]);
 };
 for(const before of current){
  const after=byId.get(before.id);
  if(!after){await audit(before,undefined);await tx.query('UPDATE structured_facts SET active=false,updated_at=$2 WHERE id=$1',[before.id,syncedAt]);}
  else {if(hash(factValue(before))!==hash(factValue(after)))await audit(before,after);byId.delete(before.id);}
 }
 for(const after of byId.values())await audit(undefined,after);
 for(const fact of next)await tx.query(`INSERT INTO structured_facts(id,source_dataset_id,source_record_id,product_key,field,value,unit,authority,source_ref,active,updated_at)
 VALUES($1,$2,$3,$4,$5,$6::jsonb,$7,$8,$9::jsonb,true,$10)
 ON CONFLICT(id) DO UPDATE SET product_key=excluded.product_key,value=excluded.value,unit=excluded.unit,authority=excluded.authority,source_ref=excluded.source_ref,active=true,
 updated_at=CASE WHEN structured_facts.value IS DISTINCT FROM excluded.value OR structured_facts.unit IS DISTINCT FROM excluded.unit OR structured_facts.authority IS DISTINCT FROM excluded.authority OR NOT structured_facts.active THEN excluded.updated_at ELSE structured_facts.updated_at END`,
 [fact.id,id,fact.sourceRecordId,fact.productKey,fact.field,JSON.stringify(fact.value),fact.unit??null,fact.authority,JSON.stringify(fact.sourceRef),syncedAt]);
}
async function snapshot(tx:Connection,row:any,reason:string){
 await tx.query('INSERT INTO structured_dataset_versions(dataset_id,version,source_revision,synced_at,reason,snapshot) VALUES($1,$2,$3,$4,$5,$6::jsonb)',[row.id,row.version,row.remote_version,row.synced_at,reason,JSON.stringify({...dataset(row),rawData:row.raw_data})]);
}
function sameSchema(raw:StructuredSourceData,next:StructuredSourceData,mapping:StructuredMapping){
 // Compare the entire source header, not only selected fields: a new/deleted column needs an explicit review.
 return JSON.stringify((raw.rows[mapping.headerRow-1]??[]).map(cellText))===JSON.stringify((next.rows[mapping.headerRow-1]??[]).map(cellText));
}
export class StructuredService {
 constructor(readonly db:Database){}
 inspect(data:StructuredSourceData,headerRow?:number){return inspect(data,headerRow);}
 async preview(id:string,headerRow:number){
  const raw=await this.sourceData(id),preview=inspect(raw,headerRow),rows=extractRows(raw,headerRow,preview.fields).rows;
  return {...preview,records:rows.slice(0,5).map(row=>({...row,id:`${id}:preview:${row.rowIndex}`,datasetId:id,sourceRef:sourceRef(raw,row.rowIndex)}))};
 }
 suggestMapping(data:StructuredSourceData,provider?:LLMProvider){return suggestMapping(data,provider);}
 async list(sourceId?:string):Promise<StructuredDataset[]>{
  const rows=await this.db.query(`SELECT * FROM structured_datasets ${sourceId?'WHERE source_id=$1':''} ORDER BY synced_at DESC`,sourceId?[sourceId]:[]);return rows.map(dataset);
 }
 async get(id:string):Promise<StructuredDataset>{
  const row=(await this.db.query('SELECT * FROM structured_datasets WHERE id=$1',[id]))[0];if(!row)throw new StructuredError('not_found','未找到结构化数据集。');
  const result=dataset(row);
  result.versions=(await this.db.query('SELECT * FROM structured_dataset_versions WHERE dataset_id=$1 ORDER BY version DESC',[id])).map(v=>({version:v.version,sourceRevision:v.source_revision??undefined,syncedAt:timestamp(v.synced_at),reason:v.reason,snapshot:v.snapshot}));
  result.factHistory=(await this.db.query('SELECT * FROM structured_fact_history WHERE dataset_id=$1 ORDER BY synced_at DESC,id',[id])).map(h=>({id:h.id,productKey:h.product_key,field:h.field,before:h.before_value,after:h.after_value,sourceRevision:h.source_revision??undefined,syncedAt:timestamp(h.synced_at),reason:h.reason,sourceRecordId:h.source_record_id,sourceRef:h.source_ref}));
  return result;
 }
 async sourceData(id:string):Promise<StructuredSourceData>{const row=(await this.db.query('SELECT raw_data FROM structured_datasets WHERE id=$1',[id]))[0];if(!row)throw new StructuredError('not_found','未找到结构化数据集。');return row.raw_data;}
 async save(sourceId:string,data:StructuredSourceData):Promise<StructuredDataset>{
  if(!sourceId||!data.remoteId||!Array.isArray(data.rows)||data.rows.some(row=>!Array.isArray(row)))throw new StructuredError('invalid_input','结构化数据缺少来源、资源标识或有效行。');
  return this.db.transaction(async tx=>{
   const old=(await tx.query('SELECT * FROM structured_datasets WHERE source_id=$1 AND remote_id=$2 FOR UPDATE',[sourceId,data.remoteId]))[0],digest=contentHash(data),now=new Date().toISOString();
   if(old&&old.content_hash===digest&&old.status!=='removed'){
    const row=(await tx.query('UPDATE structured_datasets SET raw_data=$2::jsonb,remote_version=$3,modified_at=$4,synced_at=$5 WHERE id=$1 RETURNING *',[old.id,JSON.stringify(data),data.version??null,data.modifiedAt??null,now]))[0];
    return {...dataset(row),change:'unchanged'};
   }
   const id=old?.id??randomUUID(),preview=inspect(data),priorMapping=old?.mapping as StructuredMapping|null;
   const compatible=!!priorMapping&&sameSchema(old.raw_data,data,priorMapping),mapping=compatible?priorMapping:null;
   const built=buildRecords(id,data,mapping),status=mapping?'active':'pending_mapping';
   if(priorMapping&&!compatible)built.warnings.push('源表字段或表头位置已变化，已暂停事实并保留历史；请重新确认映射。');
   const row=(await tx.query(`INSERT INTO structured_datasets(id,source_id,remote_id,title,summary,source_type,status,raw_data,schema_fields,mapping,records,warnings,version,content_hash,remote_version,modified_at,synced_at)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9::jsonb,$10::jsonb,$11::jsonb,$12::jsonb,$13,$14,$15,$16,$17)
    ON CONFLICT(id) DO UPDATE SET title=excluded.title,summary=excluded.summary,status=excluded.status,raw_data=excluded.raw_data,schema_fields=excluded.schema_fields,mapping=excluded.mapping,records=excluded.records,warnings=excluded.warnings,version=excluded.version,content_hash=excluded.content_hash,remote_version=excluded.remote_version,modified_at=excluded.modified_at,synced_at=excluded.synced_at RETURNING *`,
    [id,sourceId,data.remoteId,old?.title??data.title,old?.summary??preview.summary,String(data.metadata?.sourceType??data.metadata?.provider??'structured'),status,JSON.stringify(data),JSON.stringify(mapping?.fields??preview.fields),mapping?JSON.stringify(mapping):null,JSON.stringify(built.records),JSON.stringify(built.warnings),(old?.version??0)+1,digest,data.version??null,data.modifiedAt??null,now]))[0];
   await reconcileFacts(tx,id,factsFor(built.records,built.invalid,mapping,now),data.version,now,priorMapping&&!compatible?'schema_changed':'sync');
   await snapshot(tx,row,old?'sync_changed':'sync_new');
   return {...dataset(row),change:old?'changed':'new'};
  });
 }
 async confirmMapping(id:string,input:StructuredMapping,metadata?:{title?:string;summary?:string}):Promise<StructuredDataset>{
  return this.db.transaction(async tx=>{
   const old=(await tx.query('SELECT * FROM structured_datasets WHERE id=$1 FOR UPDATE',[id]))[0];if(!old)throw new StructuredError('not_found','未找到结构化数据集。');if(old.status==='removed')throw new StructuredError('invalid_input','来源已移除，请先同步恢复后再确认映射。');
   const raw=old.raw_data as StructuredSourceData,mapping=validateMapping(raw,input),now=new Date().toISOString(),built=buildRecords(id,raw,mapping);
   const title=metadata?.title?.trim()||old.title,summary=metadata?.summary?.trim()??old.summary;
   if(title.length>300||summary.length>4000)throw new StructuredError('invalid_input','表格标题或摘要过长。');
   if(old.status==='active'&&hash(old.mapping)===hash(mapping)&&title===old.title&&summary===old.summary)return {...dataset(old),change:'unchanged'};
   const row=(await tx.query("UPDATE structured_datasets SET status='active',mapping=$2::jsonb,schema_fields=$3::jsonb,records=$4::jsonb,warnings=$5::jsonb,version=version+1,synced_at=$6,title=$7,summary=$8 WHERE id=$1 RETURNING *",[id,JSON.stringify(mapping),JSON.stringify(mapping.fields),JSON.stringify(built.records),JSON.stringify(built.warnings),now,title,summary]))[0];
   await reconcileFacts(tx,id,factsFor(built.records,built.invalid,mapping,now),raw.version,now,'mapping_confirmed');await snapshot(tx,row,'mapping_confirmed');
   return {...dataset(row),change:'changed'};
  });
 }
 async remove(id:string):Promise<StructuredDataset>{
  return this.db.transaction(async tx=>{
   const old=(await tx.query('SELECT * FROM structured_datasets WHERE id=$1 FOR UPDATE',[id]))[0];if(!old)throw new StructuredError('not_found','未找到结构化数据集。');if(old.status==='removed')return {...dataset(old),change:'unchanged'};
   const now=new Date().toISOString(),row=(await tx.query("UPDATE structured_datasets SET status='removed',version=version+1,synced_at=$2 WHERE id=$1 RETURNING *",[id,now]))[0];
   await reconcileFacts(tx,id,[],old.remote_version??undefined,now,'removed_from_source');await snapshot(tx,row,'removed_from_source');return {...dataset(row),change:'changed'};
  });
 }
 async searchFacts(query:string):Promise<StructuredFact[]>{
  const term=query.trim().slice(0,200).replace(/[\\%_]/g,'\\$&');
  const rows=await this.db.query(`SELECT f.*,d.title AS dataset_title FROM structured_facts f JOIN structured_datasets d ON d.id=f.source_dataset_id
   WHERE f.active=true AND d.status='active' AND ($1='' OR f.product_key ILIKE $2 OR f.field ILIKE $2 OR f.value::text ILIKE $2)
   ORDER BY CASE f.authority WHEN 'authoritative' THEN 0 ELSE 1 END,f.product_key,f.field LIMIT 200`,[term,`%${term}%`]);
  return rows.map(fromFact);
 }
 /** Exact model matching for document generation: K1 must never retrieve K18 parameters. */
 async productFacts(productKeys:string[]):Promise<StructuredFact[]>{
  if(!productKeys.length)return [];
  const rows=await this.db.query(`SELECT f.*,d.title AS dataset_title FROM structured_facts f JOIN structured_datasets d ON d.id=f.source_dataset_id
   WHERE f.active=true AND d.status='active' AND f.authority='authoritative' AND lower(f.product_key)=ANY($1::text[])
   ORDER BY f.product_key,f.field,f.id`,[[...new Set(productKeys.map(k=>k.normalize('NFKC').toLowerCase().trim()))]]);
  return rows.map(fromFact);
 }
}
