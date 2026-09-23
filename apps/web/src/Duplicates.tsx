import { useEffect, useState } from 'react';
import { ArrowLeft, ArrowRight, ArrowUpRight, Check, Copy, Download, FileSearch, Files, GitBranch, Link2, LoaderCircle, RotateCcw, ScanSearch, ShieldCheck, Split, X } from 'lucide-react';
import type { Settings } from '../../../packages/core/src/types.js';
import { post } from './api.js';
import { Empty, ErrorMessage, FileIcon, Loading, fullDate, number, sourceLabels, statusLabels, useResource, type Notify } from './ui.js';
import { safeSourceUrl } from './StructuredData.js';
import './duplicates.css';

export interface DuplicateScanScope { documentIds?: string[]; source?: string; filters?: Record<string, string> }
type Relation = 'exact_duplicate' | 'content_duplicate' | 'near_duplicate' | 'possible_version' | 'similar';
interface Difference { location?: string; field?: string; label?: string; message?: string; kind?: string; left?: unknown; right?: unknown; before?: unknown; after?: unknown; a?: unknown; b?: unknown }
interface Member { documentId: string; title: string; filename: string; status: string; versionId: string; sourceId: string; sourceName: string; sourceType: string; sourcePath?: string; sourceUrl?: string }
interface Group { id: string; status: 'suggested' | 'confirmed' | 'dismissed'; relation: Relation; score: number; reasons: string[]; differences: Difference[]; canonicalDocumentId: string; members: Member[]; canUndo: boolean; operation?: 'merge' | 'version'; stale: boolean }
interface ScanResult { truncated?: boolean; scanned: number; candidates: number; created: number; updated: number; counts: Record<Relation, number> }
export interface DocumentSourceReference { id: string; documentId: string; sourceId: string; sourceName: string; sourceType: string; sourceDocumentId: string; sourcePath?: string; sourceUrl?: string; remoteVersion?: string; filename: string; discoveredAt: string; removed: boolean; contentHash?: string; objectKey?: string; sourceMetadata?: Record<string, unknown> }
export interface DocumentSources { canonicalDocumentId: string; items: DocumentSourceReference[] }

const relationLabels: Record<Relation, string> = { exact_duplicate: '完全重复', content_duplicate: '内容重复', near_duplicate: '高度相似', possible_version: '疑似版本', similar: '相似资料' };
const reasonLabels: Record<string, string> = {
  exact_content_hash: '原始文件内容完全一致。',
  normalized_content_hash: '去除格式差异后，正文与表格内容一致。',
  insufficient_content: '可比对的正文较少，需要人工核对。',
  different_product_model: '检测到不同的产品型号。',
  template_similarity: '资料可能采用了相同的项目模板。',
  historical_project_facts_require_review: '历史项目事实需要核对，请确认客户、场地与项目是否相同。',
  same_document_identity: '标题和内容表明它们可能是同一份资料。',
  version_changed: '版本标识发生了变化。',
  date_changed: '资料日期发生了变化。',
  critical_values_changed: '重要参数或数值发生了变化。',
  material_values_differ: '关键内容存在差异，需要人工核对。',
  version_identity_unconfirmed: '尚不能确认这些资料属于同一份资料的不同版本。',
  high_lexical_similarity: '正文用词和内容高度相似。',
  substantial_text_overlap: '正文中有较多相同内容。',
  lexical_similarity: '正文用词有一定相似度。',
  low_lexical_similarity: '正文用词的相似度较低。',
};
const statusText = { suggested: '待处理', confirmed: '已确认', dismissed: '保持独立' };
const percent = (score: number) => `${Math.round(Math.max(0, Math.min(1, score)) * 100)}%`;
const failure = (caught: unknown) => caught instanceof Error ? caught.message : '操作未完成，请重试。';
const stringify = (value: unknown): string => value == null ? '—' : typeof value === 'string' ? value : Array.isArray(value) ? value.map(stringify).join('\n') : JSON.stringify(value);

