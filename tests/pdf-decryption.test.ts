import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { beforeAll, afterEach, describe, expect, it, vi } from 'vitest';
import type { SourceFile } from '../packages/core/src/types.js';
import { decryptPdf } from '../packages/documents/src/decrypt.js';

const password = 'local-test-only 密码';
const hash = (buffer: Uint8Array) => createHash('sha256').update(buffer).digest('hex');
const source = (buffer: Uint8Array): SourceFile => ({ buffer, contentHash: hash(buffer), meta: { sourceId: 'test', sourceType: 'test_pdf', filename: 'encrypted.pdf', mimeType: 'application/pdf', sourceUri: 'https://example.test/original.pdf', metadata: { contentFingerprint: 'remote-stable-fingerprint' } } });
let plain: Uint8Array, encrypted: Uint8Array;

beforeAll(() => {
  const fixture = spawnSync(process.env.PDF_PYTHON || 'python', ['-c', `
import io, json, sys, base64
from pypdf import PdfWriter
from pypdf.generic import DictionaryObject, NameObject, DecodedStreamObject
password=json.loads(sys.stdin.buffer.read())['password']
writer=PdfWriter()
page=writer.add_blank_page(width=600,height=800)
font=DictionaryObject({NameObject('/Type'):NameObject('/Font'),NameObject('/Subtype'):NameObject('/Type1'),NameObject('/BaseFont'):NameObject('/Helvetica')})
page[NameObject('/Resources')]=DictionaryObject({NameObject('/Font'):DictionaryObject({NameObject('/F1'):writer._add_object(font)})})
stream=DecodedStreamObject();stream.set_data(b'BT /F1 14 Tf 72 700 Td (Authorized PDF local copy) Tj ET')
page[NameObject('/Contents')]=writer._add_object(stream)
writer.add_metadata({'/Title':'Local PDF fixture'})
plain=io.BytesIO();writer.write(plain)
writer.encrypt(password,algorithm='AES-256')
encrypted=io.BytesIO();writer.write(encrypted)
print(json.dumps({'plain':base64.b64encode(plain.getvalue()).decode(),'encrypted':base64.b64encode(encrypted.getvalue()).decode()}))
`], { input: JSON.stringify({ password }), encoding: 'utf8', timeout: 30_000, maxBuffer: 1024 * 1024, windowsHide: true, shell: false });
  if (fixture.status !== 0) throw new Error('PDF test fixtures require pypdf and cryptography in PDF_PYTHON (or python).');
  const result = JSON.parse(fixture.stdout); plain = Buffer.from(result.plain, 'base64'); encrypted = Buffer.from(result.encrypted, 'base64');
}, 30_000);
afterEach(() => vi.unstubAllEnvs());

async function text(buffer: Uint8Array) {
  const { getDocument } = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const task = getDocument({ data: Uint8Array.from(buffer), useSystemFonts: true, verbosity: 0 });
  try { const document = await task.promise; const page = await document.getPage(1); const content = await page.getTextContent(); return content.items.map(item => 'str' in item ? item.str : '').join(' '); }
  finally { await task.destroy(); }
}

describe('local PDF decryption', () => {
  it('requires a password for the original; makes a readable derivative without changing the original', async () => {
    await expect(text(encrypted)).rejects.toMatchObject({ name: 'PasswordException' });
    const original = source(encrypted), originalHash = original.contentHash;
    const decrypted = await decryptPdf(original, password);
    expect(await text(decrypted.buffer)).toContain('Authorized PDF local copy');
    expect(original.contentHash).toBe(originalHash);
    expect(hash(original.buffer)).toBe(originalHash);
    expect(decrypted.contentHash).toBe(hash(decrypted.buffer));
    expect(decrypted.contentHash).not.toBe(originalHash);
    expect(decrypted.meta.metadata).toMatchObject({ decrypted: true, originalContentHash: originalHash, contentFingerprint: 'remote-stable-fingerprint' });
    expect(JSON.stringify(decrypted.meta)).not.toContain(password);
    expect(decrypted.meta.sourceUri).toBe(original.meta.sourceUri);
    expect(original.meta.metadata).not.toHaveProperty('decrypted');
  }, 30_000);

  it('rejects an incorrect password without revealing it', async () => {
    const badPassword = 'wrong-secret-test';
    await expect(decryptPdf(source(encrypted), badPassword)).rejects.toThrow('PDF 密码不正确');
    await expect(decryptPdf(source(encrypted), '')).rejects.toThrow('PDF 密码不正确');
  }, 30_000);

  it('returns an unencrypted PDF with identical bytes and content hash', async () => {
    const original = source(plain);
    const decrypted = await decryptPdf(original, password);
    expect(decrypted).toBe(original);
    expect(decrypted.contentHash).toBe(hash(plain));
  });

  it('does not launch Python for a non-PDF file', async () => {
    vi.stubEnv('PDF_PYTHON', 'does-not-exist-test');
    const original = source(Buffer.from('Plain document')); original.meta.filename = 'note.txt'; original.meta.mimeType = 'text/plain';
    expect(await decryptPdf(original, password)).toBe(original);
  });

  it('rejects oversized input before launching a subprocess', async () => {
    vi.stubEnv('PDF_PYTHON', 'does-not-exist-test');
    await expect(decryptPdf(source(new Uint8Array(64 * 1024 * 1024 + 1)), password)).rejects.toThrow('64 MiB');
  });
});
