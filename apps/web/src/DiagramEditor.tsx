import {useEffect,useState} from 'react';
import type {DocumentBlock} from '../../../packages/document-engine/src/types.js';
import {cleanMermaidSource,diagramTheme} from '../../../packages/document-engine/src/diagram-policy.js';
import {ErrorMessage} from './ui.js';

export function MermaidPreview({source}:{source:string}){
 const [svg,setSvg]=useState(''),[error,setError]=useState('');
 useEffect(()=>{let cancelled=false;const timer=setTimeout(async()=>{try{const checked=cleanMermaidSource(source);const {default:mermaid}=await import('mermaid');mermaid.initialize(diagramTheme);await mermaid.parse(checked);const result=await mermaid.render(`diagram-${crypto.randomUUID()}`,checked);if(!cancelled){setSvg(result.svg);setError('');}}catch(caught){if(!cancelled){setSvg('');setError(caught instanceof Error?caught.message:'技术图语法错误');}}},250);return()=>{cancelled=true;clearTimeout(timer);};},[source]);
 return <div className="mermaid-preview">{error?<ErrorMessage message={`图形未通过检查：${error}`} />:svg?<div role="img" aria-label="技术图预览" dangerouslySetInnerHTML={{__html:svg}} />:<p className="subtle">正在绘制技术图…</p>}</div>;
}
export function DiagramEditor({block,disabled,onChange}:{block:Extract<DocumentBlock,{type:'diagram'}>;disabled:boolean;onChange:(b:DocumentBlock)=>void}){
 return <><MermaidPreview source={block.source}/><details><summary>编辑代码</summary><textarea className="diagram-source" aria-label="Mermaid 技术图代码" rows={10} disabled={disabled} value={block.source} onChange={e=>onChange({...block,source:e.target.value,generatedBy:'user'})}/></details><label className="field">图题<input value={block.caption??''} disabled={disabled} onChange={e=>onChange({...block,caption:e.target.value})}/></label><p className="subtle">保存时校验语法；可在右侧 AI 重新生成，或在内容块右上角删除图。</p></>;
}
