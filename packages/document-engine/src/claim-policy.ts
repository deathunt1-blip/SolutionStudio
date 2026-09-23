import type {DocumentBlock} from './types.js';
import {customerText} from './customer-facing.js';

export interface HighRiskClaimProblem {blockId:string;message:string;quote:string}

// These narrow rules cover explicit technical overclaims, not arbitrary natural-language
// doNotClaim constraints. Source review remains necessary for project-specific promises.
const negated=/(?:不能|无法|不会|不应|不可|不保证|不代表|不构成|不等同|不等于|不是|并非|不意味|不视为|不作为|不称为|不将|不把|不宣称|不承诺|尚未|未达到|未实现|难以|避免(?:将|把|承诺|宣称))/;
const objective=/^(?:(?:客户|用户|项目|本项目)\s*)?(?:提出的?\s*)?(?:要求|期望|希望|目标|设计目标|研究目标|拟研究|假设|假如|例如|举例|若(?:客户|用户)?要求)/;
const comparison=/(?:与|和).{0,35}(?:真实测量|实测|测量真值).{0,12}(?:比较|比对|对比|核对|校核|误差|区分|分别|分开)|(?:比较|比对|对比|核对|区分).{0,35}(?:真实测量|实测|测量真值)/;

export function highRiskClaimProblems(blocks:DocumentBlock[]):HighRiskClaimProblem[]{
 const problems:HighRiskClaimProblem[]=[];
 for(const block of blocks){
  for(const sentence of customerText(block).split(/[。！？\n；;]+/)){
   const clauses=sentence.split(/[，,]|但是|然而|不过/).map(value=>value.trim()).filter(Boolean);
   for(const [index,clause] of clauses.entries()){
    if(objective.test(clause))continue;
    // Continuation clauses may refer back to the prediction output in the preceding clause.
    const preceding=clauses[index-1]??'',subject=/(?:该|这些|上述|其|此)(?:数据|结果|输出|轨迹|估计)/.test(clause)?preceding+'，'+clause:clause;
    let message:string|undefined;
    if(/预测|插值|补全|补点/.test(subject)&&/(?:无损(?:真实)?(?:测量|实测|还原|恢复)?|真实(?:测量|实测|采集)|测量真值|实测结果)/.test(clause)&&!comparison.test(clause))message='预测、插值或补全结果不能宣称为无损还原或真实实测数据。';
    else if(/同步|同一时基|时间对齐/.test(clause)&&/(?:零(?:误差|偏差|时差)|绝对同步|完全无(?:误差|偏差)|不存在(?:任何)?(?:同步)?(?:误差|偏差))/.test(clause))message='同步设计不能作零误差或绝对同步的无依据承诺。';
    else if(/(?:任意|任何|全部|全|完全|彻底|所有).{0,12}遮挡|遮挡.{0,12}(?:任意|任何|完全|全部)/.test(clause)&&/(?:不(?:会)?受(?:到)?.{0,8}影响|不(?:会)?影响|无影响|毫无影响|零误差|无(?:精度)?损失|(?:精度|性能|准确率|测量结果).{0,8}(?:不变|不降低)|(?:保证|确保).{0,15}(?:稳定|准确|精确|可靠))/.test(clause))message='不能承诺任意或完全遮挡时测量性能不受影响。';
    // "不会受完全遮挡影响" is an absolute promise, not a disclaimer.
    const disclaimer=message?.startsWith('不能承诺')?/(?:不保证|不能保证|无法保证|不承诺|不能承诺|不应|不可|不代表|并非|不是|避免(?:承诺|宣称)|未证明)/.test(clause):negated.test(clause);
    if(message&&!disclaimer)problems.push({blockId:block.id,message,quote:clause});
   }
  }
 }
 return problems;
}