export function openDuplicateScan(scope: DuplicateScanScope = {}) {
  window.location.hash = `duplicates?scan=${encodeURIComponent(JSON.stringify(scope))}`;
}
export function browseDuplicates(documentId?: string) {
  window.location.hash = documentId ? `duplicates?documentId=${encodeURIComponent(documentId)}` : 'duplicates';
}
function route() {
  const params = new URLSearchParams(window.location.hash.split('?')[1]);
  let scope: DuplicateScanScope = {};
  try { const parsed = JSON.parse(params.get('scan') ?? '{}'); if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) { if (Array.isArray(parsed.documentIds) && parsed.documentIds.every((id: unknown) => typeof id === 'string')) scope.documentIds = parsed.documentIds; if (typeof parsed.source === 'string') scope.source = parsed.source; if (parsed.filters && typeof parsed.filters === 'object' && !Array.isArray(parsed.filters)) scope.filters = Object.fromEntries(Object.entries(parsed.filters).filter((entry): entry is [string, string] => typeof entry[1] === 'string')); } } catch { /* Invalid hash falls back to the entire library. */ }
  return { scope, documentId: params.get('documentId') || '', scan: params.has('scan') };
}

export default function Duplicates({ settings, refresh, reload, notify, open }: { settings?: Settings; refresh: number; reload: () => void; notify: Notify; open: (id: string) => void }) {
  const [initialRoute, setInitialRoute] = useState(route);
  const [scope, setScope] = useState<DuplicateScanScope>(initialRoute.scope);
  const [scopeKind, setScopeKind] = useState(() => initialRoute.scope.documentIds ? 'selected' : initialRoute.scope.filters ? 'filtered' : initialRoute.scope.source ? 'source' : 'all');
  const [showScan, setShowScan] = useState(initialRoute.scan);
  const [scanBusy, setScanBusy] = useState(false); const [scanError, setScanError] = useState(''); const [scanResult, setScanResult] = useState<ScanResult>();
  const [status, setStatus] = useState(initialRoute.documentId ? '' : 'suggested'); const [relation, setRelation] = useState(''); const [page, setPage] = useState(1); const [selected, setSelected] = useState<string>();
  const params = new URLSearchParams({ page: String(page), pageSize: '20' });
  if (status) params.set('status', status); if (relation) params.set('relation', relation); if (initialRoute.documentId) params.set('documentId', initialRoute.documentId);
  const groups = useResource<{ items: Group[]; total: number; page: number; pageSize: number }>(`/duplicates?${params}`, refresh);
  useEffect(() => { const update = () => { const next = route(); setInitialRoute(next); setScope(next.scope); setScopeKind(next.scope.documentIds ? 'selected' : next.scope.filters ? 'filtered' : next.scope.source ? 'source' : 'all'); setShowScan(next.scan); setStatus(next.documentId ? '' : 'suggested'); setPage(1); setSelected(undefined); }; window.addEventListener('hashchange', update); return () => window.removeEventListener('hashchange', update); }, []);
  useEffect(() => { if (!groups.loading && groups.data && !groups.data.items.some(group => group.id === selected)) setSelected(groups.data.items[0]?.id); }, [groups.data, groups.loading, selected]);
  const scan = async () => {
    setScanBusy(true); setScanError(''); setScanResult(undefined);
    const input = scopeKind === 'all' ? {} : scopeKind === 'source' ? { source: scope.source } : scopeKind === 'selected' ? { documentIds: scope.documentIds } : { filters: scope.filters };
    try { const result = await post<ScanResult>('/duplicates/scan', input); setScanResult(result); if (initialRoute.documentId) { setInitialRoute(current => ({ ...current, documentId: '' })); window.history.replaceState(null, '', '#duplicates'); } setStatus('suggested'); setPage(1); groups.reload(); reload(); notify(`扫描完成：新增 ${result.created} 组建议，更新 ${result.updated} 次。`); } catch (caught) { setScanError(failure(caught)); } finally { setScanBusy(false); }
  };
  const changed = (group: Group) => { setStatus(group.status); setPage(1); groups.reload(); reload(); };
  return <>
    <div className="page-heading"><div><div className="eyebrow">ONE KNOWLEDGE, EVERY SOURCE</div><h1>重复资料<span className="heading-dot">.</span></h1><p>辨认重复与版本关系，让同一份知识保留完整的来路。</p></div><button className="button primary" aria-expanded={showScan} onClick={() => setShowScan(value => !value)}><ScanSearch size={17} />扫描重复资料</button></div>
    <div className="duplicate-principle"><ShieldCheck size={19} /><p>扫描只生成建议。合并来源或确认版本关系后，原文件与来源仍保留，操作可撤销。</p><span>本地比对 · 不调用 Kimi</span></div>
    {showScan && <section className="panel duplicate-scan"><div className="panel-heading"><div><h2><ScanSearch size={17} />扫描范围</h2><p>所选范围内的资料会与全库候选比对，支持跨来源发现重复。</p></div><button className="icon-button" aria-label="收起扫描设置" onClick={() => setShowScan(false)}><X size={16} /></button></div><div className="duplicate-scan-body"><label className="field">选择扫描范围<select disabled={scanBusy} value={scopeKind} onChange={event => setScopeKind(event.target.value)}><option value="all">全部知识库</option><option value="source">指定资料来源</option>{scope.documentIds && <option value="selected">从资料库选中的 {scope.documentIds.length} 份资料</option>}{scope.filters && <option value="filtered">资料库当前筛选结果</option>}</select></label>{scopeKind === 'source' && <label className="field">资料来源<select disabled={scanBusy} value={scope.source ?? ''} onChange={event => setScope(current => ({ ...current, source: event.target.value }))}><option value="">请选择资料来源</option>{settings?.sources.map(source => <option key={source.id} value={source.id}>{source.name}</option>)}</select></label>}{scopeKind === 'filtered' && <div className="duplicate-scope-summary"><strong>已携带资料库筛选条件</strong><span>{Object.entries(scope.filters ?? {}).map(([key, value]) => `${filterLabel(key)}：${filterValue(key, value, settings)}`).join(' · ') || '未限制筛选条件'}</span></div>}{scopeKind === 'selected' && <div className="duplicate-scope-summary"><strong>{scope.documentIds?.length ?? 0} 份已选资料</strong><span>将与资料库中的其他候选资料比对。</span></div>}<button className="button primary" disabled={scanBusy || (scopeKind === 'source' && !scope.source) || (scopeKind === 'selected' && !scope.documentIds?.length)} onClick={() => void scan()}>{scanBusy ? <LoaderCircle className="spin" size={15} /> : <FileSearch size={15} />}{scanBusy ? '正在扫描…' : '开始扫描'}</button></div>{scanError && <ErrorMessage message={scanError} />}{scanResult && <div className="duplicate-scan-result"><p>已扫描 {number(scanResult.scanned)} 份资料，比较 {number(scanResult.candidates)} 对候选；新增 {number(scanResult.created)} 组，更新 {number(scanResult.updated)} 次。</p><p className="subtle">本次评估的候选关系数：</p><div>{Object.entries(relationLabels).map(([key, label]) => <span key={key}>{label}<strong>{scanResult.counts?.[key as Relation] ?? 0}</strong></span>)}</div>{scanResult.truncated && <p className="source-error">候选数量较多，本次扫描已限量，请缩小范围继续。</p>}</div>}</section>}
    {initialRoute.documentId && <div className="duplicate-document-filter"><span>仅查看当前资料相关的重复建议</span><button className="text-button" onClick={() => open(initialRoute.documentId)}>查看资料与全部来源<ArrowUpRight size={13} /></button><button className="text-button" onClick={() => browseDuplicates()}>查看全部建议<X size={13} /></button></div>}
    <section className="panel duplicate-filter-panel"><div className="duplicate-status-tabs" role="tablist" aria-label="重复建议处理状态">{[{ key: 'suggested', label: '待处理' }, { key: 'confirmed', label: '已确认' }, { key: 'dismissed', label: '保持独立' }, { key: '', label: '全部' }].map(item => <button key={item.key} role="tab" aria-selected={status === item.key} className={status === item.key ? 'active' : ''} onClick={() => { setStatus(item.key); setPage(1); setSelected(undefined); }}>{item.label}</button>)}</div><label className="filter-select"><span className="sr-only">重复关系类型</span><select value={relation} onChange={event => { setRelation(event.target.value); setPage(1); setSelected(undefined); }}><option value="">全部关系类型</option>{Object.entries(relationLabels).map(([key, label]) => <option key={key} value={key}>{label}</option>)}</select></label><span className="subtle">{number(groups.data?.total)} 组</span></section>
    {groups.error && <ErrorMessage message={groups.error} retry={groups.reload} />}
    {groups.loading ? <Loading text="读取重复资料建议…" /> : groups.data?.items.length ? <div className="duplicate-layout"><aside className="panel duplicate-group-list" aria-label="重复资料组">{groups.data.items.map(group => <button className={`duplicate-group-item ${selected === group.id ? 'active' : ''}`} key={group.id} onClick={() => setSelected(group.id)}><span><span className={`duplicate-relation relation-${group.relation}`}>{relationLabels[group.relation]}</span><strong>{percent(group.score)}</strong></span><h3>{group.members.find(member => member.documentId === group.canonicalDocumentId)?.title || group.members[0]?.title || '待确认的资料组'}</h3><p>{group.members.length} 份资料 · {new Set(group.members.map(member => member.sourceId)).size} 个来源</p><small>{statusText[group.status]}{group.stale ? ' · 内容已变化' : ''}</small></button>)}{groups.data.total > 20 && <div className="duplicate-pagination"><button className="icon-button" aria-label="上一页重复建议" disabled={page <= 1} onClick={() => { setPage(value => value - 1); setSelected(undefined); }}><ArrowLeft size={14} /></button><span>{page} / {Math.ceil(groups.data.total / 20)}</span><button className="icon-button" aria-label="下一页重复建议" disabled={page >= Math.ceil(groups.data.total / 20)} onClick={() => { setPage(value => value + 1); setSelected(undefined); }}><ArrowRight size={14} /></button></div>}</aside>{selected && <DuplicateGroupDetail key={selected} id={selected} refresh={refresh} open={open} notify={notify} changed={changed} />}</div> : <section className="panel"><Empty title={status === 'suggested' ? '当前没有待处理的重复建议' : '此范围内暂无重复建议'} text={initialRoute.documentId ? '完全相同文件可直接关联到已有资料。可打开资料详情查看保留的全部来源。' : status === 'suggested' ? '可以扫描全部知识库，或从资料库选择一个范围。相似资料不会自动被合并。' : '调整关系类型或处理状态，查看其他建议。'}>{!showScan && <button className="button" onClick={() => setShowScan(true)}><ScanSearch size={15} />选择扫描范围</button>}</Empty></section>}
  </>;
}

