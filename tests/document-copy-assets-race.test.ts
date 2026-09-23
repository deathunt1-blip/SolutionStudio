import {expect,test,vi} from 'vitest';
import {mkdtemp,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createApp} from '../apps/server/src/app.js';
import type {DocumentEngine} from '../packages/document-engine/src/service.js';
import type {ProjectService} from '../packages/projects/src/service.js';

test('a copy cannot restore asset references from a source revision changed before its transaction',async()=>{
 const directory=await mkdtemp(join(tmpdir(),'studio-copy-race-'));
 const app=await createApp({dataDir:directory,llmDisabled:true,providerFactory:()=>({generate:async()=>{throw Error('No model calls in copy race test');}})});
 try{
  const projects=(app as any).projects as ProjectService,engine=(app as any).documentEngine as DocumentEngine;
  const project=await projects.create({name:'复制并发保护',description:'建设目标：动作采集。'});
  const asset=await projects.addAsset(project.id,{filename:'diagram.png',buffer:Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGOQ0zD6DwACWAF41TTQUQAAAABJRU5ErkJggg==','base64')});
  await projects.confirmContext(project.id,(await projects.getContext(project.id)).revision);
  let doc=await engine.create(project.id);
  doc=await engine.edit(doc.id,doc.sections[0].id,{revision:doc.sections[0].revision,blocks:[{type:'asset',assetId:asset.id}]});
  doc=await engine.patch(doc.id,{revision:doc.revision,outputProfile:{coverLogoAssetId:asset.id}});
  const before=(await engine.list(project.id)).length,read=engine.get.bind(engine);
  const spy=vi.spyOn(engine,'get').mockImplementationOnce(async id=>{
   spy.mockRestore();const snapshot=await read(id);
   let changed=await engine.edit(id,snapshot.sections[0].id,{revision:snapshot.sections[0].revision,blocks:[{type:'paragraph',text:'系统按功能模块组织。'}]});
   await engine.patch(id,{revision:changed.revision,outputProfile:{coverLogoAssetId:''}});
   await projects.removeInput(project.id,asset.inputId!);
   return snapshot;
  });
  await expect(engine.copy(doc.id)).rejects.toMatchObject({statusCode:409});
  expect((await engine.list(project.id)).length).toBe(before);
  await expect(projects.downloadAsset(project.id,asset.id)).rejects.toMatchObject({statusCode:404});
  const revisionSpy=vi.spyOn(engine,'get').mockImplementationOnce(async id=>{
   revisionSpy.mockRestore();const snapshot=await read(id);
   await engine.edit(id,snapshot.sections[0].id,{revision:snapshot.sections[0].revision,blocks:[{type:'paragraph',text:'已调整系统功能关系。'}]});
   return snapshot;
  });
  await expect(engine.copy(doc.id)).rejects.toMatchObject({statusCode:409,message:'原方案已更新，请刷新后重新复制'});
  expect((await engine.list(project.id)).length).toBe(before);
 }finally{vi.restoreAllMocks();await app.close();await rm(directory,{recursive:true,force:true});}
},30000);
