/** Shared before browser/server Mermaid parsing. Author-supplied runtime directives and links are forbidden. */
export function cleanMermaidSource(value:unknown):string {
 if(typeof value!=='string')throw new Error('技术图代码须为 Mermaid 文本');
 const source=value.trim().replace(/^```(?:mermaid)?\s*/i,'').replace(/\s*```$/,'').trim();
 if(!source||source.length>20000)throw new Error('技术图代码须为 1–20000 字符');
 if(!/^(?:flowchart|graph|sequenceDiagram|classDiagram|stateDiagram-v2)\b/.test(source))throw new Error('请使用流程、拓扑、时序、模块或状态图');
 if(/%%\{|^\s*---|\bclick\s|\b(?:href|src)\s*=|https?:\/\/|file:|javascript:|<\/?(?:script|iframe|img|foreignObject)|\b(?:icon|img|image)\s*:|@\s*\{/im.test(source))throw new Error('技术图不允许脚本、链接、外部图片或自定义配置');
 return source;
}
export const diagramTheme={startOnLoad:false,securityLevel:'strict' as const,theme:'base' as const,fontFamily:'Microsoft YaHei, SimSun, sans-serif',maxTextSize:20000,maxEdges:150,flowchart:{htmlLabels:false},themeVariables:{background:'#ffffff',primaryColor:'#EEF4F0',primaryTextColor:'#1E2A25',primaryBorderColor:'#456B5B',lineColor:'#7A8982',secondaryColor:'#F5F7F6',tertiaryColor:'#ffffff'}};
