import {afterAll,beforeAll,describe,expect,it} from 'vitest';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve,sep} from 'node:path';
import {randomUUID} from 'node:crypto';
import {openDatabase,type Database} from '../packages/knowledge/src/database.js';
import {StructuredService,inspect,suggestMapping,type StructuredSourceData,type StructuredMapping} from '../packages/structured/src/service.js';

const data=(rows:unknown[][]=[['型号','设备名称','温度 (°C)','软件版本'],['ROBOT-A','测试机器人',23,'1.2'],['ROBOT-B','备用机器人',24,'1.4']]):StructuredSourceData=>({remoteId:randomUUID(),title:'机器人产品参数',sourceUrl:'https://example.test/sheets/test',spreadsheetToken:'test',sheetId:'sheet-a',version:'rev-1',rows});
const mapping=(raw:StructuredSourceData,authority:'reference'|'authoritative'='reference'):StructuredMapping=>{const p=inspect(raw);return{headerRow:p.headerRow,fields:p.fields.map(f=>({...f,canonicalName:f.key==='col_3'?'temperature':f.key})),productKey:p.suggestedProductKey,isProductTable:true,authority};};
describe('Generic structured data inspection and bounded mapping suggestions',()=>{
 it('detects title/blank preamble, retains real row indexes, units and generic schema',()=>{
  const raw=data([['设备参数目录'],[],['型号','设备名称','温度 (°C)','软件版本'],['ROBOT-A','测试机器人',23,'1.2']]);
  const p=inspect(raw);expect(p.headerRow).toBe(3);expect(p.rowCount).toBe(1);expect(p.fields[2]).toMatchObject({key:'col_3',unit:'°C',semanticType:'number'});expect(p.suggestedProductKey).toBe('col_1');
 });
 it('separates another table after a gap and skips repeated headers',()=>{
  const p=inspect(data([['型号','设备名称'],['A','机械臂'],['型号','设备名称'],['B','控制器'],[],['软件配置表'],['版本','名称'],['1.2','控制软件']]));
  expect(p.rowCount).toBe(2);expect(p.warnings.join(' ')).toContain('另一张表');expect(p.warnings.join(' ')).toContain('重复表头');
  const wider=inspect(data([['型号','设备名称'],['A','机械臂'],[],['版本','名称','编号','单位','参数'],['1.2','控制软件','S1','版本','稳定']]));expect(wider.headerRow).toBe(1);expect(wider.rowCount).toBe(1);
 });
 it('labels rule fallback, keeps default reference and requires product-table confirmation',async()=>{
  const result=await suggestMapping(data());expect(result.method).toBe('rule');expect(result.suggestedMapping.authority).toBe('reference');expect(result.suggestedMapping.isProductTable).toBe(false);
 });
 it('bounds AI context and does not accept hallucinated units, products or unknown columns',async()=>{
  const raw=data([Array.from({length:100},(_,i)=>`字段${i}${'内容'.repeat(200)}`),...Array.from({length:1000},()=>Array.from({length:100},()=> '正文'.repeat(200)))]);
  let prompt='';const result=await suggestMapping(raw,{async generate(request){prompt=request.prompt;return{content:JSON.stringify({title:'虚构产品Z999参数表',fields:[{key:'col_1',semanticType:'number',unit:'fps',confidence:0.99}]}),usage:{inputTokens:50,outputTokens:20}};}});
  expect(Buffer.byteLength(prompt)).toBeLessThanOrEqual(16000);expect(result.fields[0].unit).toBeUndefined();expect(result.title).toBe(raw.title);expect(result.usage?.inputTokens).toBe(50);
  const rejected=await suggestMapping(data(),{async generate(){return{content:JSON.stringify({fields:[{key:'invented',semanticType:'number',confidence:1}]})};}});expect(rejected.method).toBe('rule');
 });
 it('preserves grounded AI names and types but never lets AI promote authority',async()=>{
  const result=await suggestMapping(data(),{async generate(){return{content:JSON.stringify({title:'机器人产品参数表',summary:'机器人型号、设备名称、温度及软件版本。',productKey:'col_1',fields:[{key:'col_3',canonicalName:'temperature',semanticType:'number',unit:'°C',confidence:.95}]})};}});
  expect(result.method).toBe('ai');expect(result.title).toBe('机器人产品参数表');expect(result.suggestedMapping.authority).toBe('reference');expect(result.fields[2].canonicalName).toBe('temperature');
 });
});

