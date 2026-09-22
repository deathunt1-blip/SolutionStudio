import Fastify from 'fastify';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { mkdir, open, readFile, stat, unlink } from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { z } from 'zod';
import type { ParsedDocument, Registries } from '../../core/src/types.js';
import { parseDocument } from '../../parsers/src/index.js';
import { contentHash, loadContext, loadLabels, loadManifest, writeJsonAtomic } from './data.js';
import type { EvaluationDocument, EvaluationLabel, EvaluationLabels } from './types.js';
import { labelHtml, labelScript, labelStyles } from './label-page.js';

export interface LabelServerOptions {
  manifestPath: string;
  labelsPath: string;
  contextPath: string;
  port?: number;
}

class LabelError extends Error {
  constructor(public statusCode: number, message: string) { super(message); }
}

const labelInput = z.object({
  documentId: z.string().min(1).max(200),
  contentHash: z.string().regex(/^[a-f0-9]{64}$/),
  documentType: z.string().trim().min(1).max(200),
  authority: z.enum(['authoritative', 'reference', 'style_only', 'unknown']),
  labeledBy: z.string().trim().min(1).max(200),
  expectedLabeledAt: z.iso.datetime().nullable(),
  applications: z.array(z.string().trim().min(1).max(200)).max(100).optional(),
  topics: z.array(z.string().trim().min(1).max(200)).max(100).optional(),
  products: z.array(z.string().trim().min(1).max(200)).max(100).optional(),
  notes: z.string().max(10000).optional(),
}).strict();

const maxSourceBytes = 40 * 1024 * 1024;
const textLimit = 2_000_000;

function validateRegistries(input: z.infer<typeof labelInput>, registries: Registries) {
  if (!registries.documentTypes.some(item => item.key === input.documentType)) throw new LabelError(400, '请选择当前数据集中的文档类型。');
  for (const field of ['applications', 'topics'] as const) {
    if (input[field]?.some(value => !registries[field].some(item => item.key === value))) throw new LabelError(400, `${field} 含有未登记的选项。`);
  }
}

