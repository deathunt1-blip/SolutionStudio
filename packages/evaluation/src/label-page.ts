/** Static shell: all document-derived text is assigned with textContent/value in labelScript. */
export const labelHtml = `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>人工标注 · Solution Studio</title><link rel="stylesheet" href="/app.css"><script src="/app.js" defer></script></head>
<body>
<header class="topbar"><div class="brand"><span class="mark">S</span><div><strong>Solution Studio</strong><span>分类质量评测</span></div></div><span class="local-badge"><i></i>本地人工标注 · 无模型调用</span></header>
<main>
<section class="intro"><div><p class="eyebrow">PHASE 0.1 / GROUND TRUTH</p><h1>用真实判断，衡量分类质量</h1><p>查看标题、目录与关键正文，再给出你的答案。这里的标注独立保存，不会修改正式资料库。</p></div><div class="progress-card"><strong id="progress-count">— / —</strong><span>已完成人工标注</span><progress id="progress" max="1" value="0"></progress></div></section>
<div id="message" class="message" role="status" aria-live="polite" hidden></div>
<nav class="document-nav" aria-label="切换文件"><div class="file-picker"><label for="file-select">数据集 <span id="dataset-name">正在读取…</span></label><select id="file-select" disabled aria-label="选择要标注的文件"></select></div><div class="navigation-buttons"><button type="button" id="previous" disabled>← 上一份</button><button type="button" id="skip" disabled>跳过</button><button type="button" id="next" disabled>下一份 →</button></div></nav>
<div class="workspace">
<section class="preview panel" aria-labelledby="filename"><div class="preview-header"><div><span class="section-label">原文阅读</span><h2 id="filename">正在加载资料</h2><p class="file-meta"><span id="file-position"></span><span id="parse-status"></span><span id="version-hash"></span></p></div><a id="original" class="button small" hidden>下载原文件 ↗</a></div>
<p id="parse-warnings" class="warning" hidden></p>
<div class="preview-content"><section><h3>正文摘录摘要 <span>原文节选</span></h3><p id="summary" class="preserve">—</p></section><section id="headings-section"><h3>前几个标题</h3><ol id="headings"></ol></section><section><div class="section-heading"><h3 id="body-title">正文预览</h3><button type="button" id="full-text" class="text-button" disabled>展开提取的全文</button></div><pre id="excerpt">—</pre><p id="text-limit" class="muted" hidden>全文过长，页面最多展示前 200 万字符。请下载原文件查看完整内容。</p></section></div></section>
<aside class="annotation panel"><div class="annotation-heading"><span class="section-label">你的独立判断</span><h2>人工标准答案</h2><p id="label-state">首次标注不会预填 AI 预测。</p></div>
<form id="label-form"><fieldset id="form-fields" disabled>
<div class="field"><label for="document-type">文档类型 <span class="required">*</span></label><select id="document-type" required><option value="">请主动选择文档类型</option></select></div>
<div class="field"><label for="authority">权威级别 <span class="required">*</span></label><select id="authority" required><option value="">请主动选择权威级别</option><option value="authoritative">权威资料 · Authoritative</option><option value="reference">参考资料 · Reference</option><option value="style_only">仅供风格参考 · Style only</option><option value="unknown">无法判断 · Unknown</option></select><details class="authority-help"><summary>如何判断权威级别？</summary><dl><dt>权威资料</dt><dd>有可靠的正式来源、发布主体或当前版本依据。产品手册本身不代表一定权威。</dd><dt>参考资料</dt><dd>历史项目、经验或一般技术资料，可供参考，需要核对其中事实。</dd><dt>仅供风格参考</dt><dd>只借鉴表达、结构或版式，不把其中内容当作事实依据。</dd><dt>无法判断</dt><dd>证据不足，明确选择未知。文档类型也可以选择“未知”。</dd></dl></details></div>
<div class="optional-section"><h3>可选字段</h3><p>只在完整核对后勾选；勾选但留空表示“确认没有”，不勾选表示“尚未评测”。</p>
<div class="field"><label class="check-label"><input type="checkbox" id="applications-complete">已完整标注应用领域</label><select id="applications" multiple size="3" disabled aria-label="应用领域，可多选"></select></div>
<div class="field"><label class="check-label"><input type="checkbox" id="topics-complete">已完整标注技术主题</label><select id="topics" multiple size="3" disabled aria-label="技术主题，可多选"></select></div>
<div class="field"><label class="check-label"><input type="checkbox" id="products-complete">已完整标注产品</label><textarea id="products" rows="2" disabled placeholder="每行一个原文中的产品名称；确认没有可留空" aria-label="产品名称，每行一个"></textarea></div></div>
<div class="field"><label for="notes">判断依据 / 备注</label><textarea id="notes" rows="3" maxlength="10000" placeholder="例如：标题说验收，但正文主要是设备测试记录"></textarea></div>
<div class="field"><label for="labeled-by">标注人 <span class="required">*</span></label><input id="labeled-by" required maxlength="200" autocomplete="name" placeholder="填写你的姓名或团队内可识别的名字"><small>同一浏览器会记住本次标注人。</small></div>
<div class="save-actions"><button type="submit" id="save" class="secondary">保存</button><button type="submit" id="save-next" class="primary">保存并继续 →</button></div><p class="form-footnote">答案只写入本地评测 labels.json，不会生成生产分类样例。</p>
</fieldset></form></aside>
</div><footer>不确定时选择“未知”。请勿只凭文件名标注；解析不完整时，可下载原文件核对。</footer>
</main></body></html>`;

