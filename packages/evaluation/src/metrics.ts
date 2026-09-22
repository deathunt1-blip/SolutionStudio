import type { EvaluationResult, EvaluationRun } from './types.js';

export const DOCUMENT_TYPES = ['product_document', 'technical_knowledge', 'solution', 'test_report', 'acceptance_report', 'implementation_document', 'standard', 'manual', 'case', 'style_sample', 'contract_or_requirement', 'other', 'unknown'];
export const AUTHORITIES = ['authoritative', 'reference', 'style_only', 'unknown'];
export const ERROR_CATEGORIES = ['filename_misleading', 'ambiguous_document', 'mixed_document', 'insufficient_evidence', 'authority_overconfidence', 'wrong_confirmed_example', 'registry_missing', 'alias_missing', 'prompt_failure', 'rule_override', 'llm_output_grounding_failure', 'parser_information_loss', 'unknown'];
const MISSING = '(no prediction)';
const divide = (numerator: number, denominator: number): number | null => denominator ? numerator / denominator : null;
const mean = (values: number[]) => values.length ? values.reduce((a, b) => a + b, 0) / values.length : null;
const sum = (values: number[]) => values.reduce((a, b) => a + b, 0);
const labeled = (doc: EvaluationResult) => Boolean(doc.expected?.origin === 'human');
const readable = (doc: EvaluationResult) => doc.parseStatus !== 'failed';
const accepted = (doc: EvaluationResult) => doc.autoAccepted && doc.finalStatus === 'active' && doc.reviewReasons.length === 0;
const correctType = (doc: EvaluationResult) => doc.predicted?.documentType.value === doc.expected?.documentType;
const correctAuthority = (doc: EvaluationResult) => doc.predicted?.authority.value === doc.expected?.authority;
const wrong = (doc: EvaluationResult) => !correctType(doc) || !correctAuthority(doc);
const resultKey = (doc: EvaluationResult) => JSON.stringify([doc.documentId, doc.repetition]);

/** Repetitions are correlated observations. Only the first observed trial per file contributes to headline metrics. */
function primaryDocuments(run: EvaluationRun): EvaluationResult[] {
 const first = new Map<string, EvaluationResult>(), keys = new Set<string>();
 for (const doc of run.documents) {
  if (keys.has(resultKey(doc))) throw new Error(`Duplicate evaluation result: ${doc.documentId} / ${doc.repetition}`);
  keys.add(resultKey(doc));
  if (!Number.isInteger(doc.repetition) || doc.repetition < 1 || doc.repetition > run.repeat) throw new Error('Invalid evaluation repetition');
  if (doc.expected && (doc.expected.origin !== 'human' || doc.expected.documentId !== doc.documentId || doc.expected.contentHash !== doc.contentHash)) throw new Error('Ground truth does not match the evaluated file version or human provenance');
  const earlier = first.get(doc.documentId);
  if (earlier && (earlier.contentHash !== doc.contentHash || stableJson(earlier.expected) !== stableJson(doc.expected))) throw new Error('A document changed content or ground truth between repetitions');
  if (!earlier || earlier.repetition > doc.repetition) first.set(doc.documentId, doc);
 }
 return [...first.values()];
}

function classificationMetrics(docs: EvaluationResult[], field: 'documentType' | 'authority', defaults: string[]) {
 const expected = (doc: EvaluationResult) => doc.expected![field];
 const predicted = (doc: EvaluationResult) => doc.predicted?.[field].value ?? MISSING;
 const classes = [...new Set([...defaults, ...docs.map(expected), ...docs.map(predicted)])];
 const matrix = Object.fromEntries(classes.map(actual => [actual, Object.fromEntries(classes.map(prediction => [prediction, 0]))]));
 for (const doc of docs) matrix[expected(doc)]![predicted(doc)]!++;
 const correct = docs.filter(doc => expected(doc) === predicted(doc)).length;
 return { labeled: docs.length, correct, accuracy: divide(correct, docs.length), classes, confusionMatrix: matrix,
  perClass: classes.map(key => {
   const actual = docs.filter(doc => expected(doc) === key), predictedDocs = docs.filter(doc => predicted(doc) === key);
   const truePositive = actual.filter(doc => predicted(doc) === key).length;
   return { key, support: actual.length, predicted: predictedDocs.length, correct: truePositive,
    precision: divide(truePositive, predictedDocs.length), recall: divide(truePositive, actual.length),
    reviewed: actual.filter(doc => doc.finalStatus === 'needs_review').length,
    falseAutoAccepted: actual.filter(doc => accepted(doc) && wrong(doc)).length };
  }) };
}

