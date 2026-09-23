import {afterEach,describe,expect,test,vi} from 'vitest';
import {renderToStaticMarkup} from 'react-dom/server';
import {load} from 'cheerio';
import {EnrichmentDialog,KnowledgeSections} from '../apps/web/src/KnowledgeEnrichment.js';
const resources=vi.hoisted(()=>new Map<string,unknown>());
vi.mock('../apps/web/src/ui.js',async importOriginal=>{const actual=await importOriginal<typeof import('../apps/web/src/ui.js')>();return {...actual,useResource:(path:string)=>({data:resources.get(path),loading:false,error:'',reload:()=>{}})};});
afterEach(()=>resources.clear());

describe('Deep knowledge user review controls',()=>{
 test('offers selected, filtered and all scope with an empty default budget',()=>{
  const html=load(renderToStaticMarkup(<EnrichmentDialog selection={{documentIds:['doc']}} selectedCount={1} filters={{application:'robotics'}} close={()=>{}} notify={()=>{}} onComplete={()=>{}}/>));
  expect(html('select').first().find('option').map((_i,node)=>html(node).text()).get()).toEqual(['所选资料（1 份）','当前筛选结果','全部可整理资料']);expect(html('input[type=number]').attr('value')).toBe('');expect(html.text()).toContain('Kimi K3');expect(html.text()).toContain('正式分类、资料权威级别与产品参数');
 });
 test('requires a dimension choice before confirming a model alias that did not specify one',()=>{
  resources.set('/enrichment/aliases',{items:[{id:'unknown',dimension:'unassigned',canonical:'运动融合',aliases:['多源运动融合'],confidence:0,reason:'同义表达',status:'pending'},{id:'known',dimension:'scenarios',canonical:'robot_testing',aliases:['机器人检查'],confidence:.9,reason:'同一场景',status:'pending'}]});
  const html=load(renderToStaticMarkup(<EnrichmentDialog selection={{documentIds:['doc']}} selectedCount={1} filters={{}} close={()=>{}} notify={()=>{}} onComplete={()=>{}}/>));
  const rows=html('.enrichment-aliases article');expect(rows).toHaveLength(2);expect(rows.eq(0).find('select option[selected]').text()).toBe('请选择');expect(rows.eq(0).find('button').first().attr('disabled')).toBeDefined();expect(rows.eq(1).find('button').first().attr('disabled')).toBeUndefined();expect(html.text()).not.toContain('unassigned');
 });
 test('shows full heading paths, soft-confidence labels and independent document/section quality stars',()=>{
  resources.set('/documents/doc/enrichment',{documentId:'doc',title:'机器人试验场方案',versionId:'v1',quality:'preferred',tags:{applications:[{value:'robotics',confidence:.99}],scenarios:[{value:'复杂场景',confidence:.4}]},enrichedAt:'2026-09-24T00:00:00Z',sections:[{id:'section',title:'相机部署',headingPath:['系统方案','相机部署'],sectionRole:'deployment',summary:'利用交叉观察组织覆盖。',quality:'good',softTags:{},blueprint:{},text:'完整原文'}]});
  const html=load(renderToStaticMarkup(<KnowledgeSections documentId="doc" close={()=>{}} notify={()=>{}}/>));expect(html.text()).toContain('系统方案 / 相机部署');expect(html.text()).toContain('机器人');expect(html.text()).toContain('低置信度');expect(html('.knowledge-quality select').map((_i,node)=>html(node).find('option[selected]').text()).get()).toEqual(['★★ 首选参考','★ 优质参考']);expect(html.text()).toContain('当前项目自己的依据');
 });
});
