# Phase 0 validation

Validated on 2026-09-22 with Node.js 24 on Windows. No proprietary originals, extracted text, credentials or local databases are included in this repository.

## Automated checks

- `npm test`: **38 tests passed** across seven suites, including adapter/storage boundaries, parsers/classification, API lifecycle integration, concurrent batches and importer budget controls.
- Coverage includes all seven supported formats, malformed/scanned PDF handling, unknown/confidence gating, bounded prompt, evidence grounding, Chinese FTS, duplicate skip/keep, confirmation examples, original downloads, historical versions, audit, same-version rebuild, new-version reclassification, job restart recovery, scope isolation and cross-origin write rejection.
- `npm run build`: TypeScript check and production Vite build.
- `npm audit`: zero known dependency vulnerabilities at validation time.
- Browser smoke check: inbox, review cards, document drawer, confidence selectors, masked-key settings, and filtered real-product chunk search rendered and responded correctly.
- A 52-file multipart request preserved all 50 valid documents while isolating one malformed PDF and one unsupported attachment. Twelve concurrent identical uploads created one document/job and eleven duplicate results. Five rapidly uploaded same-path revisions retained every original and exposed only the latest version in search.
- Budget tests use a local fake HTTP server: a CNY 0.40 allowance stops before a second unique document, a duplicate consumes no reservation, and an incompatible model is rejected before upload. No model requests occur in automated tests.

## Expanded live-library validation

An additional **60 distinct real files** were uploaded through the running application's API: 19 DOCX, 17 PDF, 12 XLSX, 4 XLS, 2 Markdown and 6 TXT. Selection excluded existing hashes, paths and filenames. Original files and private per-document reports stay local.

| New documents | Result |
| --- | ---: |
| Active in the default searchable library | 27 |
| Awaiting human confirmation | 32 |
| Failed scanned-PDF negative test | 1 |
| Parser success / partial with warnings / failure | 38 / 21 / 1 |
| Indexed chunks, including documents awaiting review | 2,109 |

All 59 readable documents finished with AI classification fields and no model-failure fallback warnings. This is a pipeline reliability check, **not a labeled classification-accuracy measurement**. Uncertain document types or authority remain in review; no human approval was fabricated. The scanned PDF has no extractable text, produces no chunks and retains its original for later OCR.

The complete local library now contains **64 documents and 2,178 chunks**. A read-only audit performed **12,436 assertions with zero failures or warnings**, including 21 filter checks, 64 filename checks, 30 keyword checks, chunk/version provenance and SHA-256 verification of eight original downloads. All four pre-existing document records, including user-confirmed fields and current versions, remained unchanged. These assertions verify structural/search consistency, not semantic correctness of every extracted passage.

The expanded run recorded **96,618 input + 19,645 output = 116,263 tokens**, including seven classification retries and three diagnostic calls. At Kimi K2.6 non-cached rates of CNY 6.50/M input and CNY 27/M output, the estimate is **CNY 1.158432 (about CNY 1.16)**. This is based on returned usage, not an invoice; shared-account balance changes are excluded. [Official pricing](https://platform.kimi.com/docs/pricing/chat).

Testing uncovered and fixed two issues: Windows concurrent publication of the same original could fail with `EPERM`, and valid model classifications could be discarded when explanations appeared in a top-level `reasoning` object. Original storage now publishes atomically without overwriting existing bytes. Only bounded explanations under known field names are tolerated; classification types, confidence and evidence validation remain strict. Safe validation diagnostics expose schema paths/codes without retaining arbitrary response text.

Reproduce the read-only library audit with `npx tsx scripts/audit-library.ts`. Private results are written to ignored `output/`; no model calls or document mutations occur.

## Paid model smoke test

Three real historical files (one DOCX, one PDF, one XLSX) were ingested into the local running application through its upload API. All three parsed successfully, producing 39 chunks. The API returned structured classifications for all three; the initial run left all three in review (two lacked formal authority evidence, one had paraphrased rather than verbatim classification evidence).

The model used **3,811 input tokens + 1,306 output tokens = 5,117 tokens**. At the checked Kimi K2.6 non-cached rates, the estimated inference cost is **CNY 0.0600**. This excludes one small connectivity probe; it is a token-based estimate, not an invoice. [Official model pricing](https://platform.kimi.com/docs/pricing/chat).

The paraphrased-evidence finding led to a stronger exact-quote instruction and a conservative filename-ending-in-方案 rule, covered by an added unit test. No additional paid rerun was made. Initial real records remain reviewable, without fabricating a user approval.

The folder importer's optional `--budget-cny` guard now reserves a conservative cost ceiling for each new document: up to three attempts, each bounded by 7,900 input and 3,000 output tokens, at the checked K2.6 rates. This is about CNY 0.39705 per new document, even if its actual classification costs less; duplicates consume no reservation. It records returned usage separately and never queries shared-account balances. The guard applies to jobs started by that command and assumes the validated server configuration/rates remain unchanged. Separate runs and other applications have separate usage.

## Offline historical corpus

Separately, 60 diverse real historical files were parsed, classified by local rules, and chunked **without any LLM provider**. Results: 40 parsed successfully, 17 partially with visible warnings, and 3 scanned PDFs failed for lack of text. Readable documents produced 1,879 chunks. Full aggregate details and reproducibility command are in [CORPUS_VALIDATION.md](CORPUS_VALIDATION.md).

This validates real format robustness and failure visibility. It is not a claim of 60-file AI accuracy or 80% automatic classification: 42 of the 57 readable documents required review in rules-only mode. Production classification quality needs a larger labeled AI sample and continued human feedback.

## Limits

No live Feishu, pgvector, OCR, remote PostgreSQL deployment, multi-tenant authorization or document generation was validated. Those are outside this P0 delivery. PGlite and PostgreSQL share the same migration/SQL adapter, but the current environment's integration runs used PGlite only.
