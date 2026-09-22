import { afterEach, describe, expect, test } from 'vitest';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const importer = fileURLToPath(new URL('../scripts/import-folder.ts', import.meta.url));
const loader = pathToFileURL(createRequire(import.meta.url).resolve('tsx')).href;
const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });

async function runCli(options: { duplicateFirst?: boolean; model?: string } = {}) {
  const directory = await mkdtemp(path.join(tmpdir(), 'studio-import-budget-'));
  cleanup.push(async () => {
    if (path.dirname(directory) === path.resolve(tmpdir()) && path.basename(directory).startsWith('studio-import-budget-')) await rm(directory, { recursive: true, force: true });
  });
  const folder = path.join(directory, 'fixtures'); await mkdir(folder);
  await writeFile(path.join(folder, 'a.md'), '# 技术方案\n第一份合成资料。');
  await writeFile(path.join(folder, 'b.md'), '# 技术方案\n第二份不同的合成资料。');
  const requests: string[] = []; let uploads = 0;
  const server = createServer(async (request, response) => {
    requests.push(`${request.method} ${request.url}`);
    for await (const _ of request) { /* consume the real multipart request without retaining content */ }
    let value: unknown;
    if (request.url === '/api/settings') value = { llm: { configured: true, model: options.model ?? 'kimi-k2.6', maxTokens: 3000, baseUrl: 'https://api.moonshot.cn/v1' } };
    else if (request.url === '/api/stats') value = { processing: 0 };
    else if (request.url === '/api/upload' && request.method === 'POST') {
      uploads++;
      value = { results: [{ status: options.duplicateFirst && uploads === 1 ? 'duplicate' : 'queued', documentId: `fixture-${uploads}` }] };
    } else if (request.url?.startsWith('/api/documents/')) value = { document: { id: request.url.split('/').at(-1), status: 'active', parseStatus: 'success', reviewReasons: [] }, parsed: { metadata: { llmUsage: { inputTokens: 1000, outputTokens: 100 } } } };
    else { response.statusCode = 404; value = { error: 'Unexpected endpoint in isolated import test' }; }
    response.setHeader('Content-Type', 'application/json'); response.end(JSON.stringify(value));
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  cleanup.push(async () => { server.closeAllConnections(); await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); });
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('Fake server did not bind');
  const endpoint = `http://127.0.0.1:${address.port}`;
  const result = await new Promise<{ code: number | null; output: string }>((resolve, reject) => {
    const child = spawn(process.execPath, ['--import', loader, importer, folder, '--url', endpoint, '--limit', '2', '--budget-cny', '0.4'], {
      cwd: directory, windowsHide: true,
      // Defense in depth: a regressed balance implementation can only contact this fake server.
      env: { ...process.env, LLM_BASE_URL: `${endpoint}/v1`, LLM_API_KEY: 'fake-test-only', KIMI_API_KEY: 'fake-test-only', LLM_MODEL: 'kimi-k2.6' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = ''; child.stdout.on('data', data => { output += String(data); }); child.stderr.on('data', data => { output += String(data); });
    const timeout = setTimeout(() => { child.kill(); reject(new Error('Isolated import CLI timed out')); }, 15_000);
    child.once('error', error => { clearTimeout(timeout); reject(error); });
    child.once('close', code => { clearTimeout(timeout); resolve({ code, output }); });
  });
  let report: any;
  try { report = JSON.parse(await readFile(path.join(directory, 'output', 'import-report.json'), 'utf8')); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  return { ...result, report, requests, uploads };
}

describe('import CLI attributes and limits its own document usage', () => {
  test('a CNY 0.4 allowance queues one document, records usage, and stops before a second upload', async () => {
    const result = await runCli();
    expect(result.code).toBe(0); expect(result.uploads).toBe(1);
    expect(result.output).toContain('Conservative token budget reached');
    expect(result.report.results).toHaveLength(1);
    expect(result.report.inputTokens).toBe(1000); expect(result.report.outputTokens).toBe(100);
    expect(result.report.estimatedCny).toBeCloseTo(0.0092, 8);
    expect(result.report.budgetUpperBoundCny).toBeGreaterThan(result.report.estimatedCny);
    expect(result.report.budgetUpperBoundCny).toBeLessThanOrEqual(0.4);
    expect(result.requests.some(request => request.includes('/users/me/balance'))).toBe(false);
  }, 20_000);
  test('a duplicate consumes no reservation and allows the next unique document within the same allowance', async () => {
    const result = await runCli({ duplicateFirst: true });
    expect(result.code).toBe(0); expect(result.uploads).toBe(2);
    expect(result.report.results.map((entry: any) => entry.results[0].status)).toEqual(['duplicate', 'queued']);
    expect(result.report.inputTokens).toBe(1000); expect(result.report.outputTokens).toBe(100);
    expect(result.report.budgetUpperBoundCny).toBeLessThanOrEqual(0.4);
    expect(result.requests.filter(request => request.startsWith('GET /api/documents/'))).toEqual(['GET /api/documents/fixture-2']);
    expect(result.requests.some(request => request.includes('/users/me/balance'))).toBe(false);
  }, 20_000);
  test('an incompatible model is rejected before any upload', async () => {
    const result = await runCli({ model: 'incompatible-model' });
    expect(result.code).not.toBe(0); expect(result.uploads).toBe(0);
    expect(result.output).toContain('Server model config differs from budget guard');
    expect(result.report).toBeUndefined();
  }, 20_000);
});
