# Architecture — v0.2.2

## Document identity and deduplication

`packages/deduplication` owns the replaceable `DuplicateDetector`, bounded lexical candidate generation, normalized text/table hashes, suggestion groups, source references, confirmation snapshots and retrieval buckets. Migration 006 adds logical canonical pointers without deleting any documents or originals. Exact/content groups can have multiple members; near/version suggestions remain pairwise. Confirmation and undo are transactional and reject stale or cyclic/overlapping relationships.

`KnowledgeService.upload` checks current hashes before parsing, attaches exact origins and preserves their filenames/bytes. A changed remote origin forks shared knowledge rather than updating unrelated sources; removing an origin only archives a canonical group when no live origin remains. Ingestion jobs cannot reactivate superseded documents. Post-index detection produces suggestions without changing titles, classification or authority.

Retriever and corpus context consume current canonical documents. Active duplicate proposals form retrieval buckets before pagination; dismissed, stale, possible-version and merely similar proposals do not suppress independent documents. Structured facts retain their existing dataset-specific mapping and revision lifecycle. See [deduplication details](docs/DEDUPLICATION.md).

## Boundaries

```text
apps/web (React)
  → apps/server (Fastify HTTP / durable worker)
    → knowledge service / PostgreSQL repository
      → source adapter → object storage → parser registry
        → bounded fingerprint → classification service → LLMProvider
          → field confidence gate → user confirmation / confirmed examples
            → structure-aware chunks → PostgreSQL FTS → knowledge search

library selection → refinement worker → bounded current evidence + corpus context
  → one structured model response → persistent field proposals
    → explicit selective apply → metadata / index / audit / confirmed examples
      → guarded rollback from before/after snapshots

eligible document cards → corpus analysis worker → taxonomy proposals
  → explicit acceptance → knowledge groups / nonconflicting aliases

external connection → secret store → remote source adapter → durable sync job
  → document bytes → existing knowledge ingestion / versions / search
  → structured rows → mapping confirmation → generic product facts / history
```

Core contracts are in `packages/core/src/types.ts` and `packages/core/src/sources.ts`; refinement, corpus-card and similarity contracts are in `packages/refinement/src/types.ts`. Source, parser, model, object storage, embedding and retriever are separate contracts. Classification and refinement import `LLMProvider`, not a Kimi SDK. The server composition layer chooses implementations. Registry keys and tags are database rows, not compile-time enums.

## Packages

| Path | Responsibility |
| --- | --- |
| `apps/web` | Chinese inbox, library, classification review, batch refinement review, corpus suggestions, groups, settings and details |
| `apps/server` | HTTP validation, upload limits, downloads, composition and queue lifecycle |
| `packages/core` | Domain types and replaceable boundary interfaces |
| `packages/source-adapters` | Manual upload, bounded local folder import, live Feishu read-only HTTP connector and explicit mock fixture |
| `packages/connections` | Generic external connections, credential redaction and encrypted/injectable SecretStore |
| `packages/sources` | Durable manual sync jobs, partial failure isolation, change detection and safe remote-removal reconciliation |
| `packages/structured` | Provider-neutral datasets, schema mapping, row provenance, product facts and parameter history |
| `packages/parsers` | DOCX / PDF / spreadsheet / CSV / Markdown / text normalization |
| `packages/classification` | Fingerprint, field validation, aliases, few-shot feedback and review gating |
| `packages/llm` | Kimi/OpenAI-compatible HTTP provider, timeout and error handling |
| `packages/ingestion` | Heading/paragraph/table aware token-bounded chunking |
| `packages/knowledge` | Storage, database, repositories, settings, search and orchestration |
| `packages/refinement` | Unified model refinement, corpus cards/context, replaceable similarity, durable proposals, explicit apply/rollback, groups and corpus analysis |
| `packages/evaluation` | Isolated human labels, classification benchmarks, threshold/calibration metrics and paired comparisons |
| `migrations` | PostgreSQL relational schema |

## Remote sources and structured facts

