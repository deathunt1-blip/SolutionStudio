import { createHash } from 'node:crypto';
import type { ParsedDocument } from '../../core/src/types.js';
import type { CandidateOptions, CandidateResult, DedupDocument, DocumentDifference, DuplicateAssessment, DuplicateDetector } from './types.js';

const MIN_CONTENT_CHARACTERS = 24;
const MAX_SHINGLES = 4096;
const sha256 = (value: string) => createHash('sha256').update(value).digest('hex');
// NFC preserves significant distinctions such as m²/m2 and MW/mW. Whitespace
// becomes a separator, never disappears between numbers, units or English words.
export function normalizeText(value: string): string {
  return value.normalize('NFC').replace(/[\uFF01-\uFF5E]/g, char => String.fromCharCode(char.charCodeAt(0) - 0xFEE0)).replace(/\s+/gu, ' ').trim();
}
function normalizedPayload(parsed: Pick<ParsedDocument, 'plainText' | 'tables'>): string {
  // JSON retains table, row and cell boundaries, including empty cells.
  return JSON.stringify({ text: normalizeText(parsed.plainText), tables: parsed.tables.map(table => ({ title: normalizeText(table.title ?? ''), rows: table.rows.map(row => row.map(normalizeText)) })) });
}
function substantial(parsed: Pick<ParsedDocument, 'plainText' | 'tables'>): boolean {
  const text = parsed.plainText + parsed.tables.flatMap(table => table.rows.flat()).join('');
  return (text.match(/[\p{L}\p{N}]/gu)?.length ?? 0) >= MIN_CONTENT_CHARACTERS;
}
export function normalizedContentHash(parsed: Pick<ParsedDocument, 'plainText' | 'tables'>): string | null {
  return substantial(parsed) ? sha256(normalizedPayload(parsed)) : null;
}
function parsedOf(document: DedupDocument): Pick<ParsedDocument, 'plainText' | 'tables'> {
  return document.parsedDocument ?? { plainText: document.plainText ?? '', tables: [] };
}
function bodyOf(document: DedupDocument): string {
  const parsed = parsedOf(document);
  return [parsed.plainText, ...parsed.tables.map(table => table.rows.map(row => row.join(' | ')).join('\n'))].join('\n');
}
function textHash(document: DedupDocument): string | null {
  // Never trust a legacy empty-text hash when parsed text is available.
  if (document.parsedDocument || document.plainText !== undefined) return normalizedContentHash(parsedOf(document));
  return document.normalizedContentHash || null;
}
function hash32(value: string): number {
  let hash = 2166136261;
  for (let i = 0; i < value.length; i++) hash = Math.imul(hash ^ value.charCodeAt(i), 16777619);
  return hash >>> 0;
}
function shingles(value: string): Set<string> {
  const text = normalizeText(value).toLowerCase();
  const length = Math.max(1, text.length - 3);
  const count = Math.min(length, MAX_SHINGLES);
  const result = new Set<string>();
  // Sample across the entire document, including its end, rather than a prefix.
  for (let i = 0; i < count; i++) result.add(text.slice(Math.floor(i * length / count), Math.floor(i * length / count) + 4));
  return result;
}
function jaccard(a: Set<string>, b: Set<string>): number {
  if (!a.size || !b.size) return 0;
  let intersection = 0;
  for (const token of a) if (b.has(token)) intersection++;
  return intersection / (a.size + b.size - intersection);
}
function ordered(values: Iterable<string>): string[] { return [...new Set(values)].sort(); }
function equalValues(a: string[], b: string[]): boolean { return JSON.stringify(a) === JSON.stringify(b); }
function versions(document: DedupDocument): string[] {
  const text = `${document.title ?? ''}\n${document.filename ?? ''}\n${bodyOf(document)}`;
  return ordered([...(document.version ? [normalizeText(document.version).toLowerCase()] : []), ...Array.from(text.matchAll(/(?:\b(?:v(?:er(?:sion)?)?|rev(?:ision)?)\s*[.:：-]?\s*|版本\s*[:：]?\s*)(\d+(?:\.\d+){0,3}(?:[-_][a-z0-9]+)?)/gi), match => match[1].toLowerCase())]);
}
function dates(document: DedupDocument): string[] {
  const text = `${document.title ?? ''}\n${document.filename ?? ''}\n${bodyOf(document)}`;
  return ordered([...(document.date ? [normalizeText(document.date)] : []), ...Array.from(text.matchAll(/\b(?:19|20)\d{2}(?:[-/.年](?:0?[1-9]|1[0-2])(?:[-/.月](?:0?[1-9]|[12]\d|3[01])日?)?)?\b/g), match => match[0])]);
}
function models(document: DedupDocument): string[] {
  const title = `${document.title ?? ''} ${document.filename ?? ''}`;
  const explicit = Array.from(bodyOf(document).matchAll(/(?:型号|model(?:\s+name)?)\s*[:：]\s*([A-Za-z][A-Za-z0-9._-]*)/gi), match => match[1]);
  const tableModels = parsedOf(document).tables.flatMap(table => table.rows.filter(row => /^(?:产品)?型号$|^model(?: name)?$/i.test(normalizeText(row[0] ?? ''))).map(row => row[1] ?? '')).filter(Boolean);
  const titleModels = `${title}\n${bodyOf(document)}`.match(/\b[A-Za-z][A-Za-z_-]*\d+[A-Za-z0-9._-]*\b/g) ?? [];
  return ordered([...explicit, ...tableModels, ...titleModels].filter(model => !/^(?:v|ver|version|rev)\d/i.test(model)).map(value => normalizeText(value).toLowerCase()));
}
function numbers(document: DedupDocument): string[] {
  // Retain number + unit, case, sign, exponent and multiplicity. A changed unit
  // or an added repeated device quantity must not become a near duplicate.
  return (normalizeText(bodyOf(document)).match(/[+-]?\d+(?:[.,]\d+)*(?:[eE][+-]?\d+)?\s*(?:[a-zA-Zµμ°%²³]+(?:\/[a-zA-Zµμ²³]+)?|[\p{Script=Han}]{1,8})?/gu) ?? []).map(value => value.replace(/\s+/g, ''));
}
function baseTitle(document: DedupDocument): string {
  return normalizeText(document.title || document.filename || '').toLowerCase()
    .replace(/\.(?:pdf|docx?|xlsx?|pptx?|txt|md|html?)$/i, '')
    .replace(/\b(?:v(?:er(?:sion)?)?|rev(?:ision)?)\s*[.:：-]?\s*\d+(?:\.\d+)*/g, '')
    .replace(/(?:19|20)\d{2}(?:[-/.年]\d{1,2}(?:[-/.月]\d{1,2}日?)?)?/g, '')
    .replace(/(?:最终版|最新版|旧版|新版|副本|拷贝|copy)|[（(]\d+[）)]/g, '').replace(/\s+/g, '').trim();
}
function historical(document: DedupDocument): boolean {
  return /^(?:historical_solution|solution|case|implementation_document|contract_or_requirement|test_report|acceptance_report)$/.test(document.documentType ?? '') || /(?:方案|项目|案例|客户|solution|proposal|project)/i.test(`${document.title ?? ''} ${document.filename ?? ''}`);
}
function projectFields(document: DedupDocument): string[] {
  return ordered(Array.from(bodyOf(document).matchAll(/(?:客户(?:名称|名)?|项目(?:名称|名)?|场地|地点|设备数量|数量|customer|client|project|site|quantity)\s*[:：]\s*([^\n\r;；|]+)/gi), match => normalizeText(match[0])));
}
function differences(a: DedupDocument, b: DedupDocument): DocumentDifference[] {
  const result: DocumentDifference[] = [];
  const add = (kind: DocumentDifference['kind'], location: string, before: string, after: string) => {
    if (normalizeText(before) === normalizeText(after) || result.length >= 12) return;
    let common = 0;
    while (common < Math.min(before.length, after.length) && before[common] === after[common]) common++;
    const start = Math.max(0, common - 80);
    const excerpt = (text: string) => `${start ? '…' : ''}${text.slice(start, start + 240)}${text.length > start + 240 ? '…' : ''}`;
    result.push({ kind, location, before: excerpt(before), after: excerpt(after) });
  };
  add('version', 'title / filename / version / plainText', versions(a).join(', '), versions(b).join(', '));
  add('date', 'title / filename / date / plainText', dates(a).join(', '), dates(b).join(', '));
  add('model', 'title / filename / plainText:model', models(a).join(', '), models(b).join(', '));
  add('project', 'plainText:project fields', projectFields(a).join('; '), projectFields(b).join('; '));
  const at = parsedOf(a).tables, bt = parsedOf(b).tables;
  for (let table = 0; table < Math.max(at.length, bt.length) && result.length < 12; table++) {
    const ar = at[table]?.rows ?? [], br = bt[table]?.rows ?? [];
    for (let row = 0; row < Math.max(ar.length, br.length) && result.length < 12; row++) {
      for (let cell = 0; cell < Math.max(ar[row]?.length ?? 0, br[row]?.length ?? 0) && result.length < 12; cell++) {
        add('table', `tables[${table}].rows[${row}][${cell}]`, ar[row]?.[cell] ?? '', br[row]?.[cell] ?? '');
      }
    }
  }
  const al = parsedOf(a).plainText.split(/\r?\n/), bl = parsedOf(b).plainText.split(/\r?\n/);
  for (let line = 0; line < Math.max(al.length, bl.length) && result.length < 12; line++) {
    const before = (al[line] ?? '').trim(), after = (bl[line] ?? '').trim();
    add(/\d/.test(before + after) ? 'number' : 'text', `plainText:line ${line + 1}`, before, after);
  }
  return result;
}

