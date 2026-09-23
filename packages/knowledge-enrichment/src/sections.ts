import type { ParsedBlock, ParsedDocument } from '../../core/src/types.js';
import type { SectionDraft } from './types.js';

// Only structural boundaries split sections. The original section text is never token-chunked.
// PDF and lightly formatted Word files frequently encode their numbered headings as plain text.
function heading(line:string):number|undefined {
 if(line.length>90||/[。；;!?！？]$/.test(line))return;
 if(/^第[一二三四五六七八九十百\d]+[章节]\s*\S+/.test(line)||/^[一二三四五六七八九十]+[、．.]\s*\S+/.test(line))return 1;
 const m=line.match(/^(\d+(?:\.\d+){0,5})[、．.\s]+([^\d\s].*)$/);if(m&&m[2].length>1)return Math.min(6,m[1].split('.').length);
 if(/^[（(][一二三四五六七八九十\d]+[)）]\s*\S+/.test(line))return 2;
}
export function extractSections(parsed:ParsedDocument,fallbackTitle:string):SectionDraft[] {
 const blocks:ParsedBlock[]=[];
 for(const block of parsed.blocks??[]) {
  if(block.type==='heading'||block.type==='table'){blocks.push(block);continue;}
  const lines=block.text.split('\n'),buffer:string[]=[];
  const flush=()=>{if(buffer.length){blocks.push({...block,text:buffer.join('\n')});buffer.length=0;}};
  for(const raw of lines){const line=raw.trim(),level=heading(line);if(level){flush();blocks.push({type:'heading',text:line,level});}else buffer.push(raw);}flush();
 }
 if(!blocks.length&&parsed.plainText.trim())blocks.push({type:'paragraph',text:parsed.plainText});
 const result:SectionDraft[]=[],stack:string[]=[];let current:SectionDraft|undefined;
 const flush=()=>{if(current?.text.trim())result.push({...current,order:result.length,text:current.text.trim()});};
 for(const block of blocks){
  if(block.type==='heading'){
   flush();const level=Math.max(1,Math.min(6,block.level??1));stack.splice(level-1);stack.push(block.text.trim());
   current={order:0,title:block.text.trim(),headingPath:[...stack],level,text:''};
  }else if(block.text.trim()){
   current??={order:0,title:fallbackTitle,headingPath:[],level:1,text:''};current.text+=(current.text?'\n\n':'')+block.text;
  }
 }
 flush();return result;
}
