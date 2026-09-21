# Architecture — Phase 0

## Boundaries

```text
apps/web (React)
  → apps/server (Fastify HTTP / durable worker)
    → knowledge service / PostgreSQL repository
      → source adapter → object storage → parser registry
        → bounded fingerprint → classification service → LLMProvider
          → field confidence gate → user confirmation / confirmed examples
            → structure-aware chunks → PostgreSQL FTS → knowledge search
```

Core contracts are in `packages/core/src/types.ts`. Source, parser, model, object storage, embedding and retriever are separate contracts. Classification imports `LLMProvider`, not a Kimi SDK. The server composition layer chooses implementations. Registry keys and tags are database rows, not compile-time enums.

## Packages

| Path | Responsibility |
| --- | --- |
| `apps/web` | Chinese inbox, library, review, settings and detail UI |
| `apps/server` | HTTP validation, upload limits, downloads, composition and queue lifecycle |
| `packages/core` | Domain types and replaceable boundary interfaces |
| `packages/source-adapters` | Manual upload, bounded local folder import, explicit Feishu mock |
| `packages/parsers` | DOCX / PDF / spreadsheet / CSV / Markdown / text normalization |
| `packages/classification` | Fingerprint, field validation, aliases, few-shot feedback and review gating |
| `packages/llm` | Kimi/OpenAI-compatible HTTP provider, timeout and error handling |
| `packages/ingestion` | Heading/paragraph/table aware token-bounded chunking |
| `packages/knowledge` | Storage, database, repositories, settings, search and orchestration |
| `migrations` | PostgreSQL relational schema |

## Durable knowledge

Original bytes are immutable version assets, identified by SHA-256. A source document identifies its logical file path; a document has multiple versions. Parsed structures, classifications and chunks are derived data. Rebuild uses the original and reapplies human corrections. A failed reparse cannot turn an empty/scanned PDF into valid knowledge.

The schema separates organizations/workspaces, source records, documents, versions, classifications, registry/tag associations, chunks, confirmation examples, jobs, audit events and future conflicts/embeddings. JSON is used only for structured parser metadata and field confidence payloads where appropriate, not as a substitute for the relational model.

User updates record previous values and operator/time. Confirmation is not model training: similar confirmed summaries/fields become bounded prompt examples for later files. `unknown` is a valid classification, and no prompt requires a forced category.

## Confidence and authority

Every field has `value`, `confidence`, `source`, and optional reasoning. Only uncertain document type and authority block indexing; low-confidence tags are advisory. Human updates always use `source=user` and confidence 1. Thresholds are configurable. Partial parsing has visible warnings and review treatment.

`authoritative`, `reference`, `style_only`, and `unknown` express how a source can be used. A model cannot invent absent product specifications, and a historical reference never overwrites authoritative facts. P0 does not automatically synthesize a canonical product fact database. Fact/conflict models are extension points requiring document/version/chunk evidence.

## Retrieval

The default search includes active versions only and enforces the configured organization/workspace context. Text is lexically segmented (including Chinese) before PostgreSQL `tsvector`/`tsquery` matching. Ranking weights relevance by authority and freshness. Results return document, original version and matching chunk identifiers. Style-only items rank lower; P0.5 can separate fact search from style search.

PGlite provides the local PostgreSQL implementation; `pg` uses the same SQL against a PostgreSQL server. No external vector database is needed. `EmbeddingProvider` and `Retriever` contracts allow pgvector and semantic search later without changing ingestion's source/parser interfaces.

## Runtime and trust

One durable ingestion worker runs per local server. Jobs survive process restarts, are processed independently, and preserve failures for retry. Upload HTTP calls queue work instead of waiting for model completion. Batch failures do not discard successful documents.

Uploaded documents are untrusted data, including instructions written inside them. Parser output is quoted into a constrained classification task. Returned JSON is schema checked and registered categories normalized. Original filenames are metadata; storage uses controlled keys and path-boundary checks. Credentials are held server-side and never sent in settings responses or committed to source control.

This phase uses a fixed default organization/workspace. Do not expose it as a public multi-tenant service without authentication and authorization. Future project scope must be server-authorized and applied to every query, confirmation-example lookup, dedup lookup, chunk and original download.

## Extension path

- **Source**: register a `KnowledgeSourceAdapter`, map remote IDs/revisions to source metadata; preserve deletion/archive history.
- **Parser**: register a `DocumentParser`; preserve blocks/tables and explicit failure warnings.
- **LLM**: inject another `LLMProvider`; classification does not change.
- **Storage**: implement `ObjectStorage` for S3-compatible storage; original keys and provenance stay stable.
- **Embedding/retrieval**: implement provider plus pgvector index/retriever; keep scoped active-version filtering.
- **Document Engine**: consume retrievable, evidence-backed knowledge references. Do not make SceneLab or a specific source connector a core dependency.

Implementation references: [PGlite official Node documentation](https://pglite.dev/docs/), [Moonshot model API example](https://github.com/MoonshotAI/Kimi-K2.5/blob/master/README.md). Model availability is queried from the configured account and may differ; it is configurable.
