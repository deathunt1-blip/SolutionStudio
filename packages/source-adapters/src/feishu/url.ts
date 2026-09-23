export interface ParsedFeishuUrl { type:'wiki'|'sheet'|'doc'|'docx'|'file'; token:string; sheetId?:string; origin:string; url:string }

/** These identifiers only ever become escaped path segments on the fixed Open API host. */
export function feishuToken(value:unknown):string {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{1,256}$/.test(value)) throw new Error('飞书资源标识无效');
  return value;
}

export function parseFeishuUrl(input:string):ParsedFeishuUrl {
  let url:URL; try { url = new URL(input.trim()); } catch { throw new Error('请输入完整的飞书 HTTPS 链接'); }
  if (url.protocol !== 'https:' || url.username || url.password || (url.port && url.port !== '443') ||
      !/^(?:[a-z0-9-]+\.)*feishu\.cn$/i.test(url.hostname)) throw new Error('仅支持 feishu.cn 域名下的 HTTPS 资源链接');
  const match = /^\/(wiki|sheets|doc|docx|file)\/([A-Za-z0-9_-]{1,256})\/?$/.exec(url.pathname);
  if (!match) throw new Error('无法识别飞书链接；支持 Wiki、Sheets、Doc、Docx 和 File');
  const type = match[1] === 'sheets' ? 'sheet' : match[1] as ParsedFeishuUrl['type'];
  const sheetId = url.searchParams.has('sheet') ? feishuToken(url.searchParams.get('sheet')) : undefined;
  if (sheetId && type !== 'sheet' && type !== 'wiki') throw new Error('该飞书链接不支持工作表参数');
  const canonical = new URL(`/${match[1]}/${match[2]}`, url.origin);
  if (sheetId) canonical.searchParams.set('sheet',sheetId);
  return {type,token:match[2],sheetId,origin:url.origin,url:canonical.href};
}
