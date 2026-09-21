import { readFile, writeFile, rename } from 'node:fs/promises';
import path from 'node:path';
import type { LLMConfig, Settings } from '../../core/src/types.js';
import type { Database } from './database.js';

export class SettingsStore {
 private key = '';
 constructor(private db: Database, private dataDir: string, private disabled = false) {}
 async init() {
  try { this.key = String(JSON.parse(await readFile(path.join(this.dataDir, 'private-secrets.json'), 'utf8')).llmApiKey || ''); } catch { /* environment-only is the default */ }
  this.key ||= process.env.LLM_API_KEY || process.env.KIMI_API_KEY || '';
 }
 async get(): Promise<Settings> {
  const rows = await this.db.query('SELECT key,value FROM settings');
  const saved = Object.fromEntries(rows.map(r => [r.key,r.value]));
  const sources = await this.db.query("SELECT id,type,name,mode,status FROM knowledge_sources WHERE organization_id='default' AND workspace_id='default' ORDER BY id");
  return {
   autoAcceptThreshold: saved.autoAcceptThreshold ?? 0.85, reviewThreshold: saved.reviewThreshold ?? 0.60,
   chunkTargetTokens: saved.chunkTargetTokens ?? 800, chunkOverlapTokens: saved.chunkOverlapTokens ?? 100,
   llm: { baseUrl: process.env.LLM_BASE_URL || 'https://api.moonshot.cn/v1', model: process.env.LLM_MODEL || 'kimi-k2.6', temperature: Number(process.env.LLM_TEMPERATURE || 0.6), maxTokens: Number(process.env.LLM_MAX_TOKENS || 3000), ...saved.llm, configured: Boolean(this.key) && !this.disabled },
   sources: sources as Settings['sources'],
  };
 }
 async config(): Promise<LLMConfig|undefined> { const s = await this.get(); return s.llm.configured ? {...s.llm, apiKey: this.key} : undefined; }
 async patch(input: Record<string, unknown>) {
  const old = await this.get();
  const numbers = ['autoAcceptThreshold','reviewThreshold','chunkTargetTokens','chunkOverlapTokens'] as const;
  const merged = {...old,...input} as Settings;
  for (const key of numbers) if (input[key] !== undefined && (typeof input[key] !== 'number' || !Number.isFinite(input[key]))) throw new Error('设置数值无效');
  if (merged.reviewThreshold < 0 || merged.autoAcceptThreshold > 1 || merged.reviewThreshold > merged.autoAcceptThreshold) throw new Error('置信度阈值需满足 0 ≤ 人工确认 ≤ 自动接受 ≤ 1');
  if (merged.chunkTargetTokens < 200 || merged.chunkTargetTokens > 4000 || merged.chunkOverlapTokens < 0 || merged.chunkOverlapTokens >= merged.chunkTargetTokens) throw new Error('切块大小需为 200–4000，重叠需小于切块大小');
  let llm: Record<string, unknown>|undefined;
  if (input.llm !== undefined) {
   if (!input.llm || typeof input.llm !== 'object' || Array.isArray(input.llm)) throw new Error('模型配置格式无效');
   const raw = input.llm as Record<string, unknown>;
   llm = Object.fromEntries(['baseUrl','model','temperature','maxTokens'].map(k=>[k, raw[k] ?? old.llm[k as keyof typeof old.llm]]));
   let url: URL; try { url = new URL(String(llm.baseUrl)); } catch { throw new Error('模型 API 地址无效'); }
   if ((url.protocol !== 'https:' && !(url.protocol === 'http:' && ['127.0.0.1','localhost','[::1]'].includes(url.hostname))) || url.username || url.password || url.search || url.hash) throw new Error('模型 API 需使用 HTTPS（本地服务可使用 HTTP），且不能含账号或查询参数');
   if (typeof llm.model !== 'string' || !llm.model.trim() || llm.model.length > 200) throw new Error('模型名称无效');
   if (typeof llm.temperature !== 'number' || llm.temperature < 0 || llm.temperature > 2 || typeof llm.maxTokens !== 'number' || !Number.isInteger(llm.maxTokens) || llm.maxTokens < 256 || llm.maxTokens > 16000) throw new Error('模型参数无效');
   if (raw.apiKey !== undefined && raw.apiKey !== '') {
    if (typeof raw.apiKey !== 'string' || raw.apiKey.length > 1000) throw new Error('API Key 格式无效');
    // Secret is never saved in SQL, returned by the API, or included in logs.
    const secretPath = path.join(this.dataDir, 'private-secrets.json');
    await writeFile(`${secretPath}.tmp`, JSON.stringify({llmApiKey:raw.apiKey}), {mode:0o600});
    await rename(`${secretPath}.tmp`, secretPath);
    this.key = raw.apiKey;
   }
  }
  await this.db.transaction(async tx => {
   for (const key of numbers) if (input[key] !== undefined) await tx.query('INSERT INTO settings(key,value) VALUES($1,$2::jsonb) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=now()', [key,JSON.stringify(input[key])]);
   if (llm) await tx.query("INSERT INTO settings(key,value) VALUES('llm',$1::jsonb) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=now()", [JSON.stringify(llm)]);
  });
  return this.get();
 }
 redact(message: string) { return message.replace(/sk-[a-zA-Z0-9_-]+/g,'[redacted]').split(this.key || '\u0000').join('[redacted]').slice(0,1000); }
}
