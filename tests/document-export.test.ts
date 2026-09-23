import { describe, expect, it } from 'vitest';
import JSZip from 'jszip';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { exportDocument } from '../packages/document-engine/src/export.js';
import { defaultOutputProfile, type DocumentSection, type GeneratedDocument } from '../packages/document-engine/src/types.js';

const png = Buffer.from('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', 'base64');
const section = (id: string, order: number, level: number, blocks: DocumentSection['blocks'] = []): DocumentSection => ({ id, order, level, title: `章节${id}`, generationMode: 'mixed', requiredContext: [], status: 'edited', blocks, sourceRefs: [], assetRefs: [], lockedFactRefs: [], claims: [], revision: 1, edited: true });
const proposal = (): GeneratedDocument => ({
  id: 'doc-export', projectId: 'project', projectName: '机器人动作捕捉系统', customerName: '测试研究院', title: '机器人动作捕捉系统技术方案', documentType: 'proposal', templateId: 'standard', templateVersion: 1, contextRevision: 1, revision: 1, status: 'edited', outputProfile: { ...defaultOutputProfile }, createdAt: '2026-09-23T08:00:00.000Z', updatedAt: '2026-09-23T08:00:00.000Z', issues: [],
  sections: [
    section('设备配置', 20, 1, [
      { id: 'table-a', type: 'table', title: '设备配置', columns: ['设备', '数量', '用途说明'], rows: [['K18 相机', '32 台', '用于完成本项目已确认的动作捕捉采集任务。'], ['同步设备', '1 套', '依据经确认的系统接口实现时钟同步。']], sourceRefs: [] },
      { id: 'paragraph', type: 'paragraph', text: '正文', runs: [{ text: '重要说明：', bold: true }, { text: '客户要求与工程分析结果应分别核对。& < > "' }] },
      { id: 'list', type: 'list', ordered: true, items: ['核对项目需求', '确认设备配置'] },
      { id: 'list-2', type: 'list', items: ['保留来源追溯', '实施前确认接口'] },
    ]),
    section('部署方案', 10, 1, [
      { id: 'p0', type: 'paragraph', text: '本方案说明机器人动作捕捉系统的部署设计、设备组成和实施边界。设备数量与接口要求以经确认的项目事实为依据。' },
      { id: 'asset', type: 'asset', assetId: 'image-one', caption: '相机部署视图' },
      { id: 'asset-2', type: 'asset', assetId: 'image-one', caption: '覆盖分析视图' },
    ]),
    section('参数说明', 30, 2, [{ id: 'table-b', type: 'table', title: '产品参数', columns: ['参数', '值'], rows: [['型号', 'K18'], ['数量', '32 台']], sourceRefs: [] }]),
    section('接口说明', 40, 3, [{ id: 'last', type: 'paragraph', text: '接口与数据链路配置在项目实施前确认，本文不补充未经确认的技术参数。' }]),
  ],
});
const assets = new Map([['image-one', { bytes: png, mimeType: 'image/png' }]]);
const unpack = async (document = proposal()) => JSZip.loadAsync(await exportDocument(document, { assets }));

