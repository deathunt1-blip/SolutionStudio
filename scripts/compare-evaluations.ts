import { resolve } from 'node:path';
import { cliOptions, readJson } from '../packages/evaluation/src/data.js';
import { evaluationReportPaths, withExclusiveReportLocks, writeComparisonReport } from '../packages/evaluation/src/reporting.js';
import type { EvaluationRun } from '../packages/evaluation/src/types.js';

const options = cliOptions(process.argv.slice(2));
if (options.has('help')) {
 console.log('npm run eval:compare -- --baseline output/baseline.json --experiment output/experiment.json [--output output/comparison.json]\nCompares complete paired runs, rejecting changed datasets or human labels; no model calls.');
} else {
 const baselinePath = options.get('baseline'), experimentPath = options.get('experiment'), output = options.get('output') ?? 'output/evaluation-comparison.json';
 if (typeof baselinePath !== 'string' || typeof experimentPath !== 'string' || typeof output !== 'string') throw new Error('--baseline, --experiment and a valid --output filename are required');
 const paths = evaluationReportPaths(output), inputs = [resolve(baselinePath), resolve(experimentPath)];
 if ([paths.json, paths.markdown].some(path => inputs.some(input => input.toLowerCase() === path.toLowerCase()))) throw new Error('Comparison output must not overwrite an input run');
 await withExclusiveReportLocks([baselinePath, experimentPath, output], async () => {
  const [baseline, experiment] = await Promise.all([readJson<EvaluationRun>(baselinePath), readJson<EvaluationRun>(experimentPath)]);
  if ([baseline, experiment].some(run => run.schemaVersion !== 1 || !Array.isArray(run.documents))) throw new Error('Not a supported EvaluationRun JSON file');
  const comparison = await writeComparisonReport(baseline, experiment, output);
  console.log(JSON.stringify({ baselineId: comparison.baselineId, experimentId: comparison.experimentId, changes: comparison.changes, confounds: comparison.confounds, json: paths.json, markdown: paths.markdown }, null, 2));
 });
}
