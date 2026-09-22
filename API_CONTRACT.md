# HTTP and integration contract — Phase 0.2

Root `package.json` installs all dependencies. Imports use relative paths with `.js` (tsx supports this). Public object keys use camelCase; domain types are in `packages/core/src/types.ts` and `packages/refinement/src/types.ts`. Proposal field names deliberately include `document_type` to match the refinement field contract.

## Processing module exports

- `packages/parsers/src/index.ts`: `parseDocument(file: SourceFile): Promise<ParsedDocument>` and parser registry.
- `packages/classification/src/index.ts`: `classifyDocument(meta, parsed, registries, examples, provider?, options?:{trace?:boolean;corpusContext?:string}): Promise<ClassificationOutput>`; `reviewReasons(classification: Classification, threshold:number): string[]`.
- `packages/ingestion/src/chunking.ts`: `chunkDocument(parsed:ParsedDocument, classification:Classification, options?:{targetTokens:number;overlapTokens:number}): ChunkDraft[]`.
- `packages/llm/src/index.ts`: `KimiProvider` constructor `(config: LLMConfig)` implementing LLMProvider.
- `packages/refinement/src/engine.ts`: `refineDocument(input, provider): Promise<RefinementOutput>` and `analyzeCorpus(cards, registries, provider): Promise<CorpusAnalysisOutput>`. Structured suggestions only; no database writes.
- `packages/refinement/src/context.ts`: `CorpusContextBuilder(db).build(document, parsed)` and `buildCorpusCards(db, ids?)`; card version IDs bind proposals to the source snapshot.
- `packages/refinement/src/similarity.ts`: `PostgreSQLDocumentSimilarityProvider` implements the replaceable `DocumentSimilarityProvider` interface.

## Knowledge API

- `GET /api/health` -> `{status:'ok',database:'pglite'|'postgres'}`
- `GET /api/stats` -> `{total:number,active:number,needsReview:number,failed:number,processing:number,chunks:number,confirmedExamples:number}`
- `POST /api/upload?duplicate=skip|keep` multipart `files` (multiple), optional `sourceId`, `sourcePath`, `documentId` fields -> `{results:[{filename,status:'queued'|'duplicate'|'error',documentId?:string,message?:string}]}`. Background persistent queue.
- `GET /api/documents?q=&documentType=&application=&topic=&product=&authority=&source=&status=&group=&page=1&pageSize=30` -> `{items:DocumentRecord[],total:number,page:number,pageSize:number}`. `group` is a knowledge-group ID. Default includes all latest documents; `status=active` used library default.
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

`DocumentRecord.title` remains the display-compatible canonical title. Additional fields include `canonicalTitle`, `originalFilename`, `parsedTitle`, `titleSource`, `titleConfidence`, `titleReasoning`, `titleLocked`, `extractiveSummary`, `aiSummary`, `summarySource`, and `knowledgeGroups`. `filename` and original bytes are never rewritten by refinement.

## Selection and budgets

Bulk endpoints accept exactly one selection form:

```json
{"documentIds":["document-id-1","document-id-2"]}
```

```json
{"selection":{"mode":"filtered","filters":{"documentType":"solution","group":"group-id"}}}
```

Selection modes are `all`, `filtered`, and `first10`. `all` ignores filters; `first10` applies filters and takes the newest ten eligible documents. Send current-page checkbox IDs using `documentIds`. Selection resolves once on the server; batches store concrete document/version targets. A request may select at most 1,000 documents. Refinement, corpus analysis, and selected group creation require parsed, nonarchived `active` / `needs_review` documents. Batch archive may select other nonarchived statuses.

`budgetCny` is 1–100 inclusive. Refinement defaults to 10; corpus analysis defaults to 5. Budget protection currently supports only Kimi CN `kimi-k2.6` with `maxTokens <= 3000`. Before each provider call the service persists a 0.613968 CNY reservation covering up to three attempts, each bounded to 18,000 prompt UTF-8 bytes plus 1,024 input-token overhead and 3,000 output tokens. The configured calculation uses 6.5 / 27 CNY per million input / output tokens. Reservations are not refunded. `estimatedCostCny`, `inputTokens`, and `outputTokens` report returned usage separately; no account-balance lookup occurs.

## Refinement batches

