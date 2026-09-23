import { useEffect, useState } from 'react';
import { ArrowUpRight, Check, CheckCircle2, ChevronRight, Database, FolderInput, Gauge, KeyRound, Layers3, Link2, LoaderCircle, Plus, Save, Settings2, ShieldCheck, SlidersHorizontal, Tag, Trash2, Unplug } from 'lucide-react';
import type { Registries, RegistryItem, Settings as SettingsType } from '../../../packages/core/src/types.js';
import { api, patch, post } from './api.js';
import { ErrorMessage, Loading, Modal, type Notify } from './ui.js';
import FeishuSources from './FeishuSources.js';

type RegistryKind = keyof Registries;
const kinds: { key: RegistryKind; name: string; description: string }[] = [{ key: 'documentTypes', name: '文档类型', description: '定义资料是什么，决定如何组织与使用。' }, { key: 'applications', name: '应用领域', description: '连接资料与业务场景，让跨行业经验可查找。' }, { key: 'topics', name: '技术主题', description: '为技术概念建立统一标签，归并不同表达。' }];

export default function Settings({ settings, registries, reload, notify }: { settings?: SettingsType; registries?: Registries; reload: () => void; notify: Notify }) {
  const [tab, setTab] = useState(() => new URLSearchParams(window.location.hash.split('?')[1]).get('tab') === 'sources' ? 'sources' : 'classification');
  return <>
    <div className="page-heading"><div><div className="eyebrow">MAKE IT WORK YOUR WAY</div><h1>分类与设置<span className="heading-dot">.</span></h1><p>定义整理规则，构建适合你的知识体系。</p></div><span className="heading-label"><Settings2 size={17} />工作台设置</span></div>
    <div className="settings-tabs" role="tablist" aria-label="设置分类">{[{ key: 'classification', text: '分类体系', Icon: Tag }, { key: 'processing', text: '处理规则', Icon: SlidersHorizontal }, { key: 'model', text: '模型配置', Icon: KeyRound }, { key: 'sources', text: '资料来源', Icon: FolderInput }].map(item => <button role="tab" aria-selected={tab === item.key} key={item.key} className={tab === item.key ? 'active' : ''} onClick={() => setTab(item.key)}><item.Icon size={16} />{item.text}</button>)}</div>
    {tab === 'classification' && (registries ? <RegistrySettings registries={registries} reload={reload} notify={notify} /> : <Loading />)}
    {tab === 'processing' && (settings ? <ProcessingSettings settings={settings} reload={reload} notify={notify} /> : <Loading />)}
    {tab === 'model' && (settings ? <ModelSettings settings={settings} reload={reload} notify={notify} /> : <Loading />)}
    {tab === 'sources' && (settings ? <FeishuSources settings={settings} notify={notify} reload={reload} /> : <Loading />)}
  </>;
}

