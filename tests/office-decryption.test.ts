import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { SourceFile } from '../packages/core/src/types.js';
import { decryptDocument, decryptPdf } from '../packages/documents/src/decrypt.js';
import { DOCXParser } from '../packages/parsers/src/index.js';

const password = 'office-test-only 密码';
const hash = (buffer: Uint8Array) => createHash('sha256').update(buffer).digest('hex');
const file = (buffer: Uint8Array, extension = 'docx'): SourceFile => ({ buffer, contentHash: hash(buffer), meta: { sourceId: 'test', sourceType: 'test', filename: `authorized.${extension}`, metadata: { contentFingerprint: 'original-remote-fingerprint' } } });
let fixtures: Record<string, { plain: Buffer; encrypted: Buffer }>;

beforeAll(() => {
  const result = spawnSync(process.env.PDF_PYTHON || 'python', ['-c', `
import base64,io,json,sys,zipfile
from msoffcrypto.format.ooxml import OOXMLFile
password=json.loads(sys.stdin.buffer.read())['password']
rels='http://schemas.openxmlformats.org/package/2006/relationships'
office='http://schemas.openxmlformats.org/officeDocument/2006/relationships'
word='<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>Authorized Office local copy</w:t></w:r></w:p></w:body></w:document>'
workbook='<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="'+office+'"><sheets><sheet name="Main" sheetId="1" r:id="rId1"/></sheets></workbook>'
worksheet='<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>Authorized Office local copy</t></is></c></row></sheetData></worksheet>'
presentation='<p:presentation xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:r="'+office+'"><p:sldIdLst><p:sldId id="256" r:id="rId1"/></p:sldIdLst></p:presentation>'
slide='<p:sld xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><p:cSld><p:spTree><p:sp><p:txBody><a:bodyPr/><a:lstStyle/><a:p><a:r><a:t>Authorized Office local copy</a:t></a:r></a:p></p:txBody></p:sp></p:spTree></p:cSld></p:sld>'
specs={'docx':('word/document.xml','application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml',{'word/document.xml':word}),
 'xlsx':('xl/workbook.xml','application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml',{'xl/workbook.xml':workbook,'xl/worksheets/sheet1.xml':worksheet,'xl/_rels/workbook.xml.rels':'<Relationships xmlns="'+rels+'"><Relationship Id="rId1" Type="'+office+'/worksheet" Target="worksheets/sheet1.xml"/></Relationships>'}),
 'pptx':('ppt/presentation.xml','application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml',{'ppt/presentation.xml':presentation,'ppt/slides/slide1.xml':slide,'ppt/_rels/presentation.xml.rels':'<Relationships xmlns="'+rels+'"><Relationship Id="rId1" Type="'+office+'/slide" Target="slides/slide1.xml"/></Relationships>'})}
results={}
for extension,(main,ctype,parts) in specs.items():
 out=io.BytesIO()
 with zipfile.ZipFile(out,'w',zipfile.ZIP_DEFLATED) as z:
  z.writestr('[Content_Types].xml','<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/'+main+'" ContentType="'+ctype+'"/></Types>')
  z.writestr('_rels/.rels','<Relationships xmlns="'+rels+'"><Relationship Id="rId1" Type="'+office+'/officeDocument" Target="'+main+'"/></Relationships>')
  for name,content in parts.items(): z.writestr(name,content)
  z.writestr('fixture-padding.bin',bytes(range(256))*24,compress_type=zipfile.ZIP_STORED)
 raw=out.getvalue(); encrypted=io.BytesIO(); OOXMLFile(io.BytesIO(raw)).encrypt(password,encrypted)
 results[extension]={'plain':base64.b64encode(raw).decode(),'encrypted':base64.b64encode(encrypted.getvalue()).decode()}
print(json.dumps(results))
`], { input: JSON.stringify({ password }), encoding: 'utf8', timeout: 30_000, maxBuffer: 1024 * 1024, windowsHide: true, shell: false });
  if (result.status !== 0) throw new Error('Office fixtures require msoffcrypto-tool in PDF_PYTHON (or python).');
  fixtures = Object.fromEntries(Object.entries(JSON.parse(result.stdout) as Record<string, { plain: string; encrypted: string }>).map(([key, value]) => [key, { plain: Buffer.from(value.plain, 'base64'), encrypted: Buffer.from(value.encrypted, 'base64') }]));
}, 30_000);
afterEach(() => vi.unstubAllEnvs());

describe('provider-neutral Office decryption', () => {
  it.each(['docx', 'xlsx', 'pptx'])('decrypts actual OLE-encrypted %s into the original OOXML ZIP bytes', async extension => {
    const fixture = fixtures[extension];
    expect(fixture.encrypted.subarray(0, 8).toString('hex')).toBe('d0cf11e0a1b11ae1');
    const original = file(fixture.encrypted, extension);
    const decrypted = await decryptDocument(original, password);
    expect(Buffer.from(decrypted.buffer).equals(fixture.plain)).toBe(true);
    expect(decrypted.contentHash).toBe(hash(fixture.plain));
    expect(hash(original.buffer)).toBe(original.contentHash);
    expect(decrypted.meta.metadata).toMatchObject({ decrypted: true, originalContentHash: original.contentHash, contentFingerprint: 'original-remote-fingerprint' });
    expect(JSON.stringify(decrypted.meta)).not.toContain(password);
    expect(original.meta.metadata).not.toHaveProperty('decrypted');
  }, 30_000);

  it('lets the existing DOCX parser extract text only after decryption', async () => {
    const original = file(fixtures.docx.encrypted);
    await expect(new DOCXParser().parse(original)).rejects.toThrow();
    const decrypted = await decryptDocument(original, password);
    expect((await new DOCXParser().parse(decrypted)).plainText).toContain('Authorized Office local copy');
  }, 30_000);

  it('rejects wrong and empty passwords with a safe fixed error', async () => {
    await expect(decryptDocument(file(fixtures.docx.encrypted), 'wrong-office-secret')).rejects.toThrow('Office 密码不正确');
    await expect(decryptDocument(file(fixtures.docx.encrypted), '')).rejects.toThrow('Office 密码不正确');
  }, 30_000);

  it.each(['docx', 'xlsx', 'pptx'])('keeps an ordinary %s ZIP unchanged without launching Python', async extension => {
    vi.stubEnv('PDF_PYTHON', 'does-not-exist-test');
    const original = file(fixtures[extension].plain, extension);
    expect(await decryptDocument(original, password)).toBe(original);
    expect(await decryptPdf(original, password)).toBe(original);
  });
});
