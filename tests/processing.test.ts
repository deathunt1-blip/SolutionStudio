import { afterEach, describe, expect, it, vi } from 'vitest';
import * as XLSX from 'xlsx';
import { parseDocument } from '../packages/parsers/src/index.js';
import { buildFingerprint, classifyDocument, reviewReasons } from '../packages/classification/src/index.js';
import { chunkDocument, tokenUpperBound } from '../packages/ingestion/src/chunking.js';
import { KimiProvider } from '../packages/llm/src/index.js';
import { Agent } from 'undici';
import type { Classification, ConfirmedExample, LLMProvider, ParsedDocument, Registries, SourceFile } from '../packages/core/src/types.js';

const registries: Registries = {
  documentTypes: [{ key: 'solution', label: '技术方案', aliases: ['解决方案'] }, { key: 'manual', label: '使用说明', aliases: [] }, { key: 'test_report', label: '测试报告', aliases: [] }, { key: 'unknown', label: '未知', aliases: [] }],
  applications: [{ key: 'robotics', label: '机器人', aliases: ['robot'] }],
  topics: [{ key: 'synchronization', label: '同步', aliases: ['PTP', 'IEEE1588', '时钟同步'] }, { key: 'camera', label: '相机', aliases: ['camera'] }],
};
const file = (name: string, text: string | Uint8Array): SourceFile => ({ meta: { sourceId: 'test', sourceType: 'upload', filename: name }, contentHash: 'test-hash', buffer: typeof text === 'string' ? Buffer.from(text) : text });
const parsed = (text: string): ParsedDocument => ({ plainText: text, blocks: [{ type: 'paragraph', text }], tables: [], metadata: {}, parseWarnings: [], parseStatus: 'success' });
const field = <T>(value: T, confidence = 0.95) => ({ value, confidence, source: 'ai' as const });
const classification = (): Classification => ({ documentType: field('solution'), applications: field(['robotics']), topics: field(['camera']), products: field(['MODEL-Z7']), authority: field('reference' as const), language: field('zh') });
const response = (overrides: Record<string, unknown> = {}) => ({ classification: { ...classification(), documentType: { ...field('solution'), evidence: '技术方案' }, authority: { ...field('reference'), evidence: '技术方案' }, ...overrides }, summary: '参考资料' });