function filterLabel(key: string) { return ({ q: '关键词', status: '状态', documentType: '文档类型', application: '领域', topic: '主题', product: '产品', authority: '权威级别', source: '来源', group: '知识分组' } as Record<string, string>)[key] || key; }
function filterValue(key: string, value: string, settings?: Settings) { return key === 'source' ? settings?.sources.find(source => source.id === value)?.name || value : key === 'status' ? statusLabels[value as keyof typeof statusLabels] || value : value; }

export function DuplicateGroupDetail({ id, refresh, open, notify, changed }: { id: string; refresh: number; open: (id: string) => void; notify: Notify; changed: (group: Group) => void }) {
  const result = useResource<Group>(`/duplicates/${id}`, refresh);
  const [canonical, setCanonical] = useState(() => result.data?.canonicalDocumentId || result.data?.members[0]?.documentId || ''); const [busy, setBusy] = useState(''); const [error, setError] = useState('');
  const group = result.data;
  useEffect(() => { if (group) setCanonical(group.canonicalDocumentId || group.members[0]?.documentId || ''); }, [group]);
  const act = async (action: 'merge' | 'confirm-version' | 'dismiss' | 'undo') => {
    setBusy(action); setError('');
    try { const updated = await post<Group>(`/duplicates/${id}/${action}`, action === 'merge' || action === 'confirm-version' ? { canonicalDocumentId: canonical } : {}); result.reload(); changed(updated); notify(action === 'merge' ? '来源已合并，原文件和历史均已保留。' : action === 'confirm-version' ? '版本关系已确认，其余资料作为历史版本保留。' : action === 'dismiss' ? '已保留为独立资料。' : '已撤销上次处理，资料关系已恢复。'); } catch (caught) { setError(failure(caught)); } finally { setBusy(''); }
  };
  if (result.loading && !group) return <section className="panel"><Loading text="读取资料对比…" /></section>;
  if (!group) return <section className="panel"><ErrorMessage message={result.error || '无法读取这组资料。'} retry={result.reload} /></section>;
  const canMerge = ['exact_duplicate', 'content_duplicate', 'near_duplicate'].includes(group.relation);
  const canConfirmVersion = !['exact_duplicate', 'content_duplicate'].includes(group.relation);
  const pending = group.status === 'suggested'; const selected = group.members.find(member => member.documentId === canonical);
  return <section className="panel duplicate-detail"><div className="panel-heading"><div><h2>{group.relation === 'possible_version' ? <GitBranch size={18} /> : <Copy size={18} />}{relationLabels[group.relation]}<span className="count-pill">{percent(group.score)}</span></h2><p>{pending ? '检查内容和来源，选择合并后的主资料或当前版本。' : group.operation === 'version' ? '已确认版本关系，默认检索使用所选当前版本。' : group.status === 'dismissed' ? '这组资料保持独立，不会因本次建议被合并。' : '已合并来源，默认检索使用主资料。'}</p></div><span className={`status ${pending ? 'status-needs_review' : group.status === 'confirmed' ? 'status-active' : 'status-archived'}`}>{statusText[group.status]}</span></div><div className="duplicate-detail-body">
      {(error || result.error) && <ErrorMessage message={error || result.error} retry={result.reload} />}
      {group.stale && <div className="notice warning"><RotateCcw size={17} /><p>部分资料已更新，请重新扫描后再合并或确认版本关系。</p></div>}
      <div className="duplicate-reasons"><h3>判断依据</h3>{group.reasons.length ? <ul>{group.reasons.map((reason, index) => <li key={index}>{reasonLabels[reason] || reason}</li>)}</ul> : <p>请查看资料原文与来源，结合业务内容判断。</p>}{group.relation === 'similar' && <p className="duplicate-project-note">相似的项目模板可能属于不同客户或场地。请核对项目事实，通常应保持独立。</p>}</div>
      <div className="duplicate-members">{group.members.map(member => <article className={`duplicate-member ${canonical === member.documentId ? 'canonical' : ''}`} key={member.documentId}><header>{pending ? <label className="canonical-choice"><input type="radio" name={`canonical-${group.id}`} value={member.documentId} disabled={!!busy || group.stale} checked={canonical === member.documentId} onChange={() => setCanonical(member.documentId)} /><span>选作{!canMerge ? '当前版本' : '主资料'}</span></label> : <span className="canonical-choice">{group.status === 'dismissed' ? '独立资料' : canonical === member.documentId ? <><Check size={14} />{group.operation === 'version' ? '当前版本' : '主资料'}</> : group.operation === 'version' ? '历史版本' : '关联资料'}</span>}<span className="subtle">{statusLabels[member.status as keyof typeof statusLabels] || member.status}</span></header><button className="duplicate-member-title" onClick={() => open(member.documentId)}><FileIcon filename={member.filename} small /><strong>{member.title || member.filename}</strong><ArrowUpRight size={14} /></button><dl><div><dt>原文件名</dt><dd>{member.filename}</dd></div><div><dt>资料来源</dt><dd>{member.sourceName || sourceLabels[member.sourceType] || member.sourceType}</dd></div>{member.sourcePath && <div><dt>来源路径</dt><dd>{member.sourcePath}</dd></div>}</dl><footer><button className="text-button" onClick={() => open(member.documentId)}>查看原文与历史<ArrowRight size={12} /></button>{safeSourceUrl(member.sourceUrl) && <a href={safeSourceUrl(member.sourceUrl)} target="_blank" rel="noopener noreferrer">远端来源<ArrowUpRight size={12} /></a>}</footer></article>)}</div>
      <div className="duplicate-differences"><h3>内容差异</h3>{group.differences?.length ? group.differences.map((difference, index) => <DifferenceCard key={index} difference={difference} labels={group.members.length === 2 ? [group.members[0].title || group.members[0].filename, group.members[1].title || group.members[1].filename] : undefined} />) : <p className="subtle">未检测到可展示的正文差异，原始文件与全部来源仍可查看。</p>}</div>
      <div className="duplicate-decision"><div><ShieldCheck size={17} /><p>{pending ? <>将以「{selected?.title || selected?.filename || '所选资料'}」作为主资料或当前版本。合并不删除原文件；确认版本关系会让其余资料退出默认检索。</> : <>原文件、原始文件名、来源与处理记录均保留。{group.canUndo ? '可以撤销本次处理。' : '当前没有可撤销的处理。'}</>}</p></div><div className="duplicate-decision-actions">{pending ? <><button className="button" disabled={!!busy} onClick={() => void act('dismiss')}>{busy === 'dismiss' ? <LoaderCircle className="spin" size={14} /> : <Split size={14} />}保持独立</button>{canConfirmVersion && <button className={`button ${!canMerge ? 'primary' : ''}`} disabled={!!busy || group.stale || !canonical || group.members.length < 2} onClick={() => void act('confirm-version')}>{busy === 'confirm-version' ? <LoaderCircle className="spin" size={14} /> : <GitBranch size={14} />}确认版本关系</button>}{canMerge && <button className="button primary" disabled={!!busy || group.stale || !canonical || group.members.length < 2} onClick={() => void act('merge')}>{busy === 'merge' ? <LoaderCircle className="spin" size={14} /> : <Link2 size={14} />}合并来源</button>}</> : group.canUndo && <button className="button" disabled={!!busy} onClick={() => void act('undo')}>{busy === 'undo' ? <LoaderCircle className="spin" size={14} /> : <RotateCcw size={14} />}撤销本次处理</button>}</div></div>
    </div></section>;
}

