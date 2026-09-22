import { randomUUID } from 'node:crypto';
import { mkdir, open, readFile, unlink, writeFile, type FileHandle } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { writeJsonAtomic } from './data.js';
import { compareEvaluationRuns, computeMetrics } from './metrics.js';
import type { EvaluationRun } from './types.js';

type Metrics = ReturnType<typeof computeMetrics>;
const decimal = (value: number | null | undefined, digits = 3) => value === null || value === undefined ? '未评估' : value.toFixed(digits);
const percent = (value: number | null | undefined) => value === null || value === undefined ? '未评估' : `${(value * 100).toFixed(2)}%`;
const escape = (value: unknown) => String(value ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/\|/g, '\\|').replace(/[\r\n]+/g, ' ');
const table = (headers: string[], rows: unknown[][]) => `| ${headers.map(escape).join(' | ')} |\n| ${headers.map(() => '---').join(' | ')} |\n${rows.map(row => `| ${row.map(escape).join(' | ')} |`).join('\n')}\n`;

/** Protect spreadsheet consumers from formulas, including formulas hidden behind leading whitespace. */
export function csvCell(value: unknown): string {
 const text = String(value ?? '');
 const safe = /^[\s]*[=+\-@]/u.test(text) || /^[\t\r\n]/.test(text) ? `'${text}` : text;
 return `"${safe.replace(/"/g, '""')}"`;
}

export function evaluationReportPaths(outputPath: string) {
 const json = resolve(outputPath), stem = json.replace(/\.json$/i, '');
 if (stem === json) throw new Error('Evaluation output must use a .json extension');
 return { json, markdown: `${stem}.md`, documentTypeCsv: `${stem}.document-type-confusion.csv`, authorityCsv: `${stem}.authority-confusion.csv` };
}

/** Standalone reporting shares the runner's checkpoint lock, including when a report rewrites its input. */
export async function withExclusiveReportLocks<T>(paths: string[], action: () => Promise<T>): Promise<T> {
 const normalized = paths.map(path => resolve(path));
 const unique = [...new Map(normalized.map(path => [process.platform === 'win32' ? path.toLowerCase() : path, path])).values()].sort();
 const owned: Array<{ path: string; handle: FileHandle; contents: string }> = [];
 try {
  for (const path of unique) {
   await mkdir(dirname(path), { recursive: true });
   let handle: FileHandle;
   try { handle = await open(`${path}.lock`, 'wx', 0o600); }
   catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new Error('Evaluation input or output is locked by another process; do not overwrite an active run.');
    throw error;
   }
   const contents = JSON.stringify({ pid: process.pid, token: randomUUID(), operation: 'evaluation-report', startedAt: new Date().toISOString() });
   owned.push({ path: `${path}.lock`, handle, contents });
   await handle.writeFile(contents);
  }
  return await action();
 } finally {
  for (const lock of owned.reverse()) {
   await lock.handle.close();
   if (await readFile(lock.path, 'utf8').catch(() => '') === lock.contents) await unlink(lock.path);
  }
 }
}

function matrixCsv(metric: Metrics['documentType']) {
 return '\ufeff' + [["actual / predicted", ...metric.classes], ...metric.classes.map(actual => [actual, ...metric.classes.map(prediction => metric.confusionMatrix[actual]![prediction]!)])]
  .map(row => row.map(csvCell).join(',')).join('\r\n') + '\r\n';
}

function classTable(metric: Metrics['documentType']) {
 return table(['类别', '人工样本', '预测数', '正确', 'Precision', 'Recall', '待确认', '错误自动通过'], metric.perClass.map(item => [item.key, item.support, item.predicted, item.correct, percent(item.precision), percent(item.recall), item.reviewed, item.falseAutoAccepted]));
}

function confidenceTable(metric: Metrics['confidence']['documentType']) {
 return table(['置信度区间', '人工样本', '平均置信度', '实际正确率'], metric.map(bin => [bin.range, bin.count, percent(bin.averageConfidence), percent(bin.accuracy)]));
}

function thresholdTable(rows: Metrics['thresholdSimulation']['joint']) {
 return table(['类型阈值', 'Authority 阈值', '自动通过', '待确认', '错误自动通过', '错误 / 有标注的自动通过', '错误 / 有标注的可解析'], rows.map(row => [row.documentTypeThreshold, row.authorityThreshold, percent(row.autoAcceptanceRate), percent(row.reviewRate), row.wrongAndAutoAccepted, percent(row.falseAutoAcceptRate), percent(row.falseAutoAcceptPerLabeledReadable)]));
}