// Minimal ZIP writer keeps DOCX fixtures explicit and independent of office software.
function zip(files: Record<string, string>): Buffer {
  const entries: Buffer[] = [], directory: Buffer[] = []; let offset = 0;
  const crc = (data: Buffer) => { let value = 0xffffffff; for (const byte of data) { value ^= byte; for (let bit = 0; bit < 8; bit++) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1; } return (value ^ 0xffffffff) >>> 0; };
  for (const [name, text] of Object.entries(files)) {
    const filename = Buffer.from(name), data = Buffer.from(text), checksum = crc(data), local = Buffer.alloc(30), central = Buffer.alloc(46);
    local.writeUInt32LE(0x04034b50); local.writeUInt16LE(20, 4); local.writeUInt32LE(checksum, 14); local.writeUInt32LE(data.length, 18); local.writeUInt32LE(data.length, 22); local.writeUInt16LE(filename.length, 26);
    central.writeUInt32LE(0x02014b50); central.writeUInt16LE(20, 4); central.writeUInt16LE(20, 6); central.writeUInt32LE(checksum, 16); central.writeUInt32LE(data.length, 20); central.writeUInt32LE(data.length, 24); central.writeUInt16LE(filename.length, 28); central.writeUInt32LE(offset, 42);
    entries.push(local, filename, data); directory.push(central, filename); offset += local.length + filename.length + data.length;
  }
  const cd = Buffer.concat(directory), end = Buffer.alloc(22); end.writeUInt32LE(0x06054b50); end.writeUInt16LE(Object.keys(files).length, 8); end.writeUInt16LE(Object.keys(files).length, 10); end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...entries, cd, end]);
}
function pdf(text = ''): Buffer {
  const stream = text ? `BT /F1 12 Tf 20 200 Td (${text}) Tj ET` : '';
  const objects = ['<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [3 0 R] /Count 1 >>', '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 300] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>', '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>', `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`];
  let output = '%PDF-1.4\n'; const offsets = [0];
  for (const [index, object] of objects.entries()) { offsets.push(Buffer.byteLength(output)); output += `${index + 1} 0 obj\n${object}\nendobj\n`; }
  const xref = Buffer.byteLength(output); output += `xref\n0 6\n0000000000 65535 f \n${offsets.slice(1).map(offset => `${String(offset).padStart(10, '0')} 00000 n `).join('\n')}\ntrailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
  return Buffer.from(output);
}

describe('format parsers preserve source structure and failure visibility', () => {
  it('preserves markdown heading paths and tables', async () => {
    const output = await parseDocument(file('方案.md', '# 项目方案\n\n正文内容\n\n## 配置\n\n| 产品 | 数量 |\n| --- | --- |\n| Z7 | 2 |'));
    expect(output.parseStatus).toBe('success'); expect(output.tables[0]?.rows[1]).toEqual(['Z7', '2']);
    expect(output.blocks.at(-1)?.headingPath).toEqual(['项目方案', '配置']);
  });
  it('reads docx paragraphs, headings and table cells in document order', async () => {
    const buffer = zip({ '[Content_Types].xml': '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>',
      '_rels/.rels': '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>',
      'word/document.xml': '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>技术方案</w:t></w:r></w:p><w:p><w:r><w:t>机器人相机部署</w:t></w:r></w:p><w:tbl><w:tr><w:tc><w:p><w:r><w:t>MODEL-Z7</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>2</w:t></w:r></w:p></w:tc></w:tr></w:tbl></w:body></w:document>' });
    const output = await parseDocument(file('方案.docx', buffer));
    expect(output.parseStatus).not.toBe('failed'); expect(output.plainText).toContain('机器人相机部署'); expect(output.tables[0]?.rows[0]).toEqual(['MODEL-Z7', '2']);
  });
  it.each(['xlsx', 'xls'] as const)('reads %s workbook sheet names and displayed cell values', async format => {
    const workbook = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet([['产品', '数量'], ['MODEL-Z7', 2]]), '设备清单');
    const output = await parseDocument(file(`设备.${format}`, XLSX.write(workbook, { type: 'buffer', bookType: format })));
    expect(output.parseStatus).toBe('success'); expect(output.tables[0]?.title).toBe('设备清单'); expect(output.tables[0]?.rows[1]).toEqual(['MODEL-Z7', '2']);
  });
  it('handles quoted multiline CSV fields and UTF-16 text', async () => {
    const output = await parseDocument(file('设备.csv', '产品,备注\nZ7,"first, second\nnext line"'));
    expect(output.tables[0]?.rows[1]?.[1]).toBe('first, second\nnext line');
    const text = await parseDocument(file('utf16.txt', Buffer.concat([Buffer.from([255, 254]), Buffer.from('中文方案内容', 'utf16le')])));
    expect(text.plainText).toBe('中文方案内容');
  });
  it('extracts PDF text and labels image-only/empty pages as failed', async () => {
    expect((await parseDocument(file('text.pdf', pdf('Technical solution sample')))).plainText).toContain('Technical solution sample');
    const scanned = await parseDocument(file('scan.pdf', pdf())); expect(scanned.parseStatus).toBe('failed'); expect(scanned.parseWarnings.join(' ')).toContain('OCR');
  });
  it('returns visible failures for corrupted, empty and unsupported files', async () => {
    for (const input of [file('bad.pdf', 'invalid'), file('empty.txt', ''), file('legacy.doc', 'word')]) { const output = await parseDocument(input); expect(output.parseStatus).toBe('failed'); expect(output.parseWarnings.length).toBeGreaterThan(0); }
  });
});

describe('grounded classification and confidence gates', () => {
  it('recognizes a filename ending in a domain-specific proposal name without an invented product list', async () => {
    const output = await classifyDocument(file('Avatar拍摄方案.docx', '').meta, parsed('项目描述与摄影部署配置。'), registries, []);
    expect(output.classification.documentType.value).toBe('solution'); expect(output.classification.authority.value).toBe('reference');
    expect(reviewReasons(output.classification, 0.6)).toEqual([]); expect(output.classification.products.value).toEqual([]);
  });
  it('normalizes aliases, removes unsupported product claims, and rejects fake authority', async () => {
    const provider: LLMProvider = { generate: async () => ({ content: `\`\`\`json\n${JSON.stringify(response({ topics: field(['PTP', 'IEEE1588', 'invented']), products: field(['MODEL-Z7', 'FAKE-999']), authority: { ...field('authoritative'), evidence: 'not in document' } }))}\n\`\`\`` }) };
    const output = await classifyDocument(file('技术方案.md', '').meta, parsed('技术方案。机器人设备 MODEL-Z7 支持 PTP 时钟同步。'), registries, [], provider);
    expect(output.classification.topics.value).toEqual(['synchronization']); expect(output.classification.products.value).toEqual(['MODEL-Z7']);
    expect(output.classification.authority.value).toBe('unknown'); expect(reviewReasons(output.classification,0.6)).toContain('权威级别需要确认'); expect(output.warnings.length).toBeGreaterThan(0);
  });
  it('only key fields block review, and unknown blocks even at confidence 1', () => {
    const value = classification(); value.topics.confidence = 0.1; value.products.confidence = 0;
    expect(reviewReasons(value, 0.6)).toEqual([]); value.documentType = field('unknown', 1);
    expect(reviewReasons(value, 0.6)).toEqual(['文档类型需要确认']); value.documentType = field('solution', 0.59);
    expect(reviewReasons(value, 0.6)).toHaveLength(1);
  });
  it('uses validated rules when AI JSON has invalid confidence; never leaks provider errors', async () => {
    const invalid: LLMProvider = { generate: async () => ({ content: JSON.stringify(response({ documentType: field('solution', 1.5) })) }) };
    const output = await classifyDocument(file('技术方案.md', '').meta, parsed('机器人相机 MODEL-Z7 的技术方案。'), registries, [], invalid);
    expect(output.classification.documentType.source).toBe('rule'); expect(output.warnings.join('')).toContain('结构校验');
    const throwing: LLMProvider = { generate: async () => { throw new Error('sk-secret-response'); } };
    expect(JSON.stringify(await classifyDocument(file('未知.txt', '').meta, parsed('碎片'), registries, [], throwing))).not.toContain('sk-secret');
  });
  it('includes confirmed examples and caps the complete prompt for huge source documents', async () => {
    const generate = vi.fn(async () => ({ content: JSON.stringify(response()) }));
    const example: ConfirmedExample = { id: 'example-1', documentId: 'doc-1', textSummary: '机器人相机部署确认案例', confirmedFields: { documentType: field('solution') }, createdAt: '2026-09-22' };
    const source = parsed('技术方案。机器人相机部署。'.repeat(30000));
    await classifyDocument(file('技术方案.md', '').meta, source, registries, [example], { generate });
    const request = generate.mock.calls[0] as unknown as [{ system: string; prompt: string }];
    expect(tokenUpperBound(request[0].system + request[0].prompt)).toBeLessThan(8000); expect(request[0].prompt).toContain('机器人相机部署确认案例'); expect(request[0].system).toContain('不可信数据');
    expect(tokenUpperBound(buildFingerprint(file('file.md', '').meta, source))).toBeLessThanOrEqual(3200);
  });
  it('does not silently promote an unregistered document type', async () => {
    const output = await classifyDocument(file('资料.txt', '').meta, parsed('uncertain notes'), registries, [], { generate: async () => ({ content: JSON.stringify(response({ documentType: field('imagined_type') })) }) });
    expect(output.classification.documentType.value).toBe('unknown'); expect(reviewReasons(output.classification, 0.6)).toContain('文档类型需要确认');
  });
});