function RegistrySettings({ registries, reload, notify }: { registries: Registries; reload: () => void; notify: Notify }) {
  const [kind, setKind] = useState<RegistryKind>('documentTypes');
  const [adding, setAdding] = useState(false);
  const [removing, setRemoving] = useState<RegistryItem>();
  const [form, setForm] = useState({ key: '', label: '', aliases: '' });
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const current = kinds.find(item => item.key === kind)!;
  const save = async (event: React.FormEvent) => {
    event.preventDefault(); setBusy(true); setError('');
    try { await post(`/registries/${kind}`, { key: form.key.trim(), label: form.label.trim(), aliases: form.aliases.split(/[,，\n]/).map(value => value.trim()).filter(Boolean) }); reload(); setAdding(false); setForm({ key: '', label: '', aliases: '' }); notify('分类已创建，可用于资料分类与筛选。'); }
    catch (caught) { setError(caught instanceof Error ? caught.message : '保存失败'); }
    finally { setBusy(false); }
  };
  const remove = async () => {
    if (!removing) return;
    setBusy(true); setError('');
    try { await api(`/registries/${kind}/${encodeURIComponent(removing.key)}`, { method: 'DELETE' }); reload(); setRemoving(undefined); notify('分类已删除。'); }
    catch (caught) { setError(caught instanceof Error ? caught.message : '删除失败'); }
    finally { setBusy(false); }
  };
  return <div className="settings-layout"><aside className="settings-side"><h3>知识的组织方式</h3><p>分类来自可维护的词表。新增类别后，后续资料会使用最新体系。</p>{kinds.map(item => <button key={item.key} className={kind === item.key ? 'active' : ''} onClick={() => setKind(item.key)}><span>{item.name}</span><span>{registries[item.key].length}<ChevronRight size={14} /></span></button>)}<div className="settings-tip"><ShieldCheck size={18} /><p>“未知”是有效的识别结果。系统只在需要关键判断时请求确认。</p></div></aside><section className="panel registry-panel"><div className="panel-heading"><div><h2>{current.name} <span className="count-pill">{registries[kind].length}</span></h2><p>{current.description}</p></div><button className="button primary small-button" onClick={() => { setError(''); setAdding(true); }}><Plus size={15} />新增{current.name}</button></div><div className="registry-table"><div className="registry-head"><span>名称 / 标识</span><span>同义词</span><span /></div>{registries[kind].map(item => <div className="registry-row" key={item.key}><div><strong>{item.label}</strong><code>{item.key}</code></div><div className="registry-aliases">{item.aliases.length ? item.aliases.map(alias => <span className="tag" key={alias}>{alias}</span>) : <span className="subtle">—</span>}</div><button className="icon-button delete-button" disabled={item.key === 'unknown'} title={item.key === 'unknown' ? '系统保留类别' : `删除${item.label}`} aria-label={`删除${item.label}`} onClick={() => { setError(''); setRemoving(item); }}><Trash2 size={15} /></button></div>)}</div><div className="panel-footer"><span>已被资料使用的分类不会被删除。</span><span>{registries[kind].length} 个类别</span></div></section>
      {adding && <Modal title={`新增${current.name}`} close={() => setAdding(false)}><form className="modal-form" onSubmit={save}>{error && <ErrorMessage message={error} />}<label className="field">显示名称<input required autoFocus value={form.label} onChange={event => setForm({ ...form, label: event.target.value })} placeholder="例如：数据采集规范" /></label><label className="field">唯一标识<input required pattern="[a-z][a-z0-9_]*" value={form.key} onChange={event => setForm({ ...form, key: event.target.value })} placeholder="例如：data_collection_standard" /><small>小写字母开头，可包含数字和下划线。</small></label><label className="field">同义词 <span className="optional">可选</span><input value={form.aliases} onChange={event => setForm({ ...form, aliases: event.target.value })} placeholder="多个词语用逗号分隔" /></label><div className="modal-form-actions"><button className="button" type="button" onClick={() => setAdding(false)}>取消</button><button className="button primary" disabled={busy}>{busy ? <LoaderCircle className="spin" size={15} /> : <Plus size={15} />}创建类别</button></div></form></Modal>}
      {removing && <Modal title="删除分类" close={() => setRemoving(undefined)}><div className="modal-form">{error && <ErrorMessage message={error} />}<p>删除“{removing.label}”？如果已有资料使用此分类，系统会保留它并提示原因。</p><div className="modal-form-actions"><button className="button" onClick={() => setRemoving(undefined)}>取消</button><button className="button danger" disabled={busy} onClick={() => void remove()}>删除分类</button></div></div></Modal>}
    </div>;
}