`RemoteSourceAdapter` returns provider-neutral resource listings and either original document bytes or structured rows. The Feishu implementation alone knows tenant authentication, Wiki pagination, document exports and Sheets APIs. Neither Knowledge Core nor Structured Core depends on the Feishu client. Sources name an explicit root, remain read-only mirrors, and preserve provider/token/URL/version/time/path provenance.

The serial sync worker persists progress and per-resource failures. Unsupported types do not stop siblings. `SourceListing.complete=false`, missing pagination, permission failures, interrupted jobs and retry-only runs disable deletion inference. A complete listing may archive disappeared documents or remove active facts; originals and historical versions remain intact.

Docx compares official document revisions and checks for edits during export. Legacy native exports use a stable rendered-content fingerprint to ignore export ZIP timestamps; immutable storage continues to use raw-file SHA-256. Changes to title/path/URL prevent unchanged shortcuts. Sheet values retain physical row positions across paged ranges, and inconsistent revisions during reading reject the snapshot.

Docx file attachments are discovered from paginated official block data at a fixed parent revision. Their stable identity combines parent document and block ID, so replacing a media token updates the existing logical resource. Supported files use the ordinary ingestion pipeline; unsupported extensions stay visible without blocking siblings. Parent document/block URL and media token remain evidence. No ordinary body-link graph, image tree or archive contents are recursively fetched; failed attachment enumeration disables deletion inference.

Structured datasets store raw rows separately from derived schema and records. Users confirm the header row, field meanings, product key/name columns, product-table status and authority before facts become active. There are no fixed camera fields or hard-coded product IDs. Each fact points to its dataset and record, and each record keeps spreadsheet/workbook identity and source row. Changed or removed parameter values produce audit history with before/after, source revision and sync time. Header changes invalidate the previous mapping until reconfirmed.

Kimi may suggest a mapping, title and summary from bounded table evidence; it cannot invent missing values or silently confirm authoritative facts. Document search remains lexical PostgreSQL retrieval; structured facts have a separate generic query API. Automatic cross-source conflict resolution, embedding search, scheduled sync, webhooks, reverse writes and full ACL mirroring remain outside this phase.

The local SecretStore encrypts credentials using AES-256-GCM; SQL stores references only and access tokens remain in memory. Development uses a local key file, while production requires `SOURCE_SECRET_KEY` or an injected external store. Protect and back up the encrypted store and key with the data directory. Connector requests target the fixed official API host, reject redirects, bound response sizes, rate-limit calls and retry transient failures without returning upstream bodies.

## Durable knowledge

Original bytes are immutable version assets, identified by SHA-256. A source document identifies its logical file path; a document has multiple versions. Parsed structures, classifications and chunks are derived data. Rebuild uses the original and reapplies human corrections. A failed reparse cannot turn an empty/scanned PDF into valid knowledge.

The schema separates organizations/workspaces, source records, documents, versions, classifications, registry/tag associations, chunks, confirmation examples, jobs, audit events and future conflicts/embeddings. JSON is used only for structured parser metadata and field confidence payloads where appropriate, not as a substitute for the relational model.

User updates record previous values and operator/time. Confirmation is not model training: similar confirmed summaries/fields become bounded prompt examples for later files. `unknown` is a valid classification, and no prompt requires a forced category.

## Canonical titles and summaries

Original filenames remain immutable on `document_versions.filename`. Parser headings are stored separately as `parsed_title`; a heading such as “概述” is not a replacement document name. `documents.canonical_title` is the display/search name, with `title` retained as a compatibility mirror. `title_source`, confidence and reasoning preserve provenance; `title_user` and user source lock a human name by default. New documents start with a filename-derived name; same-version rebuild keeps the canonical name. Uploading a new version preserves a human title and resets other titles from the new filename.

Versions keep `extractive_summary` as the local fallback and `ai_summary` separately. `summary` is the display-compatible selected summary, and `summary_source` identifies its origin. Accepted refinement values are explicit user confirmations; model confidence and evidence remain on the proposal instead of being promoted into an unreviewed ground truth.

