import { createHash } from 'node:crypto';
import { readFile, readdir, stat, realpath } from 'node:fs/promises';
import { basename, extname, isAbsolute, join, relative, resolve } from 'node:path';
import type { KnowledgeSourceAdapter, SourceDocumentMeta, SourceFile } from '../../core/src/types.js';

export const supportedExtensions = new Set(['.docx', '.pdf', '.xlsx', '.xls', '.csv', '.md', '.txt']);
export const contentHash = (buffer: Uint8Array) => createHash('sha256').update(buffer).digest('hex');

export class SourceRegistry {
  private adapters = new Map<string, KnowledgeSourceAdapter>();
  register(adapter: KnowledgeSourceAdapter) { this.adapters.set(adapter.type, adapter); return this; }
  get(type: string) { const adapter = this.adapters.get(type); if (!adapter) throw new Error(`Unknown source adapter: ${type}`); return adapter; }
  list() { return [...this.adapters.keys()]; }
}

/** The upload request passes bytes to the adapter; no source-specific logic enters ingestion. */
export class ManualUploadAdapter implements KnowledgeSourceAdapter {
  type = 'manual';
  async fetchDocument(id: string, config: Record<string, unknown> = {}): Promise<SourceFile> {
    if (!(config.buffer instanceof Uint8Array)) throw new Error('Upload bytes required');
    const filename = basename(String(config.filename ?? id).replaceAll('\\', '/'));
    return { meta: { sourceId: id, sourceType: this.type, filename, sourcePath: typeof config.sourcePath === 'string' ? config.sourcePath : filename }, buffer: config.buffer, contentHash: contentHash(config.buffer) };
  }
}

/** An explicit root is required. Symlinks and paths outside it cannot be imported. */
export class LocalFolderAdapter implements KnowledgeSourceAdapter {
  type = 'local_folder';
  async listDocuments(config: Record<string, unknown>): Promise<SourceDocumentMeta[]> {
    const root = await realpath(resolve(String(config.root)));
    const found: SourceDocumentMeta[] = [];
    const walk = async (dir: string) => {
      for (const item of await readdir(dir, { withFileTypes: true })) {
        if (item.isSymbolicLink() || item.name.startsWith('~$') || item.name.startsWith('.')) continue;
        const path = join(dir, item.name);
        if (item.isDirectory()) await walk(path);
        else if (supportedExtensions.has(extname(item.name).toLowerCase())) {
          const info = await stat(path); const sourcePath = relative(root, path).replaceAll('\\', '/');
          found.push({ sourceId: sourcePath, sourceType: this.type, filename: item.name, sourcePath, version: `${info.mtimeMs}:${info.size}`, modifiedAt: info.mtime.toISOString(), metadata: { bytes: info.size } });
        }
      }
    };
    await walk(root); return found;
  }
  async fetchDocument(id: string, config: Record<string, unknown> = {}): Promise<SourceFile> {
    const root = await realpath(resolve(String(config.root)));
    const path = await realpath(resolve(root, id)); const rel = relative(root, path);
    if (!rel || rel.startsWith('..') || isAbsolute(rel)) throw new Error('Source path outside configured folder');
    const buffer = await readFile(path); const info = await stat(path);
    return { meta: { sourceId: id, sourceType: this.type, filename: basename(path), sourcePath: rel.replaceAll('\\', '/'), version: `${info.mtimeMs}:${info.size}`, modifiedAt: info.mtime.toISOString() }, buffer, contentHash: contentHash(buffer) };
  }
}

/** Explicit development fixture, never represents a connected Feishu account. */
export class MockFeishuAdapter implements KnowledgeSourceAdapter {
  type = 'feishu_mock';
  constructor(private files: SourceFile[] = []) {}
  async listDocuments() { return this.files.map(file => ({ ...file.meta, sourceType: this.type })); }
  async fetchDocument(id: string) {
    const file = this.files.find(value => value.meta.sourceId === id);
    if (!file) throw new Error('Mock source document not found');
    return { ...file, meta: { ...file.meta, sourceType: this.type } };
  }
  async getVersion(id: string) { return (await this.fetchDocument(id)).meta.version ?? null; }
}

export const sourceRegistry = new SourceRegistry().register(new ManualUploadAdapter()).register(new LocalFolderAdapter()).register(new MockFeishuAdapter());
