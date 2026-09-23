export interface SourceRef { type:'project_input'|'engineering_data'|'structured_fact'|'knowledge_chunk'|'user'; id:string; label:string; evidence:string; versionId?:string; authority?:string;documentId?:string;inputId?:string }
export interface TextRun { text:string; bold?:boolean }
export type DocumentBlock =
 | {id:string;type:'paragraph'|'heading';text:string;runs?:TextRun[];level?:number}
 | {id:string;type:'list';items:string[];ordered?:boolean}
 | {id:string;type:'table';title:string;columns:string[];rows:string[][];sourceRefs:SourceRef[];generated?:boolean}
 | {id:string;type:'asset';assetId:string;caption:string;role?:string};
export interface DocumentTemplateSection {id:string;title:string;level:number;order:number;generationMode:'fixed'|'ai'|'mixed'|'table'|'asset';requiredContext:string[];retrievalPolicy?:{query:string;authority?:string;limit?:number};generationInstruction?:string;fixedContent?:string;condition?:'engineering';assetRoles?:string[];tableKind?:'requirements'|'equipment'|'products'|'engineering';validationRules?:string[]}
export interface DocumentTemplate {id:string;name:string;version:number;documentType:string;sections:DocumentTemplateSection[]}
export interface DocumentSection extends DocumentTemplateSection {status:'empty'|'queued'|'generating'|'generated'|'edited'|'validated'|'failed';blocks:DocumentBlock[];sourceRefs:SourceRef[];assetRefs:string[];lockedFactRefs:string[];claims:Claim[];revision:number;edited:boolean;error?:string;contextTokens?:number}
export interface Claim {text:string;factIds:string[];sourceIds:string[];kind?:'requirement'|'capability'|'engineering'}
export interface OutputProfile {companyName:string;fontFamily:string;fontSize:number;titleFontFamily:string;pageMarginMm:number;header:string;footer:string;coverLogoAssetId?:string}
export interface GeneratedDocument {id:string;projectId:string;projectName:string;customerName:string;title:string;documentType:string;templateId:string;templateVersion:number;contextRevision:number;revision:number;status:string;sections:DocumentSection[];outputProfile:OutputProfile;createdAt:string;updatedAt:string;issues:ValidationIssue[];contextStale?:boolean}
export interface ValidationIssue {id:string;sectionId:string;blockId?:string;severity:'error'|'warning';type:'fact_mismatch'|'unsupported_claim'|'requirement_conflict'|'missing_source'|'stale_context'|'incomplete';message:string;quote?:string;sourceRefs:SourceRef[]}
export interface GenerationConfig {model:string;temperature:number;maxTokens:number;maxContextTokens:number;budgetCny:number;limitsEnabled?:boolean;reasoningEffort?:'low'|'high'|'max'}
export interface GenerationJob {id:string;documentId:string;status:'queued'|'running'|'completed'|'partially_failed'|'failed'|'budget_exhausted'|'interrupted';sectionIds:string[];processed:number;failed:number;config:GenerationConfig;reservedCny:number;estimatedCostCny:number;inputTokens:number;outputTokens:number;errors:{sectionId:string;message:string}[];createdAt:string;updatedAt:string}
export type GenerationMode='regenerate'|'shorten'|'expand'|'formal'|'technical'|'rewrite';
export const defaultOutputProfile:OutputProfile={companyName:'上海青瞳视觉科技有限公司',fontFamily:'宋体',fontSize:11,titleFontFamily:'黑体',pageMarginMm:25,header:'技术方案',footer:'',};