function ProcessingSettings({ settings, reload, notify }: { settings: SettingsType; reload: () => void; notify: Notify }) {
  const [form, setForm] = useState({ autoAcceptThreshold: settings.autoAcceptThreshold, reviewThreshold: settings.reviewThreshold, chunkTargetTokens: settings.chunkTargetTokens, chunkOverlapTokens: settings.chunkOverlapTokens });
  const [busy, setBusy] = useState(false); const [error, setError] = useState('');
  const save = async (event: React.FormEvent) => {
    event.preventDefault(); setError('');
    if (form.reviewThreshold >= form.autoAcceptThreshold) { setError('待确认阈值必须小于自动接受阈值。'); return; }
    if (form.chunkOverlapTokens >= form.chunkTargetTokens) { setError('片段重叠长度必须小于目标片段长度。'); return; }
    setBusy(true);
    try { await patch('/settings', form); reload(); notify('处理规则已保存，将用于后续导入与重建。'); }
    catch (caught) { setError(caught instanceof Error ? caught.message : '保存失败'); } finally { setBusy(false); }
  };
  return <form className="settings-form" onSubmit={save}><section className="panel form-panel"><div className="panel-heading"><div><h2><Gauge size={18} />置信度与人工确认</h2><p>只让文档类型和权威级别的不确定判断进入待确认。</p></div></div><div className="form-panel-body"><div className="threshold-visual"><div className="threshold-review" style={{ flex: form.reviewThreshold }}><span>待人工确认</span><strong>&lt; {Math.round(form.reviewThreshold * 100)}%</strong></div><div className="threshold-low" style={{ flex: form.autoAcceptThreshold - form.reviewThreshold }}><span>低置信度</span></div><div className="threshold-auto" style={{ flex: 1 - form.autoAcceptThreshold }}><span>自动接受</span><strong>≥ {Math.round(form.autoAcceptThreshold * 100)}%</strong></div></div><div className="form-grid"><label className="field">自动接受阈值<input type="number" min="0.1" max="1" step="0.01" required value={form.autoAcceptThreshold} onChange={event => setForm({ ...form, autoAcceptThreshold: Number(event.target.value) })} /><small>达到此置信度的字段自动接受，默认 0.85。</small></label><label className="field">待确认阈值<input type="number" min="0" max="0.99" step="0.01" required value={form.reviewThreshold} onChange={event => setForm({ ...form, reviewThreshold: Number(event.target.value) })} /><small>关键字段低于此值需要确认，默认 0.60。</small></label></div><div className="notice"><ShieldCheck size={17} /><p>未知的关键字段始终需要确认。领域、主题、产品的低置信度不会阻塞资料入库。</p></div></div></section><section className="panel form-panel"><div className="panel-heading"><div><h2><Layers3 size={18} />知识片段</h2><p>优先按标题、段落和表格组织内容，过长片段再按长度切分。</p></div></div><div className="form-panel-body"><div className="form-grid"><label className="field">目标片段长度 · tokens<input type="number" min="200" max="4000" step="1" required value={form.chunkTargetTokens} onChange={event => setForm({ ...form, chunkTargetTokens: Number(event.target.value) })} /><small>建议 500–1200，平衡完整性与检索精度。</small></label><label className="field">片段重叠长度 · tokens<input type="number" min="0" max="3999" step="1" required value={form.chunkOverlapTokens} onChange={event => setForm({ ...form, chunkOverlapTokens: Number(event.target.value) })} /><small>建议 50–150，帮助保持相邻片段的上下文。</small></label></div></div></section>{error && <ErrorMessage message={error} />}<div className="settings-save"><span>保存后对新导入或重新处理的资料生效</span><button className="button primary" disabled={busy}>{busy ? <LoaderCircle className="spin" size={15} /> : <Save size={15} />}保存处理规则</button></div></form>;
}