describe('Structured persistence, source provenance and fact history',()=>{
 let db:Database,service:StructuredService,directory:string;
 beforeAll(async()=>{
  directory=await mkdtemp(join(tmpdir(),'studio-structured-'));db=await openDatabase(directory);service=new StructuredService(db);
  const sql=await readFile(new URL('../migrations/004_structured.sql',import.meta.url),'utf8');for(const statement of sql.split(';').filter(s=>s.trim()))await db.query(statement);
 },30000);
 afterAll(async()=>{await db?.close();if(directory&&resolve(directory).startsWith(resolve(tmpdir())+sep+'studio-structured-'))await rm(directory,{recursive:true,force:true});});
 it('holds first import pending until confirmation and preserves actual source row references',async()=>{
  const raw=data([['机器人清单'],[],['型号','温度 (°C)'],['R1',23]]),saved=await service.save('test',raw);
  expect(saved.status).toBe('pending_mapping');expect(saved.records[0].rowIndex).toBe(4);expect(saved.records[0].sourceRef).toMatchObject({rowIndex:4,sheetId:'sheet-a',spreadsheetToken:'test'});
  expect((await service.searchFacts('R1')).length).toBe(0);
  const active=await service.confirmMapping(saved.id,mapping(raw));expect(active.status).toBe('active');expect((await service.searchFacts('R1')).every(f=>f.authority==='reference')).toBe(true);
 });
 it('reuses confirmed mappings, skips unchanged values and audits only a changed parameter',async()=>{
  const raw=data(),saved=await service.save('test',raw);await service.confirmMapping(saved.id,mapping(raw));const before=await service.get(saved.id),recordId=before.records[0].id;
  const unchanged=await service.save('test',{...raw,version:'rev-same'});expect(unchanged.change).toBe('unchanged');expect((await service.get(saved.id)).versions!.length).toBe(before.versions!.length);
  const revised={...raw,version:'rev-2',rows:raw.rows.map(r=>[...r])};revised.rows[1][2]=25;
  const updated=await service.save('test',revised);expect(updated.status).toBe('active');expect(updated.records[0].id).toBe(recordId);
  const detail=await service.get(saved.id),history=detail.factHistory!.filter(h=>h.sourceRevision==='rev-2');expect(history).toHaveLength(1);expect(history[0]).toMatchObject({productKey:'ROBOT-A',field:'temperature',before:{value:23,unit:'°C'},after:{value:25,unit:'°C'},reason:'sync',sourceRef:{rowIndex:2}});
 });
 it('keeps record identity across row reordering and updates source locations without invented changes',async()=>{
  const raw=data(),saved=await service.save('reorder',raw);await service.confirmMapping(saved.id,mapping(raw));const before=await service.get(saved.id),historyCount=before.factHistory!.length;
  await service.save('reorder',{...raw,version:'reordered',rows:[raw.rows[0],raw.rows[2],raw.rows[1]]});const after=await service.get(saved.id);
  expect(after.records[1].id).toBe(before.records[0].id);expect(after.records[1].sourceRef.rowIndex).toBe(3);expect(after.factHistory).toHaveLength(historyCount);
 });
 it('requires reconfirmation on schema changes and audits removed fields instead of retaining stale facts',async()=>{
  const raw=data(),saved=await service.save('schema',raw);await service.confirmMapping(saved.id,mapping(raw));
  const revised={...raw,version:'drop-column',rows:raw.rows.map(row=>row.slice(0,2))},pending=await service.save('schema',revised);
  expect(pending.status).toBe('pending_mapping');expect((await service.searchFacts('ROBOT-A')).filter(f=>f.sourceDatasetId===saved.id)).toHaveLength(0);
  const detail=await service.get(saved.id);expect(detail.factHistory!.some(h=>h.field==='temperature'&&h.after===null&&h.reason==='schema_changed')).toBe(true);
  await expect(service.confirmMapping(saved.id,mapping(raw))).rejects.toThrow();await service.confirmMapping(saved.id,mapping(revised));
  expect((await service.searchFacts('ROBOT-A')).filter(f=>f.sourceDatasetId===saved.id).map(f=>f.field)).not.toContain('temperature');
 });
 it('does not silently overwrite duplicate or empty product keys and retracts previous ambiguous facts',async()=>{
  const raw=data(),saved=await service.save('duplicates',raw);await service.confirmMapping(saved.id,mapping(raw));
  const duplicated={...raw,rows:[raw.rows[0],raw.rows[1],['ROBOT-A','重复机型',999,'9.9'],['','缺少机型',100,'1.0']]},after=await service.save('duplicates',duplicated);
  expect(after.records).toHaveLength(3);expect(after.warnings.join(' ')).toContain('重复');expect(after.warnings.join(' ')).toContain('为空');
  expect((await service.searchFacts('ROBOT-A')).filter(f=>f.sourceDatasetId===saved.id)).toHaveLength(0);
 });
 it('retracts removed rows, preserves source removal history and restores the existing mapping',async()=>{
  const raw=data(),saved=await service.save('removal',raw);await service.confirmMapping(saved.id,mapping(raw));
  await service.save('removal',{...raw,version:'row-removed',rows:raw.rows.slice(0,2)});let detail=await service.get(saved.id);
  expect(detail.factHistory!.some(h=>h.productKey==='ROBOT-B'&&h.after===null)).toBe(true);
  await service.remove(saved.id);detail=await service.get(saved.id);expect(detail.status).toBe('removed');expect(detail.records).toHaveLength(1);expect(detail.versions!.length).toBeGreaterThan(2);
  expect((await service.searchFacts('ROBOT-A')).filter(f=>f.sourceDatasetId===saved.id)).toHaveLength(0);
  const restored=await service.save('removal',raw);expect(restored.status).toBe('active');expect(restored.records).toHaveLength(2);
 });
 it('keeps generic non-product tables without product facts and uses user-confirmed authority and names',async()=>{
  const raw=data(),saved=await service.save('generic',raw),m=mapping(raw);m.isProductTable=false;
  await service.confirmMapping(saved.id,m,{title:'机器人配置参考表',summary:'人工确认的字段说明。'});expect((await service.searchFacts('ROBOT-A')).filter(f=>f.sourceDatasetId===saved.id)).toHaveLength(0);
  m.isProductTable=true;m.authority='authoritative';await service.confirmMapping(saved.id,m);
  expect((await service.searchFacts('ROBOT-A')).filter(f=>f.sourceDatasetId===saved.id).every(f=>f.authority==='authoritative')).toBe(true);
  const changed=await service.save('generic',{...raw,version:'revision-next',rows:[raw.rows[0],raw.rows[1]]});expect(changed.title).toBe('机器人配置参考表');expect(changed.summary).toBe('人工确认的字段说明。');
 });
 it('rejects duplicate canonical field names and invalid product-key mappings',async()=>{
  const raw=data(),saved=await service.save('invalid',raw),m=mapping(raw);m.fields[0].canonicalName='temperature';
  await expect(service.confirmMapping(saved.id,m)).rejects.toThrow('唯一');await expect(service.confirmMapping(saved.id,{...mapping(raw),productKey:'nonexistent'})).rejects.toThrow('主键');
 });
 it('preserves image and composite cells as raw records without generating facts and keeps valid scalar values',async()=>{
  const image=[{id:1,type:'embed-image'}],object={nested:'unparsed payload'},raw=data([['型号','文本','数值','启用','附件A','附件B'],['SCALAR-ONLY','真实说明',0,false,image,object]]),saved=await service.save('non-scalar',raw);
  const active=await service.confirmMapping(saved.id,mapping(raw,'authoritative'));expect(active.records[0].values.col_5).toEqual(image);expect(active.records[0].values.col_6).toEqual(object);expect((await service.sourceData(saved.id)).rows[1][4]).toEqual(image);expect(active.warnings.join(' ')).toContain('2 个单元格');
  const facts=(await service.searchFacts('SCALAR-ONLY')).filter(f=>f.sourceDatasetId===saved.id);expect(facts).toHaveLength(4);expect(facts.map(f=>f.value)).toEqual(expect.arrayContaining(['SCALAR-ONLY','真实说明',0,false]));expect(facts.every(f=>f.authority==='authoritative')).toBe(true);expect(facts.every(f=>typeof f.value!=='object')).toBe(true);
  raw.rows[1][2]=image;raw.version='scalar-replaced';await service.save('non-scalar',raw);const detail=await service.get(saved.id);expect(detail.factHistory!.some(h=>h.field==='temperature'&&(h.before as any)?.value===0&&h.after===null)).toBe(true);expect((await service.searchFacts('SCALAR-ONLY')).filter(f=>f.sourceDatasetId===saved.id)).toHaveLength(3);
 });
 it('does not stringify a composite product-key cell into a product identifier',async()=>{
  const raw=data([['型号','数值'],[[{id:1,type:'embed-image'}],42]]),saved=await service.save('non-scalar-key',raw),active=await service.confirmMapping(saved.id,mapping(raw));expect(active.records).toHaveLength(1);expect(active.warnings.join(' ')).toContain('产品主键不是文本');expect((await service.searchFacts('')).filter(f=>f.sourceDatasetId===saved.id)).toHaveLength(0);
 });
 it('migration is idempotent and leaves unrelated extracted facts untouched',async()=>{
  const before=await db.query('SELECT count(*) AS count FROM extracted_facts');const sql=await readFile(new URL('../migrations/004_structured.sql',import.meta.url),'utf8');for(const statement of sql.split(';').filter(s=>s.trim()))await db.query(statement);
  expect(await db.query('SELECT count(*) AS count FROM extracted_facts')).toEqual(before);expect((await service.list('test')).length).toBeGreaterThan(0);
 });
});
