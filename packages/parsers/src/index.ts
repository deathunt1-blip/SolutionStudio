import path from 'node:path';
import mammoth from 'mammoth';
import { load } from 'cheerio';
import * as XLSX from 'xlsx';
import type { DocumentParser, ParsedBlock, ParsedDocument, ParsedTable, SourceDocumentMeta, SourceFile } from '../../core/src/types.js';

const clean = (text: string) => text.replace(/\u0000/g, '').replace(/\r\n?/g, '\n').trim();
const extension = (meta: SourceDocumentMeta) => path.extname(meta.filename).toLowerCase();
function result(blocks: ParsedBlock[], tables: ParsedTable[] = [], metadata: Record<string, unknown> = {}, warnings: string[] = []): ParsedDocument {
  const filtered = blocks.filter(block => block.text.trim());
  let headings: string[] = [];
  for (const block of filtered) {
    if (block.type === 'heading') { const depth = Math.max(1, block.level ?? 1); headings = headings.slice(0, depth - 1); headings.push(block.text); }
    block.headingPath = [...headings];
  }
  const plainText = filtered.map(block => block.text).join('\n\n');
  return { title: filtered.find(block => block.type === 'heading')?.text, plainText, blocks: filtered, tables, metadata, parseWarnings: warnings,
    parseStatus: !plainText.trim() ? 'failed' : warnings.length ? 'partial' : 'success' };
}

function decodeText(buffer: Uint8Array): { text: string; warnings: string[] } {
  if (buffer[0] === 0xff && buffer[1] === 0xfe) return { text: clean(new TextDecoder('utf-16le').decode(buffer)), warnings: [] };
  if (buffer[0] === 0xfe && buffer[1] === 0xff) return { text: clean(new TextDecoder('utf-16be').decode(buffer)), warnings: [] };
  try { return { text: clean(new TextDecoder('utf-8', { fatal: true }).decode(buffer)), warnings: [] }; }
  catch { return { text: clean(new TextDecoder('gb18030').decode(buffer)), warnings: ['文件非 UTF-8，已按 GB18030 解码；请检查文字是否正确。'] }; }
}

