# HTTP and integration contract — v0.2.2

## Deduplication and source references

The complete endpoints, payloads, scan limits and undo behavior are documented in [DEDUPLICATION.md](docs/DEDUPLICATION.md). `POST /api/duplicates/scan` is deterministic and makes no model calls. Confirmations are separate POST requests; there is no automatic merge of existing records. Exact incoming copies reuse current canonical knowledge and persist their own source reference and original object.

Search applies canonical/current status and duplicate-group diversity before count and pagination. Set `includeDuplicates=1` explicitly to inspect the uncollapsed result set. Source filters include attached references, not just the original primary source. A document detail includes `canonicalDocumentId` when merged and `sourceReferenceCount`; `GET /api/documents/:id/sources` provides per-source download references.

Root `package.json` installs all dependencies. Imports use relative paths with `.js` (tsx supports this). Public object keys use camelCase; domain types are in `packages/core/src/types.ts` and `packages/refinement/src/types.ts`. Proposal field names deliberately include `document_type` to match the refinement field contract.

## Processing module exports

- `packages/parsers/src/index.ts`: `parseDocument(file: SourceFile): Promise<ParsedDocument>` and parser registry.
- `packages/classification/src/index.ts`: `classifyDocument(meta, parsed, registries, examples, provider?, options?:{trace?:boolean;corpusContext?:string}): Promise<ClassificationOutput>`; `reviewReasons(classification: Classification, threshold:number): string[]`.
- `packages/ingestion/src/chunking.ts`: `chunkDocument(parsed:ParsedDocument, classification:Classification, options?:{targetTokens:number;overlapTokens:number}): ChunkDraft[]`.
- `packages/llm/src/index.ts`: `KimiProvider` constructor `(config: LLMConfig)` implementing LLMProvider.
- `packages/refinement/src/engine.ts`: `refineDocument(input, provider): Promise<RefinementOutput>` and `analyzeCorpus(cards, registries, provider): Promise<CorpusAnalysisOutput>`. Structured suggestions only; no database writes.
- `packages/refinement/src/context.ts`: `CorpusContextBuilder(db).build(document, parsed)` and `buildCorpusCards(db, ids?)`; card version IDs bind proposals to the source snapshot.
- `packages/refinement/src/similarity.ts`: `PostgreSQLDocumentSimilarityProvider` implements the replaceable `DocumentSimilarityProvider` interface.
- `packages/core/src/sources.ts`: provider-neutral `RemoteSourceAdapter`, `RemoteResource`, `SourceListing`, `StructuredSourceData`, and schema mapping contracts.
- `packages/source-adapters/src/feishu/index.ts`: `FeishuSourceAdapter(credentials, options?)` and `parseFeishuUrl(url)`. Constructor transport overrides are test-only; source configuration cannot override API hosts.
- `packages/structured/src/service.ts`: structured dataset storage, explicit mapping confirmation, fact reconciliation/history and search; no Feishu API dependency.

## Connections, sync and structured data

| Endpoint | Request | Response |
| --- | --- | --- |
| `GET /api/connections` | — | `{items:[connection]}` including public App ID, with no App Secret/token/secret reference |
| `POST /api/connections` | `{name,appId,appSecret}` | `{connection}` |
| `PATCH /api/connections/:id` | Optional `name`, `appId`, `appSecret`, `status:'connected'|'disabled'` | `{connection}`; omitted secret keeps the current value |
| `POST /api/connections/:id/test` | `{rootUrl}` | Actual token plus root resource permission check |
| `GET /api/sources` | — | `{items:[source]}` including resource count and last job |
| `POST /api/sources` | `{name,connectionId,rootUrl,recursive?,authorityHint?}` | `{source}`; URL infers Wiki or Sheet mode |
| `PATCH /api/sources/:id` | Optional `name`, `rootUrl`, `recursive`, `authorityHint`, `status:'ready'|'disabled'` | `{source}`; queued/running sync returns 409 |
| `POST /api/sources/:id/sync` | Optional `{retryFailed:boolean}` | HTTP 202 `{job}`; existing queued/running job is reused |
| `GET /api/sources/:id/jobs` | — | `{items:[job]}` with counts and redacted per-resource errors |
| `GET /api/sources/:id/resources` | — | `{items:[resource]}` with local document/dataset IDs and status |
| `GET /api/datasets` | — | `{items:[dataset]}` |
| `GET /api/datasets/:id` | — | `{dataset}` with schema, preview/records, mapping and history |
| `POST /api/datasets/:id/suggest` | Optional `{useAi:boolean}` | Mapping/title/summary suggestions; does not confirm mapping |
| `POST /api/datasets/:id/mapping` | `{headerRow,productKey?,productName?,isProductTable,authority,fields,title?,summary?}` | `{dataset}` after explicit mapping confirmation and fact reconciliation |
| `GET /api/facts?q=...` | Optional query | `{items:[fact]}` with dataset, record and source-row evidence |

