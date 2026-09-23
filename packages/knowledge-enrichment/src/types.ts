export const tagDimensions = ['document_type','applications','target_objects','scenarios','technical_topics','system_modules','products','project_stage','environment','constraints','deliverables'] as const;
export type TagDimension = typeof tagDimensions[number];
export type ReferenceQuality = 'normal'|'good'|'preferred';
export interface SoftTag {value:string;confidence:number}
export type SoftTags = Partial<Record<TagDimension,SoftTag[]>>;
export interface ProjectFingerprint {applications:string[];targetObjects:string[];scenarios:string[];topics:string[];modules:string[];products:string[];environment:string[];constraints:string[]}
export interface SectionBlueprint {purpose:string;recommendedStructure:string[];reusableTechnicalLogic:string[];expectedFacts:string[];projectSpecificElements:string[];writingNotes?:string}
export interface KnowledgeSection {
 id:string;documentId:string;versionId:string;title:string;headingPath:string[];level:number;text:string;summary:string;
 sectionRole:string;tags:string[];softTags:SoftTags;applications:string[];targetObjects:string[];scenarios:string[];topics:string[];modules:string[];products:string[];
 reusable:boolean;quality:ReferenceQuality;authority:string;blueprint:SectionBlueprint;order:number;
}
export interface HistoricalSectionReference {section:KnowledgeSection;documentTitle:string;score:number;use:'writing_reference'}
export interface SectionDraft {order:number;title:string;headingPath:string[];level:number;text:string}
export type AliasDimension = TagDimension|'unassigned';
export interface EnrichmentOutput {documentTags:SoftTags;sections:{order:number;summary:string;sectionRole:string;tags:SoftTags;reusable:boolean;blueprint:SectionBlueprint}[];aliases?:{dimension:AliasDimension;canonical:string;aliases:string[];confidence:number;reason:string}[];warnings?:string[]}
export interface EnrichmentBatch {
 id:string;status:'queued'|'running'|'completed'|'partially_failed'|'failed'|'cancelled';total:number;processed:number;failed:number;running:number;
 budgetCny:number|null;reservedCny:number;estimatedCostCny:number;inputTokens:number;outputTokens:number;model:string;createdAt:string;updatedAt:string;
}
export interface EnrichmentItem {id:string;documentId:string;versionId:string;documentTitle:string;status:string;sectionCount:number;error?:string;inputTokens:number;outputTokens:number}
export interface AliasSuggestion {id:string;dimension:AliasDimension;canonical:string;aliases:string[];confidence:number;reason:string;status:'pending'|'accepted'|'rejected'}
