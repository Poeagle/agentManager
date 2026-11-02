import {Children,isValidElement,useEffect,useRef,useState,type ComponentProps} from 'react';
import {ImagePreview,useConversationImagePreview} from './ConversationImagePreview';
import {copyConversationText} from '../lib/conversation-clipboard';
import {isMermaidCode,renderMermaid} from '../lib/mermaid-render';
import './MermaidDiagram.css';
export {isMermaidCode};
export function MarkdownDiagramPre({children,node:_node,...props}:ComponentProps<'pre'>&{node?:unknown}) {
  const code=Children.toArray(children).find(child=>isValidElement(child));
  if(isValidElement<{children?:unknown;className?:string}>(code)){
    const source=String(code.props.children??''),language=(code.props.className||'').replace(/^language-/,'').split(/\s/)[0];
    if(isMermaidCode(source,language))return <MermaidDiagram source={source}/>;
  }
  return <pre {...props}>{children}</pre>;
}
export function MermaidDiagram({source,streaming=false}:{source:string;streaming?:boolean}) {
  const [image,setImage]=useState(''),[error,setError]=useState(''),[showSource,setShowSource]=useState(false),[expanded,setExpanded]=useState(false),[copied,setCopied]=useState(false),[dark,setDark]=useState(()=>document.documentElement.dataset.theme!=='light');
  const url=useRef(''),preview=useConversationImagePreview();
  useEffect(()=>{const observer=new MutationObserver(()=>setDark(document.documentElement.dataset.theme!=='light'));observer.observe(document.documentElement,{attributes:true,attributeFilter:['data-theme']});return()=>observer.disconnect();},[]);
  useEffect(()=>{
    let cancelled=false;setError('');setCopied(false);
    const timer=setTimeout(()=>{void renderMermaid(source,dark).then(svg=>{if(cancelled)return;const next=URL.createObjectURL(new Blob([svg],{type:'image/svg+xml'}));if(url.current)URL.revokeObjectURL(url.current);url.current=next;setImage(next);}).catch(()=>{if(!cancelled)setError(streaming?'图表源码正在更新…':'图表暂时无法显示，请检查 Mermaid 源码。');});},streaming?350:0);
    return()=>{cancelled=true;clearTimeout(timer);};
  },[source,dark,streaming]);
  useEffect(()=>()=>{if(url.current)URL.revokeObjectURL(url.current);},[]);
  return <figure className="mermaid-diagram" aria-label="Mermaid 图表" contentEditable={false}>
    <figcaption><span>Mermaid 图表</span><div><button type="button" aria-expanded={showSource} onClick={()=>setShowSource(value=>!value)}>{showSource?'收起源码':'查看源码'}</button><button type="button" onClick={()=>void copyConversationText(source).then(()=>setCopied(true)).catch(()=>setError('复制失败，请展开源码手动复制。'))}>{copied?'已复制':'复制源码'}</button></div></figcaption>
    {image&&<button type="button" className="mermaid-diagram-image" aria-label="放大 Mermaid 图表" onClick={()=>preview?preview({src:image,name:'Mermaid 图表'}):setExpanded(true)}><img src={image} alt="Mermaid 图表"/></button>}
    {!image&&!error&&<p role="status">{streaming?'正在接收图表…':'正在绘制图表…'}</p>}
    {error&&<p role={streaming?'status':'alert'}>{error}</p>}
    {(showSource||!!error&&!streaming)&&<pre className="mermaid-diagram-source"><code>{source}</code></pre>}
    {expanded&&image&&<ImagePreview image={{src:image,name:'Mermaid 图表'}} onClose={()=>setExpanded(false)}/>}
  </figure>;
}
