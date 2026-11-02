let sequence=0;
let queue:Promise<unknown>=Promise.resolve();
const cache=new Map<string,string>();
export function isMermaidCode(source:string,language='') {
  const name=language.toLowerCase();if(name==='mermaid')return true;if(name&&!['text','txt','plaintext'].includes(name))return false;
  return /^(?:(?:flowchart|graph)\s+(?:TD|TB|BT|LR|RL)\b|(?:sequenceDiagram|classDiagram|stateDiagram(?:-v2)?|erDiagram|gantt|pie|mindmap|timeline|gitGraph|journey)\s*(?:$|\n))/i.test(source.trimStart());
}
export function renderMermaid(source:string,dark:boolean):Promise<string> {
  if(source.length>40000)return Promise.reject(Error('图表源码超过 40 KB，请拆成较小的图表。'));
  if(/@\{[^}]*\bimg\s*:|<\s*(?:img|image)\b/i.test(source))return Promise.reject(Error('图表不支持加载外部图片，请使用文字节点。'));
  // Document directives must not override application security or inject CSS.
  const clean=source.replace(/^\s*---\r?\n[\s\S]*?\r?\n---\s*\r?\n/,'').replace(/%%\{[\s\S]*?\}%%/g,'');
  const key=JSON.stringify([clean,dark]);const saved=cache.get(key);if(saved)return Promise.resolve(saved);
  const work=queue.catch(()=>{}).then(async()=>{
    const again=cache.get(key);if(again)return again;
    const mermaid=(await import('mermaid')).default;
    mermaid.initialize({startOnLoad:false,securityLevel:'strict',suppressErrorRendering:true,maxTextSize:40000,maxEdges:300,theme:dark?'dark':'default',htmlLabels:false,flowchart:{htmlLabels:false},fontFamily:'Arial, sans-serif'});
    const container=document.createElement('div');container.style.cssText='position:fixed;left:-100000px;top:0;width:1400px;visibility:hidden;pointer-events:none';container.setAttribute('aria-hidden','true');document.body.append(container);
    try {const result=await mermaid.render(`octoally-mermaid-${++sequence}`,clean,container);if(result.svg.length>2*1024*1024)throw Error('图表过大，请拆分后查看。');cache.set(key,result.svg);if(cache.size>12)cache.delete(cache.keys().next().value!);return result.svg;}
    finally{container.remove();}
  });queue=work;return work;
}