export class LexicalDuplicateDetector implements DuplicateDetector {
  async compare(a: DedupDocument, b: DedupDocument): Promise<DuplicateAssessment> {
    if (a.contentHash && b.contentHash && a.contentHash === b.contentHash) return { relation: 'exact_duplicate', score: 1, reasons: ['exact_content_hash'] };
    const ah = textHash(a), bh = textHash(b);
    const history = historical(a) || historical(b);
    const modelChanged = models(a).length > 0 && models(b).length > 0 && !equalValues(models(a), models(b));
    const productChanged = !!a.products?.length && !!b.products?.length && !a.products.some(product => b.products!.some(other => normalizeText(other).toLowerCase() === normalizeText(product).toLowerCase()));
    const versionChanged = !equalValues(versions(a), versions(b));
    const dateChanged = !equalValues(dates(a), dates(b));
    const quantityChanged = !equalValues(numbers(a), numbers(b));
    const projectChanged = !equalValues(projectFields(a), projectFields(b)) || (history && !!a.title && !!b.title && baseTitle(a) !== baseTitle(b));
    // Metadata carrying a new model/version/project is material even when an
    // exported body is unchanged. Binary identity above remains definitive.
    if (ah && ah === bh && !modelChanged && !productChanged && !versionChanged && !dateChanged && !projectChanged) return { relation: 'content_duplicate', score: 1, reasons: ['normalized_content_hash'] };
    const textSimilarity = jaccard(shingles(bodyOf(a)), shingles(bodyOf(b)));
    const titleSimilarity = jaccard(shingles(baseTitle(a)), shingles(baseTitle(b)));
    const score = Math.round(Math.min(1, textSimilarity * .9 + titleSimilarity * .1) * 10000) / 10000;
    const change = differences(a, b);
    const result = (relation: DuplicateAssessment['relation'], reasons: string[]): DuplicateAssessment => ({ relation, score, reasons, ...(change.length ? { differences: change } : {}) });
    if (!substantial(parsedOf(a)) || !substantial(parsedOf(b))) return result('none', ['insufficient_content']);
    if (modelChanged || productChanged) return result(textSimilarity >= .6 ? 'similar' : 'none', ['different_product_model']);
    if (history && (projectChanged || quantityChanged || dateChanged || versionChanged || ah !== bh)) return result(textSimilarity >= .55 ? 'similar' : 'none', ['template_similarity', 'historical_project_facts_require_review']);
    const identity = titleSimilarity >= .72 || (!!a.products?.length && a.products.some(product => b.products?.includes(product))) || (models(a).length > 0 && equalValues(models(a), models(b)));
    if (identity && textSimilarity >= .65 && (quantityChanged || versionChanged || dateChanged)) return result('possible_version', ['same_document_identity', ...(versionChanged ? ['version_changed'] : []), ...(dateChanged ? ['date_changed'] : []), ...(quantityChanged ? ['critical_values_changed'] : [])]);
    if (quantityChanged || versionChanged || dateChanged) return result(score >= .6 ? 'similar' : 'none', ['material_values_differ', 'version_identity_unconfirmed']);
    if (score >= .95 && textSimilarity >= .95) return result('near_duplicate', ['high_lexical_similarity']);
    if (score >= .8 && identity) return result('possible_version', ['same_document_identity', 'substantial_text_overlap']);
    return result(score >= .65 ? 'similar' : 'none', [score >= .65 ? 'lexical_similarity' : 'low_lexical_similarity']);
  }
}