function confidenceBuckets(docs: EvaluationResult[], field: 'documentType' | 'authority') {
 return [[0, 0.6], [0.6, 0.7], [0.7, 0.8], [0.8, 0.9], [0.9, 1.000001]].map(([min, max], index) => {
  const subset = docs.filter(doc => doc.predicted && doc.predicted[field].confidence >= min! && doc.predicted[field].confidence < max!);
  const correct = subset.filter(doc => doc.predicted![field].value === doc.expected![field]).length;
  return { range: ['0.00–0.59', '0.60–0.69', '0.70–0.79', '0.80–0.89', '0.90–1.00'][index]!,
   count: subset.length, correct, accuracy: divide(correct, subset.length), averageConfidence: mean(subset.map(doc => doc.predicted![field].confidence)) };
 });
}

function acceptanceMetrics(docs: EvaluationResult[], accept: (doc: EvaluationResult) => boolean = accepted, simulated = false) {
 const labeledDocs = docs.filter(labeled), auto = docs.filter(accept), labeledAuto = auto.filter(labeled);
 const wrongAuto = labeledAuto.filter(wrong).length;
 const reviewed = docs.filter(doc => simulated ? !accept(doc) : doc.finalStatus === 'needs_review');
 return { readableDocuments: docs.length, labeledReadableDocuments: labeledDocs.length, autoAccepted: auto.length,
  autoAcceptanceRate: divide(auto.length, docs.length), reviewed: reviewed.length, reviewRate: divide(reviewed.length, docs.length),
  labeledAutoAccepted: labeledAuto.length, wrongAndAutoAccepted: wrongAuto,
  falseAutoAcceptRate: divide(wrongAuto, labeledAuto.length), falseAutoAcceptRateDenominator: 'labeled auto-accepted readable documents',
  falseAutoAcceptPerLabeledReadable: divide(wrongAuto, labeledDocs.length),
  wrongButReviewed: reviewed.filter(doc => labeled(doc) && wrong(doc)).length,
  wrongWithClassificationFailure: labeledDocs.filter(doc => doc.finalStatus === 'failed').length };
}

function thresholdMetrics(docs: EvaluationResult[], typeThreshold: number, authorityThreshold: number) {
 const policy = (doc: EvaluationResult) => Boolean(doc.predicted && doc.predicted.documentType.value !== 'unknown' && doc.predicted.authority.value !== 'unknown'
  && doc.predicted.documentType.confidence >= typeThreshold && doc.predicted.authority.confidence >= authorityThreshold);
 return { documentTypeThreshold: typeThreshold, authorityThreshold, ...acceptanceMetrics(docs, policy, true) };
}

function setMetrics(docs: EvaluationResult[], field: 'products' | 'applications' | 'topics') {
 const annotated = docs.filter(doc => labeled(doc) && doc.expected![field] !== undefined);
 let truePositive = 0, falsePositive = 0, falseNegative = 0;
 const samples = annotated.map(doc => {
  const expected = new Set(doc.expected![field]!), predicted = new Set(doc.predicted?.[field].value ?? []);
  const missing = [...expected].filter(value => !predicted.has(value)), extra = [...predicted].filter(value => !expected.has(value));
  truePositive += [...predicted].filter(value => expected.has(value)).length;
  falsePositive += extra.length; falseNegative += missing.length;
  return { documentId: doc.documentId, expected: [...expected], predicted: [...predicted], missing, extra };
 });
 return { annotatedDocuments: annotated.length, truePositive, falsePositive, falseNegative,
  precision: divide(truePositive, truePositive + falsePositive), recall: divide(truePositive, truePositive + falseNegative),
  matchingPolicy: 'exact set match; unannotated fields are excluded; an explicit [] is a reviewed empty set', samples };
}

