import type { LLMConfig, LLMProvider, LLMRequest, LLMResponse } from '../../core/src/types.js';

class ProviderError extends Error { constructor(message: string, readonly retryable = false) { super(message); } }

/** OpenAI-compatible boundary. Never surface response bodies, URLs or credentials in errors. */
export class KimiProvider implements LLMProvider {
  private readonly endpoint: string;
  constructor(private readonly config: LLMConfig) {
    let url: URL;
    try { url = new URL(config.baseUrl); } catch { throw new Error('LLM base URL 无效。'); }
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error('LLM base URL 必须是无凭据、无查询参数的 HTTP(S) 地址。');
    if (!config.apiKey.trim()) throw new Error('尚未配置 LLM API key。');
    if (!config.model.trim() || !Number.isFinite(config.temperature) || config.temperature < 0 || config.temperature > 2 || !Number.isInteger(config.maxTokens) || config.maxTokens < 128 || config.maxTokens > 32768) throw new Error('LLM 模型或采样参数无效。');
    this.endpoint = `${config.baseUrl.replace(/\/+$/, '')}/chat/completions`;
  }
  async generate(request: LLMRequest): Promise<LLMResponse> {
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const response = await fetch(this.endpoint, {
          method: 'POST', headers: { Authorization: `Bearer ${this.config.apiKey}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ model: this.config.model, temperature: this.config.temperature, max_tokens: this.config.maxTokens,
            messages: [{ role: 'system', content: request.system }, { role: 'user', content: request.prompt }],
            ...(/^kimi-k[23](?:[.\-]|$)/i.test(this.config.model) ? { thinking: { type: 'disabled' } } : {}) }),
          signal: AbortSignal.timeout(45_000), redirect: 'error',
        });
        if (!response.ok) {
          await response.body?.cancel();
          throw new ProviderError(`LLM 请求失败（HTTP ${response.status}）。${response.status === 401 || response.status === 403 ? '请检查 API key 与访问权限。' : ''}`, response.status === 429 || response.status >= 500);
        }
        // Read with a hard cap before parsing to avoid retaining unbounded provider responses.
        const reader = response.body?.getReader();
        if (!reader) throw new ProviderError('LLM 返回空响应。');
        const chunks: Uint8Array[] = []; let size = 0;
        while (true) { const read = await reader.read(); if (read.done) break; size += read.value.length; if (size > 512_000) { await reader.cancel(); throw new ProviderError('LLM 响应超过大小限制。'); } chunks.push(read.value); }
        let body: { choices?: { message?: { content?: unknown }; finish_reason?: unknown }[]; usage?: { prompt_tokens?: unknown; completion_tokens?: unknown } };
        try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw new ProviderError('LLM 返回了无效 JSON 响应。'); }
        const choice = body.choices?.[0];
        if (choice?.finish_reason === 'length') throw new ProviderError('LLM 输出达到 token 限制，请提高 max_tokens。');
        if (typeof choice?.message?.content !== 'string' || !choice.message.content.trim()) throw new ProviderError('LLM 未返回可用的文本内容。');
        const input = body.usage?.prompt_tokens, output = body.usage?.completion_tokens;
        return { content: choice.message.content, ...(typeof input === 'number' && typeof output === 'number' ? { usage: { inputTokens: input, outputTokens: output } } : {}) };
      } catch (error) {
        const safe = error instanceof ProviderError ? error : new ProviderError('LLM 连接失败或请求超时。', true);
        if (!safe.retryable || attempt === 2) throw safe;
        await new Promise(resolve => setTimeout(resolve, (attempt + 1) * 500));
      }
    }
    throw new Error('LLM 请求未完成。');
  }
}
