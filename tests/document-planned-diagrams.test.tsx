// @vitest-environment happy-dom
import {act} from 'react';
import {createRoot,type Root} from 'react-dom/client';
import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import DocumentEditor from '../apps/web/src/DocumentEditor.js';
import {defaultOutputProfile,type DocumentSection,type GeneratedDocument} from '../packages/document-engine/src/types.js';
import {missingPlannedVisuals,validateDocumentLayout} from '../packages/document-engine/src/layout-qa.js';
import {standardTemplate} from '../packages/document-engine/src/templates.js';
const resources=vi.hoisted(()=>new Map<string,unknown>());
vi.mock('../apps/web/src/ui.js',async original=>({...await original<typeof import('../apps/web/src/ui.js')>(),useResource:(path:string)=>({data:resources.get(path),loading:false,error:'',reload:()=>{}})}));
const section=(id:string,type:'mermaid'|'user_upload'|'none',complete=false):DocumentSection=>({id,title:id,level:1,order:0,generationMode:'ai',requiredContext:[],visualPlan:{type},status:'generated',revision:1,edited:false,sourceRefs:[],lockedFactRefs:[],assetRefs:[],claims:[],blocks:[{id:id+'-body',type:'paragraph',text:'已有正文。'},...(complete?[{id:id+'-diagram',type:'diagram' as const,diagramType:'mermaid' as const,source:'flowchart LR\n A-->B',caption:'模块关系',generatedBy:'ai' as const,sourceRefs:[]}]:[])]});
const proposal:GeneratedDocument={id:'document',projectId:'project',projectName:'项目',customerName:'客户',title:'技术方案',documentType:'technical_proposal',templateId:'standard',templateVersion:4,contextRevision:1,revision:7,status:'generated',outputProfile:defaultOutputProfile,createdAt:'',updatedAt:'',issues:[],sections:[section('需要技术图','mermaid'),section('已有技术图','mermaid',true),section('需要照片','user_upload'),section('不配图','none')]};
let host:HTMLDivElement,root:Root;
beforeEach(()=>{vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT',true);host=document.createElement('div');document.body.append(host);root=createRoot(host);});
afterEach(async()=>{await act(async()=>root.unmount());host.remove();resources.clear();vi.restoreAllMocks();vi.unstubAllGlobals();});
async function mount(doc=proposal,active=false){resources.set('/generated-documents/document',{document:doc});resources.set('/generated-documents/document/jobs',{jobs:active?[{status:'running',sectionIds:[],processed:0,failed:0,estimatedCostCny:0,errors:[],config:{model:'kimi-k3',limitsEnabled:false}}]:[]});resources.set('/generated-documents/document/assets',{items:[]});resources.set('/projects/project/context',{context:{lockedFacts:[],requirements:{}}});await act(async()=>root.render(<DocumentEditor id="document" projectId="project" notify={vi.fn()} back={vi.fn()} openKnowledge={vi.fn()}/>));}
const action=()=>[...host.querySelectorAll('button')].find(button=>button.textContent?.startsWith('生成计划技术图'))!;
describe('planned technical drawings are discoverable and deliberately generated',()=>{
 it('the standard v4 template plans one system architecture figure without adding diagrams to unrelated chapters',()=>{
  expect(standardTemplate.version).toBe(4);expect(standardTemplate.sections.filter(section=>section.visualPlan?.type==='mermaid').map(section=>section.title)).toEqual(['系统总体架构']);
  expect(missingPlannedVisuals(proposal.sections).map(section=>section.id)).toEqual(['需要技术图','需要照片']);expect(validateDocumentLayout(proposal).filter(issue=>issue.code==='missing_visual').map(issue=>issue.sectionId)).toEqual(['需要技术图','需要照片']);
 });
 it('shows missing artwork and sends only missing Mermaid targets with the current generation settings',async()=>{
  const fetcher=vi.fn().mockResolvedValue(new Response(JSON.stringify({job:{}}),{headers:{'content-type':'application/json'}}));vi.stubGlobal('fetch',fetcher);await mount();
  expect(host.querySelector('[aria-label="计划配图"]')?.textContent).toContain('还有 2 处计划配图尚未添加');expect(action().textContent).toContain('（1）');
  const model=[...host.querySelectorAll('select')].find(select=>[...select.options].some(option=>option.value==='kimi-k2.6'))!;
  await act(async()=>{model.value='kimi-k2.6';model.dispatchEvent(new Event('change',{bubbles:true}));});await act(async()=>action().click());
  expect(fetcher).toHaveBeenCalledTimes(1);const payload=JSON.parse(fetcher.mock.calls[0][1].body);expect(payload).toMatchObject({sectionIds:['需要技术图'],mode:'diagram',expectedRevision:7,overwriteEdited:false,config:{model:'kimi-k2.6',limitsEnabled:false}});expect(payload.blocks).toBeUndefined();
 });
 it('preserves the explicit confirmation before adding diagrams to a manually edited chapter',async()=>{
  const fetcher=vi.fn().mockResolvedValue(new Response(JSON.stringify({job:{}}),{headers:{'content-type':'application/json'}}));vi.stubGlobal('fetch',fetcher);await mount({...proposal,sections:proposal.sections.map((section,index)=>index?section:{...section,edited:true,status:'edited'})});
  await act(async()=>action().click());expect(fetcher).not.toHaveBeenCalled();expect(host.querySelector('[role=dialog]')?.textContent).toContain('保留已有正文');
  await act(async()=>[...host.querySelectorAll('button')].find(button=>button.textContent==='确认添加技术图')!.click());expect(JSON.parse(fetcher.mock.calls[0][1].body)).toMatchObject({mode:'diagram',overwriteEdited:true,sectionIds:['需要技术图']});
 });
 it.each(['running','stale'] as const)('prevents planned drawing requests while the document is %s',async condition=>{
  const fetcher=vi.fn();vi.stubGlobal('fetch',fetcher);await mount({...proposal,contextStale:condition==='stale'},condition==='running');expect(action().disabled).toBe(true);await act(async()=>action().click());expect(fetcher).not.toHaveBeenCalled();
 });
 it('adds selected evidence with both revisions, preserves edited prose and does not request a model',async()=>{
  const fetcher=vi.fn().mockResolvedValue(new Response(JSON.stringify({document:proposal}),{headers:{'content-type':'application/json'}}));vi.stubGlobal('fetch',fetcher);
  await mount({...proposal,sections:[{...proposal.sections[0],edited:true,status:'edited',sourceRefs:[{id:'authority-chunk',type:'knowledge_chunk',label:'MC4000 规格书',evidence:'MC4000 FOV 53°×53°',authority:'authoritative',use:'fact_evidence'}]}]});
  await act(async()=>[...host.querySelectorAll('[role=tab]')].find(button=>button.textContent==='来源')!.dispatchEvent(new MouseEvent('click',{bubbles:true})));
  const add=()=>[...host.querySelectorAll('button')].find(button=>button.textContent?.startsWith('补充章节依据（'))!;
  expect(add().disabled).toBe(true);await act(async()=>(host.querySelector('.inspector-source input[type=checkbox]') as HTMLInputElement).click());expect(add().disabled).toBe(false);
  await act(async()=>add().click());expect(fetcher).toHaveBeenCalledTimes(1);expect(fetcher.mock.calls[0][0]).toBe('/api/generated-documents/document/sections/需要技术图/sources');expect(JSON.parse(fetcher.mock.calls[0][1].body)).toEqual({revision:1,documentRevision:7,sourceIds:['authority-chunk']});
  expect(host.querySelector('[role=dialog]')).toBeNull();expect(add().disabled).toBe(true);expect(host.textContent).toContain('已有正文。');
 });
 it('keeps the evidence selection available after a rejected source and displays the server reason',async()=>{
  const fetcher=vi.fn().mockResolvedValue(new Response(JSON.stringify({message:'所选资料已归档，请重新选择'}),{status:409,headers:{'content-type':'application/json'}}));vi.stubGlobal('fetch',fetcher);
  await mount({...proposal,sections:[{...proposal.sections[0],sourceRefs:[{id:'old-chunk',type:'knowledge_chunk',label:'原规格书',evidence:'原引用'}]}]});
  await act(async()=>[...host.querySelectorAll('[role=tab]')].find(button=>button.textContent==='来源')!.dispatchEvent(new MouseEvent('click',{bubbles:true})));
  await act(async()=>(host.querySelector('.inspector-source input[type=checkbox]') as HTMLInputElement).click());
  const button=[...host.querySelectorAll('button')].find(button=>button.textContent?.startsWith('补充章节依据（'))!;await act(async()=>button.click());
  expect(host.textContent).toContain('所选资料已归档，请重新选择');expect((host.querySelector('.inspector-source input[type=checkbox]') as HTMLInputElement).checked).toBe(true);expect(button.disabled).toBe(false);
 });
 it.each(['running','stale'] as const)('blocks manual evidence while the document is %s',async condition=>{
  const fetcher=vi.fn();vi.stubGlobal('fetch',fetcher);await mount({...proposal,contextStale:condition==='stale',sections:[{...proposal.sections[0],sourceRefs:[{id:'source',type:'knowledge_chunk',label:'规格书',evidence:'原引用'}]}]},condition==='running');
  await act(async()=>[...host.querySelectorAll('[role=tab]')].find(button=>button.textContent==='来源')!.dispatchEvent(new MouseEvent('click',{bubbles:true})));
  await act(async()=>(host.querySelector('.inspector-source input[type=checkbox]') as HTMLInputElement).click());const button=[...host.querySelectorAll('button')].find(button=>button.textContent?.startsWith('补充章节依据（'))!;expect(button.disabled).toBe(true);await act(async()=>button.click());expect(fetcher).not.toHaveBeenCalled();
 });
});
