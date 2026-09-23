import { useEffect, useState } from 'react';
import { ArrowRight, BellDot, BookOpen, Check, CheckCheck, ChevronDown, ChevronRight, CircleHelp, Copy, Database, FolderKanban, Link2, FolderInput, Inbox as InboxIcon, Layers3, LibraryBig, ListChecks, Menu, Plus, Settings2, ShieldCheck, Sparkles, Upload, X } from 'lucide-react';
import type { Registries, Settings as SettingsType } from '../../../packages/core/src/types.js';
import Inbox from './Inbox.js';
import Library, { Review } from './Library.js';
import Settings from './Settings.js';
import Refinement from './Refinement.js';
import DocumentDrawer from './DocumentDrawer.js';
import Duplicates from './Duplicates.js';
import Projects from './Projects.js';
import FeishuSources from './FeishuSources.js';
import { StructuredDatasets } from './StructuredData.js';
import { Dropzone, useUploads } from './Upload.js';
import { ErrorMessage, Modal, number, useResource, type Page, type Stats } from './ui.js';

const pageNames: Record<Page, string> = { inbox: '知识收件箱', library: '资料库', review: '待确认', settings: '分类与设置', refinement: '智能整理', duplicates: '重复资料', projects: '项目', structured: '结构化数据', sources: '资料来源' };
const currentPage = (): Page => { const value = window.location.hash.slice(1).split('?')[0]; return value in pageNames ? value as Page : 'projects'; };

