import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import type { SourceFile } from '../../core/src/types.js';

const MAX_DOCUMENT_BYTES = 64 * 1024 * 1024;
const MAX_OUTPUT_BYTES = Math.ceil(MAX_DOCUMENT_BYTES / 3) * 4 + 32_768;
const TIMEOUT_MS = 30_000;
const oleSignature = Buffer.from('d0cf11e0a1b11ae1', 'hex');
interface Response { ok: boolean; encrypted?: boolean; data?: string; code?: string }

/** Make a local, decrypted derivative. Source credentials never enter argv, metadata, or logs. */
export async function decryptPdf(file: SourceFile, password: string): Promise<SourceFile> {
  const signature = Buffer.from(file.buffer.subarray(0, 1024)).includes(Buffer.from('%PDF-'));
  if (!signature && file.meta.mimeType !== 'application/pdf' && !/\.pdf$/i.test(file.meta.filename)) return file;
  return decrypt(file, password, 'pdf');
}

/** Office encryption wraps an OOXML ZIP in an OLE container; ordinary ZIPs need no helper. */
export async function decryptDocument(file: SourceFile, password: string): Promise<SourceFile> {
  if (/\.(docx|xlsx|pptx)$/i.test(file.meta.filename)) {
    if (!Buffer.from(file.buffer.subarray(0, 8)).equals(oleSignature)) return file;
    return decrypt(file, password, 'office');
  }
  return decryptPdf(file, password);
}

async function decrypt(file: SourceFile, password: string, kind: 'pdf' | 'office'): Promise<SourceFile> {
  const label = kind === 'pdf' ? 'PDF' : 'Office';
  const dependencies = kind === 'pdf' ? 'pypdf 和 cryptography' : 'msoffcrypto-tool';
  const script = fileURLToPath(new URL(`../../../scripts/decrypt-${kind}.py`, import.meta.url));
  const errors: Record<string, string> = {
    incorrect_password: `${label} 密码不正确，未生成解密副本。`,
    invalid_pdf: `${label} 文件无效或已损坏，无法解密。`,
    invalid_office: `${label} 文件无效或已损坏，无法解密。`,
    missing_dependencies: `${label} 解密依赖缺失，请为 PDF_PYTHON 对应的 Python 安装 ${dependencies}。`,
    too_large: `${label} 超出 64 MiB 解密大小限制。`,
    invalid_request: `${label} 解密输入无效。`,
    unsupported_encryption: `此 ${label} 的加密方式暂不支持。`,
    decryption_failed: `${label} 解密失败，原始文件已保留。`,
  };
  if (file.buffer.byteLength > MAX_DOCUMENT_BYTES) throw new Error(errors.too_large);
  if (typeof password !== 'string' || Buffer.byteLength(password, 'utf8') > 4096) throw new Error(errors.invalid_request);
  const result = await new Promise<Response>((resolve, reject) => {
    const child = spawn(process.env.PDF_PYTHON || 'python', [script], {
      shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
    });
    let settled = false, outputBytes = 0;
    const chunks: Buffer[] = [];
    const timer = setTimeout(() => fail(`${label} 解密超时，已终止本次处理。`), TIMEOUT_MS);
    function fail(message: string) {
      if (settled) return;
      settled = true; clearTimeout(timer); child.kill(); reject(new Error(message));
    }
    child.on('error', () => fail(`无法启动 ${label} 解密程序，请检查 PDF_PYTHON 配置及 Python 是否可用。`));
    // Drain diagnostic output without retaining it: a parser traceback may include document contents.
    child.stderr.on('data', () => {});
    child.stdout.on('data', (chunk: Buffer) => {
      outputBytes += chunk.length;
      if (outputBytes > MAX_OUTPUT_BYTES) { fail(errors.too_large); return; }
      chunks.push(chunk);
    });
    child.stdin.on('error', () => { /* Early child exit is reported by close/error below. */ });
    child.on('close', code => {
      if (settled) return;
      settled = true; clearTimeout(timer);
      if (code !== 0) { reject(new Error(errors.decryption_failed)); return; }
      try {
        const response = JSON.parse(Buffer.concat(chunks).toString('utf8')) as Response;
        if (response.ok !== true) { reject(new Error(errors[response.code ?? ''] ?? errors.decryption_failed)); return; }
        if (typeof response.encrypted !== 'boolean') throw new Error('Invalid helper response');
        resolve(response);
      } catch { reject(new Error(`${label} 解密程序返回了无效结果。`)); }
    });
    child.stdin.end(JSON.stringify({ password, data: Buffer.from(file.buffer).toString('base64') }));
  });
  if (!result.encrypted) return file;
  if (typeof result.data !== 'string' || !/^[A-Za-z0-9+/]*={0,2}$/.test(result.data)) throw new Error(`${label} 解密程序返回了无效文件。`);
  const buffer = Buffer.from(result.data, 'base64');
  if (buffer.length > MAX_DOCUMENT_BYTES) throw new Error(errors.too_large);
  const valid = kind === 'pdf' ? buffer.subarray(0, 1024).includes(Buffer.from('%PDF-')) : buffer.subarray(0, 4).equals(Buffer.from('504b0304', 'hex'));
  if (!valid) throw new Error(`${label} 解密程序返回了无效文件。`);
  return {
    ...file,
    buffer,
    contentHash: createHash('sha256').update(buffer).digest('hex'),
    meta: { ...file.meta, metadata: { ...file.meta.metadata, decrypted: true, originalContentHash: file.contentHash } },
  };
}
