import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initialRegistries } from '../packages/knowledge/src/database.js';
import { contentHash, writeJsonAtomic } from '../packages/evaluation/src/data.js';
import { createLabelServer } from '../packages/evaluation/src/label-server.js';
import { runEvaluation } from '../packages/evaluation/src/runner.js';
import type { EvaluationContext, EvaluationLabels, EvaluationManifest } from '../packages/evaluation/src/types.js';

const reportedSizes = vi.hoisted(() => new Map<string, number>());
vi.mock('node:fs/promises', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return { ...actual, stat: async (...args: Parameters<typeof actual.stat>) => {
    const result = await actual.stat(...args);
    const size = reportedSizes.get(String(args[0]));
    return size === undefined ? result : Object.assign(result, { size });
  } };
});

const directories: string[] = [];
const host = '127.0.0.1:4312';
const timestamp = '2026-09-22T00:00:00.000Z';
afterEach(async () => {
  reportedSizes.clear();
  await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true })));
});

async function fixture(size: number) {
  const directory = await mkdtemp(join(tmpdir(), 'studio-evaluation-size-'));
  directories.push(directory);
  const text = '# 技术方案\n机器人部署历史项目方案，仅供参考。';
  const sourcePath = join(directory, 'source.md');
  await writeFile(sourcePath, text);
  // Only metadata is enlarged: exercise the actual guards without parsing 80 MiB.
  reportedSizes.set(sourcePath, size);
  const document = { id: 'source', path: sourcePath, filename: 'source.md', contentHash: contentHash(text) };
  const manifest: EvaluationManifest = { schemaVersion: 1, datasetId: 'size-boundary', createdAt: timestamp, documents: [document] };
  const labels: EvaluationLabels = { schemaVersion: 1, datasetId: manifest.datasetId, labels: [{
    documentId: document.id, filename: document.filename, contentHash: document.contentHash,
    documentType: 'solution', authority: 'reference', labeledBy: 'Synthetic fixture author', labeledAt: timestamp, origin: 'human',
  }] };
  const context: EvaluationContext = { schemaVersion: 1, createdAt: timestamp, registries: structuredClone(initialRegistries), examples: [], thresholds: { review: 0.6, autoAccept: 0.85 } };
  const paths = { manifest: join(directory, 'manifest.json'), labels: join(directory, 'labels.json'), context: join(directory, 'context.json'), output: join(directory, 'run.json') };
  await Promise.all([writeJsonAtomic(paths.manifest, manifest), writeJsonAtomic(paths.labels, labels), writeJsonAtomic(paths.context, context)]);
  return { paths, document };
}

describe('evaluation source size matches the production 80 MiB limit', () => {
  it.each([67_313_434, 80 * 1024 * 1024, 80 * 1024 * 1024 + 1])('preflights %i bytes before any model request', async size => {
    const { paths } = await fixture(size);
    const generate = vi.fn(async () => ({ content: JSON.stringify({ classification: {
      documentType: { value: 'solution', confidence: 0.9 }, authority: { value: 'reference', confidence: 0.9 },
      applications: { value: [], confidence: 0.9 }, topics: { value: [], confidence: 0.9 },
      products: { value: [], confidence: 0.9 }, language: { value: 'zh', confidence: 0.99 },
    } }), usage: { inputTokens: 10, outputTokens: 10 } }));
    const execution = runEvaluation({ ...paths, provider: 'synthetic', budgetCny: 1 }, { provider: { generate } });
    if (size > 80 * 1024 * 1024) {
      await expect(execution).rejects.toThrow('超过 80 MiB');
      expect(generate).not.toHaveBeenCalled();
      await expect(readFile(paths.output)).rejects.toMatchObject({ code: 'ENOENT' });
    } else {
      expect((await execution).status).toBe('completed');
      expect(generate).toHaveBeenCalledOnce();
    }
  }, 20_000);

  it.each([67_313_434, 80 * 1024 * 1024, 80 * 1024 * 1024 + 1])('applies the same %i-byte limit to preview, download and label saves', async size => {
    const { paths, document } = await fixture(size);
    await writeJsonAtomic(paths.labels, { schemaVersion: 1, datasetId: 'size-boundary', labels: [] });
    const app = await createLabelServer({ manifestPath: paths.manifest, labelsPath: paths.labels, contextPath: paths.context });
    try {
      const csrf = (await app.inject({ method: 'GET', url: '/api/dataset', headers: { host } })).json().csrfToken;
      const expectedStatus = size > 80 * 1024 * 1024 ? 413 : 200;
      for (const url of ['/api/documents/source', '/api/documents/source/original']) {
        const response = await app.inject({ method: 'GET', url, headers: { host } });
        expect(response.statusCode).toBe(expectedStatus);
        if (expectedStatus === 413) expect(response.json().error).toContain('80 MiB');
      }
      const saved = await app.inject({ method: 'POST', url: '/api/labels', headers: { host, origin: `http://${host}`, 'x-label-csrf': csrf }, payload: {
        documentId: document.id, contentHash: document.contentHash, documentType: 'solution', authority: 'reference', labeledBy: 'Synthetic fixture author', expectedLabeledAt: null,
      } });
      expect(saved.statusCode).toBe(expectedStatus);
      expect(JSON.parse(await readFile(paths.labels, 'utf8')).labels).toHaveLength(expectedStatus === 200 ? 1 : 0);
    } finally { await app.close(); }
  });
});
