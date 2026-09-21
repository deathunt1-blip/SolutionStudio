// Intl uses ICU's Chinese dictionary. Bigrams additionally cover product/domain words
// absent from that dictionary, while PostgreSQL performs matching and ranking.
const segmenter = new Intl.Segmenter('zh-CN', { granularity: 'word' });
export function lexicalTokens(text: string): string[] {
 const terms: string[] = [];
 for (const part of segmenter.segment(text.normalize('NFKC').toLowerCase())) {
  if (!part.isWordLike) continue;
  terms.push(part.segment);
  if (/^[\p{Script=Han}]+$/u.test(part.segment) && part.segment.length > 2) {
   for (let i=0; i<part.segment.length-1; i++) terms.push(part.segment.slice(i,i+2));
  }
 }
 return terms;
}
export const indexText = (text: string) => lexicalTokens(text).join(' ');
export function queryText(text: string, mode: 'and'|'or' = 'and'): string {
 const terms = [...new Set(lexicalTokens(text).filter(v => /^[\p{L}\p{N}_-]+$/u.test(v)))].slice(0, 60);
 return terms.map(v => `'${v.replace(/'/g, "''")}'`).join(mode === 'and' ? ' & ' : ' | ');
}
