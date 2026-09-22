# Architecture — Phase 0.2

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
```

Core contracts are in `packages/core/src/types.ts`; refinement, corpus-card and similarity contracts are in `packages/refinement/src/types.ts`. Source, parser, model, object storage, embedding and retriever are separate contracts. Classification and refinement import `LLMProvider`, not a Kimi SDK. The server composition layer chooses implementations. Registry keys and tags are database rows, not compile-time enums.

## Packages

| Path | Responsibility |
| --- | --- |
| `apps/web` | Chinese inbox, library, classification review, batch refinement review, corpus suggestions, groups, settings and details |
| `apps/server` | HTTP validation, upload limits, downloads, composition and queue lifecycle |
| `packages/core` | Domain types and replaceable boundary interfaces |
| `packages/source-adapters` | Manual upload, bounded local folder import, explicit Feishu mock |
| `packages/parsers` | DOCX / PDF / spreadsheet / CSV / Markdown / text normalization |
| `packages/classification` | Fingerprint, field validation, aliases, few-shot feedback and review gating |
| `packages/llm` | Kimi/OpenAI-compatible HTTP provider, timeout and error handling |
| `packages/ingestion` | Heading/paragraph/table aware token-bounded chunking |
| `packages/knowledge` | Storage, database, repositories, settings, search and orchestration |
| `packages/refinement` | Unified model refinement, corpus cards/context, replaceable similarity, durable proposals, explicit apply/rollback, groups and corpus analysis |
| `packages/evaluation` | Isolated human labels, classification benchmarks, threshold/calibration metrics and paired comparisons |
| `migrations` | PostgreSQL relational schema |

## Durable knowledge

Original bytes are immutable version assets, identified by SHA-256. A source document identifies its logical file path; a document has multiple versions. Parsed structures, classifications and chunks are derived data. Rebuild uses the original and reapplies human corrections. A failed reparse cannot turn an empty/scanned PDF into valid knowledge.

The schema separates organizations/workspaces, source records, documents, versions, classifications, registry/tag associations, chunks, confirmation examples, jobs, audit events and future conflicts/embeddings. JSON is used only for structured parser metadata and field confidence payloads where appropriate, not as a substitute for the relational model.

User updates record previous values and operator/time. Confirmation is not model training: similar confirmed summaries/fields become bounded prompt examples for later files. `unknown` is a valid classification, and no prompt requires a forced category.

## Canonical titles and summaries

Original filenames remain immutable on `document_versions.filename`. Parser headings are stored separately as `parsed_title`; a heading such as “概述” is not a replacement document name. `documents.canonical_title` is the display/search name, with `title` retained as a compatibility mirror. `title_source`, confidence and reasoning preserve provenance; `title_user` and user source lock a human name by default. New documents start with a filename-derived name; same-version rebuild keeps the canonical name. Uploading a new version preserves a human title and resets other titles from the new filename.

Versions keep `extractive_summary` as the local fallback and `ai_summary` separately. `summary` is the display-compatible selected summary, and `summary_source` identifies its origin. Accepted refinement values are explicit user confirmations; model confidence and evidence remain on the proposal instead of being promoted into an unreviewed ground truth.

Migration 002 adds these fields and preserves existing display names. Existing parser-derived titles are identified by provenance but are not silently renamed during migration. Migration 003 creates `refinement_batches`, `refinement_proposals`, `refinement_applies`, `knowledge_groups`, `knowledge_group_documents`, `entity_alias_groups`, `entity_aliases`, `corpus_analyses`, and `taxonomy_proposals`. `schema_migrations` records each applied migration, so backfills run once. Back up the data directory with its sole PGlite process stopped before upgrading; a code rollback alone does not undo a schema migration.

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

`authoritative`, `reference`, `style_only`, and `unknown` express how a source can be used. A model cannot invent absent product specifications, and a historical reference never overwrites authoritative facts. P0 does not automatically synthesize a canonical product fact database. Fact/conflict models are extension points requiring document/version/chunk evidence.

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

- **Source**: register a `KnowledgeSourceAdapter`, map remote IDs/revisions to source metadata; preserve deletion/archive history.
- **Parser**: register a `DocumentParser`; preserve blocks/tables and explicit failure warnings.
- **LLM**: inject another `LLMProvider`; classification does not change.
- **Storage**: implement `ObjectStorage` for S3-compatible storage; original keys and provenance stay stable.
- **Embedding/retrieval**: implement provider plus pgvector index/retriever; keep scoped active-version filtering.
- **Document Engine**: consume retrievable, evidence-backed knowledge references. Do not make SceneLab or a specific source connector a core dependency.

Implementation references: [PGlite official Node documentation](https://pglite.dev/docs/), [Moonshot model API example](https://github.com/MoonshotAI/Kimi-K2.5/blob/master/README.md). The ingestion model is configurable; refinement currently restricts the provider configuration to the model and endpoint covered by its budget calculation.

Public interfaces are documented in [API_CONTRACT.md](API_CONTRACT.md). Implementation checks and real acceptance evidence are tracked separately in [docs/PHASE_0_2_VALIDATION.md](docs/PHASE_0_2_VALIDATION.md).