function codeBlock(text: string, language = '') {
 const ticks = Math.max(3, ...Array.from(text.matchAll(/`+/g), match => match[0].length + 1));
 const fence = '`'.repeat(ticks);
 return `${fence}${language}\n${text}\n${fence}\n`;
}

export function evaluationMarkdown(run: EvaluationRun, metrics = computeMetrics(run)) {
 const m = metrics, lines: string[] = [
  '# Classification Evaluation / 分类质量评测', '',
  '**本报告不自动宣告分类达标。真实准确率需要人工标注；重复运行只用于稳定性分析。**', '',
  ...m.methodology.warnings.map(warning => `> ${escape(warning)}\n`),
  '## 运行与统计口径', '',
  table(['字段', '值'], [
   ['Run', run.id], ['Dataset', run.datasetId], ['Status', run.status], ['Provider / model', `${run.provider} / ${run.model}`],
   ['Temperature / max tokens', `${run.temperature} / ${run.maxTokens}`], ['Classification / prompt / rule', `${run.classificationVersion} / ${run.classificationPromptVersion} / ${run.classificationRuleVersion}`],
   ['Examples / isolate evaluation', `${run.examplesMode} / ${run.isolateEvaluation}`], ['Gate', `${run.gatePolicy}; review=${run.thresholds.review}; autoAccept=${run.thresholds.autoAccept}`],
   ['Code hash', run.codeHash ?? 'unavailable'], ['Manifest hash', run.manifestHash], ['Labels hash', run.labelsHash], ['Context hash', run.contextHash], ['Created / updated', `${run.createdAt} / ${run.updatedAt}`],
  ]),
  '主指标每份文件只计第一次可用试验；多次试验不增加独立样本量。类型与 Authority 正确率的分母为**人工标注且可解析的文件**，可解析但无分类结果计为错误。解析失败单列，不计分类错误。', '',
  '## 文件与分类结果', '',
  table(['指标', '结果'], [
   ['计划文件 / 已处理文件 / 总尝试', `${m.counts.plannedDocuments} / ${m.counts.documents} / ${m.counts.attempts}`],
   ['Parse success / partial / failed', `${m.counts.success} / ${m.counts.partial} / ${m.counts.failed}`], ['Parse Failure Rate', percent(m.counts.parseFailureRate)],
   ['可解析 / 已分类 / 人工标注', `${m.counts.readable} / ${m.counts.classified} / ${m.counts.labeledReadable}`], ['标注覆盖率', percent(m.counts.labelCoverage)],
   ['Document Type Accuracy', percent(m.documentType.accuracy)], ['Authority Accuracy', percent(m.authority.accuracy)],
   ['自动通过 / 可解析', `${m.acceptance.autoAccepted} / ${m.counts.readable} (${percent(m.acceptance.autoAcceptanceRate)})`],
   ['待确认 / 可解析', `${m.acceptance.reviewed} / ${m.counts.readable} (${percent(m.acceptance.reviewRate)})`],
   ['Wrong but reviewed', m.acceptance.wrongButReviewed], ['Wrong and auto-accepted', m.acceptance.wrongAndAutoAccepted],
   ['False Auto-Accept Rate（错误 / 有标注的自动通过）', `${m.acceptance.wrongAndAutoAccepted} / ${m.acceptance.labeledAutoAccepted} (${percent(m.acceptance.falseAutoAcceptRate)})`],
   ['错误自动通过 / 有标注的可解析', `${m.acceptance.wrongAndAutoAccepted} / ${m.counts.labeledReadable} (${percent(m.acceptance.falseAutoAcceptPerLabeledReadable)})`],
  ]),
  '未知标准答案不会按“正确”或“错误”计分；此处“未评估”表示分母为零，不表示准确率为零。人工选择 unknown 是有效标准答案，与未标注不同。', '',
  '## HIGH RISK ERRORS / 错误自动通过', '',
  m.highRiskErrors.length ? table(['文件 ID', '文件名', '类型：标准 → 预测', 'Authority：标准 → 预测', '置信度 类型 / Authority'], m.highRiskErrors.map(error => [error.documentId, error.filename, `${error.expected.documentType} → ${error.predicted.documentType}`, `${error.expected.authority} → ${error.predicted.authority}`, `${decimal(error.predicted.documentTypeConfidence)} / ${decimal(error.predicted.authorityConfidence)}`])) : '当前已标注样本中未观察到错误自动通过；未标注样本无法判定。\n',
  '## 按类型统计', '', classTable(m.documentType),
  '## Authority 单独统计', '', classTable(m.authority),
  '混淆矩阵 CSV 分别保存于同名 `.document-type-confusion.csv` 和 `.authority-confusion.csv`；行是真实类别，列是预测类别。', '',
  '## 置信度校准', '', '### Document Type', '', confidenceTable(m.confidence.documentType), '### Authority', '', confidenceTable(m.confidence.authority),
  '## 阈值模拟', '',
  '以下只模拟关键字段置信度门槛，不修改生产配置。unknown 仍需要人工确认。实际运行遵循保存的生产 review 门槛；autoAccept 配置值不是实际通过率的同义词。', '',
  '### 类型和 Authority 同时调整', '', thresholdTable(m.thresholdSimulation.joint),
  '### 类型阈值固定，单独调整 Authority', '', thresholdTable(m.thresholdSimulation.authoritySpecific),
  '## 可选字段抽查与产品证据', '',
  '只有人工明确标注的可选字段参与统计；未填字段被排除，显式空数组表示人工确认没有该实体。Precision / Recall 使用精确集合匹配，不将推测的别名算作正确。', '',
  table(['字段', '已标注文档', 'TP', 'FP', 'FN', 'Precision', 'Recall'], Object.entries(m.optionalFields).map(([field, value]) => [field, value.annotatedDocuments, value.truePositive, value.falsePositive, value.falseNegative, percent(value.precision), percent(value.recall)])),
  `已检查产品原文证据 ${m.productGrounding.inspectedDocuments} 份，产品提及 ${m.productGrounding.predictedMentions} 个，无证据 ${m.productGrounding.ungroundedMentions} 个。原文匹配不能替代人工语义准确率。`, '',
  m.productGrounding.ungrounded.length ? table(['文件 ID', '缺少原文依据的产品'], m.productGrounding.ungrounded.map(row => [row.documentId, row.values.join(', ')])) : '没有记录到缺少原文证据的输出；应同时检查证据抽查覆盖率。\n',
  m.productGrounding.normalizationCandidates.length ? table(['候选型号', '拼写变体（需人工核实，未自动合并）'], m.productGrounding.normalizationCandidates.map(row => [row.token, row.values.join(' / ')])) : '未发现可报告的产品拼写归一化候选。\n',
  '## 全部误判与建议归因', '',
  '原因标签是规则提示，**不是已证实的因果结论**。请结合原文、指纹、规则和 AI 原始决策核对。完整结构化记录与实际 Prompt 保存在本地 JSON。', '',
  table(['原因候选', '涉及错误样本'], m.errorAttribution.counts.map(row => [row.category, row.count])),
 ];
 for (const error of m.misclassifications) {
  lines.push(`### ${escape(error.documentId)} — ${escape(error.filename)}`, '',
   `类型：${escape(error.expected.documentType)} → ${escape(error.predicted.documentType)}；Authority：${escape(error.expected.authority)} → ${escape(error.predicted.authority)}；自动通过：${error.autoAccepted}。`, '',
   `待确认原因：${escape(error.reviewReasons.join('；') || '无')}。样例：${escape(error.usedConfirmedExamples.join(', ') || '无')}。`, '',
   table(['归因建议', '依据'], error.suggestedErrorCategories.map(suggestion => [suggestion.category, suggestion.basis])),
   'AI 指纹：', '', codeBlock(error.fingerprint ?? '(not captured)'),
   '保存的证据：', '', codeBlock(error.evidence.join('\n') || '(none)'), '');
 }
 lines.push('## Confirmed Example 关联统计', '',
  '同一样例与多个错误共同出现只说明关联；效果需使用有／无样例的配对 A/B 对照验证。', '',
  table(['样例 ID', '使用文档', '其中已标注', '错误', '错误自动通过', '错误 / 已标注使用'], m.exampleAssociations.map(row => [row.exampleId, row.usedDocuments, row.labeledUses, row.wrongDocuments, row.wrongAutoAccepted, percent(row.errorRateAmongLabeledUses)])),
  '## Token 与成本', '',
  table(['指标', '值'], [
   ['Input / Output / Total tokens', `${m.cost.inputTokens} / ${m.cost.outputTokens} / ${m.cost.totalTokens}`],
   ['平均 Input / Output（有 usage 的尝试）', `${decimal(m.cost.averageInputTokens, 1)} / ${decimal(m.cost.averageOutputTokens, 1)}`],
   ['模型', m.cost.model], ['输入 / 输出单价（元 / 百万 tokens）', `${run.prices.inputPerMillionCny} / ${run.prices.outputPerMillionCny}`],
   ['本次已记录估算成本（元）', decimal(m.cost.estimatedCostCny, 6)], ['平均每次文件处理（元）', decimal(m.cost.averageCostCny, 6)],
   ['配置预算 / 已预留预算上界（元）', `${decimal(m.cost.budgetCny)} / ${decimal(m.cost.reservedBudgetCny)}`],
   ['100 / 1000 份估算（元）', `${decimal(m.cost.projected100DocumentsCny)} / ${decimal(m.cost.projected1000DocumentsCny)}`],
   ['Usage 缺失尝试 / 尚未结算请求', `${m.cost.usageMissingAttempts} / ${m.cost.unsettledRequests}`], ['尚未结算预算预留（元）', decimal(m.cost.unsettledReservedCny, 6)],
  ]),
  '仅按本次请求的 usage 估算，不查询共享账户余额。预算预留是包含潜在重试的保守上界，不是已扣费。未记录用量不计入金额；100 / 1000 份估算假设每份运行一次且文件分布相同，不是账户账单。', '',
  '## 耗时', '',
  table(['阶段（全部尝试，毫秒）', '均值', 'P50', 'P90', 'P95'], [['Parse', m.timings.parse], ['Classification', m.timings.classification], ['Total', m.timings.total]].map(([name, value]) => {
   const latency = value as Metrics['timings']['parse']; return [name, decimal(latency.mean, 1), decimal(latency.p50, 1), decimal(latency.p90, 1), decimal(latency.p95, 1)];
  })),
  '分位数使用 nearest-rank 方法。', '', '## 重复试验稳定性', '',
  `至少完成 3 次有效分类的文件：${m.stability.eligibleDocuments}；10 份 × 3 次协议${m.stability.sufficientForRequestedProtocol ? '已满足样本数量' : '尚未满足'}。类型漂移 ${m.stability.typeDriftDocuments} 份，Authority 漂移 ${m.stability.authorityDriftDocuments} 份。`, '',
  table(['文件 ID', '有效重复次数', '类型漂移', 'Authority 漂移', '类型置信度范围', 'Authority 置信度范围'], m.stability.samples.filter(sample => sample.attempts > 1).map(sample => [sample.documentId, sample.classifiedAttempts, sample.typeChanged, sample.authorityChanged,
   sample.documentTypeConfidence ? `${decimal(sample.documentTypeConfidence.min)}–${decimal(sample.documentTypeConfidence.max)}` : '未评估', sample.authorityConfidence ? `${decimal(sample.authorityConfidence.min)}–${decimal(sample.authorityConfidence.max)}` : '未评估'])),
  '重复试验用于观察随机漂移，不可把 10 份 × 3 次写成 30 份独立人工标注样本。', '',
  '本报告包含本地文件名、指纹与模型输入，保存在被 Git 忽略的本地评测目录。', '');
 return lines.join('\n');
}

export async function writeEvaluationReports(run: EvaluationRun, outputPath: string): Promise<void> {
 const paths = evaluationReportPaths(outputPath), metrics = computeMetrics(run);
 await mkdir(dirname(paths.json), { recursive: true });
 await writeJsonAtomic(paths.json, { ...run, metrics });
 await Promise.all([
  writeFile(paths.markdown, evaluationMarkdown(run, metrics), { encoding: 'utf8', mode: 0o600 }),
  writeFile(paths.documentTypeCsv, matrixCsv(metrics.documentType), { encoding: 'utf8', mode: 0o600 }),
  writeFile(paths.authorityCsv, matrixCsv(metrics.authority), { encoding: 'utf8', mode: 0o600 }),
 ]);
}

export async function writeComparisonReport(baseline: EvaluationRun, experiment: EvaluationRun, outputPath: string) {
 const comparison = compareEvaluationRuns(baseline, experiment), paths = evaluationReportPaths(outputPath);
 await writeJsonAtomic(paths.json, comparison);
 const markdown = ['# 配对分类实验对比', '',
  `Baseline：${escape(comparison.baselineId)}；Experiment：${escape(comparison.experimentId)}。`, '',
  `相同文件 ${comparison.pairedDocuments} 份，相同文件／重复编号 ${comparison.pairedAttempts} 对。是否仅一个可归因变量：${comparison.isolatedSingleChange}。`, '',
  '**只报告观测差异，不自动宣告优化成功或质量达标。**', '',
  ...comparison.confounds.map(confound => `> ${escape(confound)}\n`),
  table(['变化轴', 'Baseline', 'Experiment'], comparison.changes.map(change => [change.axis, change.before, change.after])),
  table(['指标', 'Baseline', 'Experiment', '变化（百分点）'], comparison.metrics.map(metric => [metric.metric, percent(metric.baseline), percent(metric.experiment), metric.delta === null ? '未评估' : (metric.delta * 100).toFixed(2)])),
  'False Auto-Accept Rate 分母为有人工标注且自动通过的可解析文件；另列相对于全部有标注可解析文件的比例。重复试验不增加独立样本量。', '',
  table(['文件 ID', 'Baseline 错误', 'Experiment 错误', 'Baseline 错误自动通过', 'Experiment 错误自动通过'], comparison.pairedTransitions.map(row => [row.documentId, row.baselineWrong, row.experimentWrong, row.baselineFalseAutoAccepted, row.experimentFalseAutoAccepted])), '',
 ].join('\n');
 await writeFile(paths.markdown, markdown, { encoding: 'utf8', mode: 0o600 });
 return comparison;
}
