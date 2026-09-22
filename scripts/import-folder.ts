import { resolve, extname, dirname } from 'node:path';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { LocalFolderAdapter } from '../packages/source-adapters/src/index.js';
import type { SourceDocumentMeta } from '../packages/core/src/types.js';

const args = process.argv.slice(2);
const option = (name:string, fallback:string) => { const i=args.indexOf(name); return i<0 ? fallback : args[i+1] ?? fallback; };
const root = args.find(arg => !arg.startsWith('--'));
if (!root || root === 'help') {
  console.log('Usage: npm run import:folder -- <folder> [--limit 60] [--url http://127.0.0.1:4310] [--sample] [--dry-run] [--manifest file.json] [--budget-cny 10] [--report output/import-report.json]');
  process.exit(0);
}
const endpoint = option('--url','http://127.0.0.1:4310');
const budget = args.includes('--budget-cny') ? Number(option('--budget-cny','10')) : undefined;
// Provider allows at most three attempts, prompt <7,900 tokens, output <=3,000.
// Reserve the full worst-case cost before every new document, including retries.
// An account balance cannot attribute spend when colleagues share the account.
const documentCostCeiling=3*(7900*6.5+3000*27)/1000000;
if(budget!==undefined && (!Number.isFinite(budget) || budget<documentCostCeiling)) throw new Error('Budget must cover one conservative document reservation (CNY 0.39705).');
const reportPath=option('--report','output/import-report.json');
type CompletedDocument={document:{id:string;status:string;parseStatus:string;reviewReasons:string[]};parsed?:{metadata?:{llmUsage?:{inputTokens:number;outputTokens:number}}}};
async function waitForDocument(id:string) {
  const deadline=Date.now()+240000;
  while(Date.now()<deadline) {
    const response=await fetch(`${endpoint}/api/documents/${id}`);if(!response.ok) throw new Error('Cannot verify ingestion status; stopped.');
    const body=await response.json() as CompletedDocument;
    if(['active','needs_review','failed','archived'].includes(body.document.status)) return body;
    await new Promise(resolve=>setTimeout(resolve,1500));
  }
  throw new Error('Ingestion timeout; stopped before adding more jobs.');
}
const limit = Math.max(1, Number(option('--limit','60')));
const adapter = new LocalFolderAdapter();
const listed = (await adapter.listDocuments({root:resolve(root)})).filter(file => Number(file.metadata?.bytes) <= 40*1024*1024 && Number(file.metadata?.bytes)>0);
// Round-robin categories gives genuine historical material broader coverage than first-N.
const categories:[string,RegExp][] = [['product',/产品|规格|参数/],['solution',/方案/],['test',/测试|test/i],['acceptance',/验收/],['manual',/说明|手册|操作|SDK|教程|文档/i],['standard',/标准|规范/],['misc',/./]];
let selected: SourceDocumentMeta[];
if (args.includes('--manifest')) {
  const names = JSON.parse(await readFile(option('--manifest',''), 'utf8')) as string[];
  selected = names.map(name => listed.find(file=>file.sourceId===name)).filter((v):v is SourceDocumentMeta=>!!v).slice(0,limit);
} else if (args.includes('--sample')) {
  const buckets = categories.map(()=>[] as SourceDocumentMeta[]);
  for (const item of listed.sort((a,b)=>a.sourceId.localeCompare(b.sourceId,'zh'))) {
    buckets[categories.findIndex(([,pattern])=>pattern.test(item.sourceId))].push(item);
  }
  selected=[];
  for(let round=0;selected.length<limit && buckets.some(b=>b.length);round++) {
    for(const bucket of buckets) { const item=bucket.shift(); if(item && selected.length<limit) selected.push(item); }
  }
  // Make sure every available supported extension is exercised.
  for (const extension of ['.xls','.xlsx','.md','.txt','.pdf','.docx','.csv']) {
    if (!selected.some(item=>extname(item.filename).toLowerCase()===extension)) {
      const candidate=listed.find(item=>extname(item.filename).toLowerCase()===extension);
      if(candidate) {
        let index=selected.length-1;
        while(index>=0 && selected.filter(other=>extname(other.filename).toLowerCase()===extname(selected[index].filename).toLowerCase()).length<2) index--;
        if(index>=0) selected.splice(index,1,candidate);
      }
    }
  }
} else selected=listed.slice(0,limit);
const report = { at:new Date().toISOString(), available:listed.length, selected:selected.map(item=>item.sourceId), budgetUpperBoundCny:0, inputTokens:0, outputTokens:0, estimatedCny:0, results:[] as unknown[] };
await mkdir('output',{recursive:true});
await mkdir(dirname(resolve(reportPath)),{recursive:true});
await writeFile('output/import-manifest.json',JSON.stringify(report.selected,null,2));
console.log(JSON.stringify({available:listed.length,selected:selected.length,formats:[...new Set(selected.map(item=>extname(item.filename)))]}));
if(args.includes('--dry-run')) { console.log('Manifest saved locally to output/import-manifest.json'); process.exit(0); }
if(budget!==undefined) {
  const settings=await (await fetch(`${endpoint}/api/settings`)).json() as {llm:{model:string;maxTokens:number;baseUrl:string;configured:boolean}};
  if(!settings.llm.configured || settings.llm.model!=='kimi-k2.6' || settings.llm.maxTokens>3000 || settings.llm.baseUrl!=='https://api.moonshot.cn/v1') throw new Error('Server model config differs from budget guard or model is disabled.');
  const stats=await (await fetch(`${endpoint}/api/stats`)).json() as {processing:number};
  if(stats.processing) throw new Error('Wait for existing jobs before budgeted import.');
}
for(const item of selected) {
  if(budget!==undefined) {
    if(report.budgetUpperBoundCny+documentCostCeiling>budget) { console.log('Conservative token budget reached; remaining files were not uploaded.'); break; }
  }
  const file=await adapter.fetchDocument(item.sourceId,{root:resolve(root)});
  const form=new FormData();
  // Set metadata before file; Fastify parses multipart sequentially.
  form.append('sourceId','local-import'); form.append('sourcePath',item.sourcePath ?? item.sourceId);
  form.append('files',new Blob([Buffer.from(file.buffer)]),item.filename);
  const response=await fetch(`${endpoint}/api/upload`,{method:'POST',body:form,signal:AbortSignal.timeout(120000)});
  if(!response.ok) { report.results.push({filename:item.filename,error:await response.text()}); console.log(`Upload failed (${response.status})`); }
  else {
    const result=await response.json() as {results:{status:string;documentId?:string;finalStatus?:string;usage?:{inputTokens:number;outputTokens:number}}[]};report.results.push(result);
    if(budget!==undefined) report.budgetUpperBoundCny+=result.results.filter(entry=>entry.status==='queued').length*documentCostCeiling;
    // Persist the queued ID before waiting, so an interrupted run remains auditable.
    await writeFile(reportPath,JSON.stringify(report,null,2));
    if(budget!==undefined) for(const entry of result.results) if(entry.status==='queued' && entry.documentId) {
      const completed=await waitForDocument(entry.documentId);
      entry.finalStatus=completed.document.status;
      const usage=completed.parsed?.metadata?.llmUsage;
      if(usage) { entry.usage=usage;report.inputTokens+=usage.inputTokens;report.outputTokens+=usage.outputTokens; }
    }
    report.estimatedCny=(report.inputTokens*6.5+report.outputTokens*27)/1000000;
    console.log(`[${report.results.length}/${selected.length}] ${budget===undefined?'queued':`${result.results.map(entry=>entry.finalStatus||entry.status).join(',')}; estimated CNY ${report.estimatedCny.toFixed(4)}; conservative reservation ${report.budgetUpperBoundCny.toFixed(4)}`}`);
  }
  await writeFile(reportPath,JSON.stringify(report,null,2));
}
await writeFile(reportPath,JSON.stringify(report,null,2));
console.log(`Uploads complete. Check Inbox for processing/review status. Local report: ${reportPath}`);
