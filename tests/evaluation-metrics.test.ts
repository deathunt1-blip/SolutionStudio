import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { Classification } from '../packages/core/src/types.js';
import { compareEvaluationRuns, computeMetrics } from '../packages/evaluation/src/metrics.js';
import { csvCell, evaluationReportPaths, withExclusiveReportLocks, writeEvaluationReports } from '../packages/evaluation/src/reporting.js';
import type { EvaluationLabel, EvaluationResult, EvaluationRun } from '../packages/evaluation/src/types.js';

function classification(type = 'solution', authority: Classification['authority']['value'] = 'reference', confidence = 0.9): Classification {
 const field = <T>(value: T) => ({ value, confidence, source: 'ai' as const });
 return { documentType: field(type), authority: field(authority), applications: field([] as string[]), topics: field([] as string[]), products: field([] as string[]), language: field('zh') };
}
function doc(id: string, overrides: Partial<EvaluationResult> = {}): EvaluationResult {
 const label: EvaluationLabel = { documentId: id, filename: `${id}.txt`, contentHash: id.padEnd(64, 'a'), documentType: 'solution', authority: 'reference', labeledBy: 'synthetic-test', labeledAt: '2026-09-22T00:00:00.000Z', origin: 'human' };
 return { documentId: id, filename: label.filename, contentHash: label.contentHash, repetition: 1, parseStatus: 'success', parseWarnings: [],
  expected: label, predicted: classification(), finalStatus: 'active', autoAccepted: true, reviewReasons: [], warnings: [], usedConfirmedExamples: [],
  timings: { parseMs: 10, classifyMs: 100, totalMs: 110 }, usage: { inputTokens: 100, outputTokens: 10 }, ...overrides };
}
function run(documents: EvaluationResult[], overrides: Partial<EvaluationRun> = {}): EvaluationRun {
 return { schemaVersion: 1, id: 'synthetic-baseline', datasetId: 'synthetic-unit-tests', createdAt: '2026-09-22T00:00:00.000Z', updatedAt: '2026-09-22T00:00:00.000Z', status: 'completed',
  provider: 'synthetic', model: 'fixture', temperature: 0, maxTokens: 3000, classificationVersion: 'v1', classificationPromptVersion: 'p1', classificationRuleVersion: 'r1',
  thresholds: { review: 0.6, autoAccept: 0.85 }, gatePolicy: 'production-review-threshold', examplesMode: 'without', isolateEvaluation: true, repeat: 1,
  manifestHash: 'manifest', labelsHash: 'labels', contextHash: 'context', configurationHash: 'configuration', codeHash: 'code', budgetCny: 1, reservedCostCny: 0,
  prices: { inputPerMillionCny: 6.5, outputPerMillionCny: 27 }, plannedDocuments: new Set(documents.map(doc => doc.documentId)).size, plannedResults: documents.length, documents, ...overrides };
}

