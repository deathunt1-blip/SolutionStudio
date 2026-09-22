/**
 * Read-only live-library audit. Every network request is GET to the configured
 * Studio server. It never uploads, edits, rebuilds, tests a model, or reads keys.
 * The detailed report is intentionally written under gitignored output/.
 *
 * npx tsx scripts/audit-library.ts [--url http://127.0.0.1:4310]
 *   [--output output/library-audit.json] [--baseline output/pre-expansion-documents.json]
 *   [--originals 8] [--filter-values 4]
 */
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, extname, resolve } from 'node:path';
import type { Classification, DocumentRecord, KnowledgeChunk, ParsedDocument, Registries } from '../packages/core/src/types.js';

type Detail = {
 document:DocumentRecord; chunks:KnowledgeChunk[]; parsed:ParsedDocument|null;
 versions:{id:string;versionNumber:number;status:string;createdAt:string;contentHash:string}[];
 audit:{id:string;action:string;modifiedAt:string;nextValue?:{classification?:Classification}}[];
};
type Stats = {total:number;active:number;needsReview:number;failed:number;processing:number;chunks:number;confirmedExamples:number};
type Finding = {code:string;documentId?:string;message:string};
type SearchItem = {document:DocumentRecord;chunk:KnowledgeChunk;score:number};
const args=process.argv.slice(2);
const option=(key:string,fallback:string)=>{const i=args.indexOf(key);return i<0?fallback:args[i+1]||fallback;};
const endpoint=new URL(option('--url','http://127.0.0.1:4310'));
if(!['http:','https:'].includes(endpoint.protocol)||endpoint.username||endpoint.password||endpoint.search||endpoint.hash)throw new Error('Use an HTTP(S) Studio URL without credentials or query parameters.');
const output=resolve(option('--output','output/library-audit.json'));
const baselinePath=resolve(option('--baseline','output/pre-expansion-documents.json'));
const originalLimit=Math.max(0,Math.min(8,Number.parseInt(option('--originals','8'))||0));
const filterLimit=Math.max(1,Math.min(10,Number.parseInt(option('--filter-values','4'))||4));
const segmenter=new Intl.Segmenter('zh-CN',{granularity:'word'});
const terminal=new Set(['active','needs_review','failed','archived']);
const hash=(value:string)=>createHash('sha256').update(value).digest('hex');
const report={
 startedAt:new Date().toISOString(),finishedAt:'',stableSnapshot:false,requestCount:0,
 statsBefore:null as Stats|null,statsAfter:null as Stats|null,
 summary:{documents:0,chunks:0,originalDocumentsChecked:0,originalVersionsChecked:0,filterChecks:0,filenameChecks:0,keywordChecks:0,userFieldsChecked:0,baselineDocuments:0,checks:0,failures:0,warnings:0},
 usage:{scope:'Current active-version metadata only; excludes superseded versions and connection tests. This is not an account billing ledger.',documentsWithUsage:0,documentsWithoutUsage:0,inputTokens:0,outputTokens:0,totalTokens:0},
 statusCounts:{} as Record<string,number>,parseStatusCounts:{} as Record<string,number>,formatCounts:{} as Record<string,number>,
 documents:[] as {id:string;extension:string;status:string;versionId:string;versionNumber:number;chunks:number;parseStatus:string;warnings:number;userFields:string[];usage?:{inputTokens:number;outputTokens:number}}[],
 originals:[] as {documentId:string;versionId:string;bytes:number;matches:boolean}[],
 filters:[] as {kind:string;valueHash:string;results:number;coherent:boolean}[],
 baselineObservations:[] as {documentId:string;observation:string;fields?:string[]}[],
 failures:[] as Finding[],warnings:[] as Finding[],
};
const fail=(code:string,message:string,documentId?:string)=>report.failures.push({code,message,...documentId?{documentId}:{}});
const warn=(code:string,message:string,documentId?:string)=>report.warnings.push({code,message,...documentId?{documentId}:{}});
const check=(condition:boolean,code:string,message:string,documentId?:string)=>{report.summary.checks++;if(!condition)fail(code,message,documentId);};
async function response(route:string) {
 report.requestCount++;
 const url=new URL(route,endpoint);
 if(url.origin!==endpoint.origin)throw new Error('Cross-origin audit request was refused.');
 const result=await fetch(url,{method:'GET',redirect:'error',signal:AbortSignal.timeout(60_000)});
 if(!result.ok){await result.body?.cancel();throw new Error(`GET ${url.pathname} returned HTTP ${result.status}`);}
 return result;
}
async function json<T>(route:string):Promise<T>{return await(await response(route)).json() as T;}
const route=(base:string,query:Record<string,string|number>)=>`${base}?${new URLSearchParams(Object.entries(query).map(([k,v])=>[k,String(v)]))}`;
async function pages<T>(base:string,query:Record<string,string|number>,visit:(items:T[])=>void|Promise<void>) {
 let seen=0,total=0;
 for(let page=1;page<=1000;page++){
  const result=await json<{items:T[];total:number}>(route(base,{...query,page,pageSize:100}));
  if(!Array.isArray(result.items)||!Number.isInteger(result.total)||result.total<0)throw new Error('Unexpected pagination response.');
  total=result.total;await visit(result.items);seen+=result.items.length;
  if(seen>=total||!result.items.length)return{total,seen};
 }
 throw new Error('Audit pagination exceeded its safety bound.');
}
async function listDocuments(){const items=new Map<string,DocumentRecord>();await pages<DocumentRecord>('/api/documents',{},page=>{for(const item of page)items.set(item.id,item);});return items;}
const equality=(left:unknown,right:unknown)=>JSON.stringify(left)===JSON.stringify(right);
const valueOf=(doc:DocumentRecord,key:string)=>doc.classification?.[key as keyof Classification]?.value;
function candidates(detail:Detail){
 const terms=new Set<string>();
 for(const part of segmenter.segment(detail.chunks.map(chunk=>chunk.text.slice(0,2000)).join('\n').slice(0,14000))){
  const term=part.segment;
  if(part.isWordLike&&term.length>=2&&term.length<=24&&(/[\p{Script=Han}]/u.test(term)||/^[A-Za-z][A-Za-z0-9_-]{2,}$/.test(term)))terms.add(term);
  if(terms.size>=160)break;
 }
 return [...terms];
}

