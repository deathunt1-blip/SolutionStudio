import { mkdir, readFile, writeFile, rename } from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { ObjectStorage } from '../../core/src/types.js';

/** All derived storage keys are relative; original file names are metadata only. */
export class LocalObjectStorage implements ObjectStorage {
  private readonly root: string;
  constructor(baseDir: string) { this.root = resolve(baseDir); }
  private path(key: string) {
    if (!key || isAbsolute(key) || key.includes('\0')) throw new Error('Invalid storage key');
    const target = resolve(this.root, key);
    const rel = relative(this.root, target);
    if (rel.startsWith('..') || isAbsolute(rel) || !rel) throw new Error('Storage key escapes root');
    return target;
  }
  async put(key: string, data: Uint8Array) {
    const target = this.path(key);
    await mkdir(dirname(target), { recursive: true });
    const temporary = `${target}.${randomUUID()}.tmp`;
    await writeFile(temporary, data, { mode: 0o600 });
    await rename(temporary, target);
  }
  async get(key: string): Promise<Uint8Array> { return readFile(this.path(key)); }
}