function groundingMetrics(docs: EvaluationResult[]) {
 const inspected = docs.filter(doc => doc.productGrounding);
 const predicted = sum(inspected.map(doc => new Set(doc.productGrounding!.predicted).size));
 const ungrounded = sum(inspected.map(doc => new Set(doc.productGrounding!.ungrounded).size));
 // Similar spellings are candidates for manual normalization review, never automatically treated as the same product.
 const values = [...new Set(docs.flatMap(doc => [...(doc.predicted?.products.value ?? []), ...(doc.expected?.products ?? [])]))];
 const groups = new Map<string, Set<string>>();
 for (const value of values) {
  const tokens = value.toUpperCase().match(/[A-Z]+[\s-]*\d+[A-Z\d-]*/g) ?? [value.normalize('NFKC').toUpperCase().replace(/[\s\p{P}]/gu, '')];
  for (const token of tokens) { const key = token.replace(/[\s-]/g, ''); const group = groups.get(key) ?? new Set<string>(); group.add(value); groups.set(key, group); }
 }
 return { inspectedDocuments: inspected.length, predictedMentions: predicted, ungroundedMentions: ungrounded,
  groundedFraction: divide(predicted - ungrounded, predicted),
  ungrounded: inspected.filter(doc => doc.productGrounding!.ungrounded.length).map(doc => ({ documentId: doc.documentId, values: doc.productGrounding!.ungrounded })),
  normalizationCandidates: [...groups.entries()].filter(([, values]) => values.size > 1).map(([token, values]) => ({ token, values: [...values] })),
  caveat: 'Text grounding is a literal evidence check, not a semantic precision score; normalization groups are heuristic candidates only.' };
}

function errorSuggestions(doc: EvaluationResult) {
 const suggestions: Array<{ category: string; basis: string }> = [];
 const add = (category: string, basis: string) => suggestions.push({ category, basis });
 const warnings = [...doc.warnings, ...doc.parseWarnings].join(' '), notes = doc.expected?.notes ?? '';
 if (doc.parseStatus === 'partial') add('parser_information_loss', 'Partial parsing may have omitted relevant evidence.');
 if (doc.predicted?.authority.value !== doc.expected?.authority && (doc.predicted?.authority.confidence ?? 0) >= 0.9) add('authority_overconfidence', 'Authority is wrong despite confidence >= 0.90.');
 if (doc.usedConfirmedExamples.length) add('wrong_confirmed_example', 'Examples were present in this mistaken trial; association does not prove influence.');
 if (/ground|原文|未出现|凭空|没有.*证据/i.test(warnings)) add('llm_output_grounding_failure', 'A grounding warning was emitted.');
 if (/schema|校验|格式|分类失败/i.test(warnings)) add('prompt_failure', 'The response format or classification request failed.');
 if (/registry|注册|未注册/i.test(warnings)) add('registry_missing', 'A registry-related warning was emitted.');
 if (/alias|别名|归一/i.test(warnings)) add('alias_missing', 'An alias or normalization warning was emitted.');
 if (/mixed|混合|多类型/i.test(notes)) add('mixed_document', 'The human annotation mentions mixed content.');
 if (doc.expected?.documentType === 'unknown') add('ambiguous_document', 'The human label uses unknown.');
 if (!doc.fingerprint || doc.fingerprint.length < 180) add('insufficient_evidence', 'The saved fingerprint is absent or very short.');
 if (doc.aiDecision && doc.predicted?.documentType.source === 'rule') add('rule_override', 'The final type came from rules while an AI decision was saved.');
 const filenameHints: [string, RegExp][] = [['solution', /方案|solution/i], ['test_report', /测试报告|test.report/i], ['acceptance_report', /验收|acceptance/i], ['manual', /说明书|manual/i]];
 if (filenameHints.some(([type, pattern]) => pattern.test(doc.filename) && type === doc.predicted?.documentType.value && type !== doc.expected?.documentType)) add('filename_misleading', 'A filename keyword agrees with the mistaken type; causation is not established.');
 if (!suggestions.length) add('unknown', 'No supported heuristic suggestion. Inspect the saved fingerprint and decisions.');
 return suggestions;
}