export const labelStyles = `
:root{font-family:Inter,"Segoe UI","Microsoft YaHei",sans-serif;color:#203735;background:#f3f5f2;font-synthesis:none;line-height:1.55;font-size:14px}*{box-sizing:border-box}body{margin:0}button,input,select,textarea{font:inherit}button,.button{border:1px solid #cdd8d1;border-radius:7px;padding:9px 13px;background:white;color:#294a45;font-weight:600;text-decoration:none;cursor:pointer;display:inline-flex;align-items:center;justify-content:center;white-space:nowrap}button:hover,.button:hover{background:#edf4ef;border-color:#87a69a}button:disabled{opacity:.45;cursor:default}button:focus-visible,input:focus-visible,select:focus-visible,textarea:focus-visible,a:focus-visible{outline:3px solid #8ac1b3;outline-offset:2px}.topbar{height:78px;background:#173d38;color:#fbfdfb;display:flex;align-items:center;justify-content:space-between;padding:0 5%;border-bottom:4px solid #dcebcf}.brand{display:flex;gap:12px;align-items:center}.mark{width:38px;height:38px;border:1px solid #a7c2b0;display:grid;place-items:center;border-radius:9px;font-size:23px;font-weight:700;color:#dcebcf}.brand strong{font-size:17px;display:block;letter-spacing:.2px}.brand span:not(.mark){font-size:11px;color:#b9d0c8;letter-spacing:2px}.local-badge{font-size:12px;color:#c8dbd1}.local-badge i{display:inline-block;width:6px;height:6px;border-radius:100%;background:#c5dba5;margin-right:7px}main{max-width:1490px;margin:0 auto;padding:32px 36px}.intro{display:flex;justify-content:space-between;gap:30px;margin-bottom:25px;align-items:center}.eyebrow{font-size:10px;letter-spacing:2px;color:#698179;font-weight:700;margin:0 0 8px}h1{font-size:27px;letter-spacing:-.5px;margin:0 0 8px;font-weight:650}.intro p:not(.eyebrow){color:#6d7d73;margin:0;max-width:730px}.progress-card{width:210px;flex-shrink:0;background:#e8eee4;border:1px solid #dce5d7;border-radius:10px;padding:13px 18px}.progress-card strong{font-size:23px;display:block;letter-spacing:.5px}.progress-card span{font-size:11px;color:#72826e}progress{display:block;accent-color:#487e69;height:6px;width:100%;margin-top:9px;border:0;border-radius:9px}progress::-webkit-progress-bar{background:#d1dcca;border-radius:9px}progress::-webkit-progress-value{background:#487e69;border-radius:9px}.document-nav{display:flex;align-items:end;gap:20px;justify-content:space-between;margin:0 0 16px}.file-picker{min-width:0;flex:1;max-width:780px}.file-picker label{font-size:11px;font-weight:700;color:#728076;display:block;margin-bottom:6px}.file-picker label span{font-weight:400;margin-left:9px}.file-picker select{width:100%;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;background:#fff}.navigation-buttons{display:flex;gap:8px;flex-shrink:0}.workspace{display:grid;grid-template-columns:minmax(0,1fr) 390px;gap:20px;align-items:start}.panel{background:#fff;border:1px solid #dae3db;border-radius:12px;overflow:hidden;box-shadow:0 3px 12px #293e3604}.preview-header{padding:23px 25px 18px;border-bottom:1px solid #e7ede6;display:flex;align-items:start;justify-content:space-between;gap:12px}.section-label{font-size:10px;color:#839282;letter-spacing:1.4px;font-weight:700}h2{font-size:18px;line-height:1.5;font-weight:650;margin:5px 0;overflow-wrap:anywhere}.file-meta{font-size:10px;color:#89948a;margin:7px 0 0;display:flex;flex-wrap:wrap;gap:12px}.small{font-size:11px;padding:7px 10px}.preview-content{padding:4px 25px 25px}.preview-content section{padding-top:19px;border-bottom:1px solid #edf0eb;padding-bottom:19px}.preview-content section:last-child{border:0;padding-bottom:0}h3{font-size:12px;letter-spacing:.4px;margin:0 0 12px;color:#496054;font-weight:700}h3 span{font-size:10px;color:#98a394;font-weight:400;margin-left:8px}.preserve{white-space:pre-wrap;overflow-wrap:anywhere;font-size:13px;line-height:1.85;color:#54675b;margin:0}ol{margin:0;padding-left:20px;font-size:13px;color:#68786b}li{padding:3px 0;overflow-wrap:anywhere}.section-heading{display:flex;align-items:center;justify-content:space-between;gap:10px;margin-bottom:10px}.section-heading h3{margin:0}.text-button{font-size:11px;color:#467b67;border:0;background:transparent;padding:3px 0}pre{white-space:pre-wrap;overflow-wrap:anywhere;word-break:break-word;font:12px/1.9 "Segoe UI","Microsoft YaHei",sans-serif;margin:0;background:#f7f8f4;border:1px solid #edf0e8;border-radius:6px;padding:16px;color:#48594c;max-height:950px;overflow:auto}.annotation{padding:23px 22px}.annotation-heading{padding-bottom:15px;border-bottom:1px solid #e7ede6;margin-bottom:19px}.annotation-heading p{font-size:11px;color:#84917f;margin:5px 0 0}fieldset{padding:0;border:0;margin:0;min-width:0}.field{margin-bottom:17px}.field>label{font-size:12px;font-weight:600;display:block;margin-bottom:7px}.required{color:#8a6951}.field small{font-size:10px;color:#98a393;display:block;margin-top:5px}select,input:not([type=checkbox]),textarea{border:1px solid #cfdad0;border-radius:6px;background:#fff;color:#334b3d;padding:9px 10px;width:100%;min-height:38px}textarea{resize:vertical;line-height:1.55;font-size:12px}select:disabled,textarea:disabled,input:disabled{background:#f5f7f2;color:#a9b1a3;border-color:#e4e9df}select[multiple]{min-height:80px;font-size:11px;padding:5px}select[multiple] option{padding:3px 4px}.authority-help{font-size:11px;margin-top:8px;color:#81917d}.authority-help summary{cursor:pointer;color:#698674}.authority-help dl{background:#f5f8f0;padding:10px 12px;border-radius:6px}.authority-help dt{font-weight:700;color:#647a58}.authority-help dd{margin:3px 0 9px}.authority-help dd:last-child{margin-bottom:0}.optional-section{border-top:1px solid #e8ede4;border-bottom:1px solid #e8ede4;padding:17px 0 0;margin:19px 0}.optional-section h3{margin-bottom:5px}.optional-section>p{font-size:10px;color:#8b9884;margin:0 0 14px;line-height:1.7}.field .check-label{display:flex;align-items:center;gap:7px;font-size:11px;color:#708369;font-weight:500}.check-label input{margin:0;accent-color:#487e69}.save-actions{display:grid;grid-template-columns:1fr 1.8fr;gap:8px}.primary{background:#23574c;color:#fff;border-color:#23574c}.primary:hover{background:#17483e;color:#fff}.secondary{background:#f4f7ef}.form-footnote{font-size:10px;text-align:center;color:#99a291;margin:12px 0 0;line-height:1.6}.warning{margin:18px 25px 0;padding:10px 12px;background:#fbf5e8;color:#8b733f;border:1px solid #ebdfbf;border-radius:6px;font-size:11px;white-space:pre-wrap;overflow-wrap:anywhere}.muted{font-size:11px;color:#8c9983}.message{background:#e6f1e8;border:1px solid #c1d7c8;color:#365e46;border-radius:8px;padding:12px 15px;font-size:12px;margin-bottom:17px}.message.error{background:#fff0e9;border-color:#e8c9b5;color:#9b573e}footer{font-size:11px;color:#919c88;text-align:center;padding:25px 10px}[hidden]{display:none!important}@media(min-width:1250px){.annotation{position:sticky;top:16px}}@media(max-width:1000px){main{padding:25px 20px}.workspace{grid-template-columns:minmax(0,1fr) 340px;gap:15px}.intro h1{font-size:24px}.preview-header{display:block}.preview-header .button{margin-top:12px}.annotation{padding:20px 16px}.preview-content{padding:4px 18px 20px}.preview-header{padding:20px 18px}.warning{margin-left:18px;margin-right:18px}}@media(max-width:760px){.topbar{height:68px;padding:0 20px}.local-badge{font-size:10px}.brand strong{font-size:15px}.brand span:not(.mark){font-size:9px}main{padding:23px 16px}.intro{align-items:stretch;gap:15px}.intro h1{font-size:21px}.intro p:not(.eyebrow){font-size:12px}.progress-card{width:120px;padding:12px}.progress-card strong{font-size:20px}.workspace{grid-template-columns:1fr}.document-nav{display:block}.navigation-buttons{justify-content:space-between;margin-top:10px}.navigation-buttons button{flex:1}.file-picker{max-width:none}.preview-content pre{max-height:520px}.annotation{padding:22px}.eyebrow{font-size:8px}.local-badge i{display:none}.brand{gap:8px}.mark{width:32px;height:32px}.preview-header{display:flex}.preview-header .button{margin:0}}`;

