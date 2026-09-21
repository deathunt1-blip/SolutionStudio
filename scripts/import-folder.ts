import 'dotenv/config';
import { resolve, extname } from 'node:path';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { LocalFolderAdapter } from '../packages/source-adapters/src/index.js';
import type { SourceDocumentMeta } from '../packages/core/src/types.js';

const args = process.argv.slice(2);
const option = (name:string, fallback:string) => { const i=args.indexOf(name); return i<0 ? fallback : args[i+1] ?? fallback; };
const root = args.find(arg => !arg.startsWith('--'));
if (!root || root === 'help') {
  console.log('Usage: npm run import:folder -- <folder> [--limit 60] [--url http://127.0.0.1:4310] [--sample] [--dry-run] [--manifest file.json]');
  process.exit(0);
}
const endpoint = option('--url','http://127.0.0.1:4310');
const budget = args.includes('--budget-cny') ? Number(option('--budget-cny','10')) : undefined;
async function balance() {
  const base=process.env.LLM_BASE_URL || 'https://api.moonshot.cn/v1';
  if(base!=='https://api.moonshot.cn/v1' || process.env.LLM_MODEL!=='kimi-k2.6') throw new Error('Budget guard requires Moonshot CN kimi-k2.6 config (CNY billing).');
  const response=await fetch(`${base}/users/me/balance`,{headers:{Authorization:`Bearer ${process.env.LLM_API_KEY || ''}`},signal:AbortSignal.timeout(15000)});
  const result=await response.json() as {data?:{available_balance:number}};
  if(!response.ok || !Number.isFinite(result.data?.available_balance)) throw new Error('Cannot verify balance; stopped before next upload.');
  return result.data!.available_balance;
}
async function waitForDocument(id:string) {
  const deadline=Date.now()+240000;
  while(Date.now()<deadline) {
    const response=await fetch(`${endpoint}/api/documents/${id}`);if(!response.ok) throw new Error('Cannot verify ingestion status; stopped.');
    const body=await response.json() as {document:{status:string}};
    if(['active','needs_review','failed','archived'].includes(body.document.status)) return body.document.status;
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
const report = { at:new Date().toISOString(), available:listed.length, selected:selected.map(item=>item.sourceId), spentCny:0, results:[] as unknown[] };
await mkdir('output',{recursive:true});
await writeFile('output/import-manifest.json',JSON.stringify(report.selected,null,2));
console.log(JSON.stringify({available:listed.length,selected:selected.length,formats:[...new Set(selected.map(item=>extname(item.filename)))]}));
if(args.includes('--dry-run')) { console.log('Manifest saved locally to output/import-manifest.json'); process.exit(0); }
const initialBalance=budget===undefined ? undefined : await balance();
if(budget!==undefined) {
  if(!Number.isFinite(budget) || budget<2) throw new Error('Budget must be at least CNY 2 for conservative reserve.');
  const settings=await (await fetch(`${endpoint}/api/settings`)).json() as {llm:{model:string;maxTokens:number;baseUrl:string}};
  if(settings.llm.model!=='kimi-k2.6' || settings.llm.maxTokens>3000 || settings.llm.baseUrl!=='https://api.moonshot.cn/v1') throw new Error('Server model config differs from budget guard.');
  const stats=await (await fetch(`${endpoint}/api/stats`)).json() as {processing:number};
  if(stats.processing) throw new Error('Wait for existing jobs before budgeted import.');
}
for(const item of selected) {
  if(budget!==undefined) {
    report.spentCny=Math.max(0,initialBalance!-await balance());
    // Keep CNY 2 reserve; account balance also reflects unrelated concurrent requests.
    if(report.spentCny+2>budget) { console.log('Budget reserve reached; remaining files were not uploaded.'); break; }
  }
  const file=await adapter.fetchDocument(item.sourceId,{root:resolve(root)});
  const form=new FormData();
  // Set metadata before file; Fastify parses multipart sequentially.
  form.append('sourceId','local-import'); form.append('sourcePath',item.sourcePath ?? item.sourceId);
  form.append('files',new Blob([Buffer.from(file.buffer)]),item.filename);
  const response=await fetch(`${endpoint}/api/upload`,{method:'POST',body:form,signal:AbortSignal.timeout(120000)});
  if(!response.ok) { report.results.push({filename:item.filename,error:await response.text()}); console.log(`Upload failed (${response.status})`); }
  else {
    const result=await response.json() as {results:{status:string;documentId?:string}[]};report.results.push(result);
    if(budget!==undefined) for(const entry of result.results) if(entry.status==='queued' && entry.documentId) await waitForDocument(entry.documentId);
    if(budget!==undefined) report.spentCny=Math.max(0,initialBalance!-await balance());
    console.log(`[${report.results.length}/${selected.length}] ${budget===undefined?'queued':`processed; spent CNY ${report.spentCny.toFixed(4)}`}`);
  }
  await writeFile('output/import-report.json',JSON.stringify(report,null,2));
}
console.log('Uploads complete. Check Inbox for processing/review status. Local report: output/import-report.json');
