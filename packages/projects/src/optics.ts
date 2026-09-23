import type { StructuredFact } from '../../structured/src/types.js';
import { stableId } from './requirements.js';
import type { EngineeringOpticalConfiguration, ProjectConflict, ProjectContext, SourceReference } from './types.js';

type OpticalMetric = 'hfovDeg' | 'vfovDeg' | 'maxWorkingDistanceM';
const metrics: OpticalMetric[] = ['hfovDeg', 'vfovDeg', 'maxWorkingDistanceM'];
const metricLabels: Record<OpticalMetric, string> = { hfovDeg: '水平视场角', vfovDeg: '垂直视场角', maxWorkingDistanceM: '最大工作距离' };
const normalized = (value: string) => value.normalize('NFKC').trim().toLowerCase();
const numberPattern = String.raw`(?:\d+(?:\.\d+)?|\.\d+)`;
const angleUnit = String.raw`(?:°|degrees?|deg|度)`;
const distanceUnit = String.raw`(?:毫米|厘米|米|mm|cm|m)`;
const pairPattern = `${numberPattern}\\s*(?:${angleUnit})?\\s*[×x*]\\s*${numberPattern}\\s*(?:${angleUnit})?`;

function distanceScale(unit: string): number | undefined {
  switch (normalized(unit)) {
    case 'm': case '米': return 1;
    case 'cm': case '厘米': return .01;
    case 'mm': case '毫米': return .001;
    default: return undefined;
  }
}

function scalar(value: unknown, metric: OpticalMetric, fallbackUnit = ''): number | undefined {
  if (typeof value !== 'number' && typeof value !== 'string') return undefined;
  const text = normalized(String(value));
  const unit = metric === 'maxWorkingDistanceM' ? distanceUnit : angleUnit;
  const match = text.match(new RegExp(`^(${numberPattern})\\s*(${unit})?$`, 'i'));
  if (!match) return undefined;
  let result = Number(match[1]);
  const declaredUnit = match[2] || fallbackUnit;
  if (metric === 'maxWorkingDistanceM') {
    const scale = declaredUnit ? distanceScale(declaredUnit) : 1;
    if (scale === undefined) return undefined;
    result *= scale;
  } else if (declaredUnit && !new RegExp(`^${angleUnit}$`, 'i').test(normalized(declaredUnit))) return undefined;
  return Number.isFinite(result) && result >= 0 && (metric === 'maxWorkingDistanceM' || result <= 360) ? result : undefined;
}

