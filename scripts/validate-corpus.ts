import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { LocalFolderAdapter } from '../packages/source-adapters/src/index.js';
import { parseDocument } from '../packages/parsers/src/index.js';
import { classifyDocument, reviewReasons } from '../packages/classification/src/index.js';
import { chunkDocument } from '../packages/ingestion/src/chunking.js';
import { initialRegistries } from '../packages/knowledge/src/database.js';
import type { SourceDocumentMeta } from '../packages/core/src/types.js';

const args = process.argv.slice(2);
const folder = args.find(value => !value.startsWith('--'));
if (!folder) throw new Error('Usage: npx tsx scripts/validate-corpus.ts <folder> [--limit60|--limit=60|--limit 60]');
const limitFlag = args.find(value => /^--limit(?:=?\d+)?$/.test(value));
const requested = limitFlag === '--limit' ? args[args.indexOf(limitFlag) + 1] : limitFlag?.replace(/^--limit=?/, '');
const limit = requested ? Number(requested) : 60;
if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error('Validation limit must be an integer from 1 to 100.');

const maxBytes = 15 * 1024 * 1024;
const formats = ['.docx', '.pdf', '.xlsx', '.xls', '.md', '.txt', '.csv'];
const category = (file: SourceDocumentMeta) => {
  const name = file.filename;
  if (/验收|终验|初验/i.test(name)) return 'acceptance';
  if (/测试|试验|检测/i.test(name)) return 'testing';
  if (/方案|设计|部署|实施/i.test(name)) return 'solution';
  if (/手册|说明|产品|规格|参数/i.test(name)) return 'product_manual';
  if (/标准|规范|技术/i.test(name)) return 'standard_technical';
  return 'other';
};
const stableOrder = (file: SourceDocumentMeta) => createHash('sha256').update(file.sourcePath ?? file.filename).digest('hex');
const adapter = new LocalFolderAdapter();
const discovered = await adapter.listDocuments({ root: folder });
const eligible = discovered.filter(file => formats.includes(path.extname(file.filename).toLowerCase()) && Number(file.metadata?.bytes) > 0 && Number(file.metadata?.bytes) <= maxBytes);
// First balance formats, then filename categories within each format; deterministic order keeps reruns comparable.
const queues = new Map<string, SourceDocumentMeta[]>();
for (const format of formats) {
  const grouped = new Map<string, SourceDocumentMeta[]>();
  for (const file of eligible.filter(item => path.extname(item.filename).toLowerCase() === format)) {
    const key = category(file); grouped.set(key, [...(grouped.get(key) ?? []), file]);
  }
  for (const files of grouped.values()) files.sort((left, right) => stableOrder(left).localeCompare(stableOrder(right)));
  const queue: SourceDocumentMeta[] = [];
  while ([...grouped.values()].some(files => files.length)) for (const files of grouped.values()) { const file = files.shift(); if (file) queue.push(file); }
  queues.set(format, queue);
}
const selected: SourceDocumentMeta[] = [];
while (selected.length < limit && [...queues.values()].some(files => files.length)) {
  for (const format of formats) { const file = queues.get(format)!.shift(); if (file) selected.push(file); if (selected.length === limit) break; }
}
const counts = { success: 0, partial: 0, failed: 0 };
const byFormat: Record<string, { selected: number; success: number; partial: number; failed: number; chunks: number }> = {};
const byType: Record<string, number> = {}, hashes = new Set<string>();
const details: Record<string, unknown>[] = [];
let needsReview = 0, chunkCount = 0, duplicateContent = 0;
const startedAt = new Date().toISOString();
for (const [index, meta] of selected.entries()) {
  const format = path.extname(meta.filename).slice(1).toLowerCase();
  const formatStats = byFormat[format] ??= { selected: 0, success: 0, partial: 0, failed: 0, chunks: 0 };
  formatStats.selected++;
  try {
    const source = await adapter.fetchDocument(meta.sourcePath ?? meta.filename, { root: folder });
    if (hashes.has(source.contentHash)) duplicateContent++; hashes.add(source.contentHash);
    const parsed = await parseDocument(source);
    counts[parsed.parseStatus]++; formatStats[parsed.parseStatus]++;
    if (parsed.parseStatus === 'failed') details.push({ filename: meta.filename, sourcePath: meta.sourcePath, format, bytes: source.buffer.length, contentHash: source.contentHash, parseStatus: parsed.parseStatus, warnings: parsed.parseWarnings, chunks: 0 });
    else {
      // Deliberately omit provider: this script cannot issue an LLM request and never opens the application DB.
      const output = await classifyDocument(source.meta, parsed, initialRegistries, []);
      const reasons = reviewReasons(output.classification, 0.6);
      const chunks = chunkDocument(parsed, output.classification, { targetTokens: 800, overlapTokens: 100 });
      if (reasons.length) needsReview++;
      chunkCount += chunks.length; formatStats.chunks += chunks.length;
      const type = output.classification.documentType.value; byType[type] = (byType[type] ?? 0) + 1;
      details.push({ filename: meta.filename, sourcePath: meta.sourcePath, format, bytes: source.buffer.length, contentHash: source.contentHash, parseStatus: parsed.parseStatus, warnings: parsed.parseWarnings, textCharacters: parsed.plainText.length, blocks: parsed.blocks.length, tables: parsed.tables.length, documentType: type, authority: output.classification.authority.value, reviewReasons: reasons, chunks: chunks.length });
    }
    console.log(`[${index + 1}/${selected.length}] ${format}: ${parsed.parseStatus}`);
  } catch {
    counts.failed++; formatStats.failed++;
    details.push({ filename: meta.filename, sourcePath: meta.sourcePath, format, parseStatus: 'failed', error: 'Unable to read or process source file; no content logged.' });
    console.log(`[${index + 1}/${selected.length}] ${format}: failed`);
  }
}
const report = { startedAt, completedAt: new Date().toISOString(), mode: 'offline_rule_based', llmRequests: 0, inputTokens: 0, outputTokens: 0, sourceFolder: path.resolve(folder), discovered: discovered.length, eligible: eligible.length, selected: selected.length, sizeLimitBytes: maxBytes, parse: counts, needsReview, chunkCount, duplicateContent, byFormat, byType, details };
await mkdir('output', { recursive: true });
await writeFile('output/corpus-validation.json', `${JSON.stringify(report, null, 2)}\n`, 'utf8');
await mkdir('docs', { recursive: true });
const rows = Object.entries(byFormat).map(([format, stats]) => `| ${format.toUpperCase()} | ${stats.selected} | ${stats.success} | ${stats.partial} | ${stats.failed} | ${stats.chunks} |`).join('\n');
const types = Object.entries(byType).sort((left, right) => right[1] - left[1]).map(([type, count]) => `| ${type} | ${count} |`).join('\n');
await writeFile('docs/CORPUS_VALIDATION.md', `# Offline corpus validation\n\nRun date: ${report.completedAt.slice(0, 10)}. This is a real-document **offline parser/rules/chunking** check. It is not a validation of ${selected.length} LLM classifications and does not measure semantic classification accuracy.\n\nThe script selected ${selected.length} supported documents from the user-authorized local archive, balancing formats and filename categories. Selection was deterministic and limited to non-empty files of at most 15 MiB. Private names, paths, extracted content and per-file details are excluded from this document. Local details remain in gitignored \`output/corpus-validation.json\`. No files were written to the application knowledge database.\n\n## Results\n\n| Format | Files | Success | Partial | Failed | Chunks |\n| --- | ---: | ---: | ---: | ---: | ---: |\n${rows}\n| **Total** | **${selected.length}** | **${counts.success}** | **${counts.partial}** | **${counts.failed}** | **${chunkCount}** |\n\n- LLM requests: **0**; input/output tokens: **0**; API cost: **0**.\n- Rule classification requires human review for **${needsReview}** of ${counts.success + counts.partial} documents with readable text (document type or authority unknown/below 0.60).\n- Identical-content duplicates in the selected sample: **${duplicateContent}**.\n- Parse failures remain visible and do not produce chunks. “Partial” means readable text was retained with explicit parser warnings, such as skipped images, missing formula caches, or unreadable PDF pages.\n\n## Rule-based type distribution\n\n| Type | Documents |\n| --- | ---: |\n${types}\n\n## Scope and limitations\n\nThis run verifies format handling, failure visibility and chunk construction on real files. It does not prove extraction completeness, product/authority correctness or the target automatic classification rate. DOCX embedded images and scanned PDFs require external OCR; PDF tables and multi-column pages are read as text without guaranteed table layout. Spreadsheet formulas use cached values; missing caches are reported. Summaries are extractive and no external facts are generated. CSV coverage is provided by synthetic parser tests when the source archive contains no CSV files.\n\nTo reproduce locally:\n\n\`\`\`powershell\nnpx tsx scripts/validate-corpus.ts "<authorized-local-folder>" --limit60\n\`\`\`\n`, 'utf8');
console.log(JSON.stringify({ selected: report.selected, parse: counts, needsReview, chunkCount, duplicateContent, byFormat, llmRequests: 0 }));
