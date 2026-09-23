// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ExportSettings } from '../apps/web/src/ExportSettings.js';
import { defaultOutputProfile, type GeneratedDocument } from '../packages/document-engine/src/types.js';

const proposal: GeneratedDocument = { id:'document',projectId:'project',projectName:'机器人项目',customerName:'客户',title:'机器人技术方案',documentType:'technical_proposal',templateId:'standard',templateVersion:3,contextRevision:3,revision:2,status:'generated',sections:[{id:'section',title:'总体方案',level:1,order:0,generationMode:'ai',requiredContext:[],status:'generated',blocks:[{id:'body',type:'paragraph',text:'系统进行机器人运动数据采集。'}],sourceRefs:[],assetRefs:[],lockedFactRefs:[],claims:[],revision:1,edited:false}],outputProfile:defaultOutputProfile,createdAt:'',updatedAt:'',issues:[] };
const response=(body:unknown,status=200)=>new Response(JSON.stringify(body),{status,headers:{'content-type':'application/json'}});
let host:HTMLDivElement,root:Root;
beforeEach(()=>{vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT',true);host=document.createElement('div');document.body.append(host);root=createRoot(host);});
afterEach(async()=>{await act(async()=>root.unmount());host.remove();vi.restoreAllMocks();vi.unstubAllGlobals();});
const mount=async(onSaved=vi.fn(),onClose=vi.fn(),document=proposal)=>{await act(async()=>root.render(<ExportSettings document={document} assets={[]} onSaved={onSaved} onClose={onClose}/>));return {onSaved,onClose};};
const click=async(text:string)=>{const button=[...host.querySelectorAll('button')].find(b=>b.textContent===text);expect(button).toBeDefined();await act(async()=>button!.click());};

describe('export settings interactive request lifecycle',()=>{
 it('saves the API document envelope, refreshes the parent and closes only after successful save',async()=>{
  const fetcher=vi.fn().mockResolvedValue(response({document:{...proposal,revision:3}}));vi.stubGlobal('fetch',fetcher);
  const {onSaved,onClose}=await mount();await click('保存设置');
  expect(fetcher).toHaveBeenCalledTimes(1);expect(fetcher.mock.calls[0][0]).toBe('/api/generated-documents/document');
  expect(JSON.parse(fetcher.mock.calls[0][1].body)).toMatchObject({revision:2,title:proposal.title});
  expect(onSaved).toHaveBeenCalledTimes(1);expect(onClose).toHaveBeenCalledTimes(1);
 });
 it('keeps the dialog open after Logo upload and persists the selected uploaded asset when saving',async()=>{
  const asset={id:'new-logo',projectId:'project',filename:'company.png',caption:'公司标识',mimeType:'image/png',url:'/api/projects/project/assets/new-logo'};
  const fetcher=vi.fn().mockResolvedValueOnce(response({asset})).mockResolvedValueOnce(response({document:{...proposal,revision:3,outputProfile:{...proposal.outputProfile,coverLogoAssetId:asset.id}}}));vi.stubGlobal('fetch',fetcher);
  const {onSaved,onClose}=await mount(),input=host.querySelector<HTMLInputElement>('input[type=file]')!;
  Object.defineProperty(input,'files',{value:[new File(['image'],'company.png',{type:'image/png'})],configurable:true});
  await act(async()=>input.dispatchEvent(new Event('change',{bubbles:true})));
  expect(onSaved).not.toHaveBeenCalled();expect(onClose).not.toHaveBeenCalled();expect(host.querySelector('[role=dialog]')).not.toBeNull();
  expect(host.querySelector<HTMLSelectElement>('select[aria-label="封面 Logo"]')!.value).toBe(asset.id);
  expect(host.querySelector<HTMLImageElement>('.export-cover-brand img')!.getAttribute('src')).toBe(asset.url);
  await click('保存设置');expect(JSON.parse(fetcher.mock.calls[1][1].body).outputProfile.coverLogoAssetId).toBe(asset.id);
  expect(onClose).toHaveBeenCalledTimes(1);
 });
 it('shows an export 422 without closing and retries with the revision inside the saved document envelope',async()=>{
  const fetcher=vi.fn().mockResolvedValueOnce(response({document:{...proposal,revision:3}})).mockResolvedValueOnce(response({message:'正文含内部审查语言，请修正后导出。'},422)).mockResolvedValueOnce(response({document:{...proposal,revision:4}}));vi.stubGlobal('fetch',fetcher);
  const {onSaved,onClose}=await mount();await click('导出 Word');
  expect(onSaved).toHaveBeenCalledTimes(1);expect(onClose).not.toHaveBeenCalled();expect(host.textContent).toContain('正文含内部审查语言，请修正后导出。');
  expect(host.querySelector('[role=dialog]')).not.toBeNull();expect(fetcher.mock.calls[1][0]).toBe('/api/generated-documents/document/export.docx');
  await click('保存设置');expect(JSON.parse(fetcher.mock.calls[2][1].body).revision).toBe(3);
  expect(onSaved).toHaveBeenCalledTimes(2);expect(onClose).toHaveBeenCalledTimes(1);
 });
 it('shows fact errors and incomplete chapters, requiring an explicit draft choice before export',async()=>{
  const fetcher=vi.fn();vi.stubGlobal('fetch',fetcher);
  await mount(vi.fn(),vi.fn(),{...proposal,sections:[{...proposal.sections[0],status:'failed'}],issues:[{id:'mismatch',sectionId:'section',severity:'error',type:'fact_mismatch',message:'相机数量与已确认事实不一致。',quote:'36台相机',sourceRefs:[]}]});
  expect(host.textContent).toContain('相机数量与已确认事实不一致。');expect(host.textContent).toContain('36台相机');expect(host.textContent).toContain('本章生成失败');
  const exportButton=[...host.querySelectorAll('button')].find(b=>b.textContent==='作为审阅稿导出')!;expect(exportButton.disabled).toBe(true);
  await act(async()=>host.querySelector<HTMLInputElement>('.export-content-check input[type=checkbox]')!.click());
  expect(exportButton.disabled).toBe(false);expect(fetcher).not.toHaveBeenCalled();
 });
 it.each(['customer_facing','prohibited_claim'] as const)('never allows the draft choice to bypass known %s errors',async(type)=>{
  await mount(vi.fn(),vi.fn(),{...proposal,issues:[{id:'internal',sectionId:'section',severity:'error',type,message:'客户正文含内部工作语言或不当技术承诺。',quote:'待确认',sourceRefs:[]}]});
  expect(host.querySelector('.export-content-check [role=alert]')?.textContent).toContain('请修正后导出');
  expect(host.querySelector('.export-content-check input[type=checkbox]')).toBeNull();
  expect([...host.querySelectorAll('button')].find(b=>b.textContent==='导出 Word')!.disabled).toBe(true);
 });
});
