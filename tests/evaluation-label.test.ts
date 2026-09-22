import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Script } from 'node:vm';
import { createLabelServer } from '../packages/evaluation/src/label-server.js';
import { labelScript } from '../packages/evaluation/src/label-page.js';
import { contentHash } from '../packages/evaluation/src/data.js';
import type { EvaluationManifest, EvaluationContext, EvaluationLabels } from '../packages/evaluation/src/types.js';

const host = '127.0.0.1:4312';
let directory: string;
let app: Awaited<ReturnType<typeof createLabelServer>> | undefined;
let manifest: EvaluationManifest;
let settings: { manifestPath: string; labelsPath: string; contextPath: string };
let csrf: string;
const writeJson = (path: string, value: unknown) => writeFile(path, JSON.stringify(value));
const validInput = (id = 'first') => ({ documentId: id, contentHash: manifest.documents.find(document => document.id === id)!.contentHash, documentType: 'solution', authority: 'reference', labeledBy: '测试标注人', expectedLabeledAt: null });
const writeHeaders = () => ({ host, origin: `http://${host}`, 'x-label-csrf': csrf });

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'studio-evaluation-label-'));
  settings = { manifestPath: join(directory, 'manifest.json'), labelsPath: join(directory, 'labels.json'), contextPath: join(directory, 'context.json') };
  const firstText = '# 技术方案\n\n现场部署 QX10 产品，包含同步与机器人应用。\n\n## 调试流程\n确认设备连接。';
  const secondText = '# 另一个文件\n\n第二份文件的正文。';
  const firstPath = join(directory, 'first.md'), secondPath = join(directory, 'second.md');
  await writeFile(firstPath, firstText); await writeFile(secondPath, secondText);
  manifest = { schemaVersion: 1, datasetId: 'synthetic-test', createdAt: new Date().toISOString(), documents: [
    { id: 'first', path: firstPath, filename: '<img src=x onerror="alert(1)">.md', contentHash: contentHash(firstText) },
    { id: 'second', path: secondPath, filename: '第二份.md', contentHash: contentHash(secondText) },
  ] };
  const context: EvaluationContext = { schemaVersion: 1, createdAt: new Date().toISOString(), thresholds: { review: 0.6, autoAccept: 0.85 }, examples: [], registries: {
    documentTypes: [{ key: 'solution', label: '技术方案', aliases: [] }, { key: 'unknown', label: '未知', aliases: [] }],
    applications: [{ key: 'robotics', label: '机器人', aliases: [] }], topics: [{ key: 'sync', label: '同步', aliases: [] }],
  } };
  await writeJson(settings.manifestPath, manifest); await writeJson(settings.contextPath, context);
  await writeJson(settings.labelsPath, { schemaVersion: 1, datasetId: manifest.datasetId, labels: [] });
  app = await createLabelServer(settings);
  const dataset = await app.inject({ method: 'GET', url: '/api/dataset', headers: { host } });
  expect(dataset.statusCode).toBe(200); csrf = dataset.json().csrfToken;
});
afterEach(async () => { await app?.close(); app = undefined; if (directory) await rm(directory, { recursive: true, force: true }); });

