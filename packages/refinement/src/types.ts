import type { Classification, DocumentRecord, LLMProvider, ParsedDocument, Registries } from '../../core/src/types.js';

export type RefinementField = 'title'|'summary'|'document_type'|'authority'|'applications'|'topics'|'products';
export type RefinementOperation = 'title'|'summary'|'classification'|'tags';
export interface CorpusDocumentCard {
 id:string; title:string; summary:string; documentType?:string; authority?:string;
 applications:string[]; topics:string[]; products:string[]; userConfirmed:boolean;
 sourceType:string; sourcePath?:string; contentHash?:string; versionId?:string; groups?:string[];
 confidence?:number; confirmedFields?:Partial<Classification>;
}
export interface SimilarDocument { document:CorpusDocumentCard; score:number; strength:'strong'|'weak'; weight:number }
export interface DocumentSimilarityProvider { findSimilar(document:CorpusDocumentCard,limit:number):Promise<SimilarDocument[]> }
export interface CorpusContext { similar:SimilarDocument[]; confirmed:CorpusDocumentCard[]; distribution:Record<string,number>; groups:Array<{id:string;name:string;documentCount:number}> }
export interface RefinementSuggestion { field:RefinementField; proposedValue:unknown; confidence:number; reasoning:string; evidence:string[] }
export interface RefinementOutput { suggestions:RefinementSuggestion[]; warnings:string[]; usage?:{inputTokens:number;outputTokens:number}; promptBytes:number;error?:string }
export interface RefinementInput { document:DocumentRecord; parsed:ParsedDocument; registries:Registries; context:CorpusContext; operations:RefinementOperation[]; includeUserFields?:boolean; includeUserTitles?:boolean }
export interface RefinementProposal extends RefinementSuggestion { id:string;batchId:string;documentId:string;versionId:string;currentValue:unknown;status:'pending'|'accepted'|'rejected'|'stale';locked:boolean;documentTitle?:string;filename?:string;acceptedValue?:unknown }
export interface RefinementBatch { id:string;status:'queued'|'running'|'completed'|'partially_failed'|'failed'|'applied'|'rolled_back';operations:RefinementOperation[];documentIds:string[];includeUserFields:boolean;includeUserTitles:boolean;total:number;processed:number;failed:number;unchanged:number;budgetCny:number;reservedCny:number;estimatedCostCny:number;inputTokens:number;outputTokens:number;createdAt:string;updatedAt:string;errors:Array<{documentId:string;message:string}>;warnings?:Array<{documentId:string;message:string}> }
export interface KnowledgeGroup { id:string;name:string;description:string;documentCount:number;createdAt?:string }
export type TaxonomyKind='group'|'topic_merge'|'entity_alias'|'possible_version'|'outlier'|'title_anomaly'|'classification_anomaly';
export interface CorpusSuggestion { kind:TaxonomyKind;name:string;description:string;documentIds:string[];canonical?:string;aliases?:string[];confidence:number;evidence?:string[] }
export interface TaxonomyProposal extends CorpusSuggestion { id:string;analysisId:string;status:'pending'|'accepted'|'rejected'|'stale';createdAt:string }
export interface CorpusAnalysisOutput { suggestions:CorpusSuggestion[];warnings:string[];usage?:{inputTokens:number;outputTokens:number};promptBytes:number;error?:string }
export interface RefinementEngine { refine(input:RefinementInput,provider:LLMProvider):Promise<RefinementOutput>; analyze(cards:CorpusDocumentCard[],registries:Registries,provider:LLMProvider):Promise<CorpusAnalysisOutput> }