function misclassifications(docs: EvaluationResult[]) {
 return docs.filter(doc => labeled(doc) && wrong(doc)).map(doc => ({
  documentId: doc.documentId, filename: doc.filename, repetition: doc.repetition,
  expected: { documentType: doc.expected!.documentType, authority: doc.expected!.authority },
  predicted: { documentType: doc.predicted?.documentType.value ?? null, documentTypeConfidence: doc.predicted?.documentType.confidence ?? null,
   authority: doc.predicted?.authority.value ?? null, authorityConfidence: doc.predicted?.authority.confidence ?? null },
  autoAccepted: accepted(doc), finalStatus: doc.finalStatus, reviewReasons: doc.reviewReasons,
  correctDocumentType: correctType(doc), correctAuthority: correctAuthority(doc), falseAutoAccept: accepted(doc),
  evidence: doc.evidence ?? [], fingerprint: doc.fingerprint ?? null, usedConfirmedExamples: doc.usedConfirmedExamples,
  ruleDecision: doc.ruleDecision ?? null, aiDecision: doc.aiDecision ?? null,
  suggestedErrorCategories: errorSuggestions(doc), attributionStatus: 'heuristic suggestions, not established causes',
 }));
}

function percentiles(values: number[]) {
 const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
 const percentile = (fraction: number) => sorted.length ? sorted[Math.max(0, Math.ceil(sorted.length * fraction) - 1)]! : null;
 return { count: sorted.length, mean: mean(sorted), p50: percentile(0.5), p90: percentile(0.9), p95: percentile(0.95), method: 'nearest rank' };
}

function stability(run: EvaluationRun) {
 const ids = [...new Set(run.documents.map(doc => doc.documentId))];
 const samples = ids.map(documentId => {
  const docs = run.documents.filter(doc => doc.documentId === documentId).sort((a, b) => a.repetition - b.repetition);
  const predictions = docs.filter(doc => readable(doc) && doc.predicted);
  const type = [...new Set(predictions.map(doc => doc.predicted!.documentType.value))], authority = [...new Set(predictions.map(doc => doc.predicted!.authority.value))];
  const range = (field: 'documentType' | 'authority') => {
   const values = predictions.map(doc => doc.predicted![field].confidence);
   return values.length ? { min: Math.min(...values), max: Math.max(...values), spread: Math.max(...values) - Math.min(...values) } : null;
  };
  return { documentId, attempts: docs.length, classifiedAttempts: predictions.length,
   eligible: predictions.length >= 3, typeValues: type, authorityValues: authority,
   typeChanged: type.length > 1, authorityChanged: authority.length > 1,
   documentTypeConfidence: range('documentType'), authorityConfidence: range('authority') };
 });
 const eligible = samples.filter(sample => sample.eligible);
 return { minimumDocuments: 10, minimumRepetitions: 3, eligibleDocuments: eligible.length,
  sufficientForRequestedProtocol: eligible.length >= 10,
  typeDriftDocuments: eligible.filter(sample => sample.typeChanged).length,
  authorityDriftDocuments: eligible.filter(sample => sample.authorityChanged).length,
  typeDriftRate: divide(eligible.filter(sample => sample.typeChanged).length, eligible.length),
  authorityDriftRate: divide(eligible.filter(sample => sample.authorityChanged).length, eligible.length), samples,
  caveat: 'Repeated trials measure stability, not additional independent labeled documents.' };
}

