import type {ProjectContext} from '../../projects/src/types.js';
import type {StructuredFact} from '../../structured/src/types.js';
import type {Claim,SourceRef} from './types.js';

export interface ClaimEvidenceProblem {quote:string;message:string;sourceRefs:SourceRef[]}
const normalize=(value:string)=>value.normalize('NFKC').trim().toLowerCase();
const standard=/标准|规范|规程|standard|(?:^|[\s《_])(?:GB(?:\/T)?|ISO|IEC|IEEE|EN|T\/)[\s\d/]/i;
const projectCommitment=/(?:本项目|本系统|本方案|本次)(?:[^。；]{0,25})(?:已支持|已实现|已配置|配置|配备|采用|选用|支持|具备|提供|达到)/;
const modelIn=(text:string,model:string)=>{
 const value=normalize(model);if(!value)return false;
 if(!/^[a-z\d ._/-]+$/i.test(value))return normalize(text).includes(value);
 return new RegExp(`(^|[^a-z0-9])${value.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')}(?![a-z0-9])`,'i').test(text);
};

/** Checks the role of the evidence explicitly cited by a model assertion.
 * It does not infer claims from ordinary prose or certify semantic entailment;
 * numeric/optical/protocol validation and project-specific review remain separate. */
export function claimEvidenceProblems(claims:Claim[],context:ProjectContext,sources:SourceRef[],facts:StructuredFact[]=(context as ProjectContext&{structuredFacts?:StructuredFact[]}).structuredFacts??[]):ClaimEvidenceProblem[]{
 const requirementIds=new Set([
  ...context.requirements.goals,...Object.values(context.requirements.performance),...context.requirements.interfaces,...context.requirements.protocols,
  ...context.requirements.environment,...context.requirements.installationConstraints,...context.requirements.specialRequirements,...context.requirements.acceptanceCriteria,
 ].filter(item=>!!item).map(item=>item!.id));
 const selected=new Set(context.products.map(normalize));
 const locked=context.lockedFacts.filter(fact=>fact.locked&&fact.sourceType!=='customer_requirement'&&!requirementIds.has(fact.id));
 const structured=facts.filter(fact=>fact.authority==='authoritative'&&selected.has(normalize(fact.productKey)));
 const problems:ClaimEvidenceProblem[]=[];
 for(const claim of claims){
  const explicitProjectPrinciple=claim.kind==='principle'&&projectCommitment.test(claim.text);
  if(!['capability','engineering'].includes(claim.kind??'')&&!explicitProjectPrinciple)continue;
  const factIds=new Set(claim.factIds.filter(id=>!requirementIds.has(id))),sourceIds=new Set(claim.sourceIds);
  const cited=sources.filter(source=>sourceIds.has(source.id));
  const currentFact=locked.some(fact=>factIds.has(fact.id)||cited.some(source=>source.id===fact.sourceRef.id&&source.labelKind==='fact'));
  const structuredFact=structured.some(fact=>factIds.has(fact.id)||sourceIds.has(fact.id));
  const productEvidence=cited.some(source=>source.type==='knowledge_chunk'&&source.use==='fact_evidence'&&source.authority==='authoritative'&&source.labelKind!=='requirement'&&!standard.test(source.label)&&context.products.some(model=>modelIn(source.label+'\n'+source.evidence,model)));
  if(currentFact||structuredFact||productEvidence)continue;
  problems.push({quote:claim.text,sourceRefs:cited,message:explicitProjectPrinciple
   ?'通用原理不能标为本项目已采用的配置或已具备的能力；请保留适用条件，或引用当前锁定事实及匹配产品依据。'
   :'本项目能力或工程配置断言未引用当前锁定事实、已选型号的权威参数或匹配产品依据；历史写作参考、标准要求及客户要求不能证明已具备该能力。'});
 }
 return problems;
}
