import { describe, expect, it } from 'vitest';
import type { ParsedDocument } from '../packages/core/src/types.js';
import { blockingKeys, generateCandidatePairs, LexicalDuplicateDetector, normalizedContentHash } from '../packages/deduplication/src/detector.js';
import type { DedupDocument } from '../packages/deduplication/src/types.js';

const description = '设备使用同步采集系统，支持多相机共同标定。按照安装说明配置网络，校验采集结果，并保存诊断日志用于后续检查。';
const parsed = (plainText: string, tables: ParsedDocument['tables'] = []): ParsedDocument => ({ plainText, tables, blocks: [], metadata: {}, parseWarnings: [], parseStatus: 'success' });
const doc = (id: string, text: string, extra: Partial<DedupDocument> = {}): DedupDocument => ({ id, title: 'K18产品技术规格书', documentType: 'product_document', parsedDocument: parsed(text), ...extra });
const detector = new LexicalDuplicateDetector();

describe('normalized content fingerprint', () => {
  it('does not fingerprint empty, whitespace, punctuation or extremely short bodies', async () => {
    for (const text of ['', '   \n\t', '---.............', '产品K18说明']) {
      expect(normalizedContentHash(parsed(text))).toBeNull();
      expect((await detector.compare(doc('a', text), doc('b', text))).relation).toBe('none');
    }
    expect((await detector.compare(doc('a', '', { normalizedContentHash: 'legacy-empty' }), doc('b', '', { normalizedContentHash: 'legacy-empty' }))).relation).toBe('none');
  });
  it('normalizes Unicode and whitespace without erasing number or unit boundaries', () => {
    const a = parsed(`Cafe\u0301 ${description} 频率 200 Hz\r\n温度 25 °C`);
    const b = parsed(`Café\t ${description}\n频率 200\tHz 温度 25 °C`);
    expect(normalizedContentHash(a)).toBe(normalizedContentHash(b));
    expect(normalizedContentHash(parsed(`${description} 型号 A B`))).not.toBe(normalizedContentHash(parsed(`${description} 型号 AB`)));
    expect(normalizedContentHash(parsed(`${description} 功率 10 MW`))).not.toBe(normalizedContentHash(parsed(`${description} 功率 10 mW`)));
    expect(normalizedContentHash(parsed(`${description} 面积 10 m²`))).not.toBe(normalizedContentHash(parsed(`${description} 面积 10 m2`)));
  });
  it('retains cells, rows and tables rather than concatenating scalar values', () => {
    const hash = (tables: ParsedDocument['tables']) => normalizedContentHash(parsed(description, tables));
    expect(hash([{ rows: [['ab', 'c']] }])).not.toBe(hash([{ rows: [['a', 'bc']] }]));
    expect(hash([{ rows: [['a', 'b'], ['c', 'd']] }])).not.toBe(hash([{ rows: [['a', 'b', 'c', 'd']] }]));
    expect(hash([{ rows: [['a'], ['b']] }])).not.toBe(hash([{ rows: [['a']] }, { rows: [['b']] }]));
    expect(hash([{ rows: [['a', '']] }])).not.toBe(hash([{ rows: [['a']] }]));
  });
  it('does not normalize away dates, quantities, units or model numbers', () => {
    for (const [before, after] of [['2025', '2026'], ['200 Hz', '250 Hz'], ['200 Hz', '200 MHz'], ['K18', 'K19'], ['10 m²', '10 m³']]) {
      expect(normalizedContentHash(parsed(description + before))).not.toBe(normalizedContentHash(parsed(description + after)));
    }
  });
});