/** Only explicit optical fields/labels and the established FOV-pair + metre suffix are interpreted. */
function opticalValues(fact: StructuredFact): Partial<Record<OpticalMetric, number>> {
  const field = normalized(fact.field).replace(/[\s_-]/g, '');
  const fieldUnit = field.match(/\((°|degrees?|deg|度|mm|cm|m|毫米|厘米|米)\)$/)?.[1];
  const name = field.replace(/\((?:°|degrees?|deg|度|mm|cm|m|毫米|厘米|米)\)$/, '');
  const found = new Map<OpticalMetric, Set<number>>();
  const add = (metric: OpticalMetric, value: number | undefined) => {
    if (value === undefined) return;
    const values = found.get(metric) || new Set<number>();
    values.add(value); found.set(metric, values);
  };
  const horizontal = /^(?:hfov(?:水平视场角)?|水平视场角(?:hfov)?|水平视场|水平fov|horizontalfov|horizontalfieldofview)(?:deg|degrees?|°|度)?$/.test(name);
  const vertical = /^(?:vfov(?:垂直视场角)?|垂直视场角(?:vfov)?|垂直视场|垂直fov|verticalfov|verticalfieldofview)(?:deg|degrees?|°|度)?$/.test(name);
  const distance = name.match(/^(?:maximumworkingdistance|maxworkingdistance|workingdistance|trackingdistance|最大工作距离|最远工作距离|工作距离|最远距离|追踪距离|跟踪距离)(mm|cm|m|毫米|厘米|米)?$/);
  const fov = /^(?:fov|fieldofview|视场角|视场)(?:deg|degrees?|°|度)?$/.test(name);
  const composite = /^(?:产品规格或简称|产品规格\/简称|规格\/简称|产品规格|规格|产品简称|简称|规格参数|产品参数|光学参数|光学配置|specifications?|productspecifications?|specs?|shortname|productshortname)$/.test(name);
  const distanceNote = /^(?:备注|描述|notes?)$/.test(name);
  if (horizontal) add('hfovDeg', scalar(fact.value, 'hfovDeg', fact.unit || fieldUnit));
  if (vertical) add('vfovDeg', scalar(fact.value, 'vfovDeg', fact.unit || fieldUnit));
  if (distance) add('maxWorkingDistanceM', scalar(fact.value, 'maxWorkingDistanceM', fact.unit || fieldUnit || distance[1]));
  if (!(horizontal || vertical || distance || fov || composite || distanceNote) || typeof fact.value !== 'string') return Object.fromEntries([...found].map(([key, values]) => [key, [...values][0]]));

  const text = normalized(fact.value);
  const readPair = (pair: string) => {
    const values = pair.split(/[×x*]/i);
    add('hfovDeg', scalar(values[0], 'hfovDeg', fact.unit || fieldUnit));
    add('vfovDeg', scalar(values[1], 'vfovDeg', fact.unit || fieldUnit));
  };
  if (fov && new RegExp(`^${pairPattern}$`, 'i').test(text)) readPair(text);
  // Product short names may place the explicitly unit-marked H×V pair in parentheses.
  if (composite) for (const match of text.matchAll(new RegExp(`\\(\\s*(${numberPattern}\\s*${angleUnit}\\s*[×x*]\\s*${numberPattern}\\s*${angleUnit})\\s*\\)`, 'gi'))) readPair(match[1]);
  // English labels need a word boundary so unrelated identifiers cannot become optical facts.
  const fovLabel = String.raw`(?<![a-z0-9_])(?:fov|field\s*of\s*view|视场角)`;
  const pairs = distanceNote ? [] : text.matchAll(new RegExp(`${fovLabel}\\s*[:=：]?\\s*(${pairPattern})(?![a-z\\d.])`, 'gi'));
  for (const match of pairs) {
    readPair(match[1]);
    // A unit-bearing metre suffix is permitted only directly after an explicit FOV pair.
    const suffix = text.slice(match.index! + match[0].length).match(new RegExp(`^\\s*[,;，；]?\\s*(${numberPattern})\\s*(m|米)\\s*$`, 'i'));
    if (suffix) add('maxWorkingDistanceM', scalar(`${suffix[1]}${suffix[2]}`, 'maxWorkingDistanceM'));
  }
  const labelled: [OpticalMetric, string, string][] = [
    ['hfovDeg', String.raw`(?<![a-z0-9_])(?:hfov|horizontal\s*(?:fov|field\s*of\s*view)|水平(?:视场角|视场|fov)?)`, angleUnit],
    ['vfovDeg', String.raw`(?<![a-z0-9_])(?:vfov|vertical\s*(?:fov|field\s*of\s*view)|垂直(?:视场角|视场|fov)?)`, angleUnit],
    ['maxWorkingDistanceM', String.raw`(?<![a-z0-9_])(?:(?:max(?:imum)?\s*)?working\s*distance|tracking\s*distance|最大工作距离|最远工作距离|工作距离|追踪距离|跟踪距离|最远(?:距离)?)`, distanceUnit],
  ];
  for (const [metric, label, unit] of labelled) {
    if (distanceNote && metric !== 'maxWorkingDistanceM') continue;
    for (const match of text.matchAll(new RegExp(`${label}\\s*[:=：]?\\s*(${numberPattern})\\s*(${unit})(?![a-z\\d.])`, 'gi'))) add(metric, scalar(`${match[1]}${match[2]}`, metric));
  }
  // Multiple variant values in one fact are ambiguous; do not assign one to this report configuration.
  if ([...found.values()].some(values => values.size > 1)) return {};
  return Object.fromEntries([...found].map(([key, values]) => [key, [...values][0]]));
}

