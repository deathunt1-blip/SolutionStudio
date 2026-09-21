import { useCallback, useEffect, useRef, useState, type ReactNode, type RefObject } from 'react';
import { AlertCircle, Check, CheckCircle2, Circle, FileSpreadsheet, FileText, FolderOpen, LoaderCircle, RefreshCw, X } from 'lucide-react';
import type { Authority, ClassifiedValue, DocumentRecord, DocumentStatus, Registries } from '../../../packages/core/src/types.js';
import { api } from './api.js';

export type Page = 'inbox' | 'library' | 'review' | 'settings';
export interface Stats { total: number; active: number; needsReview: number; failed: number; processing: number; chunks: number; confirmedExamples: number }
export type Notify = (message: string, kind?: 'success' | 'error') => void;
export const authorities: Record<Authority, string> = { authoritative: '正式权威', reference: '历史参考', style_only: '写作参考', unknown: '待判断' };
export const statusLabels: Record<DocumentStatus, string> = { discovered: '已发现', uploaded: '排队中', parsing: '解析中', parsed: '已解析', classifying: '分类中', needs_review: '待确认', indexing: '建立索引', active: '已入库', superseded: '历史版本', archived: '已归档', failed: '处理失败' };
export const sourceLabels: Record<string, string> = { manual: '手动上传', manual_upload: '手动上传', upload: '手动上传', local_folder: '本地目录', local: '本地目录', feishu: '飞书', mock_feishu: '飞书演示' };
export const fieldSources: Record<string, string> = { ai: '模型识别', rule: '规则识别', user: '人工确认', metadata: '文件信息' };
export const processingStatuses = ['discovered', 'uploaded', 'parsing', 'parsed', 'classifying', 'indexing'];
export const supportedFiles = '.docx,.pdf,.xlsx,.xls,.csv,.md,.txt,.png,.jpg,.jpeg';
export const number = (value: number | undefined) => value === undefined ? '—' : value.toLocaleString('zh-CN');
export const date = (value: string) => new Date(value).toLocaleDateString('zh-CN', { month: '2-digit', day: '2-digit' });
export const fullDate = (value: string) => new Date(value).toLocaleString('zh-CN', { hour12: false });
export const label = (items: { key: string; label: string }[] | undefined, key: string | undefined) => items?.find(item => item.key === key)?.label || (key === 'unknown' ? '未知' : key) || '待识别';
export const splitTags = (value: string) => [...new Set(value.split(/[,，、\n]/).map(item => item.trim()).filter(Boolean))];

export function useResource<T>(path: string | null, refresh = 0, interval = 0) {
  const [data, setData] = useState<T>();
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [attempt, setAttempt] = useState(0);
  const reload = useCallback(() => setAttempt(value => value + 1), []);
  useEffect(() => {
    if (!path) { setLoading(false); return; }
    let active = true;
    let fetching = false;
    const controller = new AbortController();
    const run = async () => {
      if (fetching) return;
      fetching = true;
      try { const result = await api<T>(path, { signal: controller.signal }); if (active) { setData(result); setError(''); } }
      catch (caught) { if (active && !(caught instanceof DOMException && caught.name === 'AbortError')) setError(caught instanceof Error ? caught.message : '暂时无法读取数据'); }
      finally { fetching = false; if (active) setLoading(false); }
    };
    setLoading(true);
    void run();
    const timer = interval ? setInterval(() => { if (!document.hidden) void run(); }, interval) : undefined;
    return () => { active = false; controller.abort(); clearInterval(timer); };
  }, [path, refresh, interval, attempt]);
  return { data, error, loading, reload };
}

export function useDebounce(value: string, delay = 350) {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => { const timer = setTimeout(() => setDebounced(value), delay); return () => clearTimeout(timer); }, [value, delay]);
  return debounced;
}

export function useDialog(ref: RefObject<HTMLElement | null>, close: () => void) {
  const closeRef = useRef(close);
  closeRef.current = close;
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    const overflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    ref.current?.focus();
    const handler = (event: KeyboardEvent) => {
      if (event.key === 'Escape') closeRef.current();
      if (event.key === 'Tab') {
        const focusable = ref.current?.querySelectorAll<HTMLElement>('button:not(:disabled), a[href], input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex="0"]');
        if (!focusable?.length) { event.preventDefault(); return; }
        const first = focusable[0]; const last = focusable[focusable.length - 1];
        if (event.shiftKey && (document.activeElement === first || document.activeElement === ref.current)) { event.preventDefault(); last.focus(); }
        else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
      }
    };
    document.addEventListener('keydown', handler);
    return () => { document.body.style.overflow = overflow; document.removeEventListener('keydown', handler); previous?.focus(); };
  }, [ref]);
}

