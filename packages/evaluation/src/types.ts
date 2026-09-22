import type { Authority, Classification, ConfirmedExample, Registries } from '../../core/src/types.js';

export interface EvaluationDocument { id:string; path:string; filename:string; contentHash:string; sourceDocumentId?:string }
export interface EvaluationManifest { schemaVersion:1; datasetId:string; createdAt:string; documents:EvaluationDocument[] }
export interface EvaluationLabel {
 documentId:string; contentHash:string; filename:string; documentType:string; authority:Authority;
 applications?:string[]; topics?:string[]; products?:string[]; notes?:string;
 labeledBy:string; labeledAt:string; origin:'human';
}
export interface EvaluationLabels { schemaVersion:1; datasetId:string; labels:EvaluationLabel[] }
export interface EvaluationExample extends ConfirmedExample { contentHashes:string[] }
export interface EvaluationContext { schemaVersion:1; createdAt:string; registries:Registries; examples:EvaluationExample[]; thresholds:{review:number;autoAccept:number} }
export interface EvaluationResult {
 documentId:string; filename:string; contentHash:string; repetition:number;
 parseStatus:'success'|'partial'|'failed'; parseWarnings:string[];
 expected?:EvaluationLabel; predicted?:Classification; finalStatus:'active'|'needs_review'|'failed';
 autoAccepted:boolean; reviewReasons:string[]; warnings:string[];
 usedConfirmedExamples:string[]; fingerprint?:string; prompt?:string; systemPrompt?:string;
 ruleDecision?:Classification; aiDecision?:unknown; evidence?:string[];
 timings:{parseMs:number;classifyMs:number;totalMs:number};
 usage?:{inputTokens:number;outputTokens:number}; estimatedCostCny?:number;
 productGrounding?:{predicted:string[];ungrounded:string[]}; error?:string;
}
export interface EvaluationRun {
 schemaVersion:1; id:string; datasetId:string; createdAt:string; updatedAt:string;
 status:'running'|'completed'|'budget_stopped'|'interrupted';
 provider:'kimi'|'rules'|'synthetic'; model:string; temperature:number; maxTokens:number;
 classificationVersion:string; classificationPromptVersion:string; classificationRuleVersion:string;
 thresholds:{review:number;autoAccept:number}; gatePolicy:'production-review-threshold';
 examplesMode:'with'|'without'; isolateEvaluation:boolean; repeat:number;
 manifestHash:string; labelsHash:string; contextHash:string; configurationHash:string;
 codeHash?:string;
 reservations?:Array<{documentId:string;repetition:number;reservedCny:number;startedAt:string;completedAt?:string}>;
 budgetCny:number; reservedCostCny:number;
 prices:{inputPerMillionCny:number;outputPerMillionCny:number};
 plannedDocuments:number; plannedResults:number; documents:EvaluationResult[];
 metrics?:unknown;
}