describe('evaluation metrics use explicit human-label and acceptance denominators', () => {
 it('separates wrong reviewed from wrong accepted, parsing failures and unlabelled acceptance', () => {
  const data = [doc('correct'), doc('unsafe', { predicted: classification('manual', 'authoritative') }),
   doc('safe', { predicted: classification('test_report'), finalStatus: 'needs_review', autoAccepted: false, reviewReasons: ['low confidence'] }),
   doc('unlabelled', { expected: undefined }), doc('scan', { parseStatus: 'failed', predicted: undefined, finalStatus: 'failed', autoAccepted: false })];
  const m = computeMetrics(run(data));
  expect(m.counts).toMatchObject({ documents: 5, readable: 4, labeledReadable: 3, failed: 1 });
  expect(m.documentType.accuracy).toBeCloseTo(1 / 3);
  expect(m.authority.accuracy).toBeCloseTo(2 / 3);
  expect(m.acceptance).toMatchObject({ autoAccepted: 3, labeledAutoAccepted: 2, wrongAndAutoAccepted: 1, wrongButReviewed: 1, falseAutoAcceptRate: 0.5 });
  expect(m.acceptance.falseAutoAcceptPerLabeledReadable).toBeCloseTo(1 / 3);
  expect(m.acceptance.autoAcceptanceRate).toBe(0.75);
  expect(m.documentType.confusionMatrix.solution).toMatchObject({ solution: 1, manual: 1, test_report: 1 });
  expect(m.documentType.classes).toContain('style_sample');
  expect(m.documentType.perClass.find(row => row.key === 'manual')).toMatchObject({ support: 0, precision: 0, recall: null });
  expect(m.highRiskErrors.map(row => row.documentId)).toEqual(['unsafe']);
  expect(m.highRiskErrors[0]!.suggestedErrorCategories).toContainEqual(expect.objectContaining({ category: 'authority_overconfidence' }));
 });
 it('returns null rather than zero for unlabelled accuracy and empty acceptance denominator', () => {
  const m = computeMetrics(run([doc('unlabelled', { expected: undefined })]));
  expect(m.documentType.accuracy).toBeNull(); expect(m.authority.accuracy).toBeNull(); expect(m.acceptance.falseAutoAcceptRate).toBeNull();
  expect(m.documentType.perClass.every(row => row.precision === null && row.recall === null)).toBe(true);
  expect(m.methodology.realHumanEvaluation).toBe(false);
  const empty = computeMetrics(run([]));
  expect(empty.counts.parseFailureRate).toBeNull(); expect(empty.cost.averageInputTokens).toBeNull(); expect(empty.timings.total.p95).toBeNull();
  expect(JSON.stringify(empty)).not.toContain('NaN');
 });
 it('counts missing classification on a readable labeled document as incorrect, while preserving missing outputs', () => {
  const m = computeMetrics(run([doc('failed-classification', { predicted: undefined, finalStatus: 'failed', autoAccepted: false })]));
  expect(m.documentType.accuracy).toBe(0); expect(m.documentType.confusionMatrix.solution?.['(no prediction)']).toBe(1);
  expect(m.acceptance.reviewRate).toBe(0); expect(m.acceptance.wrongWithClassificationFailure).toBe(1);
 });
 it('treats a human unknown as a valid label and rejects mismatched or non-human label provenance', () => {
  const unknown = doc('unknown'); unknown.expected!.documentType = 'unknown'; unknown.expected!.authority = 'unknown'; unknown.predicted = classification('unknown', 'unknown'); unknown.finalStatus = 'needs_review'; unknown.autoAccepted = false;
  expect(computeMetrics(run([unknown])).documentType.accuracy).toBe(1);
  const mismatch = doc('bad'); mismatch.expected!.contentHash = 'different';
  expect(() => computeMetrics(run([mismatch]))).toThrow(/Ground truth/);
  const fake = doc('fake'); fake.expected!.origin = 'ai' as 'human';
  expect(() => computeMetrics(run([fake]))).toThrow(/provenance/);
 });
});