export const labelScript = String.raw`
'use strict';
const $ = id => document.getElementById(id);
const state = { dataset: null, index: 0, current: null, dirty: false, loading: false, full: false };
const form = $('label-form');
const optionalFields = ['applications', 'topics', 'products'];
function message(text, error = false) { $('message').textContent = text; $('message').className = 'message' + (error ? ' error' : ''); $('message').hidden = !text; }
async function api(url, options) { const response = await fetch(url, { credentials: 'same-origin', ...options }); const body = await response.json(); if (!response.ok) throw new Error(body.error || '本地服务暂时不可用。'); return body; }
function rememberedName() { try { return sessionStorage.getItem('evaluation-labeled-by') || ''; } catch { return ''; } }
function rememberName(name) { try { sessionStorage.setItem('evaluation-labeled-by', name); } catch {} }
function busy(value) {
  state.loading = value; $('form-fields').disabled = value || !state.current; $('file-select').disabled = value || !state.dataset;
  $('previous').disabled = value || !state.dataset || state.index === 0;
  $('next').disabled = value || !state.dataset || state.index >= state.dataset.documents.length - 1;
  $('skip').disabled = value || !state.dataset || state.index >= state.dataset.documents.length - 1;
  $('full-text').disabled = value || !state.current;
}
function progress() {
  const count = state.dataset.labeledIds.length, total = state.dataset.documents.length;
  $('progress-count').textContent = count + ' / ' + total; $('progress').max = total; $('progress').value = count;
  const select = $('file-select'); select.replaceChildren();
  state.dataset.documents.forEach((item, index) => { const option = new Option((state.dataset.labeledIds.includes(item.id) ? '✓ ' : '') + (index + 1) + '. ' + item.filename, String(index)); select.add(option); });
  select.value = String(state.index);
}
function optionsFor(field, items) {
  const select = $(field); select.replaceChildren();
  if (field === 'document-type') select.add(new Option('请主动选择文档类型', ''));
  items.forEach(item => select.add(new Option(item.label, item.key)));
}
function render(data) {
  state.current = data; state.full = false;
  $('filename').textContent = data.filename;
  $('file-position').textContent = '第 ' + (state.index + 1) + ' / ' + state.dataset.documents.length + ' 份';
  $('parse-status').textContent = { success: '已提取文本', partial: '部分解析', failed: '未能提取文本' }[data.parseStatus] || data.parseStatus;
  $('version-hash').textContent = 'SHA256 ' + data.contentHash.slice(0, 12);
  $('summary').textContent = data.summary || '没有可读取的正文摘要，请下载原文件核对。';
  $('parse-warnings').hidden = !data.parseWarnings.length; $('parse-warnings').textContent = data.parseWarnings.join('\n');
  $('headings').replaceChildren(); data.headings.forEach(heading => { const item = document.createElement('li'); item.textContent = heading; $('headings').append(item); });
  $('headings-section').hidden = !data.headings.length;
  $('excerpt').textContent = data.excerpt || '当前解析器无法读取正文。你可以下载原文件查看，再决定是否标注；也可以跳过。';
  $('body-title').textContent = '正文预览'; $('full-text').textContent = '展开提取的全文'; $('text-limit').hidden = true;
  $('original').href = '/api/documents/' + encodeURIComponent(data.id) + '/original'; $('original').hidden = false;
  const label = data.label;
  $('document-type').value = label ? label.documentType : ''; $('authority').value = label ? label.authority : '';
  $('labeled-by').value = label ? label.labeledBy : rememberedName(); $('notes').value = label ? (label.notes || '') : '';
  optionalFields.forEach(field => {
    const complete = Boolean(label && Object.prototype.hasOwnProperty.call(label, field));
    $(field + '-complete').checked = complete; $(field).disabled = !complete;
    if (field === 'products') $(field).value = label && label[field] ? label[field].join('\n') : '';
    else Array.from($(field).options).forEach(option => { option.selected = Boolean(label && label[field] && label[field].includes(option.value)); });
  });
  $('label-state').textContent = label ? '已由 ' + label.labeledBy + ' 标注 · ' + new Date(label.labeledAt).toLocaleString('zh-CN') : '首次标注不会预填 AI 预测。';
  state.dirty = false;
}
async function loadDocument(index, preserveMessage = false) {
  if (state.loading || !state.dataset || index < 0 || index >= state.dataset.documents.length) return;
  if (state.dirty && !window.confirm('当前修改尚未保存。确定放弃修改并切换文件吗？')) { $('file-select').value = String(state.index); return; }
  state.index = index; $('file-select').value = String(index); state.current = null; state.dirty = false; busy(true);
  if (!preserveMessage) message('');
  form.reset(); optionalFields.forEach(field => { $(field).disabled = true; });
  $('label-state').textContent = '正在读取当前文件，尚未加载人工答案。';
  $('original').hidden = true; $('filename').textContent = state.dataset.documents[index].filename; $('excerpt').textContent = '正在读取并验证文件版本…';
  $('file-position').textContent = ''; $('parse-status').textContent = ''; $('version-hash').textContent = '';
  $('summary').textContent = '—'; $('headings-section').hidden = true; $('parse-warnings').hidden = true;
  try { render(await api('/api/documents/' + encodeURIComponent(state.dataset.documents[index].id))); }
  catch (error) { message(error.message, true); $('excerpt').textContent = '无法预览当前文件，请查看上方提示。可切换其他文件继续标注。'; }
  finally { busy(false); }
}
$('previous').addEventListener('click', () => loadDocument(state.index - 1));
$('next').addEventListener('click', () => loadDocument(state.index + 1));
$('skip').addEventListener('click', () => loadDocument(state.index + 1));
$('file-select').addEventListener('change', event => loadDocument(Number(event.target.value)));
form.addEventListener('input', () => { state.dirty = true; }); form.addEventListener('change', () => { state.dirty = true; });
optionalFields.forEach(field => $(field + '-complete').addEventListener('change', () => { $(field).disabled = !$(field + '-complete').checked; }));
$('full-text').addEventListener('click', async () => {
  if (!state.current || state.loading) return;
  if (state.full) { $('excerpt').textContent = state.current.excerpt; $('body-title').textContent = '正文预览'; $('full-text').textContent = '展开提取的全文'; $('text-limit').hidden = true; state.full = false; return; }
  busy(true);
  try { const data = await api('/api/documents/' + encodeURIComponent(state.current.id) + '?full=1'); $('excerpt').textContent = data.fullText || '没有可提取的文字，请下载原文件。'; $('body-title').textContent = '提取的全文'; $('full-text').textContent = '收起全文'; $('text-limit').hidden = !data.fullTextTruncated; state.full = true; }
  catch (error) { message(error.message, true); }
  finally { busy(false); }
});
form.addEventListener('submit', async event => {
  event.preventDefault(); if (state.loading || !state.current || !form.reportValidity()) return;
  const input = { documentId: state.current.id, contentHash: state.current.contentHash, documentType: $('document-type').value, authority: $('authority').value, labeledBy: $('labeled-by').value.trim(), expectedLabeledAt: state.current.label ? state.current.label.labeledAt : null };
  if (!input.labeledBy) { message('请填写真实标注人的姓名或团队内可识别的名字。', true); $('labeled-by').focus(); return; }
  optionalFields.forEach(field => { if ($(field + '-complete').checked) input[field] = field === 'products' ? $(field).value.split(/\r?\n/).map(value => value.trim()).filter(Boolean) : Array.from($(field).selectedOptions).map(option => option.value); });
  if ($('notes').value.trim()) input.notes = $('notes').value.trim();
  const continueAfter = event.submitter && event.submitter.id === 'save-next'; busy(true); message('');
  let saved = false;
  try {
    const result = await api('/api/labels', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Label-CSRF': state.dataset.csrfToken }, body: JSON.stringify(input) });
    state.current.label = result.label; state.dirty = false; rememberName(input.labeledBy);
    if (!state.dataset.labeledIds.includes(input.documentId)) state.dataset.labeledIds.push(input.documentId);
    progress(); $('label-state').textContent = '已由 ' + result.label.labeledBy + ' 标注 · ' + new Date(result.label.labeledAt).toLocaleString('zh-CN');
    message('人工标注已保存。' + (result.labeledCount === result.total ? '所有文件均已标注，可以运行正式分类评测。' : '可继续核对下一份。')); saved = true;
  } catch (error) { message(error.message, true); }
  finally { busy(false); }
  if (saved && continueAfter && state.index < state.dataset.documents.length - 1) await loadDocument(state.index + 1, true);
});
window.addEventListener('beforeunload', event => { if (state.dirty) { event.preventDefault(); event.returnValue = ''; } });
(async () => {
  try {
    state.dataset = await api('/api/dataset'); $('dataset-name').textContent = state.dataset.datasetId;
    optionsFor('document-type', state.dataset.registries.documentTypes); optionsFor('applications', state.dataset.registries.applications); optionsFor('topics', state.dataset.registries.topics);
    progress(); const firstUnlabeled = state.dataset.documents.findIndex(item => !state.dataset.labeledIds.includes(item.id));
    await loadDocument(firstUnlabeled < 0 ? 0 : firstUnlabeled);
  } catch (error) { message(error.message, true); $('filename').textContent = '无法加载评测数据集'; }
})();
`;