`authorityHint` is `none`, `reference`, or `authoritative`; it is an advisory source setting, not automatic authority promotion. Source config fixes `syncMode:'manual'`; source mode is `mirror` and source of truth is `remote`. `headerRow` and record row indices are one-based. Mapping `authority` is `reference` or `authoritative`, and field semantic types are `identifier`, `name`, `number`, `text`, `enum`, `url`, `date`, `unknown`.

Sync jobs use `queued`, `running`, `completed`, `partial`, or `failed`; counters include `discovered`, `added`, `updated`, `unchanged`, `removed`, `failed`, and `unsupported`. A listing returns `{items,complete,errors}`. Only a complete error-free normal listing permits removal inference; retry-only or interrupted jobs cannot archive unseen resources. Removal archives local knowledge or deactivates structured facts while preserving originals, dataset revisions and audit history.

Docx resources expose a reliable `docx:<revision_id>`; unchanged shortcuts must also compare title, source path and remote URL. Legacy exports provide `SourceFile.meta.metadata.contentFingerprint` for stable content comparison; `SourceFile.contentHash` remains the SHA-256 of original bytes. Sheet reads preserve physical row positions and reject mixed revisions. An empty terminal Wiki page may omit `items`; omitted `items` with `has_more:true` is an incomplete listing.

Docx File Blocks additionally produce `objectType:'attachment'` resources with stable ID `feishu:attachment:<parentDocumentToken>:<blockId>`. `remoteToken` is the media token; `remoteVersion` is `media:<token>`. Metadata includes parent document identity/revision/URL, block ID, original filename, extension and MIME hint. Supported parser formats are document resources; unsupported formats remain discoverable with `kind:'unsupported'`. Block-list failures make the entire source listing incomplete, retaining successful pages and preventing deletion inference. Downloads use the fixed Drive media endpoint; ordinary body hyperlinks are not followed.

Connections store opaque secret references in SQL, with server-side encrypted local or injected secret storage. Tenant tokens are memory-only. API responses and errors do not expose credentials or upstream response bodies. URL/parser validation restricts production requests to the official Feishu API host. No endpoint writes remote business data. Setup and limits: [FEISHU_SETUP.md](docs/FEISHU_SETUP.md).

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

Backend export `createApp(options?: {dataDir?:string;databaseUrl?:string;llmDisabled?:boolean;providerFactory?;secretStore?;adapterFactory?})` returns a Fastify instance. Tests inject provider, secret store and remote-adapter factories to avoid real paid or company API calls. `index.ts` starts at PORT default 4310 and serves the built frontend from `dist/`. Vite proxies `/api` to `http://127.0.0.1:4310`.

`RefinementService` owns its worker lifecycle and does not close the shared database. The application stops it before closing `KnowledgeService`. Migrations are version tracked at startup; see [ARCHITECTURE.md](ARCHITECTURE.md). Validation and current acceptance evidence are recorded in [docs/PHASE_0_2_VALIDATION.md](docs/PHASE_0_2_VALIDATION.md).
