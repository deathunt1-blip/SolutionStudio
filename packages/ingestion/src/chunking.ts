import type { ChunkDraft, Classification, ParsedDocument } from '../../core/src/types.js';

/** Conservative byte bound: a byte-level tokenizer cannot emit more tokens than UTF-8 bytes. */
export const tokenUpperBound = (text: string): number => Buffer.byteLength(text, 'utf8');
/** A readable preview is deliberately extractive: it cannot introduce absent technical facts. */
export function extractiveSummary(text: string, maxCharacters = 220): string {
  const normalized = text.replace(/\s+/g, ' ').trim();
  if (Array.from(normalized).length <= maxCharacters) return normalized;
  const excerpt = Array.from(normalized).slice(0, maxCharacters - 1).join('');
  const end = Math.max(excerpt.lastIndexOf('。'), excerpt.lastIndexOf('. '), excerpt.lastIndexOf('；'));
  return `${end >= maxCharacters / 2 ? excerpt.slice(0, end + 1) : excerpt}…`;
}

function prefixWithin(text: string, budget: number): string {
  let used = 0, end = 0;
  for (const character of text) { const count = tokenUpperBound(character); if (used + count > budget) break; used += count; end += character.length; }
  return text.slice(0, end);
}
function suffixWithin(text: string, budget: number): string {
  let used = 0, output = '';
  for (const character of Array.from(text).reverse()) { const count = tokenUpperBound(character); if (used + count > budget) break; used += count; output = character + output; }
  return output;
}
function splitOversize(text: string, budget: number, overlap: number): string[] {
  const parts: string[] = []; let remaining = text;
  while (tokenUpperBound(remaining) > budget) {
    let segment = prefixWithin(remaining, budget);
    // Prefer complete rows, then sentences, then spaces, while always making progress.
    const boundary = Math.max(segment.lastIndexOf('\n'), segment.lastIndexOf('。') + 1, segment.lastIndexOf('；') + 1, segment.lastIndexOf('. ') + 1, segment.lastIndexOf(' '));
    if (boundary > segment.length / 2) segment = segment.slice(0, boundary);
    parts.push(segment.trim());
    const tail = suffixWithin(segment, overlap);
    remaining = tail + remaining.slice(segment.length);
  }
  if (remaining.trim()) parts.push(remaining.trim());
  return parts;
}

export function chunkDocument(parsed: ParsedDocument, classification: Classification, options?: { targetTokens: number; overlapTokens: number }): ChunkDraft[] {
  const target = Math.max(128, Math.min(12000, Math.floor(options?.targetTokens ?? 900)));
  const overlap = Math.max(0, Math.min(Math.floor(target / 3), Math.floor(options?.overlapTokens ?? 90)));
  const output: ChunkDraft[] = []; let current = '', currentPath: string[] = [], blockTypes = new Set<string>(), pages = new Set<number>();
  const append = (text: string, headingPath: string[], metadata: Record<string, unknown>) => {
    if (!text.trim()) return;
    const lower = text.toLowerCase();
    output.push({ order: output.length, headingPath: [...headingPath], text: text.trim(), summary: extractiveSummary(text, 120),
      // Products must occur in the chunk. Topics are document context and explicitly labeled as inherited.
      topics: [...classification.topics.value], products: classification.products.value.filter(product => lower.includes(product.toLowerCase())),
      metadata: { ...metadata, summaryMethod: 'extractive', topicSource: 'document', tokenUpperBound: tokenUpperBound(text.trim()), sectionRole: blockTypes.has('table') ? 'table' : 'content' } });
  };
  const flush = () => { append(current, currentPath, { blockTypes: [...blockTypes], pages: [...pages] }); current = ''; blockTypes = new Set(); pages = new Set(); };
  const blocks = parsed.blocks.length ? parsed.blocks : [{ type: 'paragraph' as const, text: parsed.plainText }];
  for (const block of blocks) {
    if (!block.text.trim()) continue;
    const headingPath = block.headingPath ?? currentPath;
    if (block.type === 'heading') { flush(); currentPath = [...headingPath]; }
    if (JSON.stringify(headingPath) !== JSON.stringify(currentPath)) { flush(); currentPath = [...headingPath]; }
    if (block.type === 'table') flush();
    if (tokenUpperBound(block.text) > target) {
      flush(); blockTypes.add(block.type);
      for (const [part, text] of splitOversize(block.text, target, overlap).entries()) append(text, headingPath, { blockTypes: [block.type], pages: block.page ? [block.page] : [], splitPart: part, overlapTokens: overlap });
      blockTypes.clear(); continue;
    }
    if (current && tokenUpperBound(`${current}\n\n${block.text}`) > target) {
      const previous = suffixWithin(current, overlap); flush();
      if (previous && tokenUpperBound(`${previous}\n\n${block.text}`) <= target) current = previous;
    }
    currentPath = [...headingPath]; current += `${current ? '\n\n' : ''}${block.text}`; blockTypes.add(block.type); if (block.page) pages.add(block.page);
    if (block.type === 'table') flush();
  }
  flush(); return output;
}