export function computeMetrics(run: EvaluationRun) {
 const primary = primaryDocuments(run), parsed = primary.filter(readable), gold = parsed.filter(labeled);
 const acceptance = acceptanceMetrics(parsed), errors = misclassifications(gold);
 const recorded = run.documents.filter(doc => doc.usage);
 const inputTokens = sum(recorded.map(doc => doc.usage!.inputTokens)), outputTokens = sum(recorded.map(doc => doc.usage!.outputTokens));
 const costs = run.documents.filter(doc => doc.estimatedCostCny !== undefined || doc.usage);
 const estimatedCostCny = costs.length ? sum(costs.map(doc => doc.estimatedCostCny ?? (doc.usage!.inputTokens * run.prices.inputPerMillionCny + doc.usage!.outputTokens * run.prices.outputPerMillionCny) / 1e6)) : run.provider === 'rules' || run.provider === 'synthetic' ? 0 : null;
 const averageCostCny = estimatedCostCny === null ? null : divide(estimatedCostCny, run.documents.length);
 const exampleIds = [...new Set(primary.flatMap(doc => doc.usedConfirmedExamples))];
 const usageMissing = run.provider === 'kimi' ? run.documents.filter(doc => readable(doc) && !doc.usage).length : 0;
 const unsettled = (run.reservations ?? []).filter(reservation => !reservation.completedAt);
 const warnings: string[] = [];
 if (run.status !== 'completed') warnings.push(`This run is ${run.status}; results are partial.`);
 if (!gold.length) warnings.push('No human-labeled readable documents: accuracy and false auto-accept rate are unavailable.');
 if (run.provider !== 'kimi') warnings.push(`${run.provider} results cannot establish real AI classification quality.`);
 if (gold.length < parsed.length) warnings.push('Accuracy covers only the human-labeled subset; selection bias may affect interpretation.');
 if (primary.some(doc => doc.repetition !== 1)) warnings.push('Some documents lack repetition 1; their earliest available repetition is provisional.');
 if (usageMissing || unsettled.length) warnings.push('Some token usage or request settlement is unknown; recorded cost is not the final bill.');
 return { methodology: { primaryUnit: 'unique document; first available repetition', primaryDocuments: primary.length,
   attempts: run.documents.length, classificationDenominator: 'human-labeled readable unique documents; missing predictions count as incorrect',
   parseFailuresExcludedFromAccuracy: true, realHumanEvaluation: run.provider === 'kimi' && gold.length > 0,
   targetAssessment: 'not automatically passed; requires representative human labels, safety review, and paired experiments', warnings },
  counts: { plannedDocuments: run.plannedDocuments, documents: primary.length, attempts: run.documents.length,
   success: primary.filter(doc => doc.parseStatus === 'success').length, partial: primary.filter(doc => doc.parseStatus === 'partial').length,
   failed: primary.filter(doc => doc.parseStatus === 'failed').length, parseFailureRate: divide(primary.filter(doc => doc.parseStatus === 'failed').length, primary.length),
   readable: parsed.length, classified: parsed.filter(doc => doc.predicted).length, labeledReadable: gold.length,
   unlabeledReadable: parsed.length - gold.length, labelCoverage: divide(gold.length, parsed.length) },
  documentType: classificationMetrics(gold, 'documentType', DOCUMENT_TYPES), authority: classificationMetrics(gold, 'authority', AUTHORITIES),
  acceptance, confidence: { documentType: confidenceBuckets(gold, 'documentType'), authority: confidenceBuckets(gold, 'authority') },
  thresholdSimulation: { caveat: 'Counterfactual confidence gates only; production settings are unchanged. Unknown type or authority is never auto-accepted.',
   productionGatePolicy: run.gatePolicy, productionReviewThreshold: run.thresholds.review,
   joint: [0.8, 0.85, 0.9, 0.95].map(threshold => thresholdMetrics(parsed, threshold, threshold)),
   authoritySpecific: [0.8, 0.85, 0.9, 0.95].map(threshold => thresholdMetrics(parsed, run.thresholds.autoAccept, threshold)) },
  optionalFields: { products: setMetrics(parsed, 'products'), applications: setMetrics(parsed, 'applications'), topics: setMetrics(parsed, 'topics') },
  productGrounding: groundingMetrics(parsed), misclassifications: errors, highRiskErrors: errors.filter(error => error.autoAccepted),
  errorAttribution: { status: 'heuristic only; inspect evidence before assigning causes', availableCategories: ERROR_CATEGORIES,
   counts: ERROR_CATEGORIES.map(category => ({ category, count: errors.filter(error => error.suggestedErrorCategories.some(suggestion => suggestion.category === category)).length })) },
  exampleAssociations: exampleIds.map(exampleId => {
   const used = primary.filter(doc => doc.usedConfirmedExamples.includes(exampleId)), labeledUses = used.filter(doc => readable(doc) && labeled(doc));
   return { exampleId, usedDocuments: used.length, labeledUses: labeledUses.length, wrongDocuments: labeledUses.filter(wrong).length,
    wrongAutoAccepted: labeledUses.filter(doc => accepted(doc) && wrong(doc)).length,
    errorRateAmongLabeledUses: divide(labeledUses.filter(wrong).length, labeledUses.length),
    caveat: 'Co-occurrence is not evidence that this example caused the error.' };
  }),
  cost: { currency: 'CNY', model: run.model, budgetCny: run.budgetCny, reservedBudgetCny: run.reservedCostCny,
   inputTokens, outputTokens, totalTokens: inputTokens + outputTokens, recordedAttempts: recorded.length,
   averageInputTokens: divide(inputTokens, recorded.length), averageOutputTokens: divide(outputTokens, recorded.length),
   estimatedCostCny, averageCostCny, projected100DocumentsCny: averageCostCny === null ? null : averageCostCny * 100,
   projected1000DocumentsCny: averageCostCny === null ? null : averageCostCny * 1000, usageMissingAttempts: usageMissing,
   unsettledRequests: unsettled.length, unsettledReservedCny: sum(unsettled.map(reservation => reservation.reservedCny)),
   prices: run.prices, caveat: 'Estimates use this run’s usage only, not a shared-account balance. Projection assumes one trial per document and the same file mix; unknown usage is excluded.' },
  timings: { unit: 'milliseconds; all attempts', parse: percentiles(run.documents.map(doc => doc.timings.parseMs)),
   classification: percentiles(run.documents.map(doc => doc.timings.classifyMs)), total: percentiles(run.documents.map(doc => doc.timings.totalMs)) },
  stability: stability(run) };
}