/** Independent local annotation service. It never opens a database or calls an LLM. */
export async function createLabelServer(options: LabelServerOptions) {
  const port = options.port ?? 4312;
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('标注服务端口无效。');
  const manifest = await loadManifest(resolve(options.manifestPath));
  const context = await loadContext(resolve(options.contextPath));
  const labelsPath = resolve(options.labelsPath);
  if ([resolve(options.manifestPath), resolve(options.contextPath)].includes(labelsPath)) throw new Error('标注文件不能覆盖清单或上下文文件。');
  const documents = new Map(manifest.documents.map(document => [document.id, document]));
  const lockPath = `${labelsPath}.lock`;
  const lockToken = randomBytes(24).toString('hex');
  await mkdir(dirname(labelsPath), { recursive: true });
  let lock: FileHandle;
  try { lock = await open(lockPath, 'wx', 0o600); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new Error('这份标注文件正在被另一标注服务使用。请先关闭原服务；异常退出时，确认原进程已结束后再移除同名 .lock 文件。');
    throw error;
  }
  const lockContents = JSON.stringify({ pid: process.pid, token: lockToken, openedAt: new Date().toISOString() });
  try { await lock.writeFile(lockContents); }
  catch (error) { await lock.close(); await unlink(lockPath); throw error; }
  let released = false;
  async function releaseLock() {
    if (released) return;
    released = true;
    await lock.close();
    if (await readFile(lockPath, 'utf8').catch(() => '') === lockContents) await unlink(lockPath);
  }
  try {
    try { await loadLabels(labelsPath, manifest); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      await writeJsonAtomic(labelsPath, { schemaVersion: 1, datasetId: manifest.datasetId, labels: [] } satisfies EvaluationLabels);
    }
  } catch (error) { await releaseLock(); throw error; }

  const app = Fastify({ logger: false, bodyLimit: 96 * 1024 });
  const csrfToken = randomBytes(32).toString('hex');
  const allowedHosts = new Set([`127.0.0.1:${port}`, `localhost:${port}`]);
  let pendingWrite: Promise<unknown> = Promise.resolve();
  const previewCache = new Map<string, ParsedDocument>();

  function documentById(id: string): EvaluationDocument {
    const document = documents.get(id);
    if (!document) throw new LabelError(404, '当前清单中没有这份文件。');
    return document;
  }
  async function source(document: EvaluationDocument) {
    let buffer: Buffer;
    try {
      const details = await stat(document.path);
      if (!details.isFile()) throw new LabelError(404, '原文件不可读取。');
      if (details.size > maxSourceBytes) throw new LabelError(413, '原文件超过本地标注预览的 40 MB 限制。');
      buffer = await readFile(document.path);
    } catch (error) {
      if (error instanceof LabelError) throw error;
      throw new LabelError(404, '原文件不可读取，请检查清单中的本地文件是否仍然存在。');
    }
    if (buffer.length > maxSourceBytes) throw new LabelError(413, '原文件超过本地标注预览的 40 MB 限制。');
    if (contentHash(buffer) !== document.contentHash) throw new LabelError(409, '原文件内容已变化，请重新生成数据集清单；旧版本标注不能保存到新文件。');
    return buffer;
  }
  async function labels() {
    try { return await loadLabels(labelsPath, manifest); }
    catch { throw new LabelError(409, '标注文件已被外部修改或不属于当前数据集。为保护已有标注，已停止写入。'); }
  }
  function serialize<T>(operation: () => Promise<T>): Promise<T> {
    const next = pendingWrite.then(operation, operation);
    pendingWrite = next.catch(() => undefined);
    return next;
  }

  app.addHook('onClose', async () => { await pendingWrite; await releaseLock(); });
  app.addHook('onRequest', async (request, reply) => {
    reply.header('Cache-Control', 'no-store').header('X-Content-Type-Options', 'nosniff').header('Referrer-Policy', 'no-referrer');
    reply.header('Content-Security-Policy', "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'");
    const host = request.headers.host;
    if (!host || !allowedHosts.has(host)) throw new LabelError(403, '标注服务只允许本机访问。');
    const origin = request.headers.origin;
    if ((origin && origin !== `http://${host}`) || request.headers['sec-fetch-site'] === 'cross-site') throw new LabelError(403, '不允许跨站访问本地标注数据。');
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      const supplied = request.headers['x-label-csrf'];
      if (origin !== `http://${host}` || typeof supplied !== 'string' || !/^[a-f0-9]{64}$/.test(supplied) || !timingSafeEqual(Buffer.from(supplied), Buffer.from(csrfToken))) throw new LabelError(403, '页面验证失败，请从本机标注页面重新打开。');
    }
  });
  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof LabelError) return reply.code(error.statusCode).send({ error: error.message });
    if (error instanceof z.ZodError) return reply.code(400).send({ error: '请明确选择文档类型、权威级别，并填写真实标注人；不要提交空值或未经完整核对的字段。' });
    const code = typeof error === 'object' && error && 'statusCode' in error ? Number(error.statusCode) : 500;
    return reply.code(code >= 400 && code < 500 ? code : 500).send({ error: code === 413 ? '提交的标注内容过大。' : '标注操作失败，原有标注已保留。请检查本地文件或服务日志。' });
  });
  app.get('/', async (_request, reply) => reply.type('text/html; charset=utf-8').send(labelHtml));
  app.get('/app.js', async (_request, reply) => reply.type('application/javascript; charset=utf-8').send(labelScript));
  app.get('/app.css', async (_request, reply) => reply.type('text/css; charset=utf-8').send(labelStyles));
  app.get('/api/dataset', async () => {
    const current = await labels();
    return {
      datasetId: manifest.datasetId,
      csrfToken,
      registries: context.registries,
      documents: manifest.documents.map(({ id, filename, contentHash }) => ({ id, filename, contentHash })),
      labeledIds: current.labels.map(label => label.documentId),
    };
  });
  app.get<{ Params: { id: string }; Querystring: { full?: string } }>('/api/documents/:id', async request => {
    const document = documentById(request.params.id);
    const buffer = await source(document);
    let parsed = previewCache.get(document.id);
    if (!parsed) {
      parsed = await parseDocument({ buffer, contentHash: document.contentHash, meta: { filename: document.filename, sourceId: document.id, sourceType: 'evaluation' } });
      previewCache.set(document.id, parsed);
    }
    const current = await labels();
    const full = request.query.full === '1';
    return {
      id: document.id, filename: document.filename, contentHash: document.contentHash,
      title: parsed.title ?? '',
      summary: parsed.blocks.filter(block => block.type === 'paragraph').slice(0, 3).map(block => block.text).join('\n').slice(0, 1000) || parsed.plainText.slice(0, 1000),
      headings: parsed.blocks.filter(block => block.type === 'heading').slice(0, 16).map(block => block.text),
      excerpt: parsed.plainText.slice(0, 6000),
      ...(full ? { fullText: parsed.plainText.slice(0, textLimit), fullTextTruncated: parsed.plainText.length > textLimit } : {}),
      parseStatus: parsed.parseStatus, parseWarnings: parsed.parseWarnings,
      label: current.labels.find(label => label.documentId === document.id) ?? null,
    };
  });
  app.get<{ Params: { id: string } }>('/api/documents/:id/original', async (request, reply) => {
    const document = documentById(request.params.id);
    const buffer = await source(document);
    const safeName = encodeURIComponent(document.filename).replace(/['()*]/g, character => `%${character.charCodeAt(0).toString(16).toUpperCase()}`);
    return reply.type('application/octet-stream').header('Content-Disposition', `attachment; filename="document"; filename*=UTF-8''${safeName}`).send(buffer);
  });
  app.post('/api/labels', async request => {
    const input = labelInput.parse(request.body);
    validateRegistries(input, context.registries);
    return serialize(async () => {
      const document = documentById(input.documentId);
      if (document.contentHash !== input.contentHash) throw new LabelError(409, '页面中的文件版本已过期，请重新打开当前文件。');
      await source(document);
      const current = await labels();
      const previous = current.labels.find(label => label.documentId === document.id);
      if ((previous?.labeledAt ?? null) !== input.expectedLabeledAt) throw new LabelError(409, '这份文件的标注已在其他页面更改，请重新加载后再修改。');
      const { expectedLabeledAt: _revision, ...fields } = input;
      const label: EvaluationLabel = {
        ...fields,
        filename: document.filename,
        origin: 'human',
        labeledAt: new Date(Math.max(Date.now(), previous ? Date.parse(previous.labeledAt) + 1 : 0)).toISOString(),
      };
      for (const field of ['applications', 'topics', 'products'] as const) if (label[field]) label[field] = [...new Set(label[field])];
      const next = current.labels.filter(candidate => candidate.documentId !== document.id);
      next.push(label);
      await writeJsonAtomic(labelsPath, { ...current, labels: next });
      return { label, labeledCount: next.length, total: manifest.documents.length };
    });
  });
  return app;
}