export function blockingKeys(document: DedupDocument): string[] {
  const keys: string[] = [];
  if (document.contentHash) keys.push(`exact:${document.contentHash}`);
  const normalized = textHash(document);
  if (normalized) keys.push(`normalized:${normalized}`);
  const title = baseTitle(document);
  if (title) keys.push(`title:${title}`);
  const tokens = title.match(/[a-z]+\d*[a-z0-9_-]*|[\p{Script=Han}]{2}/gu) ?? [];
  for (const token of ordered(tokens).slice(0, 6)) keys.push(`title-token:${token}`);
  for (const product of ordered(document.products ?? []).slice(0, 8)) keys.push(`product:${normalizeText(product).toLowerCase()}`);
  for (const topic of ordered(document.topics ?? []).slice(0, 6)) keys.push(`topic:${document.documentType ?? ''}:${normalizeText(topic).toLowerCase()}`);
  if (document.documentType && document.documentType !== 'unknown') keys.push(`type:${document.documentType}`);
  const hashes = [...shingles(bodyOf(document))].filter(value => value.trim()).map(hash32).sort((a, b) => a - b);
  // Bottom lexical hashes create source-independent buckets without embeddings.
  for (const hash of [...new Set(hashes)].slice(0, 8)) keys.push(`lexical:${hash}`);
  return ordered(keys);
}