describe('lexical duplicate and version assessment', () => {
  it('recognizes binary identity before parsing, including an empty file', async () => {
    expect(await detector.compare({ id: 'a', contentHash: 'same' }, { id: 'b', contentHash: 'same' })).toMatchObject({ relation: 'exact_duplicate', score: 1 });
    expect((await detector.compare(doc('a', description, { contentHash: 'a' }), doc('b', description, { contentHash: 'b' }))).relation).toBe('content_duplicate');
  });
  it('accepts a whitespace-only reexport as a content duplicate', async () => {
    expect((await detector.compare(doc('a', `${description}\n采样 200 Hz`), doc('b', `${description}   采样\t200 Hz`))).relation).toBe('content_duplicate');
  });
  it.each([['200 Hz', '250 Hz'], ['200 Hz', '200 MHz'], ['10 MW', '10 mW'], ['20公里', '20千米']])('treats critical change %s → %s as a possible version', async (before, after) => {
    const result = await detector.compare(doc('a', `${description}\n最大采样：${before}`), doc('b', `${description}\n最大采样：${after}`));
    expect(result.relation).toBe('possible_version');
    expect(result.reasons).toContain('critical_values_changed');
    expect(result.differences).toEqual(expect.arrayContaining([expect.objectContaining({ kind: 'number', location: 'plainText:line 2', before: `最大采样：${before}`, after: `最大采样：${after}` })]));
  });
  it('does not mistake swapped parameter values for the same facts', async () => {
    const a = doc('a', description, { parsedDocument: parsed(description, [{ rows: [['速度', '100'], ['距离', '200']] }]) });
    const b = doc('b', description, { parsedDocument: parsed(description, [{ rows: [['速度', '200'], ['距离', '100']] }]) });
    const result = await detector.compare(a, b);
    expect(result.relation).toBe('possible_version');
    expect(result.differences).toEqual(expect.arrayContaining([expect.objectContaining({ kind: 'table', location: 'tables[0].rows[0][1]', before: '100', after: '200' })]));
  });
  it.each([['K18规格书2025', 'K18规格书2026', 'date_changed'], ['K18技术说明 V1', 'K18技术说明 V2', 'version_changed']])('detects title metadata changes for %s', async (before, after, reason) => {
    const result = await detector.compare(doc('a', description, { title: before }), doc('b', description, { title: after }));
    expect(result.relation).toBe('possible_version');
    expect(result.reasons).toContain(reason);
  });
  it('prevents different models being treated as versions or duplicates', async () => {
    for (const title of [true, false]) {
      const a = doc('a', `${description}\n产品 K18 技术参数`, { title: title ? 'K18技术规格书' : '产品技术规格书' });
      const b = doc('b', `${description}\n产品 K19 技术参数`, { title: title ? 'K19技术规格书' : '产品技术规格书' });
      expect(await detector.compare(a, b)).toMatchObject({ relation: 'similar', reasons: ['different_product_model'] });
    }
  });
  it('protects explicit alphabetic model names in body fields and tables', async () => {
    for (const inTable of [false, true]) {
      const modelDoc = (id: string, model: string) => doc(id, inTable ? description : `${description}\n型号：${model}`, {
        title: '产品技术规格书', ...(inTable ? { parsedDocument: parsed(description, [{ rows: [['型号', model]] }]) } : {}),
      });
      expect(await detector.compare(modelDoc('a', 'Prime'), modelDoc('b', 'Flex'))).toMatchObject({ relation: 'similar', reasons: ['different_product_model'] });
    }
  });
  it.each([['客户：甲方公司', '客户：乙方公司'], ['项目：无人机测试', '项目：机械臂测试'], ['场地：北京', '场地：上海'], ['设备数量：10台', '设备数量：20台'], ['日期：2025-05-01', '日期：2026-05-01']])('caps historical project changes at template similarity: %s', async (before, after) => {
    const a = doc('a', `${description}\n${before}`, { title: '无人机方案', documentType: 'solution' });
    const b = doc('b', `${description}\n${after}`, { title: '无人机方案', documentType: 'solution' });
    const result = await detector.compare(a, b);
    expect(result.relation).toBe('similar');
    expect(result.reasons).toContain('template_similarity');
  });
  it('uses conservative template protection for unlabelled customer edits and differing titles', async () => {
    const a = doc('a', `${description}本方案为甲公司安装系统。`, { title: '无人机方案', documentType: 'solution' });
    const b = doc('b', `${description}本方案为乙公司安装系统。`, { title: '无人机方案', documentType: 'solution' });
    expect((await detector.compare(a, b)).reasons).toContain('template_similarity');
    expect((await detector.compare({ ...a, title: '甲公司方案' }, { ...a, id: 'b', title: '乙公司方案' })).relation).toBe('similar');
  });
  it('is symmetric in relation, score and reasons while orienting value differences', async () => {
    const a = doc('a', `${description}\n帧率：200 Hz`), b = doc('b', `${description}\n帧率：250 Hz`);
    const ab = await detector.compare(a, b), ba = await detector.compare(b, a);
    expect({ ...ab, differences: undefined }).toEqual({ ...ba, differences: undefined });
    expect(ab.differences?.[0].before).toBe(ba.differences?.[0].after);
  });
});

