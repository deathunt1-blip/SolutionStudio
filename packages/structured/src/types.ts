import type { StructuredField, StructuredMapping, StructuredSourceData, StructuredSourcePreview } from '../../core/src/sources.js';

export interface StructuredSourceRef { sourceUrl:string; spreadsheetToken?:string; sheetId?:string; rowIndex:number }
export interface StructuredRecord { id:string;datasetId:string;rowIndex:number;values:Record<string,unknown>;sourceRef:StructuredSourceRef }
export interface StructuredFact { id:string;productKey:string;field:string;value:unknown;unit?:string;authority:'reference'|'authoritative';sourceDatasetId:string;sourceRecordId:string;sourceRef:StructuredSourceRef;updatedAt:string;datasetTitle?:string }
export interface StructuredFactChange { id:string;productKey:string;field:string;before:unknown;after:unknown;sourceRevision?:string;syncedAt:string;reason:string;sourceRecordId:string;sourceRef:StructuredSourceRef }
export interface StructuredDataset {
 id:string;sourceId:string;remoteId:string;title:string;summary:string;sourceType:string;
 status:'pending_mapping'|'active'|'removed';schema:StructuredField[];mapping:StructuredMapping|null;
 records:StructuredRecord[];preview:StructuredSourcePreview;version:number;remoteVersion?:string;modifiedAt?:string;
 contentHash:string;syncedAt:string;warnings:string[];provenance:Omit<StructuredSourceRef,'rowIndex'>&{metadata?:Record<string,unknown>};
 change?:'new'|'changed'|'unchanged';versions?:{version:number;sourceRevision?:string;syncedAt:string;reason:string;snapshot:unknown}[];factHistory?:StructuredFactChange[];
}
export interface MappingSuggestion extends StructuredSourcePreview { suggestedMapping:StructuredMapping;method:'rule'|'ai';usage?:{inputTokens:number;outputTokens:number} }
export type { StructuredField, StructuredMapping, StructuredSourceData, StructuredSourcePreview };