export function generateCandidatePairs(documents: DedupDocument[], options: CandidateOptions = {}): CandidateResult {
  const limit = (value: number | undefined, fallback: number, ceiling: number) => value === undefined ? fallback : Math.max(1, Math.min(ceiling, Math.floor(Number.isFinite(value) ? value : fallback)));
  const maxPairs = limit(options.maxPairs, 25000, 100000);
  const perDocument = limit(options.maxPairsPerDocument, 32, 256);
  const maxBucketSize = limit(options.maxBucketSize, 64, 256);
  const neighbors = limit(options.oversizedBucketNeighbors, 8, 32);
  const focus = options.focusDocumentIds === undefined ? null : new Set(options.focusDocumentIds);
  const byId = new Map(documents.map(document => [document.id, document]));
  const buckets = new Map<string, string[]>();
  for (const id of [...byId.keys()].sort()) for (const key of blockingKeys(byId.get(id)!)) {
    const bucket = buckets.get(key) ?? []; bucket.push(id); buckets.set(key, bucket);
  }
  const pairs = new Map<string, [string, string]>(), counts = new Map<string, number>();
  let truncated = false, oversizedBuckets = 0, largestEligibleBucketPairs = 0;
  const eligibleBuckets = [...buckets.entries()].filter(([, ids]) => ids.length > 1 && (!focus || ids.some(id => focus.has(id))));
  // Hash matches and narrow buckets precede broad document-type buckets.
  eligibleBuckets.sort(([ak, a], [bk, b]) => Number(!/^(exact|normalized):/.test(ak)) - Number(!/^(exact|normalized):/.test(bk)) || a.length - b.length || ak.localeCompare(bk));
  for (const [, ids] of eligibleBuckets) {
    const focused = focus ? ids.filter(id => focus.has(id)).length : ids.length;
    const possible = focus ? focused * (ids.length - focused) + focused * (focused - 1) / 2 : ids.length * (ids.length - 1) / 2;
    largestEligibleBucketPairs = Math.max(largestEligibleBucketPairs, possible);
    if (ids.length > maxBucketSize) { oversizedBuckets++; truncated = true; }
  }
  outer: for (const [, ids] of eligibleBuckets) {
    const oversized = ids.length > maxBucketSize;
    for (let i = 0; i < ids.length; i++) {
      if (focus && !focus.has(ids[i])) continue;
      const attempts = oversized ? Math.min(neighbors, ids.length - 1) : ids.length - 1;
      for (let offset = 1; offset <= attempts; offset++) {
        const j = (i + offset) % ids.length;
        if (!focus && !oversized && j <= i) continue;
        const pair: [string, string] = ids[i] < ids[j] ? [ids[i], ids[j]] : [ids[j], ids[i]];
        const key = JSON.stringify(pair);
        if (pairs.has(key)) continue;
        if (pairs.size >= maxPairs) { truncated = true; break outer; }
        if ((counts.get(pair[0]) ?? 0) >= perDocument || (counts.get(pair[1]) ?? 0) >= perDocument) { truncated = true; continue; }
        pairs.set(key, pair);
        for (const id of pair) counts.set(id, (counts.get(id) ?? 0) + 1);
      }
    }
  }
  return { pairs: [...pairs.values()].sort((a, b) => a[0].localeCompare(b[0]) || a[1].localeCompare(b[1])), truncated,
    stats: { documentCount: byId.size, bucketCount: eligibleBuckets.length, oversizedBuckets, candidatePairs: pairs.size, maxPairs, skippedComparisonsLowerBound: Math.max(0, largestEligibleBucketPairs - pairs.size) } };
}