function DifferenceCard({ difference, labels }: { difference: Difference; labels?: string[] }) {
  const left = difference.left ?? difference.before ?? difference.a, right = difference.right ?? difference.after ?? difference.b;
  return <article className="duplicate-difference"><h4>{difference.location ? differenceLocation(difference.location) : difference.label || difference.field || ({ parameter: '参数变化', number: '数值变化', model: '型号变化', table: '表格差异', version: '版本变化', date: '日期变化', project: '项目事实变化', text: '正文差异' } as Record<string, string>)[difference.kind ?? ''] || '检测到的差异'}</h4>{difference.message && <p>{difference.message}</p>}{(left !== undefined || right !== undefined) && <div className="duplicate-difference-values"><div><small>{labels?.[0] || '资料 A'}</small><p>{stringify(left)}</p></div><ArrowRight size={14} /><div><small>{labels?.[1] || '资料 B'}</small><p>{stringify(right)}</p></div></div>}</article>;
}

function differenceLocation(location: string) {
  const cell = location.match(/^tables\[(\d+)\]\.rows\[(\d+)\]\[(\d+)\]$/);
  if (cell) return `表格 ${Number(cell[1]) + 1} · 第 ${Number(cell[2]) + 1} 行第 ${Number(cell[3]) + 1} 列`;
  const line = location.match(/^plainText:line\s*(\d+)$/i);
  if (line) return `正文 · 第 ${line[1]} 行`;
  const labels: Record<string, string> = { title: '资料标题', filename: '原始文件名', version: '版本标识', date: '日期', plainText: '正文内容', 'plainText:model': '正文中的产品型号', 'plainText:project fields': '正文中的项目事实' };
  return location.split(/\s*\/\s*/).map(part => labels[part] || part).join(' / ');
}

