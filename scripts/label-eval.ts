import { cliOptions } from '../packages/evaluation/src/data.js';
import { createLabelServer } from '../packages/evaluation/src/label-server.js';

async function main() {
  const options = cliOptions(process.argv.slice(2));
  const supported = new Set(['manifest', 'labels', 'context', 'port', 'help']);
  for (const key of options.keys()) if (!supported.has(key)) throw new Error(`不支持的参数：--${key}`);
  if (options.has('help')) {
    console.log('本地人工标注（不调用模型、不修改正式知识库）\n\nnpm run eval:label -- --manifest evaluation-data/manifest.json --labels evaluation-data/labels.json --context evaluation-data/context.json [--port 4312]\n\n在浏览器中逐份查看原文，选择类型和权威级别后保存。可选字段仅在完整标注后勾选对应复选框。');
    return;
  }
  const value = (key: string, fallback: string) => {
    const result = options.get(key) ?? fallback;
    if (typeof result !== 'string' || !result.trim()) throw new Error(`--${key} 需要一个值。`);
    return result;
  };
  const port = Number(value('port', '4312'));
  const app = await createLabelServer({
    manifestPath: value('manifest', 'evaluation-data/manifest.json'),
    labelsPath: value('labels', 'evaluation-data/labels.json'),
    contextPath: value('context', 'evaluation-data/context.json'),
    port,
  });
  const shutdown = async () => { await app.close(); process.exit(0); };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
  try {
    await app.listen({ host: '127.0.0.1', port });
    console.log(`人工标注页面：http://127.0.0.1:${port}\n仅保存人工答案到本地 labels.json；不会使用 AI 预填。按 Ctrl+C 关闭服务。`);
  } catch (error) { await app.close(); throw error; }
}
main().catch(error => { console.error(error instanceof Error ? error.message : '标注服务启动失败。'); process.exitCode = 1; });