Migration 002 adds these fields and preserves existing display names. Existing parser-derived titles are identified by provenance but are not silently renamed during migration. Migration 003 creates `refinement_batches`, `refinement_proposals`, `refinement_applies`, `knowledge_groups`, `knowledge_group_documents`, `entity_alias_groups`, `entity_aliases`, `corpus_analyses`, and `taxonomy_proposals`. `schema_migrations` records each applied migration, so backfills run once. Back up the data directory with its sole PGlite process stopped before upgrading; a code rollback alone does not undo a schema migration.

Migration 004 adds structured datasets, dataset snapshots, facts and fact change history. Migration 005 adds external connection references, durable sync jobs and source-resource mappings. Connection secrets remain outside ordinary SQL fields. Upgrades create capability without automatically starting a remote sync.

## Proposal lifecycle and rollback

The HTTP boundary resolves explicit IDs or `first10` / `filtered` / `all` selection into a bounded set of current document IDs. A refinement batch captures active version IDs and requested operations. Its serial worker obtains current text and context, then requests all requested metadata in one model response. Suggestions are stored independently; neither model generation nor opening the review page applies them.

Each proposal stores its source version, field, captured current value, model value, confidence, reasoning, evidence and status. Human titles and user-sourced fields are excluded unless the batch explicitly includes them. Apply runs in a transaction and rechecks source version, document state, current field value and human locks. It validates edited values, registered classifications and current-file product grounding. New versions, archive and subsequent changes invalidate pending suggestions. Selective acceptance can use proposal IDs, fields or a minimum confidence, and stores edited accepted values separately from original model values.

Accepted changes update metadata, classification associations, review reasons and the chunk search index together. Only accepted classification fields create new confirmed examples. Every affected document receives a `batch_refinement_apply` audit event and an application snapshot containing before/after metadata and the IDs of new examples.

Rollback walks the batch's application snapshots in reverse order. Current metadata must still match each recorded after-state; a new version or later edit rejects the entire rollback with a conflict. Successful rollback restores prior metadata and indexes, deletes only the examples made by this batch, and adds rollback audit events. This guarantees that undo does not overwrite later human work. Group/alias acceptance and archive are independent operations outside this rollback boundary.

## Corpus context and analysis

`CorpusContextBuilder` creates lightweight document cards with titles, bounded summaries, metadata, groups and source/version identity. The default similarity provider combines PostgreSQL FTS, title and summary overlap, application/topic/product overlap, and matching source directories. It excludes the current document and same-content copies. This is lexical retrieval; no embedding vendor or paid embedding API is required.

A card is a strong example only when its current version's type and authority both have explicit user confirmation. Its confirmed-field subset contains only user-sourced values. Other sufficiently confident cards have weak weight at most 0.3; low-confidence cards contribute no similarity reference. Context includes nearby cards, relevant confirmed cards, Registry entries, classification distribution and existing groups. Normal ingestion also receives a compact context excerpt to help type/application/topic choices.

Authority must be justified by the current file's evidence, source metadata or explicit user confirmation; neighbours cannot confer authority. Products must occur in the current file. The model cannot turn AI-only neighbours into training labels merely through repeated retrieval.

Whole-corpus analysis sends at most 50 cards per request, not the collection's full document text. Source version IDs remain attached to the original card snapshot; the worker verifies them before sending and suggestions are invalidated if those versions change. Analysis writes only suggestions and diagnostics. Knowledge groups are many-to-many browse/context collections, separate from document type and application, and appear only after explicit creation or confirmation.

P0.5 support is deliberately limited: entity confirmation records canonical/alias relationships without rewriting document product names. Topic confirmation adds aliases only to an existing canonical topic when no other Registry key owns them; cross-key topic merges return a conflict for manual review. Possible-version and anomaly suggestions can be acknowledged, but acknowledgement does not merge files or rewrite their metadata.

## Confidence and authority

Every field has `value`, `confidence`, `source`, and optional reasoning. Only uncertain document type and authority block indexing; low-confidence tags are advisory. Human updates always use `source=user` and confidence 1. Thresholds are configurable. Partial parsing has visible warnings and review treatment.