describe('structural chunks', () => {
  it('keeps section paths, bounds oversized tables, overlaps text, and grounds chunk products', async () => {
    const source = await parseDocument(file('chunks.md', `# 第一节\n\nMODEL-Z7 相机部署。\n\n## 同步\n\n${'时间同步校准并采集数据。'.repeat(100)}\n\n# 第二节\n\n没有产品名的其他内容。`));
    const chunks = chunkDocument(source, classification(), { targetTokens: 400, overlapTokens: 60 });
    expect(chunks.length).toBeGreaterThan(3); expect(chunks.every(chunk => tokenUpperBound(chunk.text) <= 400)).toBe(true);
    expect(chunks.some(chunk => chunk.headingPath.join('/') === '第一节/同步')).toBe(true); expect(chunks.at(-1)?.headingPath).toEqual(['第二节']); expect(chunks.at(-1)?.products).toEqual([]);
    expect(chunks[0]?.products).toEqual(['MODEL-Z7']); expect(chunks.every(chunk => chunk.summary.length > 0)).toBe(true);
    const table = parsed(''); table.blocks = [{ type: 'table', text: Array.from({ length: 30 }, (_, index) => `ROW-${index} | value-${index}`).join('\n'), headingPath: ['表格'] }];
    const tableChunks = chunkDocument(table, classification(), { targetTokens: 200, overlapTokens: 30 });
    expect(tableChunks.length).toBeGreaterThan(1); for (let index = 0; index < 30; index++) expect(tableChunks.some(chunk => chunk.text.includes(`ROW-${index} | value-${index}`))).toBe(true);
  });
});

