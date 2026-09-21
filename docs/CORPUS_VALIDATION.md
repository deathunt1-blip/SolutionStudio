# Offline corpus validation

Run date: 2026-09-21 UTC (2026-09-22 Asia/Shanghai). This is a real-document **offline parser/rules/chunking** check. It is not a validation of 60 LLM classifications and does not measure semantic classification accuracy.

The script selected 60 supported documents from the user-authorized local archive, balancing formats and filename categories. Selection was deterministic and limited to non-empty files of at most 15 MiB. Private names, paths, extracted content and per-file details are excluded from this document. Local details remain in gitignored `output/corpus-validation.json`. No files were written to the application knowledge database.

## Results

| Format | Files | Success | Partial | Failed | Chunks |
| --- | ---: | ---: | ---: | ---: | ---: |
| DOCX | 13 | 3 | 10 | 0 | 846 |
| PDF | 13 | 7 | 3 | 3 | 503 |
| XLSX | 12 | 12 | 0 | 0 | 147 |
| XLS | 4 | 4 | 0 | 0 | 17 |
| MD | 6 | 6 | 0 | 0 | 24 |
| TXT | 12 | 8 | 4 | 0 | 342 |
| **Total** | **60** | **40** | **17** | **3** | **1879** |

- LLM requests: **0**; input/output tokens: **0**; API cost: **0**.
- Rule classification requires human review for **42** of 57 documents with readable text (document type or authority unknown/below 0.60).
- Identical-content duplicates in the selected sample: **6**.
- Parse failures remain visible and do not produce chunks. “Partial” means readable text was retained with explicit parser warnings, such as skipped images, missing formula caches, or unreadable PDF pages.

## Rule-based type distribution

| Type | Documents |
| --- | ---: |
| unknown | 34 |
| solution | 8 |
| contract_or_requirement | 5 |
| manual | 5 |
| product_document | 3 |
| standard | 1 |
| implementation_document | 1 |

## Scope and limitations

This run verifies format handling, failure visibility and chunk construction on real files. It does not prove extraction completeness, product/authority correctness or the target automatic classification rate. DOCX embedded images and scanned PDFs require external OCR; PDF tables and multi-column pages are read as text without guaranteed table layout. Spreadsheet formulas use cached values; missing caches are reported. Summaries are extractive and no external facts are generated. CSV coverage is provided by synthetic parser tests when the source archive contains no CSV files.

To reproduce locally:

```powershell
npx tsx scripts/validate-corpus.ts "<authorized-local-folder>" --limit60
```
