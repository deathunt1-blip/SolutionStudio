import { resolve } from 'node:path';
import { cliOptions, readJson } from '../packages/evaluation/src/data.js';
import { evaluationReportPaths, withExclusiveReportLocks, writeEvaluationReports } from '../packages/evaluation/src/reporting.js';
import type { EvaluationRun } from '../packages/evaluation/src/types.js';

const options = cliOptions(process.argv.slice(2));
if (options.has('help')) {
 console.log('npm run eval:report -- --input output/evaluation.json [--output output/evaluation.json]\nRebuild local JSON, Markdown and two confusion CSV reports; no model calls.');
} else {
 const input = options.get('input');
 if (typeof input !== 'string') throw new Error('--input is required');
 const output = options.get('output') ?? input;
 if (typeof output !== 'string') throw new Error('--output needs a filename');
 await withExclusiveReportLocks([input, output], async () => {
  const run = await readJson<EvaluationRun>(resolve(input));
  if (run.schemaVersion !== 1 || !Array.isArray(run.documents)) throw new Error('Not a supported EvaluationRun JSON file');
  await writeEvaluationReports(run, output);
  console.log(JSON.stringify({ runId: run.id, status: run.status, reports: evaluationReportPaths(output) }, null, 2));
 });
}
