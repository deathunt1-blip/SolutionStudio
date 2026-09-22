import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createApp } from '../apps/server/src/app.js';

describe('isolated batch queue and version race coverage without LLM requests', () => {
  let app: Awaited<ReturnType<typeof createApp>>;
  let directory: string;
  beforeAll(async () => {
    directory = await mkdtemp(path.join(tmpdir(), 'solution-studio-batch-'));
    app = await createApp({ dataDir: directory, databaseUrl: '', llmDisabled: true });
  }, 30_000);
  afterAll(async () => {
    await app?.close();
    // The only removal target is the absolute mkdtemp result inside the OS temporary directory.
    if (directory && path.dirname(directory) === path.resolve(tmpdir()) && path.basename(directory).startsWith('solution-studio-batch-')) await rm(directory, { recursive: true, force: true });
  }, 30_000);

  async function upload(files: { name: string; text: string }[], fields: Record<string, string> = {}) {
    const form = new FormData();
    for (const [key, value] of Object.entries(fields)) form.set(key, value);
    for (const file of files) form.append('files', new Blob([file.text]), file.name);
    const request = new Request('http://localhost/api/upload', { method: 'POST', body: form });
    const response = await app.inject({ method: 'POST', url: '/api/upload', headers: { 'content-type': request.headers.get('content-type')! }, payload: Buffer.from(await request.arrayBuffer()) });
    expect(response.statusCode).toBe(202);
    return response.json().results as { filename: string; status: string; documentId?: string; message?: string }[];
  }

  async function idle() {
    const deadline = Date.now() + 45_000;
    while (Date.now() < deadline) {
      const jobs = (await app.inject('/api/jobs')).json().items as { status: string }[];
      if (!jobs.some(job => ['queued', 'running'].includes(job.status))) return;
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    throw new Error('Isolated batch queue did not drain within 45 seconds');
  }

  test('one 52-file multipart request continues after malformed and unsupported members', async () => {
    const good = Array.from({ length: 50 }, (_, index) => ({ name: `batch-${index}-技术方案.md`, text: `# 技术方案\n\n机器人相机部署批次 ${index}，使用网络同步完成采集。唯一检索标记 bulkmarker${String(index).padStart(3, '0')}。` }));
    const files = [...good.slice(0, 17), { name: 'corrupt-middle.pdf', text: 'This is deliberately not a PDF.' }, ...good.slice(17, 33), { name: 'unsupported.exe', text: 'Synthetic unsupported attachment.' }, ...good.slice(33)];
    const results = await upload(files);
    expect(results).toHaveLength(52);
    expect(results.filter(result => result.status === 'queued')).toHaveLength(51);
    expect(results.find(result => result.filename === 'unsupported.exe')?.status).toBe('error');
    await idle();
    const stats = (await app.inject('/api/stats')).json();
    expect(stats.total).toBe(51); expect(stats.active).toBe(50); expect(stats.failed).toBe(1); expect(stats.processing).toBe(0);
    const corrupt = results.find(result => result.filename === 'corrupt-middle.pdf')!;
    const failed = (await app.inject(`/api/documents/${corrupt.documentId}`)).json();
    expect(failed.document.status).toBe('failed'); expect(failed.document.parseWarnings.length).toBeGreaterThan(0); expect(failed.chunks).toHaveLength(0);
    expect((await app.inject(`/api/documents/${corrupt.documentId}/original`)).body).toBe('This is deliberately not a PDF.');
    for (const marker of ['bulkmarker000', 'bulkmarker016', 'bulkmarker017', 'bulkmarker033', 'bulkmarker049']) {
      const result = (await app.inject(`/api/search?q=${marker}`)).json();
      expect(result.total, `A valid document surrounding failed members must remain searchable: ${marker}`).toBeGreaterThan(0);
    }
  }, 60_000);

  test('twelve concurrent identical submissions create exactly one document and one ingestion job', async () => {
    const before = (await app.inject('/api/stats')).json().total;
    const text = '# 技术方案\n\n并发上传相同原文，机器人相机采用网络时钟同步。concurrentunique';
    const responses = await Promise.all(Array.from({ length: 12 }, (_, index) => upload([{ name: `parallel-${index}.md`, text }])));
    const results = responses.flat();
    expect(results.filter(result => result.status === 'queued')).toHaveLength(1);
    expect(results.filter(result => result.status === 'duplicate')).toHaveLength(11);
    const ids = new Set(results.map(result => result.documentId)); expect(ids.size).toBe(1);
    await idle();
    expect((await app.inject('/api/stats')).json().total).toBe(before + 1);
    const id = [...ids][0];
    const jobs = (await app.inject('/api/jobs')).json().items as { documentId: string; status: string }[];
    expect(jobs.filter(job => job.documentId === id)).toHaveLength(1);
    expect((await app.inject(`/api/documents/${id}/original`)).body).toBe(text);
  }, 30_000);

  test('rapid same-path revisions retain all originals while search exposes only the latest version', async () => {
    const markers = ['olderalpha', 'olderbeta', 'oldergamma', 'olderdelta', 'currentomega'];
    const texts = markers.map((marker, index) => `# 技术方案\n\n机器人相机部署方案，修订 ${index + 1}，独有检索词 ${marker}。`);
    const ids: (string | undefined)[] = [];
    // No job wait between uploads: earlier queue items must not overwrite the final version.
    for (const text of texts) ids.push((await upload([{ name: 'rapid-技术方案.md', text }], { sourcePath: 'batch-test/rapid-技术方案.md' }))[0]!.documentId);
    expect(new Set(ids).size).toBe(1);
    await idle();
    const id = ids[0];
    const detail = (await app.inject(`/api/documents/${id}`)).json();
    expect(detail.document.status).toBe('active'); expect(detail.document.versionNumber).toBe(5); expect(detail.versions).toHaveLength(5);
    expect(detail.versions.filter((version: { status: string }) => version.status === 'active')).toHaveLength(1);
    expect(detail.versions.filter((version: { status: string }) => version.status === 'superseded')).toHaveLength(4);
    for (const version of detail.versions as { id: string; versionNumber: number }[]) {
      expect((await app.inject(`/api/documents/${id}/original?versionId=${version.id}`)).body).toBe(texts[version.versionNumber - 1]);
    }
    expect(detail.chunks.every((chunk: { versionId: string }) => chunk.versionId === detail.document.activeVersionId)).toBe(true);
    expect((await app.inject(`/api/documents/${id}/original`)).body).toBe(texts[4]);
    for (const marker of markers.slice(0, -1)) expect((await app.inject(`/api/search?q=${marker}`)).json().total).toBe(0);
    const search = (await app.inject('/api/search?q=currentomega')).json();
    expect(search.total).toBeGreaterThan(0); expect(search.items.every((item: { document: { id: string }; chunk: { versionId: string } }) => item.document.id === id && item.chunk.versionId === detail.document.activeVersionId)).toBe(true);
  }, 45_000);
});
