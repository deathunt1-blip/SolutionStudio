import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LocalObjectStorage } from '../packages/knowledge/src/storage.js';
import { LocalFolderAdapter, ManualUploadAdapter, MockFeishuAdapter, SourceRegistry } from '../packages/source-adapters/src/index.js';
const temporary:string[]=[];
async function dir(){const path=await mkdtemp(join(tmpdir(),'studio-adapter-'));temporary.push(path);return path;}
afterEach(async()=>{for(const path of temporary.splice(0)) await rm(path,{recursive:true,force:true});});
describe('source and object storage boundaries',()=>{
  it('preserves original bytes and rejects traversals',async()=>{
    const root=await dir();const storage=new LocalObjectStorage(root);const buffer=new Uint8Array([0,255,2,3]);
    await storage.put('originals/hash/file',buffer);expect(await storage.get('originals/hash/file')).toEqual(Buffer.from(buffer));
    await expect(storage.put('../outside',buffer)).rejects.toThrow('escapes');
    await expect(storage.get('/absolute')).rejects.toThrow();
  });
  it('atomically reuses concurrent identical originals and rejects conflicting bytes without temp leftovers',async()=>{
    const root=await dir();const storage=new LocalObjectStorage(root);const bytes=Buffer.from('immutable original bytes');
    await Promise.all(Array.from({length:12},()=>storage.put('originals/samehash',bytes)));
    expect(await storage.get('originals/samehash')).toEqual(bytes);
    await expect(storage.put('originals/samehash',Buffer.from('conflicting content'))).rejects.toThrow('different content');
    expect(await storage.get('originals/samehash')).toEqual(bytes);
    const racing=await Promise.allSettled([storage.put('originals/racing-key',Buffer.from('first')),storage.put('originals/racing-key',Buffer.from('second'))]);
    expect(racing.filter(result=>result.status==='fulfilled')).toHaveLength(1);expect(racing.filter(result=>result.status==='rejected')).toHaveLength(1);
    expect(['first','second']).toContain(Buffer.from(await storage.get('originals/racing-key')).toString());
    expect((await readdir(join(root,'originals'))).sort()).toEqual(['racing-key','samehash']);
  });
  it('discovers only supported files and blocks folder traversal',async()=>{
    const root=await dir();await mkdir(join(root,'docs'));await writeFile(join(root,'docs','资料.md'),'# 资料');await writeFile(join(root,'ignore.exe'),'ignored');
    const adapter=new LocalFolderAdapter();const files=await adapter.listDocuments({root});expect(files).toHaveLength(1);
    const file=await adapter.fetchDocument(files[0].sourceId,{root});expect(file.contentHash).toHaveLength(64);
    await expect(adapter.fetchDocument('../does-not-exist',{root})).rejects.toThrow();
  });
  it('normalizes upload names and keeps Feishu explicitly mock',async()=>{
    const upload=new ManualUploadAdapter();const file=await upload.fetchDocument('x',{filename:'../../data.txt',buffer:Buffer.from('hello')});expect(file.meta.filename).toBe('data.txt');
    const registry=new SourceRegistry().register(upload).register(new MockFeishuAdapter([file]));expect(registry.list()).toEqual(['manual','feishu_mock']);
    expect((await registry.get('feishu_mock').fetchDocument('x')).meta.sourceType).toBe('feishu_mock');
  });
});