describe('Kimi API boundary', () => {
  afterEach(() => vi.unstubAllGlobals());
  it('honors configured model/temperature and uses instant mode with bounded response', async () => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify({ choices: [{ message: { content: '{}' }, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 2 } }), { status: 200 })); vi.stubGlobal('fetch', fetcher);
    const provider = new KimiProvider({ baseUrl: 'https://api.example.test/v1', apiKey: 'private-token', model: 'kimi-k2.6', temperature: 0.6, maxTokens: 1500 });
    const result = await provider.generate({ system: 'JSON only', prompt: 'classify', responseFormat:'json_object' });
    const args = fetcher.mock.calls[0] as unknown as [string, RequestInit]; const body = JSON.parse(args[1].body as string);
    expect(body.thinking.type).toBe('disabled'); expect(body.response_format).toEqual({type:'json_object'}); expect(body.temperature).toBe(0.6); expect(body.model).toBe('kimi-k2.6'); expect(body.max_tokens).toBe(1500); expect(body).not.toHaveProperty('max_completion_tokens'); expect(body).not.toHaveProperty('reasoning_effort'); expect(result.usage?.inputTokens).toBe(10);
  });
  it.each([undefined, 'low', 'high', 'max'] as const)('uses K3 reasoning controls (%s) and returns only the final JSON answer', async reasoningEffort => {
    const answer='{"result":"final answer"}',reasoning='private reasoning '.repeat(35000);
    const fetcher=vi.fn(async()=>new Response(JSON.stringify({choices:[{message:{content:answer,reasoning_content:reasoning},finish_reason:'stop'}],usage:{prompt_tokens:100,completion_tokens:120000,completion_tokens_details:{reasoning_tokens:119900}}}),{status:200}));vi.stubGlobal('fetch',fetcher);
    const provider=new KimiProvider({baseUrl:'https://api.example.test/v1',apiKey:'private-token',model:'kimi-k3',temperature:1,maxTokens:131072,reasoningEffort});
    const result=await provider.generate({system:'JSON only',prompt:'Write a proposal',responseFormat:'json_object'});
    const args=fetcher.mock.calls[0] as unknown as [string,RequestInit],body=JSON.parse(args[1].body as string);
    expect(body).toMatchObject({model:'kimi-k3',max_completion_tokens:131072,reasoning_effort:reasoningEffort??'max',response_format:{type:'json_object'}});
    expect(body).not.toHaveProperty('max_tokens');expect(body).not.toHaveProperty('temperature');expect(body).not.toHaveProperty('thinking');
    expect(result).toEqual({content:answer,usage:{inputTokens:100,outputTokens:120000}});expect(JSON.stringify(result)).not.toContain('private reasoning');
  });
  it('enforces model-specific output token ceilings before issuing requests',()=>{
    const config={baseUrl:'https://api.example.test/v1',apiKey:'private-token',temperature:1};
    expect(()=>new KimiProvider({...config,model:'kimi-k3',maxTokens:1048576})).not.toThrow();
    expect(()=>new KimiProvider({...config,model:'kimi-k3',maxTokens:1048577})).toThrow('采样参数无效');
    expect(()=>new KimiProvider({...config,model:'kimi-k2.6',maxTokens:32769})).toThrow('采样参数无效');
    expect(()=>new KimiProvider({...config,model:'compatible-model',maxTokens:32769})).toThrow('采样参数无效');
  });
  it('shares the long-request connection pool and retains each request overall abort deadline',async()=>{
    const fetcher=vi.fn(async()=>new Response(JSON.stringify({choices:[{message:{content:'{}'},finish_reason:'stop'}]}),{status:200}));vi.stubGlobal('fetch',fetcher);
    const timeout=vi.spyOn(AbortSignal,'timeout');
    try{
      const base={baseUrl:'https://api.example.test/v1',apiKey:'private-token',model:'kimi-k3',temperature:1,maxTokens:131072,requestTimeoutMs:600000};
      await new KimiProvider(base).generate({system:'JSON',prompt:'First chapter'});
      await new KimiProvider(base).generate({system:'JSON',prompt:'Second chapter'});
      const requests=fetcher.mock.calls.map(call=>(call as unknown as [string,RequestInit&{dispatcher:Agent}])[1]);
      expect(requests[0].dispatcher).toBeInstanceOf(Agent);expect(requests[1].dispatcher).toBe(requests[0].dispatcher);
      expect(requests[0].signal).toBeInstanceOf(AbortSignal);expect(requests[1].signal).not.toBe(requests[0].signal);
      expect(timeout).toHaveBeenNthCalledWith(1,600000);expect(timeout).toHaveBeenNthCalledWith(2,600000);
    }finally{timeout.mockRestore();}
  });
  it('retains a finite response cap for K3 and never exposes reasoning-only responses',async()=>{
    const cancel=vi.fn(),large=new ReadableStream<Uint8Array>({start(controller){controller.enqueue(new Uint8Array(16*1024*1024+1));},cancel});
    const fetcher=vi.fn().mockResolvedValueOnce(new Response(large,{status:200})).mockResolvedValueOnce(new Response(JSON.stringify({choices:[{message:{content:null,reasoning_content:'private-only-reasoning'},finish_reason:'stop'}]}),{status:200}));vi.stubGlobal('fetch',fetcher);
    const provider=new KimiProvider({baseUrl:'https://api.example.test/v1',apiKey:'private-token',model:'kimi-k3',temperature:1,maxTokens:131072});
    await expect(provider.generate({system:'JSON',prompt:'Generate'})).rejects.toThrow('响应超过大小限制');expect(cancel).toHaveBeenCalledTimes(1);
    await expect(provider.generate({system:'JSON',prompt:'Generate'})).rejects.toThrow('未返回可用的文本内容');expect(fetcher).toHaveBeenCalledTimes(2);
  });
  it('does not expose upstream body or key on authentication errors', async () => {
    const fetcher = vi.fn(async () => new Response('sk-private-token sensitive provider detail', { status: 401 })); vi.stubGlobal('fetch', fetcher);
    const provider = new KimiProvider({ baseUrl: 'https://api.example.test/v1', apiKey: 'sk-private-token', model: 'kimi-k2.6', temperature: 0.6, maxTokens: 1500 });
    await expect(provider.generate({ system: 'JSON', prompt: 'classify' })).rejects.toThrow('HTTP 401'); expect(fetcher).toHaveBeenCalledTimes(1);
  });
});
