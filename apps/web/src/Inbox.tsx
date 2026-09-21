import { useState } from 'react';
import { ArrowDown, ArrowRight, Check, CircleCheck, FileStack, FolderInput, Layers3, ListChecks, RefreshCw, ScanText, ShieldCheck } from 'lucide-react';
import type { DocumentRecord, Registries, Settings } from '../../../packages/core/src/types.js';
import { DocumentTable, Empty, ErrorMessage, Loading, number, processingStatuses, useResource, type Page, type Stats } from './ui.js';
import { Dropzone, UploadList, type UploadManager } from './Upload.js';

export default function Inbox({ stats, registries, settings, refresh, uploads, open, navigate }: { stats?: Stats; registries?: Registries; settings?: Settings; refresh: number; uploads: UploadManager; open: (id: string) => void; navigate: (page: Page) => void }) {
  const { data, loading, error, reload } = useResource<{ items: DocumentRecord[]; total: number }>('/documents?pageSize=100', refresh, 4000);
  const [tab, setTab] = useState('all');
  const documents = data?.items || [];
  const shown = documents.filter(doc => tab === 'all' || (tab === 'processing' ? processingStatuses.includes(doc.status) : doc.status === tab)).slice(0, 8);
  const metrics = [
    { label: '已沉淀资料', value: stats?.active, detail: '可搜索、可追溯', Icon: FileStack, className: 'green' },
    { label: '待人工确认', value: stats?.needsReview, detail: '少量判断，让知识更准确', Icon: ListChecks, className: 'amber', action: () => navigate('review') },
    { label: '正在处理', value: stats?.processing, detail: '自动解析与分类中', Icon: RefreshCw, className: 'blue' },
    { label: '知识片段', value: stats?.chunks, detail: '从原始资料中建立索引', Icon: Layers3, className: 'purple' },
  ];
  return <>
    <div className="page-heading"><div><div className="eyebrow">YOUR KNOWLEDGE, ORGANIZED</div><h1>知识收件箱<span className="heading-dot">.</span></h1><p>把资料交给系统，把判断留给你。</p></div><span className="subtle heading-note"><span className="live-dot" />后台自动整理</span></div>
    <div className="metrics">{metrics.map(metric => <button key={metric.label} className={`metric ${metric.className}`} onClick={metric.action} disabled={!metric.action}><div className="metric-top"><span>{metric.label}</span><metric.Icon size={18} /></div><div className="metric-value">{number(metric.value)}{metric.action && <ArrowRight size={19} />}</div><p>{metric.detail}</p></button>)}</div>
    <div className="intake-grid"><Dropzone onFiles={files => void uploads.add(files)} /><aside className="workflow-card"><span className="section-kicker">FROM FILES TO KNOWLEDGE</span><h2>一次导入，持续沉淀。</h2><p>每一份资料，都有清晰的来路。</p><div className="workflow-step"><span><FolderInput size={18} /></span><div><strong>01 <b>保留原始文件</b></strong><small>版本与来源始终可追踪</small></div></div><ArrowDown className="step-arrow" size={14} /><div className="workflow-step"><span><ScanText size={18} /></span><div><strong>02 <b>理解与整理</b></strong><small>自动分类、提取标签、建立索引</small></div></div><ArrowDown className="step-arrow" size={14} /><div className="workflow-step"><span><CircleCheck size={18} /></span><div><strong>03 <b>只确认不确定的内容</b></strong><small>人工反馈用于后续分类参考</small></div></div><div className="workflow-footer"><ShieldCheck size={15} />可查找 · 可纠正 · 可重建</div></aside></div>
    <UploadList manager={uploads} documents={documents} open={open} />
    {!!stats?.needsReview && <button className="review-callout" onClick={() => navigate('review')}><span className="callout-icon"><ListChecks size={21} /></span><span><strong>{stats.needsReview} 份资料，等你的判断</strong><small>确认文档类型或权威级别，即可继续入库。</small></span><span className="callout-link">前往确认 <ArrowRight size={16} /></span></button>}
    <section className="panel"><div className="panel-heading"><div><h2>最近的资料 <span className="count-pill">{number(stats?.total)}</span></h2><p>从上传到入库，查看每一份资料的进展</p></div><button className="text-button" onClick={() => navigate('library')}>查看资料库 <ArrowRight size={14} /></button></div><div className="panel-tabs"><div role="tablist" aria-label="资料处理状态">{[['all', '全部资料'], ['processing', '处理中'], ['failed', '处理失败']].map(([key, text]) => <button role="tab" aria-selected={tab === key} key={key} className={tab === key ? 'active' : ''} onClick={() => setTab(key)}>{text}{key === 'failed' && !!stats?.failed && <span className="tab-count">{stats.failed}</span>}</button>)}</div><button className="icon-button" title="刷新列表" aria-label="刷新列表" onClick={reload}><RefreshCw size={15} /></button></div>
      {error && <ErrorMessage message={error} retry={reload} />}{loading && !data ? <Loading /> : shown.length ? <DocumentTable documents={shown} registries={registries} open={open} compact /> : <Empty title={tab === 'failed' ? '没有处理失败的资料' : tab === 'processing' ? '当前没有处理中的资料' : '你的知识库，从第一份资料开始'} text={tab === 'all' ? '上传产品手册、历史方案或技术报告，系统会自动整理它们。' : '新的处理进展会自动显示在这里。'} />}
      <div className="panel-footer"><span><span className="live-dot" />每 4 秒自动更新</span><span>{stats?.failed ? `${stats.failed} 份处理失败，可在详情中重新处理` : '原始文件与历史版本始终保留'}</span></div>
    </section>
    <div className="source-summary"><span><span className="source-summary-icon"><FolderInput size={18} /></span><span><strong>资料来源</strong><small>{settings?.sources.filter(source => ['active', 'connected', 'ready'].includes(source.status)).length || 1} 个可用来源 · 手动上传已就绪</small></span></span><button className="text-button subtle" onClick={() => navigate('settings')}>管理来源 <ArrowRight size={14} /></button></div>
    <div className="page-footnote"><Check size={13} />你的知识，始终有据可依。<span>Solution Studio · Knowledge Manager</span></div>
  </>;
}
