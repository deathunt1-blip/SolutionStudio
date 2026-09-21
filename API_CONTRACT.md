# Internal integration contract

Root package.json installs all dependencies. Imports use relative paths with `.js` (tsx supports this). All public JSON uses camelCase and types in packages/core/src/types.ts.

## Processing module exports (agent parser owner)
- `packages/parsers/src/index.ts`: `parseDocument(file: SourceFile): Promise<ParsedDocument>` and parser registry.
- `packages/classification/src/index.ts`: `classifyDocument(meta: SourceDocumentMeta, parsed: ParsedDocument, registries: Registries, examples: ConfirmedExample[], provider?: LLMProvider): Promise<ClassificationOutput>`; `reviewReasons(classification: Classification, threshold:number): string[]`.
- `packages/ingestion/src/chunking.ts`: `chunkDocument(parsed:ParsedDocument, classification:Classification, options?:{targetTokens:number;overlapTokens:number}): ChunkDraft[]`.
- `packages/llm/src/index.ts`: `KimiProvider` constructor `(config: LLMConfig)` implementing LLMProvider.

## API (agent backend owner)
- `GET /api/health` -> `{status:'ok',database:'pglite'|'postgres'}`
- `GET /api/stats` -> `{total:number,active:number,needsReview:number,failed:number,processing:number,chunks:number,confirmedExamples:number}`
- `POST /api/upload?duplicate=skip|keep` multipart `files` (multiple), optional `sourceId`, `sourcePath`, `documentId` fields -> `{results:[{filename,status:'queued'|'duplicate'|'error',documentId?:string,message?:string}]}`. Background persistent queue.
- `GET /api/documents?q=&documentType=&application=&topic=&product=&authority=&source=&status=&page=1&pageSize=30` -> `{items:DocumentRecord[],total:number,page:number,pageSize:number}`. Default includes all latest documents; `status=active` used library default.
- `GET /api/search?q=...` same filter params -> `{items:[{document:DocumentRecord,chunk:KnowledgeChunk,score:number}],total:number}` active only default. PostgreSQL FTS + Chinese lexical token support.
- `GET /api/documents/:id` -> `{document:DocumentRecord,chunks:KnowledgeChunk[],versions:[{id,versionNumber,status,createdAt,contentHash}],audit:[...]}`
- `GET /api/documents/:id/original?versionId=...` original download.
- `PATCH /api/documents/:id` -> accepts `{title?,documentType?,authority?,applications?,topics?,products?}`, writes user confidence 1, audit, example, index if review resolved. returns `{document:DocumentRecord}`.
- `POST /api/documents/:id/archive` -> `{ok:true}`
- `POST /api/documents/:id/rebuild` -> `{ok:true}` reparse stored original and honor user confirmations.
- `GET /api/registries` -> Registries
- `POST /api/registries/:kind` (`documentTypes`, `applications`, `topics`) JSON `{key,label,aliases?:string[]}` -> RegistryItem
- `DELETE /api/registries/:kind/:key` -> `{ok:true}` only if unused, forbid unknown deletion.
- `GET /api/settings` -> Settings
- `PATCH /api/settings` -> partial settings including llm `{baseUrl,apiKey?,model,temperature,maxTokens}`, omit apiKey retains existing; keys never returned; -> Settings
- `POST /api/settings/test-llm` -> `{ok:boolean,message:string}`
- `GET /api/jobs` -> `{items:[{id,documentId,filename,status,error,createdAt,updatedAt}]}`

Backend export `createApp(options?: {dataDir?:string;databaseUrl?:string;llmDisabled?:boolean})` returning Fastify instance for integration tests. index.ts starts at PORT default 4310; serves dist/ built frontend. Vite proxy /api -> http://127.0.0.1:4310.

Root owner writes infrastructure, source/storage adapters, docs, importer scripts and integration tests. Backend owner can use filesystem storage initially via core ObjectStorage interface or packages/knowledge/src/storage.ts supplied by root. Root will supply `LocalObjectStorage(baseDir)` with put/get.
