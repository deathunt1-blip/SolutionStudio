import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { load } from 'cheerio';
import type { DocumentBlock, DocumentSection, GeneratedDocument, GenerationJob, ValidationIssue } from '../packages/document-engine/src/types.js';
import { defaultOutputProfile } from '../packages/document-engine/src/types.js';
import type { ProjectAsset, ProjectContext } from '../packages/projects/src/types.js';
import Projects, { ContextReview, contextFactPayload, parseFactValue, requirementRows } from '../apps/web/src/Projects.js';
import DocumentEditor, { BlockEditor, DocumentPlan, GenerationProgress, GenerationSettings, OutputSettings, SectionEditor, ValidationPanel, defaultGenerationConfig, planPayload, planProblem } from '../apps/web/src/DocumentEditor.js';

const resources = vi.hoisted(() => new Map<string, unknown>());
vi.mock('../apps/web/src/ui.js', async importOriginal => ({ ...await importOriginal<typeof import('../apps/web/src/ui.js')>(), useResource: (path: string) => ({ data: resources.get(path), loading: false, error: '', reload: () => {} }) }));
const source = { type: 'engineering_data' as const, id: 'input-engineering', label: '工程报告', evidence: '设备数量 32' };
const context: ProjectContext = { projectId: 'project', revision: 3, confirmed: false, summary: '机器人动作捕捉', requirements: { goals: [{ id: 'goal', value: '测量机器人运动', sourceInputId: 'input-customer', evidence: '需要测量机器人运动', confidence: .9, confirmedByUser: false }], performance: { accuracy: { id: 'accuracy', value: '≤0.1mm', sourceInputId: 'input-customer', evidence: '精度要求≤0.1mm', confidence: 1, confirmedByUser: false } }, interfaces: [], protocols: [], environment: [], installationConstraints: [], specialRequirements: [], acceptanceCriteria: [], unresolved: [] }, lockedFacts: [{ id: 'count', key: 'deployment.equipmentCount', label: '设备数量', value: 32, unit: '台', sourceType: 'engineering_data', sourceRef: source, locked: true }], products: ['K18'], capabilities: [], assets: [], conflicts: [{ id: 'conflict', key: 'accuracy', message: '客户要求≤0.1mm，工程P95理论误差为0.35mm', severity: 'error', sourceRefs: [source], status: 'open' }], unresolved: [{ id: 'question', key: 'protocol', question: '数据接口协议尚未明确' }] };
const section: DocumentSection = { id: 'section', title: '系统设计', level: 1, order: 0, generationMode: 'ai', requiredContext: [], status: 'generated', blocks: [{ id: 'paragraph', type: 'paragraph', text: '本项目使用32台相机。' }], sourceRefs: [source], assetRefs: [], lockedFactRefs: ['count'], claims: [], revision: 2, edited: false };
const document: GeneratedDocument = { id: 'document', projectId: 'project', projectName: '机器人项目', customerName: '客户甲', title: '技术方案', documentType: 'technical_proposal', templateId: 'standard', templateVersion: 1, contextRevision: 3, revision: 2, status: 'generated', sections: [section], outputProfile: defaultOutputProfile, createdAt: '2026-09-23T00:00:00Z', updatedAt: '2026-09-23T00:00:00Z', issues: [] };
const button = (html: ReturnType<typeof load>, text: string) => html('button').filter((_i, element) => html(element).text() === text);
const render = (element: React.ReactNode) => load(renderToStaticMarkup(element));
afterEach(() => { resources.clear(); vi.unstubAllGlobals(); });