`authoritative`, `reference`, `style_only`, and `unknown` express how a source can be used. A model cannot invent absent product specifications, and a historical reference never overwrites authoritative facts. Phase 0.2.1 creates product facts only from explicitly confirmed structured mappings with dataset/row evidence. It does not automatically synthesize canonical facts from narrative documents or resolve cross-source conflicts.

## Retrieval

The default search includes active versions only and enforces the configured organization/workspace context. Text is lexically segmented (including Chinese) before PostgreSQL `tsvector`/`tsquery` matching. Ranking weights relevance by authority and freshness. Results return document, original version and matching chunk identifiers. Style-only items rank lower; P0.5 can separate fact search from style search.

PGlite provides the local PostgreSQL implementation; `pg` uses the same SQL against a PostgreSQL server. No external vector database is needed. `EmbeddingProvider` and `Retriever` contracts allow pgvector and semantic search later without changing ingestion's source/parser interfaces.

## Runtime and trust

One durable ingestion worker runs per local server. Jobs survive process restarts, are processed independently, and preserve failures for retry. Upload HTTP calls queue work instead of waiting for model completion. Batch failures do not discard successful documents. A separate serial refinement worker processes refinement batches and corpus analyses; application shutdown waits for this worker before closing the shared database.

Refinement requests have an 18,000-byte UTF-8 bound across system and user prompts. The budget gate persists a reservation before calling the provider, assuming that many input tokens plus 1,024 overhead, at most 3,000 output tokens, and up to three attempts. At the implemented Kimi CN K2.6 rates of 6.5 / 27 CNY per million input / output tokens this reserves 0.613968 CNY per document-refinement call or per corpus-card batch. API budgets are 1–100 CNY; the gate rejects unsupported model/base URL/output limits. Reservations are never refunded, and budget exhaustion prevents later requests. Returned usage and estimated cost are separate counters, not a measurement of shared-account balance or all retries.

Queued refinement jobs can run after restart. A running job has an unknown paid-request outcome, so startup marks it partially failed and preserves its reservations and completed proposals; it does not silently repeat the call. Continuing requires a new batch. Failed requests and schema validation errors remain visible even when no proposal can safely be retained.

Uploaded documents are untrusted data, including instructions written inside them. Parser output is quoted into a constrained classification task. Returned JSON is schema checked and registered categories normalized. Original filenames are metadata; storage uses controlled keys and path-boundary checks. Credentials are held server-side and never sent in settings responses or committed to source control.

This phase uses a fixed default organization/workspace. Do not expose it as a public multi-tenant service without authentication and authorization. Future project scope must be server-authorized and applied to every query, confirmation-example lookup, dedup lookup, chunk and original download.

## Extension path

- **Source**: use `KnowledgeSourceAdapter` for file ingestion or implement `RemoteSourceAdapter` for sync; map remote IDs/revisions to source metadata and preserve deletion/archive history. Structured sources return generic row data, never provider-specific core tables.
- **Parser**: register a `DocumentParser`; preserve blocks/tables and explicit failure warnings.
- **LLM**: inject another `LLMProvider`; classification does not change.
- **Storage**: implement `ObjectStorage` for S3-compatible storage; original keys and provenance stay stable.
- **Embedding/retrieval**: implement provider plus pgvector index/retriever; keep scoped active-version filtering.
- **Document Engine**: consume retrievable, evidence-backed knowledge references. Do not make SceneLab or a specific source connector a core dependency.

Implementation references: [PGlite official Node documentation](https://pglite.dev/docs/), [Moonshot model API example](https://github.com/MoonshotAI/Kimi-K2.5/blob/master/README.md). The ingestion model is configurable; refinement currently restricts the provider configuration to the model and endpoint covered by its budget calculation.

Public interfaces are documented in [API_CONTRACT.md](API_CONTRACT.md). Implementation checks and real acceptance evidence are tracked separately in [docs/PHASE_0_2_VALIDATION.md](docs/PHASE_0_2_VALIDATION.md).