try {
 report.statsBefore=await json<Stats>('/api/stats');
 const registries=await json<Registries>('/api/registries');
 const listing=await listDocuments();
 const details=new Map<string,Detail>();
 for(const id of listing.keys()){
  const detail=await json<Detail>(`/api/documents/${encodeURIComponent(id)}`);details.set(id,detail);
  const doc=detail.document;
  check(doc.id===id,'DOCUMENT_ID','Detail response must refer to the requested document.',id);
  check(doc.scope==='global','SCOPE','The current local library must expose only global documents.',id);
  const version=detail.versions.find(v=>v.id===doc.activeVersionId);
  check(Boolean(version),'CURRENT_VERSION','The current version must be present in version history.',id);
  check(version?.contentHash===doc.contentHash,'VERSION_HASH','Current-version hash and document hash must agree.',id);
  check(version?.versionNumber===doc.versionNumber,'VERSION_NUMBER','Current-version number must agree with version history.',id);
  check(detail.chunks.length===doc.chunkCount,'CHUNK_COUNT','Detail chunk count must agree with document metadata.',id);
  const orders=new Set<number>();
  for(const chunk of detail.chunks){
   check(chunk.documentId===id&&chunk.versionId===doc.activeVersionId,'CHUNK_PROVENANCE','Chunk must identify its document and current version.',id);
   check(Boolean(chunk.id)&&!orders.has(chunk.order),'CHUNK_ORDER','Chunk IDs must exist and ordering must be unique within a version.',id);orders.add(chunk.order);
   check(Boolean(chunk.text.trim()),'EMPTY_CHUNK','An indexed chunk must have source text.',id);
  }
  if(doc.status==='active')check(detail.chunks.length>0&&doc.parseStatus!=='failed','ACTIVE_PARSE','An active document must have successfully extracted chunks.',id);
  if(doc.status==='needs_review')check(doc.reviewReasons.length>0,'REVIEW_REASON','A review document must explain what needs confirmation.',id);
  if(!terminal.has(doc.status))warn('PROCESSING','Document is still processing; search and correction checks will be partial.',id);
  for(const [field,value]of Object.entries(doc.classification||{})){
   check(Number.isFinite(value.confidence)&&value.confidence>=0&&value.confidence<=1,'CONFIDENCE','Field confidence must be between zero and one.',id);
   check(['ai','rule','metadata','user'].includes(value.source),'CLASSIFICATION_SOURCE','Field provenance must be explicit.',id);
   if(value.source==='user'){report.summary.userFieldsChecked++;check(value.confidence===1,'USER_CONFIDENCE','A user-confirmed field must have confidence 1.',id);}
   if(field==='documentType')check(registries.documentTypes.some(r=>r.key===value.value),'TYPE_REGISTRY','Document type must exist in the registry.',id);
   if(field==='applications'||field==='topics')check(Array.isArray(value.value)&&value.value.every((v:string)=>registries[field].some(r=>r.key===v)),'TAG_REGISTRY','Application/topic tags must use registered canonical keys.',id);
  }
  // Audit snapshots include the full classification; only edits made after this
  // version's creation are applicable. Earlier versions intentionally reclassify.
  const edit=detail.audit.find(e=>e.action==='user_edit'&&version&&Date.parse(e.modifiedAt)>=Date.parse(version.createdAt));
  if(edit?.nextValue?.classification&&Date.parse(edit.modifiedAt)<=Date.parse(doc.updatedAt)){
   for(const [field,value]of Object.entries(edit.nextValue.classification))if(value?.source==='user'){
    const current=doc.classification?.[field as keyof Classification];
    check(current?.source==='user'&&equality(current.value,value.value),'USER_AUDIT_PRESERVATION','Current-version confirmed fields must retain their user provenance and confirmed values.',id);
   }
  }
  const rawUsage=detail.parsed?.metadata.llmUsage as {inputTokens?:unknown;outputTokens?:unknown}|undefined;
  const usage=rawUsage&&typeof rawUsage.inputTokens==='number'&&typeof rawUsage.outputTokens==='number'?{inputTokens:rawUsage.inputTokens,outputTokens:rawUsage.outputTokens}:undefined;
  if(usage){report.usage.documentsWithUsage++;report.usage.inputTokens+=usage.inputTokens;report.usage.outputTokens+=usage.outputTokens;}else report.usage.documentsWithoutUsage++;
  const extension=extname(doc.filename).toLowerCase()||'(none)';
  report.statusCounts[doc.status]=(report.statusCounts[doc.status]||0)+1;report.parseStatusCounts[doc.parseStatus]=(report.parseStatusCounts[doc.parseStatus]||0)+1;report.formatCounts[extension]=(report.formatCounts[extension]||0)+1;
  report.documents.push({id,extension,status:doc.status,versionId:doc.activeVersionId,versionNumber:doc.versionNumber,chunks:detail.chunks.length,parseStatus:doc.parseStatus,warnings:doc.parseWarnings.length,userFields:Object.entries(doc.classification||{}).filter(([,v])=>v.source==='user').map(([k])=>k),...usage?{usage}:{}});
  report.summary.chunks+=detail.chunks.length;
 }
 report.summary.documents=details.size;
 report.usage.totalTokens=report.usage.inputTokens+report.usage.outputTokens;

 const defaultIds=new Set<string>();
 const defaultSearch=await pages<SearchItem>('/api/search',{},items=>{
  for(const item of items){
   const id=item.document.id;defaultIds.add(id);
   check(item.document.status==='active','DEFAULT_SEARCH_STATUS','Default search must exclude review, failed, archived and processing documents.',id);
   check(item.chunk.documentId===id&&item.chunk.versionId===item.document.activeVersionId,'SEARCH_PROVENANCE','Search evidence must refer to the document current version.',id);
   check(Number.isFinite(item.score)&&item.score>=0,'SEARCH_SCORE','Search relevance must be a finite nonnegative number.',id);
  }
 });
 for(const detail of details.values())if(detail.document.status==='active')check(defaultIds.has(detail.document.id),'DEFAULT_SEARCH_RECALL','Every active document with chunks must occur in unfiltered default search.',detail.document.id);

 const filterKinds=['product','topic','source','application','documentType','authority'] as const;
 const readValues=(doc:DocumentRecord,kind:typeof filterKinds[number]):string[]=>{
  if(kind==='source')return[doc.sourceId];
  const key=kind==='product'?'products':kind==='topic'?'topics':kind==='application'?'applications':kind;
  const value=valueOf(doc,key);return Array.isArray(value)?value:typeof value==='string'?[value]:[];
 };
 for(const kind of filterKinds){
  const frequencies=new Map<string,number>();for(const detail of details.values())if(detail.document.status==='active')for(const value of readValues(detail.document,kind))frequencies.set(value,(frequencies.get(value)||0)+1);
  const sorted=[...frequencies].sort((a,b)=>b[1]-a[1]||a[0].localeCompare(b[0]));
  const selected=sorted.length<=filterLimit?sorted:[...sorted.slice(0,Math.max(0,filterLimit-1)),sorted[sorted.length-1]];
  for(const[value]of selected){
   let coherent=true;const matched=new Set<string>();
   const result=await pages<SearchItem>('/api/search',{[kind]:value},items=>{for(const item of items){matched.add(item.document.id);if(item.document.status!=='active'||!readValues(item.document,kind).includes(value))coherent=false;}});
   check(coherent,'SEARCH_FILTER',`${kind} filter must return matching active documents.`);
   for(const detail of details.values())if(detail.document.status==='active'&&readValues(detail.document,kind).includes(value))check(matched.has(detail.document.id),'FILTER_RECALL',`${kind} filter must include matching active documents.`,detail.document.id);
   report.filters.push({kind,valueHash:hash(value).slice(0,16),results:result.total,coherent});report.summary.filterChecks++;
  }
 }

 const candidateMap=new Map<string,string[]>();const frequencies=new Map<string,number>();
 for(const[id,detail]of details)if(detail.document.status==='active'){const words=candidates(detail);candidateMap.set(id,words);for(const word of words)frequencies.set(word,(frequencies.get(word)||0)+1);}
 for(const[id,detail]of details){
  let filenameFound=false;
  await pages<DocumentRecord>('/api/documents',{q:detail.document.filename},items=>{if(items.some(item=>item.id===id))filenameFound=true;});
  check(filenameFound,'FILENAME_SEARCH','Searching the exact filename must find the document.',id);report.summary.filenameChecks++;
  if(detail.document.status!=='active')continue;
  const term=candidateMap.get(id)?.sort((a,b)=>(frequencies.get(a)||0)-(frequencies.get(b)||0)||b.length-a.length)[0];
  if(!term){warn('NO_KEYWORD','No suitable source-text keyword was available for a meaningful keyword search.',id);continue;}
  let keywordFound=false;let sourceEvidence=false;
  await pages<SearchItem>('/api/search',{q:term},items=>{for(const item of items)if(item.document.id===id){keywordFound=true;if(item.chunk.text.normalize('NFKC').toLowerCase().includes(term.normalize('NFKC').toLowerCase()))sourceEvidence=true;}});
  check(keywordFound&&sourceEvidence,'KEYWORD_EVIDENCE','A source-text keyword must retrieve the expected document with matching chunk evidence.',id);report.summary.keywordChecks++;
 }

 // Greedy diversity sampling covers formats, states and sources while imposing
 // an absolute limit of eight distinct documents, regardless of library size.
 const pending=[...details.values()];const originals:Detail[]=[];const coverage=new Set<string>();
 while(originals.length<originalLimit&&pending.length){
  const tags=(detail:Detail)=>[`format:${extname(detail.document.filename).toLowerCase()}`,`state:${detail.document.status}`,`source:${detail.document.sourceId}`,`history:${detail.versions.length>1}`];
  pending.sort((a,b)=>tags(b).filter(t=>!coverage.has(t)).length-tags(a).filter(t=>!coverage.has(t)).length);
  const selected=pending.shift()!;originals.push(selected);for(const tag of tags(selected))coverage.add(tag);
 }
 for(const detail of originals){
  const current=detail.versions.find(v=>v.id===detail.document.activeVersionId)!;
  // Include one historical version where available, without selecting more files.
  const versions=[current,...detail.versions.filter(v=>v.id!==current.id).slice(0,1)];
  for(const version of versions){
   const fetched=await response(`/api/documents/${encodeURIComponent(detail.document.id)}/original?versionId=${encodeURIComponent(version.id)}`);
   const digest=createHash('sha256');let bytes=0;
   if(!fetched.body)throw new Error('Original download returned no body.');
   const reader=fetched.body.getReader();
   try{while(true){const part=await reader.read();if(part.done)break;digest.update(part.value);bytes+=part.value.length;}}finally{reader.releaseLock();}
   const matches=digest.digest('hex')===version.contentHash;
   check(matches,'ORIGINAL_HASH','Downloaded original bytes must match the recorded SHA256.',detail.document.id);
   report.originals.push({documentId:detail.document.id,versionId:version.id,bytes,matches});
  }
 }
 report.summary.originalDocumentsChecked=originals.length;report.summary.originalVersionsChecked=report.originals.length;

 try{
  const raw=JSON.parse(await readFile(baselinePath,'utf8')) as {items:DocumentRecord[]}|DocumentRecord[];
  const baseline=Array.isArray(raw)?raw:raw.items;
  if(!Array.isArray(baseline))throw new Error('Invalid baseline');
  report.summary.baselineDocuments=baseline.length;
  for(const before of baseline){
   const now=details.get(before.id)?.document;
   if(!now){report.baselineObservations.push({documentId:before.id,observation:'Document not present in this snapshot.'});continue;}
   if(before.activeVersionId!==now.activeVersionId){report.baselineObservations.push({documentId:before.id,observation:'Current version changed since baseline; previous confirmations intentionally do not carry into changed content.'});continue;}
   const changed=Object.entries(before.classification||{}).filter(([key,value])=>value.source==='user'&&!equality(value,now.classification?.[key as keyof Classification])).map(([key])=>key);
   if(changed.length)report.baselineObservations.push({documentId:before.id,observation:'User-confirmed fields differ from baseline; this may reflect a concurrent intentional edit.',fields:changed});
   else report.baselineObservations.push({documentId:before.id,observation:'Same version; baseline user-confirmed fields preserved.'});
  }
 }catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')warn('NO_BASELINE','No optional pre-expansion baseline was found.');else warn('BASELINE_FORMAT','The optional baseline could not be read.');}

 const finalListing=await listDocuments();report.statsAfter=await json<Stats>('/api/stats');
 const changedIds=new Set<string>();for(const[id,detail]of details){const latest=finalListing.get(id);if(!latest||latest.activeVersionId!==detail.document.activeVersionId||latest.updatedAt!==detail.document.updatedAt)changedIds.add(id);}
 report.stableSnapshot=report.statsBefore.processing===0&&report.statsAfter.processing===0&&listing.size===finalListing.size&&changedIds.size===0&&report.statsBefore.total===report.statsAfter.total;
 if(!report.stableSnapshot){
  warn('CHANGING_LIBRARY','The library changed or was processing during this read-only audit. Repeat after processing stops for a complete stable result.');
  // A moving document can legitimately move between pages or leave active search.
  const changedFailures=report.failures.filter(f=>f.documentId&&changedIds.has(f.documentId));
  report.failures=report.failures.filter(f=>!changedFailures.includes(f));
  for(const item of changedFailures)warn(`CONCURRENT_${item.code}`,`${item.message} Inconclusive because this document changed during the audit.`,item.documentId);
 }
 if(report.stableSnapshot){const activeChunkCount=[...details.values()].filter(d=>d.document.status==='active').reduce((sum,d)=>sum+d.chunks.length,0);check(defaultSearch.total===activeChunkCount,'SEARCH_CHUNK_TOTAL','Default search must contain exactly the current active-document chunks.');check(details.size===report.statsAfter.total,'DOCUMENT_TOTAL','Pagination must include every document in the stable snapshot.');}
}catch(error){fail('AUDIT_ERROR',error instanceof Error?error.message:'The read-only audit could not complete.');}
report.finishedAt=new Date().toISOString();report.summary.failures=report.failures.length;report.summary.warnings=report.warnings.length;
await mkdir(dirname(output),{recursive:true});await writeFile(output,JSON.stringify(report,null,2),{mode:0o600});
console.log(JSON.stringify({report:output,stableSnapshot:report.stableSnapshot,...report.summary,statuses:report.statusCounts,formats:report.formatCounts,usage:report.usage},null,2));
if(report.failures.length)process.exitCode=1;