function factReference(fact: StructuredFact): SourceReference {
  const value = typeof fact.value === 'string' ? fact.value : JSON.stringify(fact.value);
  return { type: 'structured_fact', id: fact.id, label: `${fact.productKey} · ${fact.field}`, evidence: `${fact.productKey} ${fact.field}：${value}${fact.unit || ''}`, authority: fact.authority };
}

function configurationIdentity(configuration: EngineeringOpticalConfiguration): string {
  return JSON.stringify([normalized(configuration.model), configuration.variant, configuration.lens?.focalLengthMm, configuration.lens?.apertureF, configuration.hfovDeg, configuration.vfovDeg, configuration.maxWorkingDistanceM, configuration.rangeMode, [...configuration.cameraIds].sort(), configuration.sourceRef.id]);
}

/** Compare report inputs with selected products' authoritative facts without changing either source. */
export function engineeringOpticsConflicts(context: ProjectContext, facts: StructuredFact[]): ProjectConflict[] {
  const selected = new Set(context.products.map(normalized));
  const authoritative = facts.filter(fact => fact.authority === 'authoritative' && selected.has(normalized(fact.productKey))).map(fact => ({ fact, values: opticalValues(fact) }));
  const reportChoice = context.lockedFacts.find(fact => fact.locked && fact.sourceType === 'user' && fact.key === 'engineering.opticsSource' && fact.value === 'report');
  const conflicts: ProjectConflict[] = [];
  for (const configuration of context.engineering?.deployment?.opticalConfigurations || []) {
    const model = normalized(configuration.model);
    if (!selected.has(model)) continue;
    for (const { fact, values } of authoritative) {
      if (normalized(fact.productKey) !== model) continue;
      const differences = metrics.filter(metric => {
        const reportValue = configuration[metric], authoritativeValue = values[metric];
        return typeof reportValue === 'number' && Number.isFinite(reportValue) && reportValue >= 0 && authoritativeValue !== undefined && Math.abs(reportValue - authoritativeValue) > 1e-6;
      });
      if (!differences.length) continue;
      const detail = differences.map(metric => `${metricLabels[metric]}：报告 ${configuration[metric]}，权威产品资料 ${values[metric]} ${metric === 'maxWorkingDistanceM' ? 'm' : '°'}`).join('；');
      conflicts.push({
        id: stableId(context.projectId, 'engineering-optics', configurationIdentity(configuration), fact.id),
        key: 'engineering.optics', severity: reportChoice ? 'warning' : 'error', status: reportChoice ? 'resolved' : 'open',
        message: `${configuration.model}${configuration.variant ? `（${configuration.variant}）` : ''} 光学配置与权威产品资料不同（${detail}）。同型号的不同光学配置不能当作同一配置已验证。${reportChoice ? '本项目按报告配置进行工程分析，产品通用光学值不是本次仿真依据；仿真输入不是实测产品能力。' : '请核对报告配置与产品资料，并明确本项目的工程分析依据。'}`,
        actual: { report: { ...configuration, lens: configuration.lens ? { ...configuration.lens } : undefined, cameraIds: [...configuration.cameraIds], sourceRef: { ...configuration.sourceRef } }, authoritative: { field: fact.field, value: fact.value, unit: fact.unit } },
        sourceRefs: [{ ...configuration.sourceRef }, factReference(fact), ...(reportChoice ? [{ ...reportChoice.sourceRef }] : [])],
      });
    }
  }
  return conflicts;
}
