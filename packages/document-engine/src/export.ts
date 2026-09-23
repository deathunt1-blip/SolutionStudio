import JSZip from 'jszip';
import { resolveTheme, type OutputTheme } from './theme.js';
import { blockHasContent, exportableSections, validateDocumentLayout } from './layout-qa.js';
import { renderMermaidPng } from './diagrams.js';
import { defaultOutputProfile, type DocumentBlock, type GeneratedDocument, type OutputProfile, type TextRun } from './types.js';

export interface ExportAsset { bytes: Buffer; mimeType: string }
export interface ExportOptions { assets: ReadonlyMap<string, ExportAsset> }

const W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
const R = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const PKG_R = 'http://schemas.openxmlformats.org/package/2006/relationships';
const XML = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>';
const zipDate = new Date('2000-01-01T00:00:00.000Z');
const crcTable = Array.from({ length: 256 }, (_, value) => { for (let bit = 0; bit < 8; bit++) value = value & 1 ? 0xEDB88320 ^ value >>> 1 : value >>> 1; return value >>> 0; });
function crc32(bytes: Buffer): number { let crc = 0xFFFFFFFF; for (const byte of bytes) crc = crcTable[(crc ^ byte) & 0xFF] ^ crc >>> 8; return (crc ^ 0xFFFFFFFF) >>> 0; }
const mmToTwips = (mm: number) => Math.round(mm * 1440 / 25.4);
const emuPerMm = 36000;
const escapeXml = (value: string) => value.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\uFFFE\uFFFF]/g, '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');
const text = (value: string) => `<w:t xml:space="preserve">${escapeXml(value)}</w:t>`;
function run(value: string, properties = ''): string {
  return `<w:r>${properties ? `<w:rPr>${properties}</w:rPr>` : ''}${value.split(/\r?\n/).map(text).join('<w:br/>')}</w:r>`;
}
const p = (content = '', properties = '') => `<w:p>${properties ? `<w:pPr>${properties}</w:pPr>` : ''}${content}</w:p>`;
const style = (name: string) => `<w:pStyle w:val="${name}"/>`;
const field = (instruction: string, cached = '') => `<w:r><w:fldChar w:fldCharType="begin"/></w:r><w:r><w:instrText xml:space="preserve"> ${escapeXml(instruction)} </w:instrText></w:r><w:r><w:fldChar w:fldCharType="separate"/></w:r>${run(cached)}<w:r><w:fldChar w:fldCharType="end"/></w:r>`;
function profileOf(profile: OutputProfile): OutputProfile {
  const merged = { ...defaultOutputProfile, ...profile };
  if (!Number.isFinite(merged.fontSize) || merged.fontSize < 8 || merged.fontSize > 18) throw new Error('导出正文字号应在 8 至 18 磅之间');
  if (!Number.isFinite(merged.pageMarginMm) || merged.pageMarginMm < 12 || merged.pageMarginMm > 40) throw new Error('导出页边距应在 12 至 40 毫米之间');
  if (merged.coverLogoAssetId !== undefined && (typeof merged.coverLogoAssetId !== 'string' || merged.coverLogoAssetId.length > 200)) throw new Error('封面 Logo 图片标识无效');
  return merged;
}
function fontProperties(family: string, size: number, bold = false, color = '1E2A25'): string {
  return `<w:rFonts w:ascii="Times New Roman" w:hAnsi="Times New Roman" w:eastAsia="${escapeXml(family)}" w:cs="Times New Roman"/><w:color w:val="${color}"/><w:sz w:val="${Math.round(size * 2)}"/><w:szCs w:val="${Math.round(size * 2)}"/>${bold ? '<w:b/><w:bCs/>' : ''}`;
}
function stylesXml(profile: OutputProfile, theme: OutputTheme, contentWidth: number): string {
  const t = theme.typography, body = fontProperties(t.chineseFont, t.bodySize, false, t.textColor);
  const noIndent = '<w:ind w:firstLine="0" w:firstLineChars="0"/>';
  const paragraphStyle = (id: string, name: string, paragraph: string, properties: string, parent = 'Normal') => `<w:style w:type="paragraph" w:styleId="${id}"${id === 'Normal' ? ' w:default="1"' : ''}><w:name w:val="${name}"/>${id !== 'Normal' ? `<w:basedOn w:val="${parent}"/><w:next w:val="Normal"/>` : ''}<w:qFormat/><w:pPr>${paragraph}</w:pPr><w:rPr>${properties}</w:rPr></w:style>`;
  return XML + `<w:styles xmlns:w="${W}"><w:docDefaults><w:rPrDefault><w:rPr>${body}<w:lang w:val="en-US" w:eastAsia="zh-CN"/></w:rPr></w:rPrDefault></w:docDefaults>`
    + paragraphStyle('Normal', 'Normal', `<w:widowControl/><w:spacing w:after="${t.paragraphAfterPt * 20}" w:line="${t.lineSpacing * 240}" w:lineRule="auto"/><w:ind w:firstLineChars="${t.firstLineCharacters * 100}"/><w:jc w:val="both"/>`, body)
    + paragraphStyle('Title', 'Title', noIndent + '<w:keepNext/><w:keepLines/><w:spacing w:before="1300" w:after="280" w:line="300" w:lineRule="auto"/><w:jc w:val="left"/>', fontProperties(t.headingFont, theme.cover.titleSize, true, t.textColor))
    + theme.headings.map(heading => paragraphStyle(`Heading${heading.level}`, `heading ${heading.level}`, noIndent + `<w:keepNext/><w:keepLines/>${heading.newPage ? '<w:pageBreakBefore/>' : ''}<w:spacing w:before="${heading.level === 1 ? 120 : 260}" w:after="${heading.level === 1 ? 260 : 140}"/><w:jc w:val="left"/><w:outlineLvl w:val="${heading.level - 1}"/>${heading.rule ? `<w:pBdr><w:bottom w:val="single" w:sz="4" w:space="8" w:color="${theme.table.borderColor}"/></w:pBdr>` : ''}`, fontProperties(t.headingFont, heading.size, true, heading.color))).join('')
    + paragraphStyle('TOCHeading', 'TOC Heading', noIndent + '<w:keepNext/><w:spacing w:after="260"/><w:jc w:val="left"/>', fontProperties(t.headingFont, 16, true))
    + [1, 2, 3].map(level => paragraphStyle(`TOC${level}`, `toc ${level}`, `<w:keepNext w:val="0"/><w:spacing w:after="${theme.toc.paragraphAfterPt * 20}" w:line="${theme.toc.lineSpacing * 240}" w:lineRule="auto"/><w:ind w:left="${(level - 1) * 280}" w:firstLine="0" w:firstLineChars="0"/><w:jc w:val="left"/><w:tabs><w:tab w:val="right" w:leader="dot" w:pos="${contentWidth}"/></w:tabs>`, fontProperties(t.chineseFont, theme.toc.fontSize, level === 1))).join('')
    + paragraphStyle('Caption', 'Caption', noIndent + '<w:keepLines/><w:spacing w:before="80" w:after="150" w:line="240" w:lineRule="auto"/><w:jc w:val="center"/>', fontProperties(t.chineseFont, theme.figure.captionSize, false, theme.figure.captionColor))
    + paragraphStyle('TableText', 'Table Text', noIndent + '<w:spacing w:after="40" w:line="270" w:lineRule="auto"/><w:jc w:val="left"/>', fontProperties(t.chineseFont, Math.min(t.bodySize, theme.table.fontSize)))
    + ['Header', 'Footer'].map(id => paragraphStyle(id, id.toLowerCase(), noIndent + `<w:spacing w:after="0" w:line="240"/><w:jc w:val="left"/><w:tabs><w:tab w:val="right" w:pos="${contentWidth}"/></w:tabs>${id === 'Header' ? `<w:pBdr><w:bottom w:val="single" w:sz="4" w:space="5" w:color="${theme.headerFooter.borderColor}"/></w:pBdr>` : ''}`, fontProperties(t.chineseFont, theme.headerFooter.fontSize, false, theme.headerFooter.color))).join('')
    + paragraphStyle('Callout', 'Design note', `<w:keepLines/><w:spacing w:before="140" w:after="160"/><w:ind w:left="180" w:right="120" w:firstLine="0" w:firstLineChars="0"/><w:shd w:fill="${theme.callout.fill}"/><w:pBdr><w:left w:val="single" w:sz="16" w:space="8" w:color="${theme.callout.borderColor}"/></w:pBdr>`, body)
    + '</w:styles>';
}
function numberingXml(listCount: number, theme: OutputTheme): string {
  const headingLevels = [0, 1, 2].map(level => `<w:lvl w:ilvl="${level}"><w:start w:val="1"/><w:numFmt w:val="${level === 0 ? 'decimalZero' : 'decimal'}"/>${level > 0 ? '<w:isLgl/>' : ''}<w:lvlText w:val="${Array.from({ length: level + 1 }, (_, i) => `%${i + 1}`).join('.')}"/><w:suff w:val="space"/><w:lvlJc w:val="left"/>${level === 0 ? `<w:rPr><w:color w:val="${theme.cover.accentColor}"/></w:rPr>` : ''}</w:lvl>`).join('');
  const listAbstract = (id: number, ordered: boolean) => `<w:abstractNum w:abstractNumId="${id}"><w:multiLevelType w:val="singleLevel"/><w:lvl w:ilvl="0"><w:start w:val="1"/><w:numFmt w:val="${ordered ? 'decimal' : 'bullet'}"/><w:lvlText w:val="${ordered ? '%1.' : '•'}"/><w:lvlJc w:val="left"/><w:pPr><w:tabs><w:tab w:val="num" w:pos="420"/></w:tabs><w:ind w:left="420" w:hanging="260"/></w:pPr></w:lvl></w:abstractNum>`;
  return XML + `<w:numbering xmlns:w="${W}"><w:abstractNum w:abstractNumId="0"><w:multiLevelType w:val="multilevel"/>${headingLevels}</w:abstractNum>${listAbstract(1, false)}${listAbstract(2, true)}<w:num w:numId="1"><w:abstractNumId w:val="0"/></w:num>`
    + Array.from({ length: listCount }, (_, index) => [false, true].map((ordered, offset) => `<w:num w:numId="${2 + index * 2 + offset}"><w:abstractNumId w:val="${ordered ? 2 : 1}"/><w:lvlOverride w:ilvl="0"><w:startOverride w:val="1"/></w:lvlOverride></w:num>`).join('')).join('') + '</w:numbering>';
}
function imageDimensions(asset: ExportAsset): { width: number; height: number; extension: 'png' | 'jpg'; mimeType: string } {
  const bytes = asset.bytes;
  if (!Buffer.isBuffer(bytes) || bytes.length === 0 || bytes.length > 20 * 1024 * 1024) throw new Error('导出图片为空或超过 20 MB');
  if (asset.mimeType === 'image/png' && bytes.length >= 33 && bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) && bytes.toString('ascii', 12, 16) === 'IHDR') {
    const width = bytes.readUInt32BE(16), height = bytes.readUInt32BE(20);
    let offset = 8, sawData = false, valid = false;
    while (offset + 12 <= bytes.length) {
      const length = bytes.readUInt32BE(offset), end = offset + 12 + length;
      if (end > bytes.length || crc32(bytes.subarray(offset + 4, end - 4)) !== bytes.readUInt32BE(end - 4)) break;
      const type = bytes.toString('ascii', offset + 4, offset + 8);
      if (type === 'IDAT') sawData = true;
      if (type === 'IEND') { valid = length === 0 && end === bytes.length && sawData; break; }
      offset = end;
    }
    if (valid && width > 0 && height > 0 && width <= 50000 && height <= 50000 && width * height <= 80000000) return { width, height, extension: 'png', mimeType: 'image/png' };
  }
  if (['image/jpeg', 'image/jpg'].includes(asset.mimeType) && bytes[0] === 0xFF && bytes[1] === 0xD8) {
    let offset = 2;
    while (offset + 4 <= bytes.length) {
      if (bytes[offset++] !== 0xFF) break;
      while (bytes[offset] === 0xFF) offset++;
      if (offset + 3 > bytes.length) break;
      const marker = bytes[offset++];
      if (marker === 0xD9 || marker === 0xDA) break;
      if (marker === 0x01 || (marker >= 0xD0 && marker <= 0xD7)) continue;
      const size = bytes.readUInt16BE(offset);
      if (size < 2 || offset + size > bytes.length) break;
      if ([0xC0, 0xC1, 0xC2, 0xC3, 0xC5, 0xC6, 0xC7, 0xC9, 0xCA, 0xCB, 0xCD, 0xCE, 0xCF].includes(marker) && size >= 8) {
        const height = bytes.readUInt16BE(offset + 3), width = bytes.readUInt16BE(offset + 5);
        if (width && height && width * height <= 80000000 && bytes[bytes.length - 2] === 0xFF && bytes[bytes.length - 1] === 0xD9) return { width, height, extension: 'jpg', mimeType: 'image/jpeg' };
      }
      offset += size;
    }
  }
  throw new Error('导出仅支持有效 PNG 或 JPEG 图片，请重新上传图片素材');
}
function drawing(relationshipId: string, id: number, caption: string, width: number, height: number): string {
  const extent = `<wp:extent cx="${width}" cy="${height}"/>`;
  return `<w:r><w:drawing><wp:inline distT="0" distB="0" distL="0" distR="0">${extent}<wp:docPr id="${id}" name="Figure ${id}" descr="${escapeXml(caption)}"/><wp:cNvGraphicFramePr><a:graphicFrameLocks noChangeAspect="1"/></wp:cNvGraphicFramePr><a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:pic><pic:nvPicPr><pic:cNvPr id="${id}" name="Figure ${id}" descr="${escapeXml(caption)}"/><pic:cNvPicPr/></pic:nvPicPr><pic:blipFill><a:blip r:embed="${relationshipId}"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill><pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="${width}" cy="${height}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr></pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing></w:r>`;
}
function tableXml(block: Extract<DocumentBlock, { type: 'table' }>, width: number, theme: OutputTheme): string {
  if (!block.columns.length || block.columns.length > 24 || block.rows.length > 10000) throw new Error('导出表格须有 1 至 24 列，且不超过 10000 行');
  if (block.rows.some(row => row.length !== block.columns.length)) throw new Error(`表格「${block.title}」行列数量不一致`);
  const weights = block.columns.map((column, index) => {
    const cells = block.rows.slice(0, 100).map(row => row[index]);
    const length = Math.max(column.length, ...cells.map(cell => cell.length));
    return Math.max(4, Math.min(30, Math.sqrt(length) * 3));
  });
  const total = weights.reduce((sum, value) => sum + value, 0);
  const widths = weights.map(value => Math.floor(width * value / total));
  widths[widths.length - 1] += width - widths.reduce((sum, value) => sum + value, 0);
  const borders = ['top', 'left', 'bottom', 'right', 'insideH', 'insideV'].map(side => `<w:${side} w:val="single" w:sz="4" w:color="${theme.table.borderColor}"/>`).join('');
  const row = (values: string[], index: number) => `<w:tr>${index === 0 ? '<w:trPr><w:tblHeader/></w:trPr>' : ''}${values.map((value, column) => {
    const center = value.length <= 12 && (column === 0 || /^[\d\s.,%±≤≥×x:/()\-a-zA-Zµμ°]+$/.test(value));
    return `<w:tc><w:tcPr><w:tcW w:w="${widths[column]}" w:type="dxa"/><w:vAlign w:val="center"/>${index === 0 ? `<w:shd w:fill="${theme.table.headerFill}"/>` : ''}</w:tcPr>${p(run(value, index === 0 ? '<w:b/>' : ''), style('TableText') + (index === 0 ? '<w:jc w:val="left"/>' : center ? '<w:jc w:val="center"/>' : '<w:jc w:val="left"/>'))}</w:tc>`;
  }).join('')}</w:tr>`;
  return `<w:tbl><w:tblPr><w:tblW w:w="${width}" w:type="dxa"/><w:tblLayout w:type="fixed"/><w:tblBorders>${borders}</w:tblBorders><w:tblCellMar><w:top w:w="${theme.table.cellPaddingTwips}" w:type="dxa"/><w:left w:w="120" w:type="dxa"/><w:bottom w:w="${theme.table.cellPaddingTwips}" w:type="dxa"/><w:right w:w="120" w:type="dxa"/></w:tblCellMar></w:tblPr><w:tblGrid>${widths.map(value => `<w:gridCol w:w="${value}"/>`).join('')}</w:tblGrid>${row(block.columns, 0)}${block.rows.map((values, i) => row(values, i + 1)).join('')}</w:tbl>`;
}
function blockRuns(block: Extract<DocumentBlock, { type: 'paragraph' | 'heading' }>): string {
  const runs: TextRun[] = block.runs?.length ? block.runs : [{ text: block.text }];
  return runs.map(item => run(item.text, item.bold ? '<w:b/><w:bCs/>' : '')).join('');
}