describe('confidence, thresholds, optional annotations, and grounding', () => {
 it('includes exact confidence boundaries and simulates joint versus authority-only gates', () => {
  const confidences = [0.59, 0.6, 0.69, 0.7, 0.79, 0.8, 0.89, 0.9, 1];
  const m = computeMetrics(run(confidences.map((confidence, index) => doc(`c${index}`, { predicted: classification('solution', 'reference', confidence) }))));
  expect(m.confidence.documentType.map(bucket => bucket.count)).toEqual([1, 2, 2, 2, 2]);
  expect(m.thresholdSimulation.joint.map(row => row.autoAccepted)).toEqual([4, 3, 2, 1]);
  const cautious = doc('authority', { predicted: classification('solution', 'reference', 0.95) }); cautious.predicted!.documentType.confidence = 0.86;
  const unknown = doc('unknown-authority', { predicted: classification('solution', 'unknown', 1) });
  const thresholds = computeMetrics(run([cautious, unknown])).thresholdSimulation;
  expect(thresholds.joint.find(row => row.documentTypeThreshold === 0.9)?.autoAccepted).toBe(0);
  expect(thresholds.authoritySpecific.find(row => row.authorityThreshold === 0.9)?.autoAccepted).toBe(1);
 });
 it('only scores explicitly annotated optional fields; empty annotations catch invented products', () => {
  const exact = doc('exact'); exact.expected!.products = ['K18']; exact.predicted!.products.value = ['K18', 'K18', 'WRONG']; exact.productGrounding = { predicted: ['K18', 'WRONG'], ungrounded: ['WRONG'] };
  const unchecked = doc('unchecked'); unchecked.predicted!.products.value = ['CHINGMU K18'];
  const empty = doc('empty'); empty.expected!.products = []; empty.predicted!.products.value = ['EXTRA'];
  const missed = doc('missed'); missed.expected!.products = ['K18相机'];
  const m = computeMetrics(run([exact, unchecked, empty, missed]));
  expect(m.optionalFields.products).toMatchObject({ annotatedDocuments: 3, truePositive: 1, falsePositive: 2, falseNegative: 1 });
  expect(m.optionalFields.products.precision).toBeCloseTo(1 / 3); expect(m.optionalFields.products.recall).toBe(0.5);
  expect(m.optionalFields.topics.precision).toBeNull(); expect(m.optionalFields.topics.annotatedDocuments).toBe(0);
  expect(m.productGrounding.groundedFraction).toBe(0.5);
  expect(m.productGrounding.normalizationCandidates).toContainEqual({ token: 'K18', values: ['K18', 'CHINGMU K18', 'K18相机'] });
 });
 it('reports shared examples as associations with explicit noncausal attribution', () => {
  const a = doc('a', { usedConfirmedExamples: ['example-1'] }), b = doc('b', { usedConfirmedExamples: ['example-1'], predicted: classification('manual') });
  const m = computeMetrics(run([a, b]));
  expect(m.exampleAssociations[0]).toMatchObject({ exampleId: 'example-1', labeledUses: 2, wrongDocuments: 1, errorRateAmongLabeledUses: 0.5 });
  expect(m.misclassifications[0]!.attributionStatus).toContain('not established causes');
 });
});