describe('deterministic native DOCX export', () => {
  it('creates a valid Word package with cover, native headings, TOC and page-number fields', async () => {
    const zip = await unpack();
    const xml = await zip.file('word/document.xml')!.async('string');
    expect(xml).toContain('上海青瞳视觉科技有限公司');
    expect(xml).toContain('机器人动作捕捉系统');
    expect(xml).toContain('测试研究院');
    expect(xml).toContain('2026年09月23日');
    expect(xml).toContain('w:pStyle w:val="Title"');
    for (const level of [1, 2, 3]) expect(xml).toContain(`w:pStyle w:val="Heading${level}"`);
    expect(xml).toContain('TOC \\o "1-3" \\h \\z \\u');
    expect(xml).toContain('w:bookmarkStart');
    expect(xml).toContain('w:numPr');
    expect(xml).toContain('w:pgSz w:w="11906" w:h="16838"');
    expect(await zip.file('word/footer1.xml')!.async('string')).toContain(' PAGE ');
    expect(await zip.file('word/header1.xml')!.async('string')).toContain('技术方案');
    expect(await zip.file('word/settings.xml')!.async('string')).toContain('w:updateFields w:val="true"');
    expect(await zip.file('[Content_Types].xml')!.async('string')).toContain('wordprocessingml.document.main+xml');
  });
  it('embeds image bytes once with internal relationships and accessible captions', async () => {
    const zip = await unpack();
    expect(await zip.file('word/media/image1.png')!.async('nodebuffer')).toEqual(png);
    expect(zip.file('word/media/image2.png')).toBeNull();
    const xml = await zip.file('word/document.xml')!.async('string');
    expect(xml).toContain('r:embed="rIdImage1"');
    expect(xml).toContain('descr="图1-1 相机部署视图"');
    expect(xml).toContain('图1-2 覆盖分析视图');
    const rels = await zip.file('word/_rels/document.xml.rels')!.async('string');
    expect(rels).toContain('Target="media/image1.png"');
    expect(rels).not.toContain('TargetMode="External"');
    expect(Object.keys(zip.files).some(path => path.includes('\\'))).toBe(false);
  });
  it('places an optional project logo on the cover without numbering it or shrinking repeated body images', async () => {
    const document = proposal(); document.outputProfile.coverLogoAssetId = 'image-one';
    const zip = await unpack(document), xml = await zip.file('word/document.xml')!.async('string');
    const title = xml.indexOf('<w:pStyle w:val="Title"/>'), logo = xml.indexOf('descr="上海青瞳视觉科技有限公司 Logo"');
    expect(logo).toBeGreaterThan(0); expect(logo).toBeLessThan(title);
    expect(xml).toContain('图1-1 相机部署视图'); expect(xml).toContain('图1-2 覆盖分析视图');
    expect(xml).not.toContain('图1-3');
    expect(Object.keys(zip.files).filter(path => path.startsWith('word/media/'))).toEqual(['word/media/image1.png']);
    const extents = [...xml.matchAll(/<wp:extent cx="(\d+)" cy="(\d+)"\/>/g)].map(match => [Number(match[1]), Number(match[2])]);
    expect(extents).toHaveLength(3);
    expect(extents[0][0]).toBeLessThanOrEqual(60 * 36000); expect(extents[0][1]).toBeLessThanOrEqual(25 * 36000);
    expect(extents[1][0]).toBeGreaterThan(extents[0][0]); expect(extents[1]).toEqual(extents[2]);
    const drawingIds = [...xml.matchAll(/<wp:docPr id="(\d+)"/g)].map(match => match[1]);
    expect(new Set(drawingIds).size).toBe(drawingIds.length);
    expect(await zip.file('word/_rels/document.xml.rels')!.async('string')).not.toContain('TargetMode="External"');
    expect(await exportDocument(document, { assets })).toEqual(await exportDocument(document, { assets }));
  });
  it('loads a cover-only asset and rejects unavailable or unsupported logos', async () => {
    const document = proposal(); document.outputProfile.coverLogoAssetId = 'cover-only';
    const withLogo = new Map([...assets, ['cover-only', { bytes: png, mimeType: 'image/png' }] as const]);
    const zip = await JSZip.loadAsync(await exportDocument(document, { assets: withLogo }));
    expect(Object.keys(zip.files).filter(path => path.startsWith('word/media/'))).toHaveLength(2);
    expect(await zip.file('word/media/image1.png')!.async('nodebuffer')).toEqual(png);
    await expect(exportDocument(document, { assets })).rejects.toThrow('图片素材 cover-only 不可用');
    await expect(exportDocument(document, { assets: new Map([...assets, ['cover-only', { bytes: Buffer.from('<svg/>'), mimeType: 'image/svg+xml' }]]) })).rejects.toThrow('PNG 或 JPEG');
    document.outputProfile.coverLogoAssetId = 'https://example.test/logo.png';
    await expect(exportDocument(document, { assets })).rejects.toThrow('不可用');
  });
  it('recomputes chapter, figure and table numbering from the latest outline', async () => {
    const document = proposal();
    let xml = await (await unpack(document)).file('word/document.xml')!.async('string');
    expect(xml).toContain('1  章节部署方案');
    expect(xml).toContain('2.1  章节参数说明');
    expect(xml).toContain('2.1.1  章节接口说明');
    expect(xml).toContain('表2-1 设备配置');
    expect(xml).toContain('表2-2 产品参数');
    document.sections[0].order = 5;
    xml = await (await unpack(document)).file('word/document.xml')!.async('string');
    expect(xml).toContain('表1-1 设备配置');
    expect(xml).toContain('图2-1 相机部署视图');
    expect(xml).toContain('表2-1 产品参数');
    expect(xml).not.toContain('表2-2 产品参数');
  });
  it('uses editable tables and list definitions, bold runs, escaped text and independent output styles', async () => {
    const document = proposal();
    document.outputProfile = { ...defaultOutputProfile, companyName: '公司 & Partners', fontFamily: '仿宋', fontSize: 12, titleFontFamily: '微软雅黑', pageMarginMm: 20, header: '专用页眉', footer: '项目文件' };
    const zip = await unpack(document), xml = await zip.file('word/document.xml')!.async('string');
    expect(xml.match(/<w:tbl>/g)).toHaveLength(2);
    expect(xml).toContain('<w:tblHeader/>');
    expect(xml).toContain('w:vAlign w:val="center"');
    expect(xml).toContain('w:color="D9D9D9"');
    expect(xml).not.toContain('w:trHeight');
    expect(xml).toContain('<w:b/><w:bCs/>');
    expect(xml).toContain('&amp; &lt; &gt; &quot;');
    expect(xml).toContain('公司 &amp; Partners');
    const styles = await zip.file('word/styles.xml')!.async('string');
    expect(styles).toContain('w:eastAsia="仿宋"');
    expect(styles).toContain('w:eastAsia="微软雅黑"');
    expect(styles).toContain('w:sz w:val="24"');
    expect(styles).not.toContain('themeColor');
    const numbering = await zip.file('word/numbering.xml')!.async('string');
    expect(numbering).toContain('w:numFmt w:val="bullet"');
    expect(numbering).toContain('w:lvlText w:val="%1.%2.%3"');
    expect(await zip.file('word/header1.xml')!.async('string')).toContain('专用页眉');
    expect(await zip.file('word/footer1.xml')!.async('string')).toContain('项目文件');
  });
  it('rejects unavailable, corrupt or non-raster assets rather than reading paths or URLs', async () => {
    await expect(exportDocument(proposal(), { assets: new Map() })).rejects.toThrow('图片素材');
    await expect(exportDocument(proposal(), { assets: new Map([['image-one', { bytes: Buffer.from('<svg/>'), mimeType: 'image/svg+xml' }]]) })).rejects.toThrow('PNG 或 JPEG');
    await expect(exportDocument(proposal(), { assets: new Map([['image-one', { bytes: Buffer.from('not a png'), mimeType: 'image/png' }]]) })).rejects.toThrow('PNG 或 JPEG');
    const corrupt = Buffer.from(png); corrupt[45] ^= 1;
    await expect(exportDocument(proposal(), { assets: new Map([['image-one', { bytes: corrupt, mimeType: 'image/png' }]]) })).rejects.toThrow('PNG 或 JPEG');
    await expect(exportDocument(proposal(), { assets: new Map([['image-one', { bytes: png.subarray(0, 33), mimeType: 'image/png' }]]) })).rejects.toThrow('PNG 或 JPEG');
    const document = proposal();
    const block = document.sections[1].blocks[1];
    if (block.type === 'asset') block.assetId = 'C:/private/credentials.png';
    await expect(exportDocument(document, { assets })).rejects.toThrow('不可用');
  });
  it('rejects invalid table shapes, profile geometry and skipped heading levels', async () => {
    const document = proposal();
    const block = document.sections[0].blocks[0];
    if (block.type === 'table') block.rows.push(['missing cells']);
    await expect(exportDocument(document, { assets })).rejects.toThrow('行列数量');
    await expect(exportDocument({ ...proposal(), outputProfile: { ...defaultOutputProfile, pageMarginMm: 100 } }, { assets })).rejects.toThrow('页边距');
    const outline = proposal(); outline.sections[1].level = 2;
    await expect(exportDocument(outline, { assets })).rejects.toThrow('标题层级');
  });
  it('is byte-deterministic and leaves caller content untouched', async () => {
    const document = proposal(), snapshot = JSON.stringify(document);
    const first = await exportDocument(document, { assets }), second = await exportDocument(document, { assets });
    expect(first).toEqual(second);
    expect(JSON.stringify(document)).toBe(snapshot);
    if (process.env.DOCX_QA_DIRECTORY) {
      const directory = resolve(process.env.DOCX_QA_DIRECTORY); await mkdir(directory, { recursive: true });
      await writeFile(resolve(directory, 'proposal-export.docx'), first);
    }
  });
  it('exports customer content without internal source evidence, claims or validation diagnostics', async () => {
    const document = proposal();
    document.sections[0].sourceRefs = [{ type: 'knowledge_chunk', id: 'private-source-id', label: 'INTERNAL_SOURCE_LABEL', evidence: 'INTERNAL_SOURCE_EVIDENCE' }];
    document.sections[0].claims = [{ text: 'INTERNAL_CLAIM_REVIEW', factIds: ['private-fact'], sourceIds: ['private-source-id'] }];
    document.issues = [{ id: 'validation', sectionId: document.sections[0].id, severity: 'warning', type: 'missing_source', message: 'INTERNAL_VALIDATION_DIAGNOSTIC', sourceRefs: [] }];
    const xml = await (await unpack(document)).file('word/document.xml')!.async('string');
    for (const value of ['INTERNAL_SOURCE_LABEL', 'INTERNAL_SOURCE_EVIDENCE', 'INTERNAL_CLAIM_REVIEW', 'INTERNAL_VALIDATION_DIAGNOSTIC', 'private-source-id']) expect(xml).not.toContain(value);
    expect(xml).toContain('设备配置');
  });
});