export default function App() {
  const [page, setPage] = useState<Page>(currentPage);
  const [refresh, setRefresh] = useState(0);
  const [drawer, setDrawer] = useState<{ id: string; tab?: 'overview' | 'chunks' }>();
  const [uploadModal, setUploadModal] = useState(false);
  const [help, setHelp] = useState(false);
  const [mobileNav, setMobileNav] = useState(false);
  const [toast, setToast] = useState<{ id: number; message: string; kind: 'success' | 'error' }>();
  const stats = useResource<Stats>('/stats', refresh, 5000);
  const registries = useResource<Registries>('/registries', refresh);
  const settings = useResource<SettingsType>('/settings', refresh);
  const reload = () => setRefresh(value => value + 1);
  const notify = (message: string, kind: 'success' | 'error' = 'success') => setToast({ id: Date.now(), message, kind });
  const uploads = useUploads(reload, notify);
  const navigate = (next: Page) => { window.location.hash = next; setPage(next); setMobileNav(false); window.scrollTo({ top: 0 }); };
  const open = (id: string, tab?: 'overview' | 'chunks') => setDrawer({ id, tab });
  const openBatch=(id:string)=>{window.location.hash=`refinement?batch=${encodeURIComponent(id)}`;setPage('refinement');reload();};
  const browseGroup=(id:string)=>{window.location.hash=`library?group=${encodeURIComponent(id)}`;setPage('library');};
  useEffect(() => { const handler = () => setPage(currentPage()); window.addEventListener('hashchange', handler); return () => window.removeEventListener('hashchange', handler); }, []);
  useEffect(() => { if (toast) { const timer = setTimeout(() => setToast(undefined), 6500); return () => clearTimeout(timer); } }, [toast]);
  const navItems = [{ key: 'projects' as const, title: '项目', Icon: FolderKanban, count: undefined }, { key: 'library' as const, title: '资料库', Icon: LibraryBig, count: undefined }, { key: 'review' as const, title: '待确认', Icon: ListChecks, count: stats.data?.needsReview }, { key: 'refinement' as const, title: '智能整理', Icon: Sparkles, count: undefined }, { key: 'duplicates' as const, title: '重复资料', Icon: Copy, count: undefined }, { key: 'structured' as const, title: '结构化数据', Icon: Database, count: undefined }, { key: 'sources' as const, title: '资料来源', Icon: Link2, count: undefined }];
  return <div className="app-shell"><a className="skip-link" href="#main-content" onClick={event => { event.preventDefault(); document.getElementById('main-content')?.focus(); }}>跳转到主要内容</a>{mobileNav && <button className="nav-backdrop" aria-label="关闭导航" onClick={() => setMobileNav(false)} />}
    <aside className={`sidebar ${mobileNav ? 'mobile-open' : ''}`}><a className="brand" href="#projects" onClick={event => { event.preventDefault(); navigate('projects'); }}><span className="brand-mark"><span /><span /><span /></span><span>Solution<span className="brand-studio">Studio</span></span></a><div className="workspace-switch"><span className="workspace-avatar">S</span><span><strong>方案工作台</strong><small>默认工作空间</small></span><span className="workspace-plan">内部版</span></div><div className="nav-label">SOLUTION WORKSPACE</div><nav aria-label="主要导航">{navItems.map(item => <button key={item.key} className={`nav-item ${page === item.key ? 'active' : ''}`} aria-current={page === item.key ? 'page' : undefined} onClick={() => navigate(item.key)}><item.Icon size={18} /><span>{item.title}</span>{!!item.count && <span className={`nav-count ${item.key === 'review' ? 'review-count' : ''}`}>{item.count}</span>}</button>)}<div className="nav-divider" /><button className={`nav-item ${page === 'settings' ? 'active' : ''}`} aria-current={page === 'settings' ? 'page' : undefined} onClick={() => navigate('settings')}><Settings2 size={18} /><span>分类与设置</span></button></nav><div className="sidebar-bottom"><div className="sidebar-note"><span className="note-icon"><Layers3 size={18} /></span><h3>从资料，到知识。</h3><p>让每一份经验被看见，<br />让每一次积累可复用。</p><span className="phase-label">PHASE 1.2 <span>技术方案</span></span></div><button className="sidebar-source" onClick={() => navigate('settings')}><span className={`live-dot ${stats.error ? 'offline' : ''}`} /><span>{stats.error ? '服务连接异常' : stats.loading && !stats.data ? '连接工作台…' : '本地工作台已就绪'}</span><ArrowRight size={13} /></button><div className="sidebar-profile"><span className="profile-avatar">S</span><span><strong>内部知识空间</strong><small>Solution Studio · Phase 1.2</small></span><ShieldCheck size={15} /></div></div></aside>
    <div className="main-shell"><header className="topbar"><button className="icon-button mobile-menu" aria-label="展开导航" onClick={() => setMobileNav(true)}><Menu size={20} /></button><div className="breadcrumbs"><span>工作空间</span><ChevronRight size={13} /><span>方案工作台</span><ChevronRight size={13} /><strong>{pageNames[page]}</strong></div><div className="topbar-actions"><button className="icon-button help-button" title="使用指南" aria-label="使用指南" onClick={() => setHelp(true)}><CircleHelp size={19} /></button><span className="topbar-divider" /><button className="button primary small-button" onClick={() => setUploadModal(true)}><Plus size={16} />导入资料</button></div></header>
      <main id="main-content" className="main-content" tabIndex={-1}>{(stats.error || registries.error || settings.error) && <ErrorMessage message={stats.error || registries.error || settings.error} retry={reload} />}{page === 'projects' && <Projects refresh={refresh} notify={notify} openKnowledge={open} />}{page === 'structured' && <><div className="page-heading"><div><div className="eyebrow">VERIFIED PRODUCT FACTS</div><h1>结构化数据<span className="heading-dot">.</span></h1><p>整理产品参数表，建立可追溯的确定性事实。</p></div></div><StructuredDatasets refresh={refresh} notify={notify} /></>}{page === 'sources' && <><div className="page-heading"><div><div className="eyebrow">KNOWLEDGE CONNECTIONS</div><h1>资料来源<span className="heading-dot">.</span></h1><p>管理飞书与本地来源，查看同步进度和历史。</p></div></div>{settings.data && <FeishuSources settings={settings.data} reload={reload} notify={notify} />}</>}{page === 'inbox' && <Inbox stats={stats.data} registries={registries.data} settings={settings.data} refresh={refresh} uploads={uploads} open={open} navigate={navigate} />}{page === 'library' && <Library registries={registries.data} settings={settings.data} refresh={refresh} open={open} onUpload={() => setUploadModal(true)} onRefined={openBatch} reload={reload} notify={notify} total={stats.data?stats.data.active+stats.data.needsReview+stats.data.failed+stats.data.processing:undefined} />}{page === 'review' && <Review stats={stats.data} registries={registries.data} refresh={refresh} open={open} />}{page === 'refinement' && <Refinement registries={registries.data} refresh={refresh} reload={reload} notify={notify} open={open} total={stats.data?stats.data.active+stats.data.needsReview:undefined} onBrowseGroup={browseGroup} />}{page === 'duplicates' && <Duplicates settings={settings.data} refresh={refresh} reload={reload} notify={notify} open={open} />}{page === 'settings' && <Settings settings={settings.data} registries={registries.data} reload={reload} notify={notify} />}</main>
    </div>
    {drawer && <DocumentDrawer key={drawer.id} id={drawer.id} initialTab={drawer.tab} registries={registries.data} close={() => setDrawer(undefined)} onChange={reload} notify={notify} onOpenDocument={open} />}
    {uploadModal && <Modal title="导入资料" close={() => setUploadModal(false)} className="upload-modal"><div className="upload-modal-body"><p>可以一次选择多份资料。系统会自动整理，只将不确定的关键字段交给你。</p><Dropzone compact onFiles={files => { if (files.length) { setUploadModal(false); navigate('inbox'); void uploads.add(files); } }} /></div></Modal>}
    {help && <Modal title="开始使用知识工作台" close={() => setHelp(false)}><div className="help-content"><div><span>01</span><div><h3>导入你的资料</h3><p>将 Word、PDF、表格或文本批量拖入收件箱。系统保留原文件，并自动检测内容重复。</p></div></div><div><span>02</span><div><h3>确认少量关键判断</h3><p>到“待确认”检查文档类型与权威级别。人工确认优先于模型判断，并会作为后续分类参考。</p></div></div><div><span>03</span><div><h3>查找有来源的知识</h3><p>在资料库搜索正文与知识片段，用类型、领域、主题、产品和权威级别筛选结果。</p></div></div><div className="notice"><ShieldCheck size={17} /><p>在资料详情中下载原文件、编辑标签、查看版本或重新处理。到“项目”创建技术方案，确认项目事实后逐章生成、编辑并导出 Word。</p></div><button className="button primary" onClick={() => setHelp(false)}>开始整理 <ArrowRight size={15} /></button></div></Modal>}
    {toast && <div className={`toast ${toast.kind}`} role={toast.kind === 'error' ? 'alert' : 'status'}><span className="toast-icon">{toast.kind === 'success' ? <Check size={15} /> : <X size={15} />}</span><span>{toast.message}</span><button className="icon-button" aria-label="关闭提示" onClick={() => setToast(undefined)}><X size={15} /></button></div>}
  </div>;
}
