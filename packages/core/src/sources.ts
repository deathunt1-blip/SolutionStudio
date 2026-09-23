import type { SourceFile } from './types.js';

/** Provider-neutral boundary used by sync and structured ingestion. */
export interface RemoteResource {
 id:string; title:string; kind:'document'|'dataset'|'unsupported'; objectType:string;
 remoteToken:string; remoteUrl:string; remoteVersion?:string; modifiedAt?:string; path:string[];
 metadata?:Record<string,unknown>;
}
export interface SourceListing { items:RemoteResource[]; complete:boolean; errors:{resourceId?:string;message:string}[] }
export interface StructuredSourceData {
 remoteId:string; title:string; sourceUrl:string; version?:string; modifiedAt?:string;
 rows:unknown[][]; sheetId?:string; spreadsheetToken?:string;
 metadata?:Record<string,unknown>;
}
export interface RemoteSourceAdapter {
 type:string;
 test(config:Record<string,unknown>):Promise<{title:string}>;
 list(config:Record<string,unknown>):Promise<SourceListing>;
 fetchDocument(resource:RemoteResource,config:Record<string,unknown>):Promise<SourceFile>;
 fetchDataset(resource:RemoteResource,config:Record<string,unknown>):Promise<StructuredSourceData>;
}
export type StructuredSemanticType='identifier'|'name'|'number'|'text'|'enum'|'url'|'date'|'unknown';
export interface StructuredField { key:string;sourceHeader:string;canonicalName?:string;semanticType:StructuredSemanticType;unit?:string;confidence?:number }
export interface StructuredMapping { headerRow:number;productKey?:string;productName?:string;isProductTable:boolean;authority:'reference'|'authoritative';fields:StructuredField[] }
export interface StructuredSourcePreview { title:string;summary:string;fields:StructuredField[];sampleRows:Record<string,unknown>[];rowCount:number;headerRow:number;suggestedProductKey?:string;suggestedProductName?:string;warnings:string[] }
export interface StructuredSourceAdapter {type:string;inspect(config:Record<string,unknown>):Promise<StructuredSourcePreview>;fetchDataset(config:Record<string,unknown>):Promise<StructuredSourceData>}
