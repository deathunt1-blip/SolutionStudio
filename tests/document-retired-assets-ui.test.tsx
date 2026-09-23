// @vitest-environment happy-dom
import { act, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import DocumentEditor, { BlockEditor, SectionEditor } from '../apps/web/src/DocumentEditor.js';
import { ExportSettings } from '../apps/web/src/ExportSettings.js';
import { defaultOutputProfile, type DocumentBlock, type GeneratedDocument } from '../packages/document-engine/src/types.js';
import type { ProjectAsset } from '../packages/projects/src/types.js';

const image=(id:string,retired=false):ProjectAsset=>({id,projectId:'project',inputId:null,role:'illustration',filename:`${id}.png`,mimeType:'image/png',objectKey:`projects/project/${id}.png`,url:`/api/projects/project/assets/${id}`,sourceRef:{type:'user',id,label:'项目图片'},...(retired?{retiredAt:'2026-09-24T00:00:00Z'}:{})});
const old=image('old',true),unused=image('unused',true),active=image('active');
const proposal:GeneratedDocument={id:'document',projectId:'project',projectName:'图片项目',customerName:'客户',title:'图片技术方案',documentType:'technical_proposal',templateId:'standard',templateVersion:3,contextRevision:1,revision:1,status:'generated',sections:[{id:'section',title:'总体方案',level:1,order:0,generationMode:'ai',requiredContext:[],status:'generated',blocks:[{id:'figure',type:'asset',assetId:old.id,caption:'原方案图片'}],sourceRefs:[],assetRefs:[old.id],lockedFactRefs:[],claims:[],revision:1,edited:false}],outputProfile:{...defaultOutputProfile,coverLogoAssetId:old.id},createdAt:'',updatedAt:'',issues:[]};
let host:HTMLDivElement,root:Root;
beforeEach(()=>{vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT',true);host=document.createElement('div');document.body.append(host);root=createRoot(host);});
afterEach(async()=>{await act(async()=>root.unmount());host.remove();vi.restoreAllMocks();vi.unstubAllGlobals();});
const options=(select:HTMLSelectElement)=>[...select.options].map(option=>option.value);
async function selectValue(select:HTMLSelectElement,value:string){await act(async()=>{select.value=value;select.dispatchEvent(new Event('change',{bubbles:true}));});}

describe('retired project images in existing proposals',()=>{
 it('previews the existing retired block while preventing selection of other retired images or reselecting one after replacement',async()=>{
  function Editor(){const [block,setBlock]=useState<DocumentBlock>(proposal.sections[0].blocks[0]);return <BlockEditor block={block} assets={[old,unused,active]} disabled={false} onChange={setBlock}/>;}
  await act(async()=>root.render(<Editor/>));
  expect(host.querySelector('img')?.getAttribute('src')).toBe(old.url);expect(options(host.querySelector('select')!)).toEqual(['',old.id,active.id]);
  await selectValue(host.querySelector('select')!,active.id);
  expect(host.querySelector('img')?.getAttribute('src')).toBe(active.url);expect(options(host.querySelector('select')!)).toEqual(['',active.id]);
 });
 it('new image blocks use the first active image and stay disabled when only retired images remain',async()=>{
  const props={section:{...proposal.sections[0],blocks:[]},documentId:proposal.id,disabled:false,dirtyChanged:vi.fn(),saved:vi.fn()};
  await act(async()=>root.render(<SectionEditor {...props} assets={[old,unused,active]}/>));
  const add=[...host.querySelectorAll('button')].find(button=>button.textContent==='图片')!;await act(async()=>add.click());
  expect(host.querySelector('select')?.value).toBe(active.id);expect(options(host.querySelector('select')!)).toEqual(['',active.id]);
  await act(async()=>root.render(<SectionEditor key="only-retired" {...props} assets={[old,unused]}/>));
  expect([...host.querySelectorAll('button')].find(button=>button.textContent==='图片')!.disabled).toBe(true);
 });
 it('loads retired cover assets after the dialog opens and removes the old Logo option once another is chosen',async()=>{
  const props={document:proposal,onSaved:vi.fn(),onClose:vi.fn()};
  await act(async()=>root.render(<ExportSettings {...props} assets={[]}/>));
  await act(async()=>root.render(<ExportSettings {...props} assets={[old,unused,active]}/>));
  expect(host.querySelector('.export-cover-brand img')?.getAttribute('src')).toBe(old.url);
  const select=host.querySelector<HTMLSelectElement>('select[aria-label="封面 Logo"]')!;expect(options(select)).toEqual(['',old.id,active.id]);
  await selectValue(select,active.id);expect(options(select)).toEqual(['',active.id]);expect(host.querySelector('.export-cover-brand img')?.getAttribute('src')).toBe(active.url);
 });
 it('the full editor fetches the document-specific asset set for both body and cover previews',async()=>{
  const fetcher=vi.fn(async(url:string)=>{const payload=url.endsWith('/jobs')?{jobs:[]}:url.endsWith('/assets')?{items:[old,active]}:url.endsWith('/context')?{context:{lockedFacts:[],requirements:{},assets:[]}}:url==='/api/generated-documents/document'?{document:proposal}:null;if(!payload)throw Error(`Unexpected API ${url}`);return new Response(JSON.stringify(payload),{headers:{'content-type':'application/json'}});});vi.stubGlobal('fetch',fetcher);
  await act(async()=>root.render(<DocumentEditor id="document" projectId="project" notify={vi.fn()} back={vi.fn()} openKnowledge={vi.fn()}/>));
  expect(fetcher.mock.calls.some(call=>call[0]==='/api/generated-documents/document/assets')).toBe(true);expect(fetcher.mock.calls.some(call=>call[0]==='/api/projects/project')).toBe(false);
  expect(host.querySelector('.block-asset')?.getAttribute('src')).toBe(old.url);
  await act(async()=>[...host.querySelectorAll('button')].find(button=>button.textContent==='输出设置')!.click());
  expect(host.querySelector('.export-cover-brand img')?.getAttribute('src')).toBe(old.url);
 });
});