function stableJson(value: unknown): string {
 if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
 if (value && typeof value === 'object') return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, entry]) => `${JSON.stringify(key)}:${stableJson(entry)}`).join(',')}}`;
 return JSON.stringify(value) ?? 'undefined';
}

export function compareEvaluationRuns(baseline: EvaluationRun, experiment: EvaluationRun) {
 const baselineMetrics = computeMetrics(baseline), experimentMetrics = computeMetrics(experiment);
 for (const run of [baseline, experiment]) {
  if (run.status !== 'completed' || run.documents.length !== run.plannedResults || new Set(run.documents.map(doc => doc.documentId)).size !== run.plannedDocuments
   || run.plannedResults !== run.plannedDocuments * run.repeat || run.documents.some(doc => !run.documents.some(other => other.documentId === doc.documentId && other.repetition === 1))) throw new Error('Only complete evaluation runs with all planned paired repetitions can be compared');
  if ((run.reservations ?? []).some(reservation => !reservation.completedAt)) throw new Error('Cannot compare a run with unsettled requests');
 }
 if (baseline.datasetId !== experiment.datasetId || baseline.manifestHash !== experiment.manifestHash || baseline.labelsHash !== experiment.labelsHash) throw new Error('Dataset manifest or human labels differ; paired comparison is invalid');
 const pairs = new Map(experiment.documents.map(doc => [resultKey(doc), doc]));
 if (pairs.size !== baseline.documents.length) throw new Error('Runs do not contain the same document/repetition pairs');
 for (const doc of baseline.documents) {
  const paired = pairs.get(resultKey(doc));
  if (!paired || doc.contentHash !== paired.contentHash || stableJson(doc.expected) !== stableJson(paired.expected)) throw new Error('Paired file content, labels, or repetitions differ');
  if (doc.parseStatus !== paired.parseStatus) throw new Error('Paired parsing outcomes differ; classification comparison would use different evidence');
 }
 const axes: Array<[string, unknown, unknown]> = [
  ['provider', baseline.provider, experiment.provider], ['model', baseline.model, experiment.model],
  ['temperature', baseline.temperature, experiment.temperature], ['maxTokens', baseline.maxTokens, experiment.maxTokens],
  ['classificationVersion', baseline.classificationVersion, experiment.classificationVersion],
  ['promptVersion', baseline.classificationPromptVersion, experiment.classificationPromptVersion],
  ['ruleVersion', baseline.classificationRuleVersion, experiment.classificationRuleVersion],
  ['reviewThreshold', baseline.thresholds.review, experiment.thresholds.review], ['autoAcceptThreshold', baseline.thresholds.autoAccept, experiment.thresholds.autoAccept],
  ['gatePolicy', baseline.gatePolicy, experiment.gatePolicy], ['examplesMode', baseline.examplesMode, experiment.examplesMode],
  ['isolateEvaluation', baseline.isolateEvaluation, experiment.isolateEvaluation], ['contextHash', baseline.contextHash, experiment.contextHash],
 ];
 const changes = axes.filter(([, before, after]) => stableJson(before) !== stableJson(after)).map(([axis, before, after]) => ({ axis, before, after }));
 const confounds = changes.length > 1 ? ['Multiple experimental axes changed; metric differences cannot be attributed to one change.'] : [];
 if (baseline.codeHash !== experiment.codeHash) confounds.push('Code snapshots differ; inspect implementation changes before interpreting the comparison.');
 if (!baseline.codeHash || !experiment.codeHash) confounds.push('A code snapshot hash is unavailable.');
 if (baseline.provider !== 'kimi' || experiment.provider !== 'kimi') confounds.push('Rules or synthetic runs do not establish real AI quality improvement.');
 if (!baselineMetrics.counts.labeledReadable) confounds.push('No readable human ground truth exists, so accuracy changes are unavailable.');
 const delta = (before: number | null, after: number | null) => before === null || after === null ? null : after - before;
 const rows: Array<[string, number | null, number | null]> = [
  ['documentTypeAccuracy', baselineMetrics.documentType.accuracy, experimentMetrics.documentType.accuracy],
  ['authorityAccuracy', baselineMetrics.authority.accuracy, experimentMetrics.authority.accuracy],
  ['autoAcceptanceRate', baselineMetrics.acceptance.autoAcceptanceRate, experimentMetrics.acceptance.autoAcceptanceRate],
  ['reviewRate', baselineMetrics.acceptance.reviewRate, experimentMetrics.acceptance.reviewRate],
  ['falseAutoAcceptRate', baselineMetrics.acceptance.falseAutoAcceptRate, experimentMetrics.acceptance.falseAutoAcceptRate],
  ['falseAutoAcceptPerLabeledReadable', baselineMetrics.acceptance.falseAutoAcceptPerLabeledReadable, experimentMetrics.acceptance.falseAutoAcceptPerLabeledReadable],
 ];
 const primary = primaryDocuments(baseline).filter(doc => readable(doc) && labeled(doc));
 const pairedTransitions = primary.map(doc => {
  const after = pairs.get(resultKey(doc))!;
  return { documentId: doc.documentId, baselineWrong: wrong(doc), experimentWrong: wrong(after),
   baselineFalseAutoAccepted: accepted(doc) && wrong(doc), experimentFalseAutoAccepted: accepted(after) && wrong(after) };
 });
 return { schemaVersion: 1, baselineId: baseline.id, experimentId: experiment.id, datasetId: baseline.datasetId,
  pairedDocuments: baselineMetrics.counts.documents, pairedAttempts: baseline.documents.length,
  changes, confounds, isolatedSingleChange: changes.length === 1 && confounds.length === 0,
  interpretation: 'Descriptive paired comparison only; no automatic improvement, pass, or causal claim. Repetitions are not independent samples.',
  metrics: rows.map(([metric, before, after]) => ({ metric, baseline: before, experiment: after, delta: delta(before, after) })),
  pairedTransitions, stability: { baseline: baselineMetrics.stability, experiment: experimentMetrics.stability },
  cost: { baseline: baselineMetrics.cost, experiment: experimentMetrics.cost } };
}
