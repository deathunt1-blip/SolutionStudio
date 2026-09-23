import type { DocumentBlock, DocumentSection, GeneratedDocument } from './types.js';

export interface LayoutIssue { severity: 'error' | 'warning'; code: 'empty_heading' | 'empty_section' | 'heading_order' | 'table_shape' | 'wide_table' | 'missing_caption' | 'internal_content'; sectionId: string; blockId?: string; message: string }
export function blockHasContent(block: DocumentBlock): boolean {
  if (block.type === 'paragraph' || block.type === 'heading' || block.type === 'callout') return !!block.text.trim();
  if (block.type === 'list') return block.items.some(item => item.trim());
  if (block.type === 'table') return !!block.rows.length;
  return block.type === 'diagram' ? !!block.source.trim() : block.type === 'asset' ? !!block.assetId : false;
}
const metricHeading = /^(?:关键|主要)?技术指标(?:要求)?$/;
/** Older proposals sometimes contain only an internal question list in this section.
 * Suppress that legacy placeholder, but never silently rewrite customer paragraphs. */
export function exportableSections(document: GeneratedDocument): DocumentSection[] {
  const sections = [...document.sections].sort((a, b) => a.order - b.order || a.id.localeCompare(b.id)).map(section => {
    if (!metricHeading.test(section.title.trim())) return section;
    const blocks = section.blocks.map(block => block.type === 'list' ? { ...block, items: block.items.filter(item => !/尚未明确|待(?:客户)?确认|未提供|不清楚/.test(item)) } : block)
      .filter(block => !(block.type === 'paragraph' && /以下需求尚待客户确认|暂无(?:已确认)?(?:技术)?指标|尚无已确认/.test(block.text)))
      .filter(blockHasContent);
    return { ...section, blocks };
  });
  return sections.filter((section, index) => {
    if (!metricHeading.test(section.title.trim())) return true;
    const hasChildren = !!sections[index + 1] && sections[index + 1].level > section.level;
    if (hasChildren) return true;
    return section.blocks.some(block => {
      if (!blockHasContent(block)) return false;
      if (block.type === 'heading') return false;
      if (block.type === 'list') return block.items.some(item => !/尚未明确|待(?:客户)?确认|未提供|不清楚/.test(item));
      if (block.type === 'paragraph') return !/以下需求尚待客户确认|暂无(?:已确认)?(?:技术)?指标|尚无已确认/.test(block.text);
      return true;
    });
  });
}

/** Structural preflight only. Pagination/overlap require a real DOCX renderer. */
export function validateDocumentLayout(document: GeneratedDocument): LayoutIssue[] {
  const issues: LayoutIssue[] = []; let priorLevel = 0;
  for (const section of exportableSections(document)) {
    const add = (code: LayoutIssue['code'], message: string, severity: LayoutIssue['severity'] = 'warning', blockId?: string) => issues.push({ code, message, severity, sectionId: section.id, ...(blockId ? { blockId } : {}) });
    if (!section.title.trim()) add('empty_heading', '章节标题为空', 'error');
    if (![1, 2, 3].includes(section.level) || section.level > priorLevel + 1) add('heading_order', `章节「${section.title}」的标题层级不连续，请先调整目录`, 'error');
    priorLevel = section.level;
    if (!section.blocks.some(blockHasContent)) add('empty_section', `章节「${section.title}」没有正文`);
    for (const block of section.blocks) {
      if (block.type === 'heading' && !block.text.trim()) add('empty_heading', '正文中有空标题', 'error', block.id);
      if (block.type === 'table') {
        if (!block.columns.length || block.rows.some(row => row.length !== block.columns.length)) add('table_shape', `表格「${block.title}」行列数量不一致`, 'error', block.id);
        if (block.columns.length > 6) add('wide_table', `表格「${block.title}」列数较多，建议拆成参数和值`, 'warning', block.id);
      }
      if ((block.type === 'asset' || block.type === 'diagram') && !block.caption?.trim()) add('missing_caption', '图片缺少图题', 'warning', block.id);
      const text = block.type === 'paragraph' || block.type === 'heading' || block.type === 'callout' ? block.text : block.type === 'list' ? block.items.join('\n') : '';
      if (/engineeringOpticsSource|ContextSnapshot|LockedFact|EvidenceRef|以下需求尚待客户确认/.test(text)) add('internal_content', '正文包含内部字段或需求处理说明', 'warning', block.id);
    }
  }
  return issues;
}