describe('repetitions, usage, and strict paired comparisons', () => {
 it('counts documents once, attempts in cost, and detects instability without inventing independent samples', () => {
  const docs = Array.from({ length: 10 }, (_, index) => [1, 2, 3].map(repetition => doc(`r${index}`, { repetition, predicted: classification(index === 0 && repetition === 2 ? 'manual' : 'solution') }))).flat();
  const m = computeMetrics(run(docs, { repeat: 3 }));
  expect(m.counts).toMatchObject({ documents: 10, attempts: 30, labeledReadable: 10 }); expect(m.documentType.accuracy).toBe(1);
  expect(m.stability).toMatchObject({ eligibleDocuments: 10, sufficientForRequestedProtocol: true, typeDriftDocuments: 1, authorityDriftDocuments: 0 });
  expect(m.cost).toMatchObject({ inputTokens: 3000, outputTokens: 300, totalTokens: 3300 });
  expect(m.cost.estimatedCostCny).toBeCloseTo(0.0276); expect(m.cost.projected100DocumentsCny).toBeCloseTo(0.092);
  expect(() => computeMetrics(run([docs[0]!, docs[0]!]))).toThrow(/Duplicate/);
 });
 it('uses nearest-rank latency percentiles and exposes unknown usage instead of a false zero bill', () => {
  const docs = Array.from({ length: 20 }, (_, i) => doc(`latency${i}`, { timings: { parseMs: i + 1, classifyMs: (i + 1) * 2, totalMs: (i + 1) * 3 }, usage: undefined }));
  const m = computeMetrics(run(docs, { provider: 'kimi', reservations: [{ documentId: 'latency0', repetition: 1, reservedCny: 0.2, startedAt: '2026-09-22' }] }));
  expect(m.timings.parse).toMatchObject({ mean: 10.5, p50: 10, p90: 18, p95: 19 });
  expect(m.cost.estimatedCostCny).toBeNull(); expect(m.cost.usageMissingAttempts).toBe(20); expect(m.cost.unsettledReservedCny).toBe(0.2);
 });
 it('compares only identical completed pairs and rejects altered labels, versions and omissions', () => {
  const baseline = run([doc('a'), doc('b')]), experiment = structuredClone(baseline); experiment.id = 'synthetic-experiment'; experiment.temperature = 0.6;
  const comparison = compareEvaluationRuns(baseline, experiment);
  expect(comparison.pairedDocuments).toBe(2); expect(comparison.changes.map(change => change.axis)).toEqual(['temperature']);
  expect(comparison.isolatedSingleChange).toBe(false); expect(comparison.confounds.join('')).toContain('synthetic');
  for (const change of [(r: EvaluationRun) => { r.status = 'budget_stopped'; }, (r: EvaluationRun) => { r.labelsHash = 'other'; },
   (r: EvaluationRun) => { r.documents.pop(); }, (r: EvaluationRun) => { r.documents[0]!.contentHash = 'other'; r.documents[0]!.expected!.contentHash = 'other'; },
   (r: EvaluationRun) => { r.documents[0]!.expected!.authority = 'unknown'; }, (r: EvaluationRun) => { r.documents[0]!.parseStatus = 'partial'; }]) {
   const incompatible = structuredClone(experiment); change(incompatible); expect(() => compareEvaluationRuns(baseline, incompatible)).toThrow();
  }
 });
 it('flags multiple changed axes rather than attributing a metric change to one experiment', () => {
  const baseline = run([doc('a')]), experiment = structuredClone(baseline); experiment.temperature = 0.6; experiment.examplesMode = 'with'; experiment.classificationPromptVersion = 'p2';
  expect(compareEvaluationRuns(baseline, experiment).confounds.join('')).toContain('Multiple experimental axes');
 });
});

describe('local report artifacts', () => {
 it('refuses standalone reporting over a locked checkpoint and releases only owned locks', async () => {
  const root = await mkdtemp(join(tmpdir(), 'solution-eval-report-lock-')), path = join(root, 'run.json');
  try {
   await withExclusiveReportLocks([path, path], async () => {
    await expect(withExclusiveReportLocks([path], async () => undefined)).rejects.toThrow(/locked/);
    expect(await readFile(`${path}.lock`, 'utf8')).toContain('evaluation-report');
   });
   await expect(readFile(`${path}.lock`, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
   expect(() => evaluationReportPaths(join(root, 'report.md'))).toThrow(/json extension/);
  } finally { await rm(root, { recursive: true, force: true }); }
 });
 it('writes independent matrix names per run, null metrics in JSON and spreadsheet-safe cells', async () => {
  const root = await mkdtemp(join(tmpdir(), 'solution-eval-reports-'));
  try {
   const runA = run([doc('unlabelled', { expected: undefined })]), pathA = join(root, 'a.json'), pathB = join(root, 'b.json');
   await writeEvaluationReports(runA, pathA); await writeEvaluationReports(runA, pathB);
   const pathsA = evaluationReportPaths(pathA), pathsB = evaluationReportPaths(pathB);
   expect(pathsA.documentTypeCsv).not.toBe(pathsB.documentTypeCsv);
   const persisted = JSON.parse(await readFile(pathA, 'utf8'));
   expect(persisted.metrics.documentType.accuracy).toBeNull();
   expect(await readFile(pathsA.markdown, 'utf8')).toContain('未评估');
   expect(await readFile(pathsA.documentTypeCsv, 'utf8')).toContain('style_sample');
   expect(csvCell('=HYPERLINK("evil")')).toBe('"\'=HYPERLINK(""evil"")"');
   expect(csvCell('  +cmd')).toBe('"\'  +cmd"'); expect(csvCell('\t@cmd')).toBe('"\'\t@cmd"'); expect(csvCell('safe')).toBe('"safe"');
  } finally { await rm(root, { recursive: true, force: true }); }
 });
});