/** Deterministic OOXML export. Asset bytes are supplied by the authorized project
 * asset loader; this module never reads a path, fetches a URL or invokes a model. */
export async function exportDocument(document: GeneratedDocument, options: ExportOptions = { assets: new Map() }): Promise<Buffer> {
  if (!document.sections.length || document.sections.length > 500) throw new Error('导出方案须有 1 至 500 个章节');
  const profile = profileOf(document.outputProfile), theme = resolveTheme(profile);
  const sections = exportableSections(document);
  const errors = validateDocumentLayout(document).filter(issue => issue.severity === 'error');
  if (errors.length) throw new Error(errors[0].message);
  if (!sections.length) throw new Error('方案没有可导出的已确认内容');
  const exportAssets = new Map(options.assets);
  let priorLevel = 0;
  for (const section of sections) {
    if (![1, 2, 3].includes(section.level) || section.level > priorLevel + 1) throw new Error(`章节「${section.title}」的标题层级不连续，请先调整目录`);
    priorLevel = section.level;
  }
  const zip = new JSZip();
  const put = (path: string, data: string | Buffer) => zip.file(path, data, { date: zipDate, createFolders: false });
  const margin = mmToTwips(profile.pageMarginMm), pageWidth = mmToTwips(210), pageHeight = mmToTwips(297), contentWidth = pageWidth - margin * 2;
  const pageSetup = `<w:pgSz w:w="${pageWidth}" w:h="${pageHeight}"/><w:pgMar w:top="${margin}" w:right="${margin}" w:bottom="${margin}" w:left="${margin}" w:header="${mmToTwips(12)}" w:footer="${mmToTwips(12)}" w:gutter="0"/>`;
  const metaDate = new Date(document.updatedAt || document.createdAt);
  if (Number.isNaN(metaDate.valueOf())) throw new Error('文档日期无效，无法生成导出封面');
  const dateParts = new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(metaDate);
  const datePart = (type: string) => dateParts.find(part => part.type === type)?.value;
  const dateLabel = `${datePart('year')}年${datePart('month')}月${datePart('day')}日`;
  const title = document.title || `${document.projectName}技术方案`;
  const centered = '<w:jc w:val="center"/>';
  let figures = 0, tables = 0, listCount = 0, imageId = 0, blockCount = 0, totalAssetBytes = 0;
  const imageRelationships: string[] = [], mediaTypes = new Map<string, string>();
  const imageCache = new Map<string, { relationship: string; width: number; height: number }>();
  const embedImage = (assetId: string, maximumWidth: number, maximumHeight: number) => {
    let embedded = imageCache.get(assetId);
    if (!embedded) {
      const asset = exportAssets.get(assetId);
      if (!asset) throw new Error(`图片素材 ${assetId} 不可用，导出已停止`);
      const dimensions = imageDimensions(asset);
      if ((totalAssetBytes += asset.bytes.length) > 80 * 1024 * 1024) throw new Error('导出图片总大小超过 80 MB');
      const index = imageCache.size + 1, relationship = `rIdImage${index}`;
      embedded = { relationship, width: dimensions.width * 9525, height: dimensions.height * 9525 };
      imageCache.set(assetId, embedded);
      put(`word/media/image${index}.${dimensions.extension}`, asset.bytes);
      imageRelationships.push(`<Relationship Id="${relationship}" Type="${R}/image" Target="media/image${index}.${dimensions.extension}"/>`);
      mediaTypes.set(dimensions.extension, dimensions.mimeType);
    }
    const scale = Math.min(1, maximumWidth / embedded.width, maximumHeight / embedded.height);
    return { relationship: embedded.relationship, width: Math.round(embedded.width * scale), height: Math.round(embedded.height * scale) };
  };
  const noIndent = '<w:ind w:firstLine="0" w:firstLineChars="0"/>';
  const left = noIndent + '<w:jc w:val="left"/>';
  let coverLogo = '';
  if (profile.coverLogoAssetId) {
    const logo = embedImage(profile.coverLogoAssetId, Math.min(theme.cover.logoMaxWidthMm, 210 - 2 * profile.pageMarginMm) * emuPerMm, theme.cover.logoMaxHeightMm * emuPerMm);
    coverLogo = p(drawing(logo.relationship, ++imageId, `${profile.companyName} Logo`, logo.width, logo.height), left + '<w:keepNext/><w:spacing w:after="240"/>');
  } else coverLogo = p(run(profile.companyName, fontProperties(profile.fontFamily, 10, false, theme.typography.secondaryColor)), left + '<w:spacing w:after="480"/>');
  const coverProjectTitle = title.replace(/(?:技术方案|方案)$/, '').trim() || document.projectName;
  const cover = coverLogo + p(run(coverProjectTitle), style('Title'))
    + p(run('技术方案', fontProperties(profile.titleFontFamily, theme.cover.subtitleSize, false, theme.cover.accentColor)), left + `<w:keepNext/><w:spacing w:after="1400"/><w:pBdr><w:left w:val="single" w:sz="16" w:space="10" w:color="${theme.cover.accentColor}"/></w:pBdr>`)
    + (document.customerName ? p(run(`客户名称  ${document.customerName}`, fontProperties(profile.fontFamily, 11)), left + '<w:keepNext/>') : '')
    + p(run(`编制单位  ${profile.companyName}`, fontProperties(profile.fontFamily, 11)), left + '<w:keepNext/>')
    + p(run(`编制日期  ${dateLabel}`, fontProperties(profile.fontFamily, 11)), left)
    + p('', `<w:sectPr><w:type w:val="nextPage"/>${pageSetup}</w:sectPr>`);
  const sectionNumbers = [0, 0, 0];
  const toc: string[] = [], body: string[] = [];
  for (const [sectionIndex, section] of sections.entries()) {
    sectionNumbers[section.level - 1]++;
    for (let index = section.level; index < 3; index++) sectionNumbers[index] = 0;
    if (section.level === 1) { figures = 0; tables = 0; }
    const number = sectionNumbers.slice(0, section.level).join('.'), chapter = sectionNumbers[0];
    const bookmark = `Section_${sectionIndex + 1}`;
    toc.push(p(`<w:hyperlink w:anchor="${bookmark}" w:history="1">${run(`${number}  ${section.title}`)}</w:hyperlink><w:r><w:tab/></w:r>${field(`PAGEREF ${bookmark} \\h`, '')}`, style(`TOC${section.level}`)));
    body.push(p(`<w:bookmarkStart w:id="${sectionIndex + 1}" w:name="${bookmark}"/>${run(section.title)}<w:bookmarkEnd w:id="${sectionIndex + 1}"/>`, style(`Heading${section.level}`) + `<w:numPr><w:ilvl w:val="${section.level - 1}"/><w:numId w:val="1"/></w:numPr>`));
    for (const block of section.blocks) {
      if (!blockHasContent(block)) continue;
      if (++blockCount > 20000) throw new Error('导出内容块超过 20000 个');
      if (block.type === 'paragraph') body.push(p(blockRuns(block)));
      else if (block.type === 'heading') body.push(p(blockRuns(block), style(`Heading${Math.max(2, Math.min(3, block.level ?? Math.min(3, section.level + 1)))}`)));
      else if (block.type === 'list') {
        const listId = 2 + listCount++ * 2 + (block.ordered ? 1 : 0);
        for (const item of block.items) body.push(p(run(item), `<w:numPr><w:ilvl w:val="0"/><w:numId w:val="${listId}"/></w:numPr><w:ind w:left="420" w:hanging="260" w:firstLineChars="0"/>`));
      } else if (block.type === 'table') {
        const caption = `表${chapter}-${++tables}${block.title ? ` ${block.title}` : ''}`;
        body.push(p(run(caption), style('Caption') + '<w:keepNext/>'), tableXml(block, contentWidth, theme), p('', '<w:spacing w:after="60" w:line="100" w:lineRule="exact"/>'));
      } else if (block.type === 'callout') {
        body.push(p(run(`${block.kind}  `, '<w:b/>') + run(block.text), style('Callout')));
      } else if (block.type === 'asset' || block.type === 'diagram') {
        const assetId = block.type === 'asset' ? block.assetId : `diagram:${section.id}:${block.id}`;
        if (block.type === 'diagram') exportAssets.set(assetId, { bytes: await renderMermaidPng(block.source), mimeType: 'image/png' });
        const caption = `图${chapter}-${++figures}${block.caption ? ` ${block.caption}` : ''}`;
        const embedded = embedImage(assetId, (210 - 2 * profile.pageMarginMm) * theme.figure.maximumWidthRatio * emuPerMm, Math.min(theme.figure.maximumHeightMm, 297 - 2 * profile.pageMarginMm - 45) * emuPerMm);
        body.push(p(drawing(embedded.relationship, ++imageId, caption, embedded.width, embedded.height), noIndent + '<w:keepNext/>' + centered), p(run(caption), style('Caption')));
      } else throw new Error('文档包含不支持的内容块');
    }
  }
  const tocField = p('<w:r><w:fldChar w:fldCharType="begin" w:dirty="true"/></w:r><w:r><w:instrText xml:space="preserve"> TOC \\o "1-3" \\h \\z \\u </w:instrText></w:r><w:r><w:fldChar w:fldCharType="separate"/></w:r>') + toc.join('') + p('<w:r><w:fldChar w:fldCharType="end"/></w:r>');
  // Continue physical page numbering so PAGE and NUMPAGES agree on the final page.
  // The cover has no displayed header/footer, but remains part of the document.
  const sectionProperties = `<w:sectPr><w:headerReference w:type="default" r:id="rIdHeader"/><w:footerReference w:type="default" r:id="rIdFooter"/>${pageSetup}</w:sectPr>`;
  const documentXml = XML + `<w:document xmlns:w="${W}" xmlns:r="${R}" xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture"><w:body>${cover}${p(run('目录'), style('TOCHeading'))}${tocField}${body.join('')}${sectionProperties}</w:body></w:document>`;
  if (Buffer.byteLength(documentXml) > 32 * 1024 * 1024) throw new Error('导出正文超过 32 MB');
  put('word/document.xml', documentXml);
  put('word/styles.xml', stylesXml(profile, theme, contentWidth));
  put('word/numbering.xml', numberingXml(listCount, theme));
  put('word/settings.xml', XML + `<w:settings xmlns:w="${W}"><w:updateFields w:val="true"/><w:defaultTabStop w:val="420"/><w:compat><w:compatSetting w:name="compatibilityMode" w:uri="http://schemas.microsoft.com/office/word" w:val="15"/></w:compat></w:settings>`);
  put('word/header1.xml', XML + `<w:hdr xmlns:w="${W}">${p(run(document.projectName.slice(0, 32)) + '<w:r><w:tab/></w:r>' + run(profile.header || '技术方案'), style('Header'))}</w:hdr>`);
  put('word/footer1.xml', XML + `<w:ftr xmlns:w="${W}">${p(run(profile.footer || profile.companyName) + '<w:r><w:tab/></w:r>' + field('PAGE', '1') + run(' / ') + field('NUMPAGES', ''), style('Footer'))}</w:ftr>`);
  put('word/_rels/document.xml.rels', XML + `<Relationships xmlns="${PKG_R}">${[['rIdStyles', 'styles', 'styles.xml'], ['rIdNumbering', 'numbering', 'numbering.xml'], ['rIdSettings', 'settings', 'settings.xml'], ['rIdHeader', 'header', 'header1.xml'], ['rIdFooter', 'footer', 'footer1.xml']].map(([id, type, target]) => `<Relationship Id="${id}" Type="${R}/${type}" Target="${target}"/>`).join('')}${imageRelationships.join('')}</Relationships>`);
  put('_rels/.rels', XML + `<Relationships xmlns="${PKG_R}"><Relationship Id="rIdDocument" Type="${R}/officeDocument" Target="word/document.xml"/><Relationship Id="rIdCore" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/></Relationships>`);
  put('docProps/core.xml', XML + `<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"><dc:title>${escapeXml(title)}</dc:title><dc:creator>${escapeXml(profile.companyName)}</dc:creator><cp:lastModifiedBy>${escapeXml(profile.companyName)}</cp:lastModifiedBy><dcterms:created xsi:type="dcterms:W3CDTF">${metaDate.toISOString()}</dcterms:created><dcterms:modified xsi:type="dcterms:W3CDTF">${metaDate.toISOString()}</dcterms:modified></cp:coreProperties>`);
  const overrides = [
    ['word/document.xml', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml'],
    ['word/styles.xml', 'application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml'],
    ['word/numbering.xml', 'application/vnd.openxmlformats-officedocument.wordprocessingml.numbering+xml'],
    ['word/settings.xml', 'application/vnd.openxmlformats-officedocument.wordprocessingml.settings+xml'],
    ['word/header1.xml', 'application/vnd.openxmlformats-officedocument.wordprocessingml.header+xml'],
    ['word/footer1.xml', 'application/vnd.openxmlformats-officedocument.wordprocessingml.footer+xml'],
    ['docProps/core.xml', 'application/vnd.openxmlformats-package.core-properties+xml'],
  ];
  put('[Content_Types].xml', XML + `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/>${[...mediaTypes].map(([extension, mime]) => `<Default Extension="${extension}" ContentType="${mime}"/>`).join('')}${overrides.map(([part, type]) => `<Override PartName="/${part}" ContentType="${type}"/>`).join('')}</Types>`);
  return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE', compressionOptions: { level: 6 }, platform: 'DOS' });
}