function textBlocks(text: string, markdown: boolean): { blocks: ParsedBlock[]; tables: ParsedTable[] } {
  const lines = text.split('\n'), blocks: ParsedBlock[] = [], tables: ParsedTable[] = [];
  let paragraph: string[] = [], fenced = false;
  const flush = () => { if (paragraph.length) { blocks.push({ type: 'paragraph', text: paragraph.join('\n').trim() }); paragraph = []; } };
  const splitRow = (line: string) => line.replace(/^\s*\|/, '').replace(/\|\s*$/, '').split(/(?<!\\)\|/).map(cell => cell.trim().replace(/\\\|/g, '|'));
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (markdown && /^\s*(```|~~~)/.test(line)) { paragraph.push(line); fenced = !fenced; continue; }
    if (fenced) { paragraph.push(line); continue; }
    const heading = markdown ? line.match(/^(#{1,6})\s+(.+?)\s*#*$/) : null;
    if (heading) { flush(); blocks.push({ type: 'heading', text: heading[2]!, level: heading[1]!.length }); continue; }
    if (markdown && line.trim() && /^(?:={3,}|-{3,})\s*$/.test(lines[i + 1] ?? '')) { flush(); blocks.push({ type: 'heading', text: line.trim(), level: lines[++i]!.startsWith('=') ? 1 : 2 }); continue; }
    if (markdown && line.includes('|') && /^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)+\|?\s*$/.test(lines[i + 1] ?? '')) {
      flush(); const rows = [splitRow(line)]; i += 2;
      while (i < lines.length && lines[i]!.includes('|') && lines[i]!.trim()) { rows.push(splitRow(lines[i]!)); i++; }
      i--; tables.push({ rows }); blocks.push({ type: 'table', text: rows.map(row => row.join(' | ')).join('\n') }); continue;
    }
    if (!line.trim()) flush(); else paragraph.push(line);
  }
  flush(); return { blocks, tables };
}

export class TextParser implements DocumentParser {
  type = 'text'; supports(meta: SourceDocumentMeta) { return ['.txt', '.md', '.markdown'].includes(extension(meta)); }
  async parse(file: SourceFile) {
    if (file.buffer.subarray(0, 8192).includes(0) && ![0xff, 0xfe].includes(file.buffer[0]!)) return result([], [], {}, ['文本文件含有二进制内容，无法安全解析。']);
    const { text, warnings } = decodeText(file.buffer);
    const { blocks, tables } = textBlocks(text, extension(file.meta) !== '.txt');
    if (!text) warnings.push('文件没有可读取的文本。');
    return result(blocks, tables, { format: extension(file.meta).slice(1) }, warnings);
  }
}

export class DOCXParser implements DocumentParser {
  type = 'docx'; supports(meta: SourceDocumentMeta) { return extension(meta) === '.docx'; }
  async parse(file: SourceFile) {
    const converted = await mammoth.convertToHtml({ buffer: Buffer.from(file.buffer) }, { convertImage: mammoth.images.imgElement(() => Promise.resolve({ src: '' })) });
    const $ = load(converted.value), blocks: ParsedBlock[] = [], tables: ParsedTable[] = [];
    $('h1,h2,h3,h4,h5,h6,p,li,table').each((_index, node) => {
      if ($(node).parents('table').length || ($(node).is('p') && $(node).parents('li').length)) return;
      const tag = node.tagName;
      if (tag === 'table') {
        const rows: string[][] = [];
        $(node).find('tr').each((_row, tr) => { const cells: string[] = []; $(tr).children('td,th').each((_cell, td) => { cells.push(clean($(td).text())); }); rows.push(cells); });
        tables.push({ rows }); blocks.push({ type: 'table', text: rows.map(row => row.join(' | ')).join('\n') });
      } else { const text = clean($(node).text()); if (text) blocks.push({ type: /^h\d$/.test(tag) ? 'heading' : 'paragraph', text, ...(/^h\d$/.test(tag) ? { level: Number(tag[1]) } : {}) }); }
    });
    const warnings = converted.messages.map(message => `DOCX: ${message.message.slice(0, 300)}`);
    if (!blocks.length) warnings.push('DOCX 没有可读取的正文；嵌入图片或扫描页需要 OCR。');
    if ($('img').length) warnings.push(`文档包含 ${$('img').length} 张图片；当前仅解析文字与表格，未运行 OCR。`);
    return result(blocks, tables, { format: 'docx', imageCount: $('img').length }, warnings);
  }
}

export class ExcelParser implements DocumentParser {
  type = 'spreadsheet'; supports(meta: SourceDocumentMeta) { return ['.xlsx', '.xls', '.csv'].includes(extension(meta)); }
  async parse(file: SourceFile) {
    const warnings: string[] = [];
    let workbook: XLSX.WorkBook;
    if (extension(file.meta) === '.csv') { const decoded = decodeText(file.buffer); warnings.push(...decoded.warnings); workbook = XLSX.read(decoded.text, { type: 'string', raw: true }); }
    else workbook = XLSX.read(file.buffer, { type: 'array', cellDates: true, cellFormula: true });
    const blocks: ParsedBlock[] = [], tables: ParsedTable[] = [];
    for (const name of workbook.SheetNames) {
      const sheet = workbook.Sheets[name]!;
      const rows = XLSX.utils.sheet_to_json<unknown[]>(sheet, { header: 1, raw: false, defval: '', blankrows: false }).map(row => row.map(cell => String(cell ?? '')));
      if (!rows.length) continue;
      blocks.push({ type: 'heading', text: name, level: 1 });
      tables.push({ title: name, rows });
      blocks.push({ type: 'table', text: rows.map(row => row.join(' | ')).join('\n') });
      if (Object.entries(sheet).some(([key, value]) => !key.startsWith('!') && value?.f && value?.v === undefined)) warnings.push(`工作表“${name}”包含没有缓存值的公式；未计算公式结果。`);
    }
    if (!blocks.length) warnings.push('电子表格没有可读取的单元格。');
    return result(blocks, tables, { format: extension(file.meta).slice(1), sheetNames: workbook.SheetNames }, warnings);
  }
}

export class PDFParser implements DocumentParser {
  type = 'pdf'; supports(meta: SourceDocumentMeta) { return extension(meta) === '.pdf'; }
  async parse(file: SourceFile) {
    const { getDocument } = await import('pdfjs-dist/legacy/build/pdf.mjs');
    const task = getDocument({ data: Uint8Array.from(file.buffer), useSystemFonts: true, verbosity: 0 });
    const document = await task.promise, blocks: ParsedBlock[] = [], warnings: string[] = [];
    try {
      for (let pageNumber = 1; pageNumber <= document.numPages; pageNumber++) {
        try {
          const page = await document.getPage(pageNumber), content = await page.getTextContent();
          const lines: string[] = []; let current = '', previousY: number | undefined;
          for (const item of content.items) {
            if (!('str' in item)) continue;
            const y = item.transform[5] as number;
            if (previousY !== undefined && Math.abs(y - previousY) > 3 && current.trim()) { lines.push(current.trim()); current = ''; }
            const cjkBoundary = /[\p{Script=Han}]$/u.test(current) || /^[\p{Script=Han}]/u.test(item.str);
            current += `${current && !/\s$/.test(current) && !cjkBoundary ? ' ' : ''}${item.str}`; previousY = y;
            if (item.hasEOL) { lines.push(current.trim()); current = ''; previousY = undefined; }
          }
          if (current.trim()) lines.push(current.trim());
          const pageText = clean(lines.join('\n'));
          if (!pageText) warnings.push(`PDF 第 ${pageNumber} 页无可提取文本，可能是扫描页或空白页；未运行 OCR。`);
          else for (const text of pageText.split(/\n\s*\n/).filter(Boolean)) blocks.push({ type: 'paragraph', text, page: pageNumber });
          page.cleanup();
        } catch { warnings.push(`PDF 第 ${pageNumber} 页解析失败，已保留其他页面内容。`); }
      }
      const metadata = await document.getMetadata().catch(() => null);
      const parsed = result(blocks, [], { format: 'pdf', pageCount: document.numPages, pdfInfo: metadata?.info ?? {} }, warnings);
      const title = (metadata?.info as { Title?: unknown } | undefined)?.Title;
      if (typeof title === 'string' && title.trim()) parsed.title = title.trim();
      if (!parsed.plainText) parsed.parseWarnings.push('PDF 没有可索引文字，扫描件需要外部 OCR 后重新导入。');
      return parsed;
    } finally { await task.destroy(); }
  }
}

/** Register additional parsers at the boundary; the ingestion pipeline only uses this registry. */
export const parserRegistry: DocumentParser[] = [new DOCXParser(), new PDFParser(), new ExcelParser(), new TextParser()];
export async function parseDocument(file: SourceFile): Promise<ParsedDocument> {
  const parser = parserRegistry.find(candidate => candidate.supports(file.meta));
  if (!parser) return result([], [], {}, [`不支持的文件格式：${extension(file.meta) || '无扩展名'}。`]);
  if (!file.buffer.length) return result([], [], { parser: parser.type }, ['文件为空，无法解析。']);
  try { const parsed = await parser.parse(file); parsed.metadata.parser = parser.type; return parsed; }
  catch { return result([], [], { parser: parser.type }, [`${parser.type.toUpperCase()} 解析失败：文件可能损坏、加密或格式与扩展名不一致。`]); }
}