describe('bounded deterministic candidate generation', () => {
  it('finds cross-source content and title/topic/product candidates', () => {
    const a = doc('a', description, { filename: 'export.pdf', products: ['K18'], topics: ['camera'] });
    const b = doc('b', description, { filename: 'upload.docx', products: ['K18'], topics: ['camera'] });
    expect(blockingKeys(a)).toEqual(expect.arrayContaining([`normalized:${normalizedContentHash(parsed(description))}`, 'product:k18', 'topic:product_document:camera']));
    expect(generateCandidatePairs([a, b])).toMatchObject({ pairs: [['a', 'b']], truncated: false });
  });
  it('is input-order stable, symmetric, unique and per-document bounded', () => {
    const documents = Array.from({ length: 150 }, (_, i) => doc(`doc-${String(i).padStart(3, '0')}`, description));
    const options = { maxPairs: 400, maxPairsPerDocument: 6 };
    const result = generateCandidatePairs(documents, options);
    expect(generateCandidatePairs([...documents].reverse(), options)).toEqual(result);
    expect(result.truncated).toBe(true);
    expect(result.pairs.length).toBeLessThanOrEqual(400);
    const counts = new Map<string, number>();
    for (const [a, b] of result.pairs) { expect(a < b).toBe(true); for (const id of [a, b]) counts.set(id, (counts.get(id) ?? 0) + 1); }
    expect(Math.max(...counts.values())).toBeLessThanOrEqual(6);
    expect(new Set(result.pairs.map(pair => JSON.stringify(pair))).size).toBe(result.pairs.length);
  });
  it('keeps 10,000 documents with a giant shared bucket bounded and reports omitted work', () => {
    const documents = Array.from({ length: 10000 }, (_, i) => doc(`doc-${String(i).padStart(5, '0')}`, description));
    const result = generateCandidatePairs(documents, { maxPairs: 5000 });
    expect(result.pairs).toHaveLength(5000);
    expect(result.truncated).toBe(true);
    expect(result.stats.documentCount).toBe(10000);
    expect(result.stats.oversizedBuckets).toBeGreaterThan(0);
    expect(result.stats.skippedComparisonsLowerBound).toBeGreaterThan(49000000);
  }, 15000);
  it('applies focus during generation so unrelated pairs cannot exhaust its budget', () => {
    const documents = Array.from({ length: 500 }, (_, i) => doc(`doc-${String(i).padStart(3, '0')}`, description));
    const result = generateCandidatePairs(documents, { focusDocumentIds: ['doc-499'], maxPairs: 5 });
    expect(result.pairs).toHaveLength(5);
    expect(result.pairs.every(pair => pair.includes('doc-499'))).toBe(true);
    expect(result.truncated).toBe(true);
    expect(generateCandidatePairs(documents, { focusDocumentIds: [] }).pairs).toEqual([]);
  });
});
