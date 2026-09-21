# Phase 0 validation

Validated on 2026-09-22 with Node.js 24 on Windows. No proprietary originals, extracted text, credentials or local databases are included in this repository.

## Automated checks

- `npm test`: 25 tests passed across adapter/storage boundaries, parsers/classification, and API lifecycle integration against a real persistent PGlite PostgreSQL database.
- Coverage includes all seven supported formats, malformed/scanned PDF handling, unknown/confidence gating, bounded prompt, evidence grounding, Chinese FTS, duplicate skip/keep, confirmation examples, original downloads, historical versions, audit, same-version rebuild, new-version reclassification, job restart recovery, scope isolation and cross-origin write rejection.
- `npm run build`: TypeScript check and production Vite build.
- `npm audit`: zero known dependency vulnerabilities at validation time.
- Browser smoke check: inbox, review cards, document drawer, confidence selectors, masked-key settings, and filtered real-product chunk search rendered and responded correctly.

## Paid model smoke test

Three real historical files (one DOCX, one PDF, one XLSX) were ingested into the local running application through its upload API. All three parsed successfully, producing 39 chunks. The API returned structured classifications for all three; the initial run left all three in review (two lacked formal authority evidence, one had paraphrased rather than verbatim classification evidence).

The model used **3,811 input tokens + 1,306 output tokens = 5,117 tokens**. At the checked Kimi K2.6 non-cached rates, the estimated inference cost is **CNY 0.0600**. This excludes one small connectivity probe; it is a token-based estimate, not an invoice. [Official model pricing](https://platform.kimi.com/docs/pricing/chat).

The paraphrased-evidence finding led to a stronger exact-quote instruction and a conservative filename-ending-in-方案 rule, covered by an added unit test. No additional paid rerun was made. Initial real records remain reviewable, without fabricating a user approval.

The folder importer supports an optional `--budget-cny 10` guard for sequential Moonshot CN K2.6 runs. It reads account balance before each next file and reserves CNY 2; account-level balance changes can include unrelated calls and settlement delay. The current validation did not exhaust this budget or run 60 paid classifications.

## Offline historical corpus

Separately, 60 diverse real historical files were parsed, classified by local rules, and chunked **without any LLM provider**. Results: 40 parsed successfully, 17 partially with visible warnings, and 3 scanned PDFs failed for lack of text. Readable documents produced 1,879 chunks. Full aggregate details and reproducibility command are in [CORPUS_VALIDATION.md](CORPUS_VALIDATION.md).

This validates real format robustness and failure visibility. It is not a claim of 60-file AI accuracy or 80% automatic classification: 42 of the 57 readable documents required review in rules-only mode. Production classification quality needs a larger labeled AI sample and continued human feedback.

## Limits

No live Feishu, pgvector, OCR, remote PostgreSQL deployment, multi-tenant authorization or document generation was validated. Those are outside this P0 delivery. PGlite and PostgreSQL share the same migration/SQL adapter, but the current environment's integration runs used PGlite only.
