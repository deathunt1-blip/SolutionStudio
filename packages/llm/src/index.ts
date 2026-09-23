import type { LLMConfig, LLMProvider, LLMRequest, LLMResponse } from '../../core/src/types.js';
import { Agent } from 'undici';

class ProviderError extends Error { constructor(message: string, readonly retryable = false) { super(message); } }
// Native fetch otherwise times out while waiting for headers after five minutes,
// before K3's ten-minute overall deadline. Share one pool across provider instances.
const providerDispatcher = new Agent({ headersTimeout: 600_000, bodyTimeout: 600_000 });

/** OpenAI-compatible boundary. Never surface response bodies, URLs or credentials in errors. */
export class KimiProvider implements LLMProvider {
  private readonly endpoint: string;
  private readonly isK3: boolean;
  constructor(private readonly config: LLMConfig) {
    let url: URL;
    try { url = new URL(config.baseUrl); } catch { throw new Error('LLM base URL 无效。'); }
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error('LLM base URL 必须是无凭据、无查询参数的 HTTP(S) 地址。');
    if (!config.apiKey.trim()) throw new Error('尚未配置 LLM API key。');
    this.isK3 = /^kimi-k3(?:[.\-]|$)/i.test(config.model);
    if (!config.model.trim() || !Number.isFinite(config.temperature) || config.temperature < 0 || config.temperature > 2 || !Number.isInteger(config.maxTokens) || config.maxTokens < 128 || config.maxTokens > (this.isK3 ? 1_048_576 : 32768)) throw new Error('LLM 模型或采样参数无效。');
    if (this.isK3 && config.reasoningEffort !== undefined && !['low', 'high', 'max'].includes(config.reasoningEffort)) throw new Error('LLM 推理强度无效。');
    this.endpoint = `${config.baseUrl.replace(/\/+$/, '')}/chat/completions`;
  }
  async generate(request: LLMRequest): Promise<LLMResponse> {
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const options: RequestInit & { dispatcher: Agent } = {
          method: 'POST', headers: { Authorization: `Bearer ${this.config.apiKey}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ model: this.config.model,
            ...(this.isK3 ? { max_completion_tokens: this.config.maxTokens, reasoning_effort: this.config.reasoningEffort ?? 'max' }
              : { temperature: this.config.temperature, max_tokens: this.config.maxTokens }),
            messages: [{ role: 'system', content: request.system }, { role: 'user', content: request.prompt }],
            ...(request.responseFormat?{response_format:{type:request.responseFormat}}:{}),
            ...(/^kimi-k2(?:[.\-]|$)/i.test(this.config.model) ? { thinking: { type: 'disabled' } } : {}) }),
          signal: AbortSignal.timeout(this.config.requestTimeoutMs??45_000), redirect: 'error', dispatcher: providerDispatcher,
        };
        const response = await fetch(this.endpoint, options);
        if (!response.ok) {
          await response.body?.cancel();
          throw new ProviderError(`LLM 请求失败（HTTP ${response.status}）。${response.status === 401 || response.status === 403 ? '请检查 API key 与访问权限。' : ''}`, response.status === 429 || response.status >= 500);
        }
        // Read with a hard cap before parsing to avoid retaining unbounded provider responses.
        const reader = response.body?.getReader();
        if (!reader) throw new ProviderError('LLM 返回空响应。');
        // K3 can return a large reasoning field alongside its final answer. It is never exposed to callers.
        const responseByteLimit = this.isK3 ? 16 * 1024 * 1024 : 512_000;
        const chunks: Uint8Array[] = []; let size = 0;
        while (true) { const read = await reader.read(); if (read.done) break; size += read.value.length; if (size > responseByteLimit) { await reader.cancel(); throw new ProviderError('LLM 响应超过大小限制。'); } chunks.push(read.value); }
        let body: { choices?: { message?: { content?: unknown }; finish_reason?: unknown }[]; usage?: { prompt_tokens?: unknown; completion_tokens?: unknown } };
        try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw new ProviderError('LLM 返回了无效 JSON 响应。'); }
        const choice = body.choices?.[0];
        if (choice?.finish_reason === 'length') throw new ProviderError(`LLM 输出达到 token 限制，请提高 ${this.isK3 ? 'max_completion_tokens' : 'max_tokens'}。`);
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