describe('independent human evaluation labels', () => {
  it('serves extractive evidence without predicted defaults, raw paths, or executable document HTML', async () => {
    const page = await app!.inject({ method: 'GET', url: '/', headers: { host } });
    expect(page.statusCode).toBe(200);
    expect(page.body).not.toContain(manifest.documents[0]!.filename);
    expect(page.body).toContain('<option value="">请主动选择权威级别</option>');
    expect(page.headers['content-security-policy']).toContain("frame-ancestors 'none'");
    expect(labelScript).not.toContain('innerHTML');
    expect(() => new Script(labelScript)).not.toThrow();
    const response = await app!.inject({ method: 'GET', url: '/api/documents/first?full=1', headers: { host } });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ label: null, filename: manifest.documents[0]!.filename, parseStatus: 'success' });
    expect(response.json().fullText).toContain('确认设备连接');
    expect(response.json().headings).toEqual(['技术方案', '调试流程']);
    expect(response.body).not.toContain(directory.replaceAll('\\', '\\\\'));
    expect(response.json()).not.toHaveProperty('classification');
    expect(response.json()).not.toHaveProperty('prediction');
  });

  it('requires explicit type, authority and annotator; keeps unannotated fields distinct from confirmed empty', async () => {
    for (const overrides of [{ documentType: '' }, { authority: '' }, { labeledBy: '   ' }, { documentType: 'invented' }, { origin: 'ai' }, { topics: ['not-registered'] }]) {
      const response = await app!.inject({ method: 'POST', url: '/api/labels', headers: writeHeaders(), payload: { ...validInput(), ...overrides } });
      expect(response.statusCode).toBe(400);
    }
    const response = await app!.inject({ method: 'POST', url: '/api/labels', headers: writeHeaders(), payload: { ...validInput(), products: [], topics: ['sync', 'sync'], notes: '已核对正文。' } });
    expect(response.statusCode).toBe(200);
    const label = response.json().label;
    expect(label).toMatchObject({ origin: 'human', products: [], topics: ['sync'], filename: manifest.documents[0]!.filename });
    expect(label).not.toHaveProperty('applications');
    expect(label.labeledAt).toMatch(/^\d{4}-/);
    const saved = JSON.parse(await readFile(settings.labelsPath, 'utf8')) as EvaluationLabels;
    expect(saved.labels).toEqual([label]);
  });

  it('requires the exact local origin, allowed Host and a non-forgeable write token', async () => {
    for (const headers of [
      { ...writeHeaders(), origin: 'https://attacker.example' },
      { host, 'x-label-csrf': csrf },
      { ...writeHeaders(), host: 'attacker.example:4312' },
      { ...writeHeaders(), 'x-label-csrf': '0'.repeat(64) },
      { ...writeHeaders(), 'x-label-csrf': '中'.repeat(64) },
      { ...writeHeaders(), 'sec-fetch-site': 'cross-site' },
    ]) {
      const response = await app!.inject({ method: 'POST', url: '/api/labels', headers, payload: validInput() });
      expect(response.statusCode).toBe(403);
    }
    const crossRead = await app!.inject({ method: 'GET', url: '/api/dataset', headers: { host, origin: 'https://attacker.example' } });
    expect(crossRead.statusCode).toBe(403);
    const rebound = await app!.inject({ method: 'GET', url: '/api/dataset', headers: { host: 'attacker.example:4312' } });
    expect(rebound.statusCode).toBe(403);
    expect(JSON.parse(await readFile(settings.labelsPath, 'utf8')).labels).toHaveLength(0);
  });

  it('rejects changed file content for preview, download and label writes', async () => {
    // Populate the preview cache, then change the source: the cached version must not hide the change.
    await app!.inject({ method: 'GET', url: '/api/documents/first', headers: { host } });
    await writeFile(manifest.documents[0]!.path, '# 替换过的文件');
    for (const url of ['/api/documents/first', '/api/documents/first/original']) expect((await app!.inject({ method: 'GET', url, headers: { host } })).statusCode).toBe(409);
    const saved = await app!.inject({ method: 'POST', url: '/api/labels', headers: writeHeaders(), payload: validInput() });
    expect(saved.statusCode).toBe(409);
    expect(JSON.parse(await readFile(settings.labelsPath, 'utf8')).labels).toHaveLength(0);
  });

  it('serializes concurrent saves for distinct documents without losing either label', async () => {
    const responses = await Promise.all(['first', 'second'].map(id => app!.inject({ method: 'POST', url: '/api/labels', headers: writeHeaders(), payload: validInput(id) })));
    expect(responses.map(response => response.statusCode)).toEqual([200, 200]);
    const saved = JSON.parse(await readFile(settings.labelsPath, 'utf8')) as EvaluationLabels;
    expect(saved.labels.map(label => label.documentId).sort()).toEqual(['first', 'second']);
    const dataset = (await app!.inject({ method: 'GET', url: '/api/dataset', headers: { host } })).json();
    expect(dataset.labeledIds).toHaveLength(2);
  });

  it('preserves existing labels across restart and prevents stale tabs from overwriting another human edit', async () => {
    const first = await app!.inject({ method: 'POST', url: '/api/labels', headers: writeHeaders(), payload: validInput() });
    const original = first.json().label;
    await app!.close(); app = await createLabelServer(settings);
    csrf = (await app.inject({ method: 'GET', url: '/api/dataset', headers: { host } })).json().csrfToken;
    expect((await app.inject({ method: 'GET', url: '/api/documents/first', headers: { host } })).json().label).toEqual(original);
    const stale = await app.inject({ method: 'POST', url: '/api/labels', headers: writeHeaders(), payload: validInput() });
    expect(stale.statusCode).toBe(409);
    const update = await app.inject({ method: 'POST', url: '/api/labels', headers: writeHeaders(), payload: { ...validInput(), expectedLabeledAt: original.labeledAt, documentType: 'unknown', authority: 'unknown' } });
    expect(update.statusCode).toBe(200);
    expect(update.json().label.labeledAt).not.toBe(original.labeledAt);
    const oldRevision = await app.inject({ method: 'POST', url: '/api/labels', headers: writeHeaders(), payload: { ...validInput(), expectedLabeledAt: original.labeledAt } });
    expect(oldRevision.statusCode).toBe(409);
    expect(JSON.parse(await readFile(settings.labelsPath, 'utf8')).labels[0].documentType).toBe('unknown');
  });

  it('holds one exclusive writer lock and refuses mismatched or externally corrupted label files', async () => {
    await expect(createLabelServer(settings)).rejects.toThrow('另一标注服务');
    const differentDataset = { schemaVersion: 1, datasetId: 'not-this-dataset', labels: [] };
    await writeJson(settings.labelsPath, differentDataset);
    expect((await app!.inject({ method: 'POST', url: '/api/labels', headers: writeHeaders(), payload: validInput() })).statusCode).toBe(409);
    expect(JSON.parse(await readFile(settings.labelsPath, 'utf8'))).toEqual(differentDataset);
    await app!.close(); app = undefined;
    await expect(createLabelServer(settings)).rejects.toThrow('不属于当前数据集');
    expect(JSON.parse(await readFile(settings.labelsPath, 'utf8'))).toEqual(differentDataset);
    await expect(readFile(`${settings.labelsPath}.lock`)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('downloads only an allowlisted document as a safe attachment and validates submitted file hashes', async () => {
    const original = await app!.inject({ method: 'GET', url: '/api/documents/first/original', headers: { host } });
    expect(original.statusCode).toBe(200);
    expect(original.headers['content-type']).toBe('application/octet-stream');
    expect(original.headers['content-disposition']).toContain('attachment;');
    expect(original.headers['content-disposition']).not.toContain('<img');
    expect(contentHash(original.rawPayload)).toBe(manifest.documents[0]!.contentHash);
    expect((await app!.inject({ method: 'GET', url: '/api/documents/not-in-manifest/original', headers: { host } })).statusCode).toBe(404);
    expect((await app!.inject({ method: 'GET', url: '/api/documents/' + encodeURIComponent(settings.contextPath) + '/original', headers: { host } })).statusCode).toBe(404);
    const wrongVersion = await app!.inject({ method: 'POST', url: '/api/labels', headers: writeHeaders(), payload: { ...validInput(), contentHash: 'a'.repeat(64) } });
    expect(wrongVersion.statusCode).toBe(409);
  });
});
