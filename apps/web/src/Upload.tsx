import { useRef, useState } from 'react';
import { ArrowUpFromLine, CheckCircle2, Copy, FileUp, LoaderCircle, RotateCcw, Upload, XCircle } from 'lucide-react';
import type { DocumentRecord } from '../../../packages/core/src/types.js';
import { uploadFile, type UploadResult } from './api.js';
import { FileIcon, Status, supportedFiles, type Notify } from './ui.js';

export interface UploadItem { id: string; file: File; progress: number; state: 'waiting' | 'uploading' | 'queued' | 'duplicate' | 'error'; documentId?: string; message?: string }
export function useUploads(refresh: () => void, notify: Notify) {
  const [items, setItems] = useState<UploadItem[]>([]);
  const update = (id: string, value: Partial<UploadItem>) => setItems(existing => existing.map(item => item.id === id ? { ...item, ...value } : item));
  const send = async (item: UploadItem, keep = false, documentId?: string) => {
    update(item.id, { state: 'uploading', progress: 0, message: undefined });
    try {
      const result: UploadResult = await uploadFile(item.file, progress => update(item.id, { progress }), keep, documentId);
      update(item.id, { state: result.status, progress: 100, documentId: result.documentId, message: result.message });
    } catch (error) { update(item.id, { state: 'error', message: error instanceof Error ? error.message : '上传失败' }); }
    refresh();
  };
  const add = async (files: File[], documentId?: string) => {
    if (!files.length) return;
    const entries: UploadItem[] = files.map(file => ({ id: crypto.randomUUID(), file, progress: 0, state: 'waiting' }));
    setItems(existing => [...entries, ...existing]);
    let index = 0;
    const worker = async () => { while (index < entries.length) { const item = entries[index++]; await send(item, false, documentId); } };
    await Promise.all(Array.from({ length: Math.min(3, entries.length) }, worker));
    notify(`${entries.length} 份文件已完成上传检查，可在收件箱查看逐项结果。`);
  };
  return { items, add, retry: (item: UploadItem, keep = false) => send(item, keep), clear: () => setItems(existing => existing.filter(item => item.state === 'uploading' || item.state === 'waiting')) };
}
export type UploadManager = ReturnType<typeof useUploads>;

export function Dropzone({ onFiles, compact = false }: { onFiles: (files: File[]) => void; compact?: boolean }) {
  const input = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);
  const depth = useRef(0);
  return <div className={`dropzone ${compact ? 'dropzone-compact' : ''} ${dragging ? 'dragging' : ''}`}
    onDragEnter={event => { event.preventDefault(); depth.current++; setDragging(true); }}
    onDragLeave={event => { event.preventDefault(); depth.current--; if (!depth.current) setDragging(false); }}
    onDragOver={event => event.preventDefault()}
    onDrop={event => { event.preventDefault(); depth.current = 0; setDragging(false); onFiles(Array.from(event.dataTransfer.files)); }}>
    <input type="file" ref={input} multiple accept={supportedFiles} className="sr-only" tabIndex={-1} aria-label="选择资料文件" onChange={event => { onFiles(Array.from(event.target.files || [])); event.target.value = ''; }} />
    <span className="upload-symbol"><ArrowUpFromLine size={27} strokeWidth={1.7} /><span><FileUp size={14} /></span></span>
    <h3>{dragging ? '松开鼠标，开始导入' : '把资料拖到这里'}</h3>
    <p>自动解析、识别分类，让知识有迹可循</p>
    <button className="button primary" onClick={() => input.current?.click()}><Upload size={16} />选择文件<span className="button-key">↗</span></button>
    <div className="format-list"><span>DOCX</span><span>PDF</span><span>EXCEL</span><span>CSV</span><span>MD / TXT</span></div>
    <small>支持批量导入 · 原文件完整保留 · 自动检测重复</small>
  </div>;
}

export function UploadList({ manager, documents = [], open }: { manager: UploadManager; documents?: DocumentRecord[]; open: (id: string) => void }) {
  if (!manager.items.length) return null;
  const completed = manager.items.filter(item => !['waiting', 'uploading'].includes(item.state)).length;
  return <section className="panel upload-results"><div className="panel-heading"><div><h2>本次导入 <span className="count-pill">{manager.items.length}</span></h2><p>{completed} / {manager.items.length} 份已检查，资料会在后台继续处理</p></div>{completed === manager.items.length && <button className="text-button subtle" onClick={manager.clear}>清除记录</button>}</div>
    <div className="upload-list">{manager.items.map(item => {
      const doc = documents.find(document => document.id === item.documentId);
      return <div className="upload-row" key={item.id}><FileIcon filename={item.file.name} small /><div className="upload-file"><strong>{item.file.name}</strong><small>{(item.file.size / 1024 / 1024).toFixed(2)} MB {item.message ? ` · ${item.message}` : ''}</small>{item.state === 'uploading' && <progress max={100} value={item.progress} aria-label={`${item.file.name} 上传进度`} />}</div><div className="upload-result">
        {item.state === 'waiting' && <span className="subtle"><LoaderCircle size={13} />等待上传</span>}
        {item.state === 'uploading' && <span className="subtle">{item.progress}%</span>}
        {item.state === 'queued' && (doc ? <Status status={doc.status} /> : <span className="status status-uploaded"><CheckCircle2 size={13} />已进入处理队列</span>)}
        {item.state === 'duplicate' && <><span className="status status-needs_review"><Copy size={13} />文件已存在</span><button className="text-button" onClick={() => void manager.retry(item, true)}>仍然导入</button></>}
        {item.state === 'error' && <><span className="status status-failed"><XCircle size={13} />上传失败</span><button className="text-button" onClick={() => void manager.retry(item)}><RotateCcw size={12} />重试</button></>}
        {item.documentId && <button className="text-button" onClick={() => open(item.documentId!)}>查看</button>}
      </div></div>;
    })}</div>
  </section>;
}