export function SourceReferences({ documentId, open, close }: { documentId: string; open?: (id: string) => void; close?: () => void }) {
  const result = useResource<DocumentSources>(`/documents/${documentId}/sources`);
  const canonical = result.data?.canonicalDocumentId;
  return <section className="detail-section all-source-references"><div className="section-heading"><h3>全部来源 <span className="count-pill">{result.data?.items.length ?? '—'}</span></h3><Files size={16} /></div>{result.error && <ErrorMessage message={result.error} retry={result.reload} />}{result.loading && !result.data ? <Loading text="读取资料来源…" /> : <>{canonical && canonical !== documentId && <div className="notice"><Link2 size={17} /><p>当前资料已关联到主资料。<button className="text-button" disabled={!open} onClick={() => open?.(canonical)}>查看主资料<ArrowRight size={12} /></button></p></div>}{!result.data?.items.length ? <p className="subtle">暂无额外来源关联。</p> : <div className="source-reference-list">{result.data.items.map(reference => <article key={reference.id}><header><strong>{reference.sourceName || sourceLabels[reference.sourceType] || reference.sourceType}</strong>{reference.removed && <span className="tag">远端已移除</span>}</header><p>{reference.filename}</p>{reference.sourcePath && <p className="source-reference-path">{reference.sourcePath}</p>}<footer><span>{reference.remoteVersion ? `远端版本 ${reference.remoteVersion} · ` : ''}{fullDate(reference.discoveredAt)}</span><a href={`/api/documents/${encodeURIComponent(documentId)}/sources/${encodeURIComponent(reference.id)}/original`} download><Download size={12} />{reference.sourceMetadata?.decrypted === true ? '下载解密副本' : '下载原文件'}</a>{reference.sourceMetadata?.decrypted === true && <a href={`/api/documents/${encodeURIComponent(documentId)}/sources/${encodeURIComponent(reference.id)}/original?sourceOriginal=1`} download><Download size={12} />下载加密原件</a>}{safeSourceUrl(reference.sourceUrl) && <a href={safeSourceUrl(reference.sourceUrl)} target="_blank" rel="noopener noreferrer">打开来源<ArrowUpRight size={12} /></a>}</footer></article>)}</div>}<button className="text-button source-duplicates-link" onClick={() => { browseDuplicates(documentId); close?.(); }}><Copy size={13} />查看相关重复建议<ArrowRight size={12} /></button></>}</section>;
}
