import { useMemo, useState, type CSSProperties } from 'react';
import { Download, ImagePlus, LoaderCircle, Save } from 'lucide-react';
import type { GeneratedDocument, OutputProfile } from '../../../packages/document-engine/src/types.js';
import type { ProjectAsset } from '../../../packages/projects/src/types.js';
import { builtinTheme, resolveTheme } from '../../../packages/document-engine/src/theme.js';
import { validateDocumentLayout } from '../../../packages/document-engine/src/layout-qa.js';
import { api, patch } from './api.js';
import { ErrorMessage, Modal } from './ui.js';
import './export-settings.css';

export interface ExportSettingsProps {
  document: GeneratedDocument; assets: ProjectAsset[]; onSaved: () => void; onClose: () => void;
}

export function ExportSettings({ document, assets, onSaved, onClose }: ExportSettingsProps) {
  const [profile, setProfile] = useState<OutputProfile>({ ...document.outputProfile, themeId: document.outputProfile.themeId || builtinTheme.id, brandColor: document.outputProfile.brandColor || '#456B5B' });
  const [title, setTitle] = useState(document.title), [revision, setRevision] = useState(document.revision);
  const [uploadedAssets, setUploadedAssets] = useState<ProjectAsset[]>([]), [busy, setBusy] = useState(false), [error, setError] = useState('');
  const localAssets = [...assets.filter(asset => asset.projectId === document.projectId), ...uploadedAssets.filter(asset => asset.projectId === document.projectId && !assets.some(current => current.id === asset.id))];
  const [draftAccepted, setDraftAccepted] = useState(false);
  const issues = useMemo(() => validateDocumentLayout(document), [document]);
  const blocking = issues.some(issue => issue.severity === 'error');
  const contentIssues = document.issues;
  const unfinished = document.sections.filter(section => ['empty', 'failed', 'queued', 'generating'].includes(section.status) && !contentIssues.some(issue => issue.type === 'incomplete' && issue.sectionId === section.id));
  const unsafeContent = contentIssues.some(issue => ['customer_facing','prohibited_claim'].includes(issue.type) && issue.severity === 'error');
  const draftRequired = contentIssues.some(issue => issue.severity === 'error' || issue.type === 'incomplete') || unfinished.length > 0;
  const theme = resolveTheme(profile), logo = localAssets.find(asset => asset.id === profile.coverLogoAssetId);
  const set = <K extends keyof OutputProfile>(key: K, value: OutputProfile[K]) => setProfile(current => ({ ...current, [key]: value }));
  const upload = async (file?: File) => {
    if (!file) return;
    if (!['image/png', 'image/jpeg'].includes(file.type) || file.size > 20 * 1024 * 1024) { setError('Logo 请选择不超过 20 MB 的 PNG 或 JPEG 图片。'); return; }
    setBusy(true); setError('');
    try {
      const data = new FormData(); data.append('file', file);
      const result = await api<{ asset: ProjectAsset }>(`/projects/${document.projectId}/assets`, { method: 'POST', body: data });
      setUploadedAssets(current => [...current.filter(asset => asset.id !== result.asset.id), result.asset]);
      set('coverLogoAssetId', result.asset.id);
    } catch (caught) { setError(caught instanceof Error ? caught.message : 'Logo 上传失败'); }
    finally { setBusy(false); }
  };
  const save = async (download: boolean) => {
    setBusy(true); setError('');
    try {
      const { document: saved } = await patch<{ document: GeneratedDocument }>(`/generated-documents/${document.id}`, { revision, title, outputProfile: profile });
      setRevision(saved.revision); onSaved();
      if (download) {
        const response = await fetch(`/api/generated-documents/${document.id}/export.docx`);
        if (!response.ok) { const body = await response.json().catch(() => ({})); throw new Error(body.message || body.error || '导出失败，请重试'); }
        const url = URL.createObjectURL(await response.blob()), anchor = window.document.createElement('a');
        anchor.href = url; anchor.download = `${title}${draftRequired ? '（审阅稿）' : ''}.docx`; window.document.body.append(anchor); anchor.click(); anchor.remove();
        window.setTimeout(() => URL.revokeObjectURL(url), 60_000);
      }
      onClose();
    } catch (caught) { setError(caught instanceof Error ? caught.message : '设置保存失败'); }
    finally { setBusy(false); }
  };
  const previewStyle = { '--export-brand': `#${theme.cover.accentColor}`, '--export-text': `#${theme.typography.textColor}`, '--export-font': profile.fontFamily, '--export-heading-font': profile.titleFontFamily } as CSSProperties;
  return <Modal title="导出技术方案" close={() => { if (!busy) onClose(); }} className="export-settings-modal">
    <div className="export-settings-grid">
      <div className="export-settings-fields">
        <label className="field">输出主题<select value={profile.themeId} disabled={busy} onChange={event => set('themeId', event.target.value)}><option value={builtinTheme.id}>{builtinTheme.name}</option></select></label>
        <label className="field">方案标题<input value={title} maxLength={200} disabled={busy} onChange={event => setTitle(event.target.value)} /></label>
        <label className="field">编制单位<input value={profile.companyName} maxLength={300} disabled={busy} onChange={event => set('companyName', event.target.value)} /></label>
        <div className="export-field-pair"><label className="field">品牌色<div className="export-color-input"><input type="color" value={`#${theme.cover.accentColor}`} disabled={busy} onChange={event => set('brandColor', event.target.value)} /><span>#{theme.cover.accentColor}</span></div></label><label className="field">正文字号<select value={profile.fontSize} disabled={busy} onChange={event => set('fontSize', Number(event.target.value))}>{[10.5, 11, 12].map(size => <option value={size} key={size}>{size} 磅</option>)}</select></label></div>
        <div className="export-field-pair"><label className="field">正文字体<select value={profile.fontFamily} disabled={busy} onChange={event => set('fontFamily', event.target.value)}>{[...new Set(['宋体', '仿宋', '微软雅黑', profile.fontFamily])].map(font => <option key={font}>{font}</option>)}</select></label><label className="field">标题字体<select value={profile.titleFontFamily} disabled={busy} onChange={event => set('titleFontFamily', event.target.value)}>{[...new Set(['黑体', '微软雅黑', '宋体', profile.titleFontFamily])].map(font => <option key={font}>{font}</option>)}</select></label></div>
        <label className="field">公司 Logo<select aria-label="封面 Logo" value={profile.coverLogoAssetId || ''} disabled={busy} onChange={event => set('coverLogoAssetId', event.target.value)}><option value="">使用公司名称</option>{localAssets.filter(asset => (!asset.retiredAt || asset.id === profile.coverLogoAssetId) && ['image/png', 'image/jpeg', 'image/jpg'].includes(asset.mimeType)).map(asset => <option key={asset.id} value={asset.id}>{asset.caption || asset.filename}</option>)}</select></label>
        <label className={`button export-logo-upload ${busy ? 'disabled' : ''}`}><ImagePlus size={15} />上传 Logo<input type="file" aria-label="上传公司 Logo" accept="image/png,image/jpeg" disabled={busy} onChange={event => { void upload(event.target.files?.[0]); event.target.value = ''; }} /></label>
        <label className="field">页眉右侧<input value={profile.header} maxLength={60} disabled={busy} onChange={event => set('header', event.target.value)} /></label>
        <p className="subtle">A4 白底 · 一级章节另起一页 · 自动目录和页码 · 图表统一编号</p>
        {!!issues.length && <details className="export-preflight"><summary>排版检查：{issues.length} 项提示</summary><ul>{issues.map((issue, index) => <li key={index}>{issue.message}</li>)}</ul></details>}
        {(contentIssues.length > 0 || unfinished.length > 0) && <section className="export-content-check" aria-label="内容校验结果">
          <h3>内容检查：{contentIssues.length + unfinished.length} 项提示</h3>
          <ul>{contentIssues.map(issue => <li key={issue.id}><strong>{document.sections.find(section => section.id === issue.sectionId)?.title || '方案内容'}：</strong>{issue.message}{issue.quote && <blockquote>{issue.quote}</blockquote>}</li>)}{unfinished.map(section => <li key={section.id}><strong>{section.title}：</strong>{section.status === 'failed' ? '本章生成失败，内容尚未完成。' : '本章尚未完成。'}</li>)}</ul>
          {unsafeContent ? <p role="alert">正文包含内部审查语言、来源名称或不当技术承诺，请修正后导出。</p> : draftRequired && <label className="check-label"><input type="checkbox" checked={draftAccepted} disabled={busy} onChange={event => setDraftAccepted(event.target.checked)} />我已了解上述问题，作为审阅稿导出</label>}
        </section>}
      </div>
      <div className="export-preview-pane"><h3>封面预览</h3><div className="export-cover-preview" style={previewStyle} aria-label="方案封面预览">
        <div className="export-cover-brand">{logo ? <img src={logo.url} alt={`${profile.companyName} Logo`} /> : <span>{profile.companyName}</span>}</div>
        <div className="export-cover-title">{title.replace(/(?:技术方案|方案)$/, '').trim() || document.projectName}</div>
        <div className="export-cover-subtitle">技术方案</div>
        <div className="export-cover-details">{document.customerName && <p><span>客户名称</span>{document.customerName}</p>}<p><span>编制单位</span>{profile.companyName}</p><p><span>编制日期</span>{new Date().toLocaleDateString('zh-CN', { year: 'numeric', month: '2-digit', day: '2-digit' })}</p></div>
      </div><p className="subtle">此处展示封面样式。正文页码由 Word 按实际内容更新。</p></div>
    </div>
    {error && <ErrorMessage message={error} />}
    <div className="export-settings-actions"><button className="button" disabled={busy} onClick={() => void save(false)}><Save size={15} />保存设置</button><button className="button primary" disabled={busy || blocking || unsafeContent || draftRequired && !draftAccepted || !title.trim()} onClick={() => void save(true)}>{busy ? <LoaderCircle className="spin" size={16} /> : <Download size={16} />}{busy ? '正在处理…' : draftRequired && !unsafeContent ? '作为审阅稿导出' : '导出 Word'}</button></div>
  </Modal>;
}
