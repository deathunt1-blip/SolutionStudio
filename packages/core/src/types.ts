export type Authority = 'authoritative' | 'reference' | 'style_only' | 'unknown';
export type DocumentStatus = 'discovered' | 'uploaded' | 'parsing' | 'parsed' | 'classifying' | 'needs_review' | 'indexing' | 'active' | 'superseded' | 'archived' | 'failed';
export interface ClassifiedValue<T> { value: T; confidence: number; source: 'ai'|'rule'|'user'|'metadata'; reasoning?: string }
export interface Classification {
 documentType: ClassifiedValue<string>; applications: ClassifiedValue<string[]>; topics: ClassifiedValue<string[]>; products: ClassifiedValue<string[]>;
 authority: ClassifiedValue<Authority>; language: ClassifiedValue<string>; documentDate?: ClassifiedValue<string|null>; version?: ClassifiedValue<string|null>;
}
export interface ParsedBlock { type: 'heading'|'paragraph'|'table'; text: string; level?: number; page?: number; headingPath?: string[] }
export interface ParsedTable { title?: string; rows: string[][] }
export interface ParsedDocument { title?: string; plainText: string; blocks: ParsedBlock[]; tables: ParsedTable[]; metadata: Record<string,unknown>; parseWarnings: string[]; parseStatus: 'success'|'partial'|'failed' }
export interface SourceDocumentMeta { sourceId: string; sourceType: string; filename: string; mimeType?: string; sourceUri?: string; sourcePath?: string; version?: string; modifiedAt?: string; metadata?: Record<string,unknown> }
export interface SourceFile { meta: SourceDocumentMeta; buffer: Uint8Array; contentHash: string }
export interface KnowledgeSourceAdapter { type: string; listDocuments?(config:Record<string,unknown>):Promise<SourceDocumentMeta[]>; fetchDocument(id:string,config?:Record<string,unknown>):Promise<SourceFile>; getVersion?(id:string):Promise<string|null> }
export interface DocumentParser { type:string; supports(meta:SourceDocumentMeta):boolean; parse(file:SourceFile):Promise<ParsedDocument> }
export interface LLMRequest { system:string; prompt:string; responseFormat?:'json_object' }
export interface LLMResponse { content:string; usage?: { inputTokens:number; outputTokens:number } }
export interface LLMProvider { generate(request:LLMRequest):Promise<LLMResponse> }
export interface LLMConfig { baseUrl:string; apiKey:string; model:string; temperature:number; maxTokens:number; requestTimeoutMs?:number; reasoningEffort?:'low'|'high'|'max' }
export interface RegistryItem { key:string; label:string; aliases:string[] }
export interface Registries { documentTypes:RegistryItem[]; applications:RegistryItem[]; topics:RegistryItem[] }
export interface ConfirmedExample { id:string; documentId:string; textSummary:string; confirmedFields:Partial<Classification>; createdAt:string }
export interface ClassificationTrace {
 fingerprint:string; prompt?:string; systemPrompt?:string; usedConfirmedExamples:string[];
 ruleDecision:Classification; aiDecision?:unknown; evidence?:string[];
}
export interface ClassificationOutput { classification:Classification; summary:string; warnings:string[]; usage?: { inputTokens:number; outputTokens:number }; trace?:ClassificationTrace }
export interface ChunkDraft { order:number; headingPath:string[]; text:string; summary:string; topics:string[]; products:string[]; metadata:Record<string,unknown> }
export interface KnowledgeChunk extends ChunkDraft { id:string; documentId:string; versionId:string }
export interface ObjectStorage { put(key:string,data:Uint8Array):Promise<void>; get(key:string):Promise<Uint8Array>;delete?(key:string):Promise<void>;replaceCache?(key:string,data:Uint8Array):Promise<void> }
export interface EmbeddingProvider { embed(texts:string[]):Promise<number[][]> }
export interface Retriever { search(query:string,filters:Record<string,string>):Promise<unknown[]> }
export interface DocumentRecord { id:string; title:string; filename:string; status:DocumentStatus; sourceType:string; sourcePath?:string; sourceId:string; activeVersionId:string; versionNumber:number; contentHash:string; summary:string; classification:Classification|null; reviewReasons:string[]; parseStatus:string; parseWarnings:string[]; createdAt:string; updatedAt:string; chunkCount:number; error?:string; scope:string;
 canonicalTitle?:string; originalFilename?:string; parsedTitle?:string; titleSource?:'filename'|'parser'|'ai'|'user';titleConfidence?:number|null;titleReasoning?:string|null;titleLocked?:boolean;extractiveSummary?:string;aiSummary?:string|null;summarySource?:'extractive'|'ai'|'user';knowledgeGroups?:{id:string;name:string}[];
}
export interface Settings { autoAcceptThreshold:number; reviewThreshold:number; chunkTargetTokens:number; chunkOverlapTokens:number; llm:Omit<LLMConfig,'apiKey'> & { configured:boolean }; sources: {id:string;type:string;name:string;mode:string;status:string}[] }
export interface DocumentRecord { sourceUri?:string;remoteVersion?:string;remoteModifiedAt?:string;sourceMetadata?:Record<string,unknown>;canonicalDocumentId?:string;sourceReferenceCount?:number }
