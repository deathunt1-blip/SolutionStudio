import type { OutputProfile } from './types.js';

/** Versioned, data-only theme contract, shared by the exporter and settings preview.
 * A future uploaded template can use sourceTemplateAssetId without changing profiles. */
export interface OutputTheme {
  id: string; name: string; version: number; sourceTemplateAssetId?: string;
  page: { widthMm: number; heightMm: number; marginMm: number; background: string };
  cover: { alignment: 'left'; titleSize: number; subtitleSize: number; accentColor: string; logoMaxWidthMm: number; logoMaxHeightMm: number };
  typography: { chineseFont: string; latinFont: string; headingFont: string; bodySize: number; textColor: string; secondaryColor: string; lineSpacing: number; paragraphAfterPt: number; firstLineCharacters: number };
  headings: { level: number; size: number; color: string; newPage: boolean; rule: boolean }[];
  toc: { maximumLevel: number; fontSize: number; lineSpacing: number; paragraphAfterPt: number; pageNumbers: boolean; leader: 'dot' };
  table: { headerFill: string; borderColor: string; textColor: string; cellPaddingTwips: number; fontSize: number };
  figure: { maximumWidthRatio: number; maximumHeightMm: number; captionSize: number; captionColor: string; borderColor: string };
  headerFooter: { fontSize: number; color: string; borderColor: string; hideOnCover: boolean };
  callout: { fill: string; borderColor: string; textColor: string };
}

export const builtinTheme: OutputTheme = {
  id: 'qingtong-simple', name: '青瞳 · 简洁技术方案', version: 1,
  page: { widthMm: 210, heightMm: 297, marginMm: 25, background: 'FFFFFF' },
  cover: { alignment: 'left', titleSize: 28, subtitleSize: 20, accentColor: '456B5B', logoMaxWidthMm: 60, logoMaxHeightMm: 25 },
  typography: { chineseFont: '宋体', latinFont: 'Times New Roman', headingFont: '黑体', bodySize: 11, textColor: '1E2A25', secondaryColor: '7A8982', lineSpacing: 1.5, paragraphAfterPt: 5, firstLineCharacters: 2 },
  headings: [{ level: 1, size: 16, color: '456B5B', newPage: true, rule: true }, { level: 2, size: 13.5, color: '1E2A25', newPage: false, rule: false }, { level: 3, size: 11.5, color: '1E2A25', newPage: false, rule: false }],
  toc: { maximumLevel: 3, fontSize: 10.5, lineSpacing: 1.1, paragraphAfterPt: 3, pageNumbers: true, leader: 'dot' },
  table: { headerFill: 'EEF4F0', borderColor: 'D9E2DD', textColor: '1E2A25', cellPaddingTwips: 110, fontSize: 10.5 },
  figure: { maximumWidthRatio: 0.9, maximumHeightMm: 160, captionSize: 9, captionColor: '7A8982', borderColor: 'D9E2DD' },
  headerFooter: { fontSize: 9, color: '7A8982', borderColor: 'D9E2DD', hideOnCover: true },
  callout: { fill: 'EEF4F0', borderColor: '456B5B', textColor: '1E2A25' },
};

export function normalizeBrandColor(value?: string): string {
  const color = (value || builtinTheme.cover.accentColor).replace(/^#/, '').toUpperCase();
  if (!/^[0-9A-F]{6}$/.test(color)) throw new Error('品牌色须为六位十六进制颜色，例如 #456B5B');
  return color;
}
function tint(color: string, whiteRatio: number): string {
  return [0, 2, 4].map(index => Math.round(parseInt(color.slice(index, index + 2), 16) * (1 - whiteRatio) + 255 * whiteRatio).toString(16).padStart(2, '0')).join('').toUpperCase();
}
export function resolveTheme(profile?: Partial<OutputProfile>): OutputTheme {
  if (profile?.themeId && profile.themeId !== builtinTheme.id) throw new Error('所选导出主题不存在');
  const theme = structuredClone(builtinTheme), primary = normalizeBrandColor(profile?.brandColor);
  theme.cover.accentColor = primary; theme.headings[0].color = primary; theme.callout.borderColor = primary;
  if (primary !== builtinTheme.cover.accentColor) {
    theme.table.headerFill = theme.callout.fill = tint(primary, 0.92);
    theme.table.borderColor = theme.figure.borderColor = theme.headerFooter.borderColor = tint(primary, 0.8);
  }
  if (profile?.fontFamily) theme.typography.chineseFont = profile.fontFamily;
  if (profile?.titleFontFamily) theme.typography.headingFont = profile.titleFontFamily;
  if (profile?.fontSize !== undefined) theme.typography.bodySize = profile.fontSize;
  if (profile?.pageMarginMm !== undefined) theme.page.marginMm = profile.pageMarginMm;
  return theme;
}
