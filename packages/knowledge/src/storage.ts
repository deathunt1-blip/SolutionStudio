import { mkdir, readFile, open, link, unlink } from 'node:fs/promises';
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
    const bytes = Buffer.from(data);
    const existingMatches = async () => {
      let existing: Buffer;
      try { existing = await readFile(target); }
      catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw error; }
      if (!existing.equals(bytes)) throw new Error('Object key already contains different content; immutable original was preserved');
      return true;
    };
    // Repeated content-addressed writes are idempotent, including across app instances.
    if (await existingMatches()) return;
    await mkdir(dirname(target), { recursive: true });
    const temporary = `${target}.${randomUUID()}.tmp`;
    let ownsTemporary = false;
    try {
      const handle = await open(temporary, 'wx', 0o600);
      ownsTemporary = true;
      try { await handle.writeFile(bytes); } finally { await handle.close(); }
      try {
        // Publishing a completed file with a hard link is atomic and never replaces an
        // existing destination. rename() could overwrite it or fail with EPERM on Windows.
        await link(temporary, target);
      } catch (error) {
        // Another writer may have published the same key first. Accept only exact bytes.
        if (!await existingMatches()) throw error;
      }
    } finally {
      // Each call owns only its UUID temp path; never remove the published original.
      if (ownsTemporary) await unlink(temporary).catch(error => { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; });
    }
  }
  async get(key: string): Promise<Uint8Array> { return readFile(this.path(key)); }
}