describe('Project review and proposal editor', () => {
  it('keeps customer targets, engineering facts, conflicts, and unanswered questions distinct', () => {
    const html = render(<ContextReview context={context} confirmed={() => {}} />);
    expect(html.text()).toContain('客户要求');
    expect(html('textarea').map((_i, el) => html(el).text()).get()).toContain('≤0.1mm');
    expect(html('.context-facts').text()).toContain('32 台');
    expect(html('.context-facts').text()).toContain('工程结果');
    expect(html('.context-conflict').text()).toContain('0.35mm');
    expect(html('.context-question').text()).toContain('协议尚未明确');
    expect(html('a[href="/api/projects/project/inputs/input-customer/original"]')).toHaveLength(2);
    expect(button(html, '确认项目理解与关键事实')).toHaveLength(1);
  });

  it('retains actual fact types for numeric values and scene dimensions', () => {
    expect(parseFactValue('32')).toBe(32);
    expect(parseFactValue('[12, 10, 5]')).toEqual([12, 10, 5]);
    expect(parseFactValue('K18')).toBe('K18');
    expect(parseFactValue('≤0.1mm')).toBe('≤0.1mm');
    expect(requirementRows(context.requirements).find(row => row.label === '精度要求')).toMatchObject({ evidence: '精度要求≤0.1mm', sourceInputId: 'input-customer', value: '≤0.1mm' });
  });

  it('offers report optical selection only when actual report configurations exist', () => {
    expect(render(<ContextReview context={context} confirmed={() => {}} />)('select[aria-label="工程分析光学口径"]')).toHaveLength(0);
    const opticalContext: ProjectContext = { ...context, engineering: { sourceType: 'scenelab', assets: [], sourceRef: source, deployment: { opticalConfigurations: [{ model: 'K18', variant: 'Standard', lens: { focalLengthMm: 8 }, hfovDeg: 72, vfovDeg: 67, maxWorkingDistanceM: 47, cameraIds: ['camera-1'], sourceRef: source }] } } };
    const html = render(<ContextReview context={opticalContext} confirmed={() => {}} />);
    const select = html('select[aria-label="工程分析光学口径"]');
    expect(select.find('option').map((_i, element) => html(element).attr('value')).get()).toEqual(['unconfirmed', 'report']);
    expect(select.find('option[selected]').attr('value')).toBe('unconfirmed');
    expect(html('.context-engineering li').text()).toContain('K18（Standard） · 镜头焦距 8mm · 水平视场角 72° · 垂直视场角 67° · 仿真最大距离 47m');
    expect(html.text()).toContain('通用产品参数不能替代报告中的仿真输入');
    expect(button(html, '保存修正').attr('disabled')).toBeDefined();
  });

  it('restores user optical choice without offering a duplicate generic fact editor', () => {
    const opticalContext: ProjectContext = { ...context, confirmed: true, engineering: { sourceType: 'scenelab', assets: [], sourceRef: source, deployment: { opticalConfigurations: [{ model: 'K18', lens: { focalLengthMm: 8 }, cameraIds: ['camera-1'], sourceRef: source }] } }, lockedFacts: [...context.lockedFacts, { id: 'choice', key: 'engineering.opticsSource', label: '工程分析光学口径', value: 'report', sourceType: 'user', sourceRef: { ...source, type: 'user' }, locked: true }] };
    const html = render(<ContextReview context={opticalContext} confirmed={() => {}} />);
    expect(html('select[aria-label="工程分析光学口径"] option[selected]').attr('value')).toBe('report');
    expect(html('.context-facts').text()).not.toContain('engineering.opticsSource');
    expect(html('.context-facts').text()).not.toContain('工程分析光学口径');
    expect(html('.context-facts article')).toHaveLength(1);
    expect(html('.context-engineering li').text()).toContain('水平视场角 未提供');
    expect(button(html, '已确认项目理解').attr('disabled')).toBeDefined();
    const inferred = render(<ContextReview context={{ ...opticalContext, lockedFacts: opticalContext.lockedFacts.map(fact => fact.key === 'engineering.opticsSource' ? { ...fact, sourceType: 'engineering_data' } : fact) }} confirmed={() => {}} />);
    expect(inferred('select[aria-label="工程分析光学口径"] option[selected]').attr('value')).toBe('unconfirmed');
  });

  it('persists one optical source fact from the selector and can explicitly return it to unconfirmed', () => {
    const facts = [{ key: 'deployment.equipmentCount', label: '设备数量', value: '32', unit: '台' }, { key: 'engineering.opticsSource', label: '旧口径', value: 'product', unit: '' }, { key: ' engineering.opticsSource ', label: '重复口径', value: 'report', unit: '' }, { key: 'scene.boundaryM', label: '场地尺寸', value: '[12,10,5]', unit: 'm' }];
    const before = structuredClone(facts);
    expect(contextFactPayload(facts, 'report')).toEqual([{ key: 'deployment.equipmentCount', label: '设备数量', value: 32, unit: '台' }, { key: 'scene.boundaryM', label: '场地尺寸', value: [12, 10, 5], unit: 'm' }, { key: 'engineering.opticsSource', label: '工程分析光学口径', value: 'report' }]);
    expect(contextFactPayload(facts, 'unconfirmed').filter(fact => fact.key === 'engineering.opticsSource')).toEqual([{ key: 'engineering.opticsSource', label: '工程分析光学口径', value: 'unconfirmed' }]);
    expect(contextFactPayload(facts).some(fact => fact.key === 'engineering.opticsSource')).toBe(false);
    expect(facts).toEqual(before);
  });

  it('only offers creation of a proposal after the current context is confirmed', () => {
    vi.stubGlobal('window', { location: { hash: '#projects?project=project' } });
    resources.set('/projects/project', { project: { id: 'project', name: '机器人项目', status: 'draft', inputs: [], assets: [] } });
    resources.set('/projects/project/context', { context });
    resources.set('/document-templates', { items: [{ id: 'standard', name: '标准技术方案', version: 1, sections: [] }] });
    resources.set('/projects/project/documents', { items: [] });
    const unconfirmed = render(<Projects refresh={0} notify={() => {}} openKnowledge={() => {}} />);
    expect(button(unconfirmed, '生成技术方案')).toHaveLength(0);
    resources.set('/projects/project/context', { context: { ...context, confirmed: true } });
    const confirmed = render(<Projects refresh={0} notify={() => {}} openKnowledge={() => {}} />);
    expect(button(confirmed, '生成技术方案')).toHaveLength(1);
  });

  it('renders parameter tables as real editable cells and retains their provenance warning', () => {
    const table: DocumentBlock = { id: 'table', type: 'table', title: '设备配置', columns: ['型号', '数量'], rows: [['K18', '32']], sourceRefs: [source], generated: true };
    const html = render(<BlockEditor block={table} assets={[]} disabled={false} onChange={() => {}} />);
    expect(html('textarea[aria-label="第 1 行第 1 列"]').text()).toBe('K18');
    expect(html('textarea[aria-label="第 1 行第 2 列"]').text()).toBe('32');
    expect(html.text()).toContain('保留 1 条来源');
    expect(button(html, '增加行')).toHaveLength(1);
    expect(button(html, '增加列')).toHaveLength(1);
  });

  it('uses an existing project asset and exposes an editable figure caption', () => {
    const asset: ProjectAsset = { id: 'asset', projectId: 'project', inputId: 'input-engineering', role: 'deployment_perspective', filename: 'deployment.png', mimeType: 'image/png', objectKey: 'objects/image', caption: '相机部署', sourceRef: source, url: '/api/projects/project/assets/asset' };
    const html = render(<BlockEditor block={{ id: 'image', type: 'asset', assetId: 'asset', caption: '相机布局透视图' }} assets={[asset]} disabled={false} onChange={() => {}} />);
    expect(html('img').attr('src')).toBe(asset.url);
    expect(html('img').attr('alt')).toBe('相机布局透视图');
    expect(html('select option[selected]').attr('value')).toBe('asset');
    expect(html('input').attr('value')).toBe('相机布局透视图');
  });

  it('does not allow inserting an image before any project assets exist', () => {
    const html = render(<SectionEditor section={section} documentId="document" assets={[]} disabled={false} saved={() => {}} dirtyChanged={() => {}} />);
    expect(button(html, '图片').attr('disabled')).toBeDefined();
    expect(button(html, '表格').attr('disabled')).toBeUndefined();
    expect(button(html, '保存章节').attr('disabled')).toBeDefined();
  });

  it('defaults to no cover logo and only offers PNG or JPEG assets from the document project', () => {
    const asset: ProjectAsset = { id: 'logo-png', projectId: 'project', inputId: 'input-brand', role: 'image', filename: 'logo.png', mimeType: 'image/png', objectKey: 'objects/logo', sourceRef: source, url: '/api/projects/project/assets/logo-png' };
    const assets = [asset, { ...asset, id: 'logo-jpeg', filename: 'logo.jpeg', mimeType: 'image/jpeg' }, { ...asset, id: 'logo-jpg', filename: 'logo.jpg', mimeType: 'image/jpg' }, { ...asset, id: 'foreign-logo', projectId: 'other-project' }, { ...asset, id: 'logo-svg', mimeType: 'image/svg+xml' }, { ...asset, id: 'logo-gif', mimeType: 'image/gif' }];
    const html = render(<OutputSettings document={document} assets={assets} close={() => {}} saved={() => {}} />);
    const select = html('select[aria-label="封面 Logo"]');
    expect(select.find('option').map((_i, el) => html(el).attr('value')).get()).toEqual(['', 'logo-png', 'logo-jpeg', 'logo-jpg']);
    expect(select.find('option[selected]').attr('value')).toBe('');
    expect(select.find('option[selected]').text()).toBe('不显示 Logo');
    expect(html('input[type=url], input[type=file]')).toHaveLength(0);
  });

  it('shows the saved cover logo and retains an option to clear it', () => {
    const asset: ProjectAsset = { id: 'logo', projectId: 'project', inputId: 'input-brand', role: 'image', filename: 'logo.png', mimeType: 'image/png', objectKey: 'objects/logo', caption: '公司标志', sourceRef: source, url: '/api/projects/project/assets/logo' };
    const html = render(<OutputSettings document={{ ...document, outputProfile: { ...defaultOutputProfile, coverLogoAssetId: 'logo' } }} assets={[asset]} close={() => {}} saved={() => {}} />);
    const select = html('select[aria-label="封面 Logo"]');
    expect(select.find('option[selected]').attr('value')).toBe('logo');
    expect(select.find('option[selected]').text()).toBe('公司标志');
    expect(select.find('option[value=""]').text()).toBe('不显示 Logo');
  });

  it('shows a persisted partial failure without discarding completed progress or cost', () => {
    const job: GenerationJob = { id: 'job', documentId: 'document', status: 'budget_exhausted', sectionIds: ['a', 'b', 'c'], processed: 2, failed: 1, config: { ...defaultGenerationConfig, limitsEnabled: true }, reservedCny: 0, estimatedCostCny: .1421, inputTokens: 2000, outputTokens: 1400, errors: [{ sectionId: 'b', message: '预算不足，后续章节尚未生成' }], createdAt: '2026-09-23T00:00:00Z', updatedAt: '2026-09-23T00:00:00Z' };
    const html = render(<GenerationProgress job={job} />);
    expect(html.text()).toContain('预算用尽，已停止新请求');
    expect(html.text()).toContain('2 / 3 章');
    expect(html.text()).toContain('¥0.1421 / 上限 ¥10.00');
    expect(html('progress').attr('value')).toBe('67');
    expect(html.text()).toContain('预算不足');
  });

  it('defaults to unlimited generation and hides inactive token and budget controls', () => {
    const html = render(<GenerationSettings config={defaultGenerationConfig} setConfig={() => {}} disabled={false} />);
    expect(defaultGenerationConfig).toMatchObject({ model: 'kimi-k3', temperature: 1, reasoningEffort: 'max', limitsEnabled: false, maxTokens: 3000, maxContextTokens: 12000, budgetCny: 10 });
    expect(html('.generation-limit-toggle').text()).toBe('启用生成额度限制');
    expect(html('input[type=checkbox]').attr('checked')).toBeUndefined();
    expect(html('input[type=number]')).toHaveLength(0);
    expect(html('select option[selected]').map((_i, el) => html(el).attr('value')).get()).toEqual(['kimi-k3', 'max']);
    expect(html.text()).toContain('K3 始终启用思考');
    expect(html.text()).toContain('10 分钟');
    expect(html.text()).not.toContain('固定为 0.6');
    expect(html.text()).not.toContain('单章上下文 Token 上限');
    expect(html.text()).not.toContain('每次任务上限');
    expect(html.text()).toContain('当前不限额度');
    expect(html.text()).toContain('模型技术上限');
    expect(html.text()).toContain('用量与费用依然记录');
  });

  it('shows the saved token and budget controls when generation limits are enabled', () => {
    const html = render(<GenerationSettings config={{ ...defaultGenerationConfig, limitsEnabled: true }} setConfig={() => {}} disabled={false} />);
    expect(html('input[type=checkbox]').attr('checked')).toBeDefined();
    expect(html('input[type=number]').map((_i, el) => html(el).attr('value')).get()).toEqual(['3000', '12000', '10']);
    expect(html.text()).toContain('单章上下文 Token 上限');
    expect(html.text()).toContain('每次任务上限 ¥10.00');
    expect(html.text()).not.toContain('当前不限额度');
    expect(html('input[type=number]:disabled')).toHaveLength(0);
  });

  it('offers all K3 reasoning levels and displays the saved selection', () => {
    const html = render(<GenerationSettings config={{ ...defaultGenerationConfig, reasoningEffort: 'high' }} setConfig={() => {}} disabled={false} />);
    const reasoning = html('label').filter((_i, element) => html(element).text().startsWith('推理强度')).find('select');
    expect(reasoning.find('option').map((_i, el) => html(el).attr('value')).get()).toEqual(['low', 'high', 'max']);
    expect(reasoning.find('option[selected]').attr('value')).toBe('high');
    expect(html('option[value="kimi-k2.6"]')).toHaveLength(1);
  });

  it('keeps K2.6 available explicitly with its own fixed temperature and no reasoning selector', () => {
    const html = render(<GenerationSettings config={{ ...defaultGenerationConfig, model: 'kimi-k2.6', temperature: 0.6 }} setConfig={() => {}} disabled={false} />);
    expect(html('select option[selected]').attr('value')).toBe('kimi-k2.6');
    expect(html('input[type=number]:disabled').attr('value')).toBe('0.6');
    expect(html.text()).toContain('Kimi K2.6 固定为 0.6');
    expect(html.text()).not.toContain('推理强度');
    expect(html.text()).not.toContain('K3 始终启用思考');
  });

  it('records costs for unlimited jobs and preserves the budget display for legacy jobs', () => {
    const job: GenerationJob = { id: 'job', documentId: 'document', status: 'completed', sectionIds: ['a'], processed: 1, failed: 0, config: defaultGenerationConfig, reservedCny: 0, estimatedCostCny: .1421, inputTokens: 2000, outputTokens: 1400, errors: [], createdAt: '', updatedAt: '' };
    const unlimited = render(<GenerationProgress job={job} />);
    expect(unlimited.text()).toContain('¥0.1421 · 不限额度');
    expect(unlimited.text()).toContain('模型 kimi-k3 · 推理强度 最高');
    expect(unlimited.text()).not.toContain('上限 ¥');
    const { limitsEnabled: _, ...legacyConfig } = defaultGenerationConfig;
    const legacy = render(<GenerationProgress job={{ ...job, config: { ...legacyConfig, model: 'kimi-k2.6', temperature: 0.6 } }} />);
    expect(legacy.text()).toContain('¥0.1421 / 上限 ¥10.00');
    expect(legacy.text()).toContain('模型 kimi-k2.6 · 温度 0.6');
    expect(legacy.text()).not.toContain('推理强度');
    expect(legacy.text()).not.toContain('不限额度');
  });

  it('disables the generation limit switch and controls while a task is running', () => {
    const html = render(<GenerationSettings config={{ ...defaultGenerationConfig, limitsEnabled: true }} setConfig={() => {}} disabled />);
    expect(html('input[type=checkbox]').attr('disabled')).toBeDefined();
    expect(html('input[type=number]:disabled')).toHaveLength(3);
    expect(html('select:disabled')).toHaveLength(2);
  });

  it('exposes supported plan edits and keeps deletion consequences visible', () => {
    const html = render(<DocumentPlan document={document} disabled={false} saved={() => {}} dirtyChanged={() => {}} />);
    expect(html('input[aria-label="章节 1 标题"]').attr('value')).toBe('系统设计');
    expect(html('select[aria-label="章节 1 层级"]')).toHaveLength(1);
    expect(html('button[aria-label="上移系统设计"]').attr('disabled')).toBeDefined();
    expect(html.text()).toContain('删除章节会在保存计划后移除该章内容');
  });

  it('submits new plan sections without client IDs and rejects skipped heading levels', () => {
    const added = { ...section, id: 'client-only-id', title: '补充章节', level: 2 };
    expect(planPayload(document, [section, added])).toEqual([{ id: 'section', title: '系统设计', level: 1 }, { title: '补充章节', level: 2 }]);
    expect(planProblem([section, added])).toBe('');
    expect(planProblem([{ ...section, level: 2 }])).toContain('第一章需为一级');
    expect(planProblem([section, { ...added, level: 3 }])).toContain('不能跳级');
  });

  it('presents validation errors with their offending quote and a location action', () => {
    const issue: ValidationIssue = { id: 'issue', sectionId: 'section', blockId: 'paragraph', severity: 'error', type: 'fact_mismatch', message: '相机数量与项目事实不一致', quote: '36台相机', sourceRefs: [source] };
    const html = render(<ValidationPanel issues={[issue]} onLocate={() => {}} validate={() => {}} disabled={false} />);
    expect(html('.validation-issue.error').text()).toContain('事实不一致');
    expect(html('blockquote').text()).toBe('36台相机');
    expect(html('.validation-issue').text()).toContain('定位内容');
  });

  it('disables new generation and editing while the persisted job is active', () => {
    resources.set('/generated-documents/document', { document });
    resources.set('/projects/project/context', { context });
    resources.set('/generated-documents/document/jobs', { jobs: [{ id: 'job', documentId: 'document', status: 'running', sectionIds: ['section'], processed: 0, failed: 0, config: defaultGenerationConfig, reservedCny: 0, estimatedCostCny: 0, inputTokens: 0, outputTokens: 0, errors: [], createdAt: '', updatedAt: '' }] });
    const html = render(<DocumentEditor id="document" projectId="project" notify={() => {}} back={() => {}} openKnowledge={() => {}} />);
    expect(button(html, '生成全部章节').attr('disabled')).toBeDefined();
    expect(button(html, '重新生成').attr('disabled')).toBeDefined();
    expect(html('textarea[aria-label="段落内容"]').attr('disabled')).toBeDefined();
  });
});
