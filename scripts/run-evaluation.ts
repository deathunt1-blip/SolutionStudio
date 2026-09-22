import 'dotenv/config';
import { cliOptions } from '../packages/evaluation/src/data.js';
import { runEvaluation } from '../packages/evaluation/src/runner.js';

const options=cliOptions(process.argv.slice(2));
if(options.has('help')) {
 console.log('Usage: npm run eval:run -- --manifest evaluation-data/manifest.json --labels evaluation-data/labels.json --context evaluation-data/context.json --output output/evaluation.json [--provider rules|kimi] [--budget-cny 5] [--limit 10] [--resume] [--examples with|without] [--isolate-evaluation true|false] [--repeat 3] [--temperature 0] [--model kimi-k2.6] [--max-tokens 3000] [--allow-unlabeled]');
 process.exit(0);
}
const allowed=new Set(['manifest','labels','context','output','provider','budget-cny','limit','resume','examples','isolate-evaluation','repeat','temperature','model','max-tokens','allow-unlabeled']);
for(const key of options.keys())if(!allowed.has(key))throw new Error(`不支持的参数：--${key}`);
const value=(key:string,fallback?:string)=>{
 const selected=options.get(key);
 if(typeof selected==='boolean')throw new Error(`--${key} 缺少参数值`);
 return selected??fallback;
};
const number=(key:string)=>options.has(key)?Number(value(key)):undefined;
const flag=(key:string,fallback=false)=>{
 const selected=options.get(key);if(selected===undefined)return fallback;
 if(selected===true||selected==='true')return true;if(selected==='false')return false;
 throw new Error(`--${key} 只接受 true 或 false`);
};
const provider=value('provider','rules');if(provider!=='rules'&&provider!=='kimi')throw new Error('--provider 只支持 rules 或 kimi');
const examples=value('examples','with');if(examples!=='with'&&examples!=='without')throw new Error('--examples 只支持 with 或 without');
const controller=new AbortController();
const interrupt=()=>{controller.abort();console.log('正在保存当前请求结果并停止；可使用相同参数加 --resume 恢复。');};
process.once('SIGINT',interrupt);process.once('SIGTERM',interrupt);
try {
 const run=await runEvaluation({manifest:value('manifest','evaluation-data/manifest.json')!,labels:value('labels','evaluation-data/labels.json')!,context:value('context','evaluation-data/context.json')!,output:value('output','output/evaluation-phase01.json')!,provider,examples,resume:flag('resume'),allowUnlabeled:flag('allow-unlabeled'),isolateEvaluation:flag('isolate-evaluation',true),budgetCny:number('budget-cny'),limit:number('limit'),repeat:number('repeat'),temperature:number('temperature'),maxTokens:number('max-tokens'),model:value('model'),signal:controller.signal},{onProgress:(current,result)=>console.log(`[${current.documents.length}/${current.plannedResults}] ${result.documentId} #${result.repetition}: ${result.finalStatus}; 预算预留 ¥${current.reservedCostCny.toFixed(4)}`)});
 console.log(`评测状态：${run.status}；完成 ${run.documents.length}/${run.plannedResults}。${run.provider==='rules'?'本次仅运行离线规则，不消耗 API token。':''}`);
 if(run.status!=='completed')process.exitCode=2;
} catch(error) {
 console.error(error instanceof Error?error.message:'评测失败');process.exitCode=1;
} finally {process.removeListener('SIGINT',interrupt);process.removeListener('SIGTERM',interrupt);}
