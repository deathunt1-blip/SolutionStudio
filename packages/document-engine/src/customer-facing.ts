import {randomUUID} from 'node:crypto';
import type {DocumentBlock,SourceRef,ValidationIssue} from './types.js';

export function customerText(block:DocumentBlock):string {
 if(block.type==='list')return block.items.join('\n');
 if(block.type==='table')return [block.title,...block.columns,...block.rows.flat()].join('\n');
 if(block.type==='asset')return block.caption??'';
 if(block.type==='diagram')return `${block.caption??''}\n${block.source}`;
 return block.type==='callout'?block.text:block.runs?.map(r=>r.text).join('')||block.text;
}

/** Customer prose is validated independently of source/claim checking. Nothing is silently deleted. */
export function customerFacingProblems(blocks:DocumentBlock[],sources:SourceRef[]=[]):{blockId:string;message:string;quote:string}[]{
 const problems:{blockId:string;message:string;quote:string}[]=[];
 const internal=/engineeringOpticsSource|engineering\.opticsSource|lockedFacts|ContextSnapshot|EvidenceRef|SectionBrief|SectionReferenceBundle|sourceInputId|used_knowledge_refs|知识库|检索(?:结果|片段|命中)|参考历史方案|内部(?:工程口径|校验|审查)|(?:待确认|尚未明确|尚未提供|资料未(?:给|提供)|需补充|不构成承诺|相关输入尚未提供)/gi;
 const names=sources.filter(s=>!['fact','requirement'].includes(s.labelKind??'')&&(s.type==='knowledge_chunk'||s.type==='knowledge_section'||s.type==='project_input')).flatMap(s=>[s.label,...(s.type==='knowledge_section'?s.label.split(' · ').slice(0,1):[])]).filter(label=>label.length>=8&&!/标准|规范|规程|\b(?:ISO|IEC|IEEE|GB)\b/i.test(label));
 for(const block of blocks){const value=customerText(block),matches=[...value.matchAll(internal)].map(m=>m[0]);const namesFound=names.filter(name=>value.includes(name));
  if(matches.length||namesFound.length)problems.push({blockId:block.id,message:`客户正文含内部工作语言或来源名称：${[...new Set([...matches,...namesFound])].join('、')}`,quote:value.slice(0,500)});
 }
 return problems;
}
export function customerFacingIssues(sectionId:string,blocks:DocumentBlock[],sources:SourceRef[]):ValidationIssue[]{return customerFacingProblems(blocks,sources).map(p=>({id:randomUUID(),sectionId,...p,severity:'error',type:'customer_facing',sourceRefs:[]}));}