| Endpoint | Request | Response |
| --- | --- | --- |
| `POST /api/refinement/batches` | Selection plus `operations`, optional `includeUserFields`, `includeUserTitles`, `budgetCny` | HTTP 202 `{batch:RefinementBatch}` |
| `GET /api/refinement/batches` | — | `{items:RefinementBatch[]}` |
| `GET /api/refinement/batches/:id` | — | `{batch,proposals:RefinementProposal[]}` |
| `POST /api/refinement/batches/:id/apply` | Optional `proposalIds`, `fields`, `minConfidence`, `edits` | `{batch,proposals,applied:number,conflicts:string[]}` |
| `POST /api/refinement/batches/:id/reject` | Optional `proposalIds` | `{batch,proposals}` |
| `POST /api/refinement/batches/:id/rollback` | `{}` | `{batch,proposals,restored:number}` |
| `POST /api/documents/batch-archive` | Selection | `{archived:number}` |

`operations` is a nonempty subset of `title`, `summary`, `classification`, and `tags`; classification covers type and authority, tags cover applications, topics, and products. Human-field inclusion flags default to false. Generation only inserts proposals; there is no automatic application.

Apply fields are `title`, `summary`, `document_type`, `authority`, `applications`, `topics`, and `products`. Apply filters intersect; an empty request explicitly applies all eligible pending proposals. `edits` maps proposal IDs to raw replacement values, for example `{"edits":{"proposal-id":"Revised title"}}`. Values are validated again on application, including Registry membership and product evidence in the current file. Original model values stay in `proposedValue`; actual accepted values are in `acceptedValue` and audit records. Accepted fields become explicit user confirmations.

Batch statuses: `queued`, `running`, `completed`, `partially_failed`, `failed`, `applied`, `rolled_back`. Proposal statuses: `pending`, `accepted`, `rejected`, `stale`. Version changes and archive invalidate pending proposals. Application also checks the captured current field value and current human locks; conflicts are skipped and returned by proposal ID. Queued/running or rolled-back batches cannot be applied.

Rollback restores all of this batch's application snapshots in reverse order, with corresponding index rebuild and removal of only its new confirmed examples. If any affected document has changed since application, HTTP 409 leaves the entire rollback unapplied. Rollback does not cover independent taxonomy acceptance, group merges, or batch archive. Interrupted running jobs become `partially_failed` on startup; reservations remain and unknown paid requests are not replayed automatically. Queued jobs can still run.

## Corpus proposals and groups

| Endpoint | Request | Response |
| --- | --- | --- |
| `POST /api/corpus/analyze` | Optional selection and `budgetCny`; omitted selection means all eligible documents | HTTP 202 `{analysis}` |
| `GET /api/corpus/proposals` | — | `{items:TaxonomyProposal[],analyses:[...]}` |
| `POST /api/corpus/proposals/:id/accept` | Optional edited `name`, `description`, `canonical`, `aliases`, `documentIds` | `TaxonomyProposal` |
| `POST /api/corpus/proposals/:id/reject` | `{}` | `TaxonomyProposal` |
| `GET /api/groups` | — | `{items:KnowledgeGroup[]}` |
| `POST /api/groups` | `{name,description?}` plus optional selection | `KnowledgeGroup` |
| `POST /api/groups/merge` | `{sourceIds:string[],targetId:string}` | Target `KnowledgeGroup` |

Analysis runs asynchronously in batches of at most 50 lightweight cards. It only writes proposals and run diagnostics, never Registry entries or group membership. The response includes status/progress, reserved and estimated cost, returned usage, errors, and warnings. Pending suggestions become stale if their source versions or availability change.

Kinds are `group`, `topic_merge`, `entity_alias`, `possible_version`, `outlier`, `title_anomaly`, and `classification_anomaly`. Explicit acceptance creates groups or entity-alias relationships as applicable. Topic acceptance adds nonconflicting aliases to an existing canonical topic; aliases owned by a different existing topic key return 409 rather than silently migrating references. Acceptance of version/anomaly suggestions records acknowledgement, not automatic file merging or metadata rewriting.

Groups are many-to-many document collections independent from document type or application. Manual group creation and merge are explicit writes; merging preserves the target group and the union of memberships.

Malformed inputs return HTTP 400, missing resources 404, and stale/locked state conflicts 409 with `{message:string}`. The service is scoped to the default organization/workspace and global documents; it is not a public multitenant API.

Backend export `createApp(options?: {dataDir?:string;databaseUrl?:string;llmDisabled?:boolean})` returning Fastify instance for integration tests. index.ts starts at PORT default 4310; serves dist/ built frontend. Vite proxy /api -> http://127.0.0.1:4310.

`RefinementService` owns its worker lifecycle and does not close the shared database. The application stops it before closing `KnowledgeService`. Migrations are version tracked at startup; see [ARCHITECTURE.md](ARCHITECTURE.md). Validation and current acceptance evidence are recorded in [docs/PHASE_0_2_VALIDATION.md](docs/PHASE_0_2_VALIDATION.md).