function ModelSettings({ settings, reload, notify }: { settings: SettingsType; reload: () => void; notify: Notify }) {
  const [form, setForm] = useState({ baseUrl: settings.llm.baseUrl, model: settings.llm.model, apiKey: '', temperature: settings.llm.temperature, maxTokens: settings.llm.maxTokens });
  const [busy, setBusy] = useState(''); const [error, setError] = useState(''); const [testResult, setTestResult] = useState<{ ok: boolean; message: string }>();
  const save = async (event: React.FormEvent) => {
    event.preventDefault(); setError(''); setBusy('save');
    try { const { apiKey, ...rest } = form; await patch('/settings', { llm: { ...rest, ...(apiKey.trim() ? { apiKey: apiKey.trim() } : {}) } }); setForm(current => ({ ...current, apiKey: '' })); reload(); setTestResult(undefined); notify('模型配置已保存，密钥不会显示或回传。'); }
    catch (caught) { setError(caught instanceof Error ? caught.message : '保存失败'); } finally { setBusy(''); }
  };
  const test = async () => {
    setBusy('test'); setError('');
    try { setTestResult(await post<{ ok: boolean; message: string }>('/settings/test-llm')); }
    catch (caught) { setError(caught instanceof Error ? caught.message : '连接测试失败'); } finally { setBusy(''); }
  };
  const dirty = form.baseUrl !== settings.llm.baseUrl || form.model !== settings.llm.model || !!form.apiKey || form.temperature !== settings.llm.temperature || form.maxTokens !== settings.llm.maxTokens;
  return <div className="settings-layout model-layout"><aside className="settings-side"><span className="model-mark">K</span><h3>模型负责理解</h3><p>分类引擎通过统一接口连接模型，当前使用 Kimi / Moonshot 兼容接口。</p><div className="settings-tip"><ShieldCheck size={18} /><p>每份资料只提交有限的文档特征用于分类；切块与索引在本地完成，控制调用成本。</p></div><div className="model-state"><span className={`live-dot ${settings.llm.configured ? '' : 'offline'}`} />{settings.llm.configured ? 'API 密钥已配置' : '尚未配置 API 密钥'}</div></aside><form className="panel form-panel" onSubmit={save}><div className="panel-heading"><div><h2>LLM 连接</h2><p>这里配置资料分类模型及共享 API 连接。项目需求提取和技术方案生成独立默认使用 K3。</p></div><span className={`status ${settings.llm.configured ? 'status-active' : 'status-needs_review'}`}>{settings.llm.configured ? '已配置' : '未配置'}</span></div><div className="form-panel-body"><label className="field">API Base URL<input type="url" required value={form.baseUrl} onChange={event => setForm({ ...form, baseUrl: event.target.value })} placeholder="https://api.moonshot.cn/v1" /></label><label className="field">API Key<input type="password" value={form.apiKey} autoComplete="new-password" onChange={event => setForm({ ...form, apiKey: event.target.value })} placeholder={settings.llm.configured ? '•••••••••••••••• · 已安全保存' : '输入 API 密钥'} /><small>{settings.llm.configured ? '留空保留现有密钥。只有需要更换时才填写。' : '密钥仅保存在服务器端，不会随设置数据返回。'}</small></label><label className="field">资料分类模型<input required value={form.model} onChange={event => setForm({ ...form, model: event.target.value })} placeholder="kimi-k2.6" /></label><div className="form-grid"><label className="field">Temperature<input type="number" required min="0" max="2" step="0.1" value={form.temperature} onChange={event => setForm({ ...form, temperature: Number(event.target.value) })} /><small>按模型支持范围设置。</small></label><label className="field">最大输出 tokens<input type="number" required min="256" max="16000" step="1" value={form.maxTokens} onChange={event => setForm({ ...form, maxTokens: Number(event.target.value) })} /><small>仅限结构化分类与摘要输出。</small></label></div>{error && <ErrorMessage message={error} />}{testResult && <div className={`notice ${testResult.ok ? 'success-notice' : 'warning'}`}>{testResult.ok ? <CheckCircle2 size={17} /> : <Unplug size={17} />}<p>{testResult.message}</p></div>}<div className="model-actions"><button type="button" className="button" disabled={!!busy || !settings.llm.configured || dirty} title={dirty ? '请先保存更改后测试连接' : '使用已保存配置发起一次短请求'} onClick={() => void test()}>{busy === 'test' ? <LoaderCircle className="spin" size={15} /> : <Link2 size={15} />}测试已保存的连接</button><button className="button primary" disabled={!!busy}>{busy === 'save' ? <LoaderCircle className="spin" size={15} /> : <Save size={15} />}保存配置</button></div><small className="subtle">{dirty ? '有未保存的更改，请先保存后再测试。' : '连接测试会发起一次简短模型请求。'}</small></div></form></div>;
}
