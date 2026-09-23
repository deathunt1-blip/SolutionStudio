import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { load } from 'cheerio';
import Duplicates, { DuplicateGroupDetail, SourceReferences } from '../apps/web/src/Duplicates.js';

const resources = vi.hoisted(() => new Map<string, unknown>());
vi.mock('../apps/web/src/ui.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../apps/web/src/ui.js')>();
  return { ...actual, useResource: (path: string) => ({ data: resources.get(path), loading: false, error: '', reload: () => {} }) };
});
const members = [{ documentId: 'a', title: '产品说明书 2025', filename: '说明书旧版.pdf', status: 'active', versionId: 'v-a', sourceId: 'manual', sourceName: '手工上传', sourceType: 'manual', sourcePath: '项目资料/旧版' }, { documentId: 'b', title: '产品说明书 2026', filename: '说明书最新版.docx', status: 'active', versionId: 'v-b', sourceId: 'feishu', sourceName: '飞书产品资料', sourceType: 'feishu_wiki', sourcePath: '产品/K18', sourceUrl: 'https://test.feishu.cn/wiki/public-example' }];
const base = { id: 'group', status: 'suggested', relation: 'possible_version', score: .93, reasons: ['大部分正文相同，参数与年份有变化。'], differences: [{ kind: 'number', location: 'tables[0].rows[2][1]', before: '172 fps', after: '180 fps' }], canonicalDocumentId: 'b', members, canUndo: false, stale: false };
function detail(overrides: Record<string, unknown> = {}) {
  resources.set('/duplicates/group', { ...base, ...overrides });
  return load(renderToStaticMarkup(<DuplicateGroupDetail id="group" refresh={0} open={() => {}} notify={() => {}} changed={() => {}} />));
}
const button = (html: ReturnType<typeof load>, text: string) => html('button').filter((_index, element) => html(element).text() === text);
afterEach(() => { resources.clear(); vi.unstubAllGlobals(); });

describe('Duplicate review UI safety and provenance', () => {
  it('identifies both source files and shows the parameter change against the correct titles', () => {
    const html = detail();
    expect(html('.duplicate-member')).toHaveLength(2);
    expect(html('input[type=radio][checked]').attr('value')).toBe('b');
    expect(html.text()).toContain('说明书旧版.pdf');
    expect(html.text()).toContain('飞书产品资料');
    expect(html.text()).toContain('表格 1 · 第 3 行第 2 列');
    expect(html('.duplicate-difference-values small').map((_i, el) => html(el).text()).get()).toEqual(['产品说明书 2025', '产品说明书 2026']);
    expect(html('.duplicate-difference-values p').map((_i, el) => html(el).text()).get()).toEqual(['172 fps', '180 fps']);
    expect(button(html, '确认版本关系').attr('disabled')).toBeUndefined();
    expect(html.text()).toContain('合并不删除原文件');
  });

  it('blocks merge and version confirmation for stale comparisons while allowing keep-independent', () => {
    const html = detail({ stale: true, relation: 'near_duplicate' });
    expect(button(html, '合并来源').attr('disabled')).toBeDefined();
    expect(button(html, '确认版本关系').attr('disabled')).toBeDefined();
    expect(button(html, '保持独立').attr('disabled')).toBeUndefined();
    expect(html.text()).toContain('重新扫描');
  });

  it('only offers actions allowed for each relation type', () => {
    for (const relation of ['exact_duplicate', 'content_duplicate']) {
      const html = detail({ relation });
      expect(button(html, '合并来源')).toHaveLength(1);
      expect(button(html, '确认版本关系')).toHaveLength(0);
    }
    for (const relation of ['possible_version', 'similar']) {
      const html = detail({ relation });
      expect(button(html, '合并来源')).toHaveLength(0);
      expect(button(html, '确认版本关系')).toHaveLength(1);
      expect(html('.canonical-choice').first().text()).toContain('当前版本');
    }
    const near = detail({ relation: 'near_duplicate' });
    expect(button(near, '合并来源')).toHaveLength(1);
    expect(button(near, '确认版本关系')).toHaveLength(1);
  });

  it('translates detector reasons and combined difference locations into Chinese', () => {
    const html = detail({ reasons: ['exact_content_hash', 'template_similarity', '自定义核对说明'], differences: [{ kind: 'model', location: 'title / filename / plainText:model', before: 'K18', after: 'K20' }, { kind: 'project', location: 'plainText:project fields', before: '项目甲', after: '项目乙' }] });
    expect(html('.duplicate-reasons').text()).toContain('原始文件内容完全一致');
    expect(html('.duplicate-reasons').text()).toContain('相同的项目模板');
    expect(html('.duplicate-reasons').text()).toContain('自定义核对说明');
    expect(html('.duplicate-difference h4').map((_i, el) => html(el).text()).get()).toEqual(['资料标题 / 原始文件名 / 正文中的产品型号', '正文中的项目事实']);
    expect(html.text()).not.toContain('exact_content_hash');
    expect(html.text()).not.toContain('plainText');
  });

  it('offers undo only when the server confirms it is safe', () => {
    expect(button(detail({ status: 'confirmed', operation: 'version', canUndo: true }), '撤销本次处理')).toHaveLength(1);
    expect(button(detail({ status: 'confirmed', operation: 'version', canUndo: false }), '撤销本次处理')).toHaveLength(0);
    const dismissed = detail({ status: 'dismissed', canUndo: true });
    expect(dismissed('.canonical-choice').map((_i, el) => dismissed(el).text()).get()).toEqual(['独立资料', '独立资料']);
  });

  it('shows every retained source and the canonical link without rendering unsafe remote URLs', () => {
    resources.set('/documents/b/sources', { canonicalDocumentId: 'a', items: members.map((member, index) => ({ ...member, id: `ref-${index}`, sourceDocumentId: `remote-${index}`, discoveredAt: '2026-09-23T00:00:00Z', removed: index === 1, sourceMetadata: index === 1 ? { decrypted: true } : {}, sourceUrl: index === 0 ? 'javascript:alert(1)' : member.sourceUrl })) });
    const html = load(renderToStaticMarkup(<SourceReferences documentId="b" open={() => {}} />));
    expect(html('.source-reference-list article')).toHaveLength(2);
    expect(button(html, '查看主资料')).toHaveLength(1);
    expect(html.text()).toContain('远端已移除');
    expect(html('a[href^="javascript:"]')).toHaveLength(0);
    expect(html('a[href="https://test.feishu.cn/wiki/public-example"]')).toHaveLength(1);
    expect(html('a[href="/api/documents/b/sources/ref-0/original"]')).toHaveLength(1);
    expect(html('a[href="/api/documents/b/sources/ref-1/original?sourceOriginal=1"]').text()).toContain('下载加密原件');
  });

  it('carries a library selection into the scan setup without automatically scanning or merging', () => {
    vi.stubGlobal('window', { location: { hash: `#duplicates?scan=${encodeURIComponent(JSON.stringify({ documentIds: ['a', 'b'] }))}` } });
    resources.set('/duplicates?page=1&pageSize=20&status=suggested', { items: [], total: 0, page: 1, pageSize: 20 });
    const html = load(renderToStaticMarkup(<Duplicates refresh={0} reload={() => {}} notify={() => {}} open={() => {}} />));
    expect(html('option[value=selected][selected]')).toHaveLength(1);
    expect(html.text()).toContain('2 份已选资料');
    expect(button(html, '开始扫描')).toHaveLength(1);
    expect(html.text()).toContain('不调用 Kimi');
  });
});