export function Status({ status }: { status: DocumentStatus }) {
  const pending = processingStatuses.includes(status);
  const Icon = status === 'active' ? CheckCircle2 : status === 'failed' ? AlertCircle : pending ? LoaderCircle : Circle;
  return <span className={`status status-${status}`}><Icon size={12} className={pending ? 'spin' : ''} />{statusLabels[status] || status}</span>;
}

export function AuthorityBadge({ value = 'unknown' }: { value?: Authority }) {
  return <span className={`authority authority-${value}`}>{value === 'authoritative' && <Check size={11} />}{authorities[value]}</span>;
}

export function FileIcon({ filename, small = false }: { filename: string; small?: boolean }) {
  const extension = filename.split('.').pop()?.toLowerCase() || 'file';
  const sheet = ['xlsx', 'xls', 'csv'].includes(extension);
  const Icon = sheet ? FileSpreadsheet : FileText;
  return <span className={`file-icon ${extension === 'pdf' ? 'file-pdf' : sheet ? 'file-sheet' : ''} ${small ? 'small' : ''}`}><Icon size={small ? 17 : 21} />{!small && <span>{extension.toUpperCase()}</span>}</span>;
}

export function Confidence({ field }: { field: ClassifiedValue<unknown> | undefined }) {
  if (!field) return null;
  return <span className={`confidence ${field.confidence < 0.6 ? 'low' : ''}`} title={field.reasoning || fieldSources[field.source]}>{field.source === 'user' ? <Check size={11} /> : <span className="confidence-dot" />}{Math.round(field.confidence * 100)}% <span>{fieldSources[field.source]}</span></span>;
}

export function Tags({ values, registry, max = 3 }: { values?: string[]; registry?: { key: string; label: string }[]; max?: number }) {
  return <span className="tags">{values?.slice(0, max).map(value => <span className="tag" key={value}>{label(registry, value)}</span>)}{values && values.length > max && <span className="tag tag-more">+{values.length - max}</span>}</span>;
}

export function Empty({ title, text, children }: { title: string; text: string; children?: ReactNode }) {
  return <div className="empty-state"><span className="empty-icon"><FolderOpen size={27} strokeWidth={1.4} /></span><h3>{title}</h3><p>{text}</p>{children}</div>;
}

export function ErrorMessage({ message, retry }: { message: string; retry?: () => void }) {
  return <div className="error-message" role="alert"><AlertCircle size={17} /><span>{message}</span>{retry && <button className="text-button" onClick={retry}><RefreshCw size={13} />重试</button>}</div>;
}

export function Loading({ text = '正在读取资料…' }: { text?: string }) {
  return <div className="loading-state" role="status"><LoaderCircle className="spin" size={20} /><span>{text}</span></div>;
}

export function Modal({ title, children, close, className = '' }: { title: string; children: ReactNode; close: () => void; className?: string }) {
  const ref = useRef<HTMLDivElement>(null);
  useDialog(ref, close);
  return <div className="modal-backdrop" onMouseDown={event => { if (event.target === event.currentTarget) close(); }}><div className={`modal ${className}`} role="dialog" aria-modal="true" aria-label={title} tabIndex={-1} ref={ref}><header className="modal-header"><h2>{title}</h2><button className="icon-button" aria-label="关闭" onClick={close}><X size={19} /></button></header>{children}</div></div>;
}

export function DocumentTable({ documents, registries, open, compact = false }: { documents: DocumentRecord[]; registries?: Registries; open: (id: string) => void; compact?: boolean }) {
  return <div className="table-scroll"><table className={`document-table ${compact ? 'compact' : ''}`}><thead><tr><th>资料名称</th><th>文档类型</th>{!compact && <th>领域 / 主题 / 产品</th>}<th>{compact ? '来源' : '权威级别'}</th><th>状态</th><th>更新时间</th></tr></thead><tbody>{documents.map(doc => <tr key={doc.id}>
    <td><button className="document-link" onClick={() => open(doc.id)}><FileIcon filename={doc.filename} small /><span><strong>{doc.title || doc.filename}</strong><small>{compact ? doc.filename : `${doc.filename} · ${sourceLabels[doc.sourceType] || doc.sourceType} · v${doc.versionNumber} · ${doc.chunkCount} 个片段`}</small></span></button></td>
    <td><span className="type-text">{label(registries?.documentTypes, doc.classification?.documentType.value)}</span>{!compact && <Confidence field={doc.classification?.documentType} />}</td>
    {!compact && <td className="table-tags"><Tags values={doc.classification?.applications.value} registry={registries?.applications} max={1} /><Tags values={doc.classification?.topics.value} registry={registries?.topics} max={2} /><Tags values={doc.classification?.products.value} max={1} /></td>}
    <td>{compact ? <span className="subtle">{sourceLabels[doc.sourceType] || doc.sourceType}</span> : <AuthorityBadge value={doc.classification?.authority.value} />}</td><td><Status status={doc.status} /></td><td className="table-date" title={fullDate(doc.updatedAt)}>{date(doc.updatedAt)}</td>
  </tr>)}</tbody></table></div>;
}
