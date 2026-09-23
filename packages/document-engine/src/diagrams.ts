import puppeteer from 'puppeteer';
import {renderMermaid as renderDiagram} from '@mermaid-js/mermaid-cli';
import {createHash} from 'node:crypto';
import {cleanMermaidSource,diagramTheme} from './diagram-policy.js';

const cache=new Map<string,Buffer>();
let tail:Promise<unknown>=Promise.resolve();
/** Local isolated browser only renders diagram source; no remote diagram service or user browser session. */
export function renderMermaid(source:string,format:'svg'|'png'='png'):Promise<Buffer>{
 const checked=cleanMermaidSource(source),key=createHash('sha256').update(format+checked).digest('hex');
 const hit=cache.get(key);if(hit)return Promise.resolve(hit);
 const task=tail.then(async()=>{
  const browser=await puppeteer.launch({headless:true,timeout:30000});
  try{const context=await browser.createBrowserContext();
   const result=await renderDiagram(context,checked,format,{backgroundColor:'#ffffff',viewport:{width:1400,height:1000,deviceScaleFactor:2},mermaidConfig:diagramTheme});
   const bytes=Buffer.from(result.data);if(cache.size>=60)cache.delete(cache.keys().next().value!);cache.set(key,bytes);return bytes;
  }finally{await browser.close();}
 });tail=task.catch(()=>{});return task;
}
export const renderMermaidPng=(source:string)=>renderMermaid(source,'png');
