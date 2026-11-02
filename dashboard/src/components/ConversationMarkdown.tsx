import {copyConversationText} from '../lib/conversation-clipboard';
export {copyConversationText} from '../lib/conversation-clipboard';
import {MermaidDiagram,isMermaidCode} from './MermaidDiagram';
import {ConversationImagePreviewRoot,useConversationImagePreview,useConversationFilePreview} from './ConversationImagePreview';
import {Children,createContext,isValidElement,memo,useContext,useEffect,useMemo,useRef,useState,type ReactNode} from 'react';
import ReactMarkdown,{type Components} from 'react-markdown';
import remarkGfm from 'remark-gfm';
import {Check,Copy,Download,WrapText} from 'lucide-react';
import {api} from '../lib/api';
import {isWithinExplorerRoot,normalizeExplorerPath} from '../lib/explorer-path';
import {highlightConversationCode,type CodeToken} from '../lib/conversation-highlight';
import {ConversationMarkdownBlocks} from '../lib/conversation-markdown-blocks';
import {conversationCjkStrong} from '../lib/conversation-cjk-strong';
import {MarkdownTable} from './AiReply';

const Streaming=createContext(false);
const SourceOffset=createContext(0);
const Trailing=createContext<{content:ReactNode;end:number;kind?:string}|null>(null);
const MarkdownSegment=memo(function MarkdownSegment({source,offset,components,footer,kind}:{source:string;offset:number;components:Components;footer?:ReactNode;kind?:string}) {
  const trailing=useMemo(()=>footer?{content:footer,end:source.trimEnd().length,kind}:null,[footer,source,kind]);
  return <SourceOffset.Provider value={offset}><Trailing.Provider value={trailing}><ReactMarkdown remarkPlugins={[remarkGfm,conversationCjkStrong]} components={components} skipHtml>{source}</ReactMarkdown></Trailing.Provider></SourceOffset.Provider>;
});
const trailingKinds=new Set(['paragraph','list','blockquote']);
function FooterParagraph({children,node,className,...props}:any){const trailing=useContext(Trailing),show=!!trailing&&['paragraph','blockquote'].includes(trailing.kind||'')&&node?.position?.end.offset===trailing.end;return <p {...props} className={[className,show?'conversation-footer-line':''].filter(Boolean).join(' ')}>{show?<span>{children}</span>:children}{show&&<span className="conversation-inline-meta">{trailing!.content}</span>}</p>;}
function FooterListItem({children,node,className,...props}:any){const trailing=useContext(Trailing),show=!!trailing&&trailing.kind==='list'&&node?.position?.end.offset===trailing.end&&!node.children?.some((child:any)=>['ul','ol'].includes(child.tagName));return <li {...props} className={[className,show?'conversation-footer-line':''].filter(Boolean).join(' ')}>{children}{show&&<span className="conversation-inline-meta">{trailing!.content}</span>}</li>;}
export function conversationLocalPath(source:string|undefined,root:string|undefined):string|null {
  if(!source||!root||source.startsWith('#')||source.startsWith('?')||source.startsWith('//')||/^[a-z][a-z\d+.-]*:/i.test(source))return null;
  try{
    const decoded=decodeURIComponent(source.split(/[?#]/,1)[0]).replace(/:\d+(?::\d+)?$/,'');
    if(decoded.includes('\0'))return null;
    const path=normalizeExplorerPath(decoded.startsWith('/')?decoded:`${root}/${decoded}`);
    return path && isWithinExplorerRoot(path,root)?path:null;
  }catch{return null;}
}

const CodeBlock=memo(function DiagramOrCode({source,language}:{source:string;language:string}){const streaming=useContext(Streaming);return isMermaidCode(source,language)?<MermaidDiagram source={source} streaming={streaming}/>:<PlainCodeBlock source={source} language={language}/>;});
const PlainCodeBlock=memo(function PlainCodeBlock({source,language}:{source:string;language:string}) {
  const streaming=useContext(Streaming);const [wrap,setWrap]=useState(false);const [copied,setCopied]=useState(false);const [copyError,setCopyError]=useState(false);
  const [highlighted,setHighlighted]=useState<{source:string;tokens:CodeToken[]}|null>(null);
  const code=source.endsWith('\n')?source.slice(0,-1):source;
  useEffect(()=>{
    let disposed=false;const timer=setTimeout(()=>{void highlightConversationCode(code,language).then(tokens=>{if(!disposed)setHighlighted({source:code,tokens});});},streaming?150:0);
    return ()=>{disposed=true;clearTimeout(timer);};
  },[code,language,streaming]);
  useEffect(()=>{if(!copied)return;const timer=setTimeout(()=>setCopied(false),1800);return ()=>clearTimeout(timer);},[copied]);
  const tokens=highlighted?.source===code?highlighted.tokens:[];const pieces:ReactNode[]=[];let offset=0;
  for(const token of tokens){if(token.from>offset)pieces.push(code.slice(offset,token.from));pieces.push(<span key={token.from} className={token.className}>{code.slice(token.from,token.to)}</span>);offset=token.to;}
  if(offset<code.length)pieces.push(code.slice(offset));
  return <div className="conversation-code" data-language={language||'text'}>
    <div className="conversation-code-toolbar"><span>{language||'text'}</span><div>
      <button aria-label="代码自动换行" aria-pressed={wrap} title="代码自动换行" onClick={()=>setWrap(value=>!value)}><WrapText size={13}/></button>
      <button aria-label="下载代码" title="下载代码" onClick={()=>{const url=URL.createObjectURL(new Blob([code],{type:'text/plain;charset=utf-8'}));const link=document.createElement('a');link.href=url;link.download=`code.${/^[a-z\d]+$/i.test(language)?language:'txt'}`;link.click();setTimeout(()=>URL.revokeObjectURL(url),1000);}}><Download size={13}/></button>
      <button aria-label={copied?'代码已复制':'复制代码'} title={copyError?'复制失败，请手动选择代码':copied?'已复制':'复制代码'} onClick={()=>{void copyConversationText(code).then(()=>{setCopied(true);setCopyError(false);}).catch(()=>setCopyError(true));}}>{copied?<Check size={13}/>:<Copy size={13}/>}</button>
    </div></div>
    <pre tabIndex={0} className={wrap?'conversation-code-wrap':undefined}><code>{pieces}</code></pre>
  </div>;
});
function MarkdownImage({src,alt,root,projectId}:{src?:string;alt?:string;root?:string;projectId:string|null}) {
  const openPreview=useConversationImagePreview();
  const local=conversationLocalPath(src,root);const [preview,setPreview]=useState<{path:string;url:string}|null>(null);const [error,setError]=useState(false);
  useEffect(()=>{
    setError(false);if(!local)return;const controller=new AbortController();let objectUrl:string|undefined;
    void api.files.preview(local,controller.signal,projectId||undefined).then(blob=>{if(controller.signal.aborted)return;objectUrl=URL.createObjectURL(blob);setPreview({path:local,url:objectUrl});}).catch(()=>{if(!controller.signal.aborted)setError(true);});
    return ()=>{controller.abort();if(objectUrl)URL.revokeObjectURL(objectUrl);};
  },[local,projectId,src]);
  const url=local?(preview?.path===local?preview.url:undefined):src && /^https?:\/\//i.test(src)?src:undefined;
  return error?<span className="conversation-image-error">图片加载失败{alt?`：${alt}`:''}</span>:<button type="button" className="conversation-inline-image" aria-label={`预览图片 ${alt||'图片'}`} disabled={!url} onClick={event=>{event.preventDefault();event.stopPropagation();if(url)openPreview?.({src:url,name:alt||'图片'});}}><img src={url} alt={alt||'图片'} loading="lazy" onError={()=>setError(true)}/></button>;
}

export const ConversationMarkdown=memo(function ConversationMarkdown({content,messageId,streaming=false,projectPath,projectId,onOpenFile,onNavigate,footer}:{
  content:string;messageId:string;streaming?:boolean;projectPath?:string;projectId:string|null;onOpenFile?:(path:string)=>void;onNavigate:()=>void;footer?:ReactNode;
}) {
  const blockReader=useRef<ConversationMarkdownBlocks|null>(null);
  blockReader.current??=new ConversationMarkdownBlocks();
  const blocks=blockReader.current.update(content,streaming);
  const components=useMemo<Components>(()=>{
    const heading=(level:1|2|3|4|5|6):Components['h1']=>function MarkdownHeading({children,node}){
      const offset=useContext(SourceOffset);
      const Tag=`h${level}` as const;return <Tag id={`chat-${messageId}-section-${offset+(node?.position?.start.offset??0)}`} data-chat-heading={level}>{children}</Tag>;
    };
    return {
      p:FooterParagraph,li:FooterListItem,
      h1:heading(1),h2:heading(2),h3:heading(3),h4:heading(4),h5:heading(5),h6:heading(6),
      pre:({children})=>{
        const child=Children.toArray(children).find(element=>isValidElement(element));
        if(!isValidElement<{children?:ReactNode;className?:string}>(child))return <pre>{children}</pre>;
        const source=String(child.props.children??'');const language=(child.props.className||'').replace(/^language-/,'').split(/\s/)[0];
        return <CodeBlock source={source} language={language}/>;
      },
      table:({children})=><MarkdownTable className="conversation-table-scroll">{children}</MarkdownTable>,
      a:({href,children,title,node})=>{
        const previewFile=useConversationFilePreview();
        if(node?.children.some(child=>child.type==='element'&&child.tagName==='img'))return <>{children}</>;
        const path=conversationLocalPath(href,projectPath);
        if(path)return <a href={href} title={title||path} onClick={event=>{event.preventDefault();if(previewFile&&projectPath)previewFile({path,rootPath:projectPath,projectId,name:path.split('/').pop()||path});else onOpenFile?.(path);}}>{children}</a>;
        if(href?.startsWith('#'))return <a href={href} onClick={event=>{
          const scope=event.currentTarget.closest('.session-chat-message');let fragment:string;try{fragment=decodeURIComponent(href.slice(1));}catch{return;}
          const target=[...(scope?.querySelectorAll<HTMLElement>('[id]')||[])].find(node=>node.id===fragment || node.id===`user-content-${fragment}` || node.dataset.chatHeading && (node.textContent||'').trim().toLowerCase().replace(/\s+/g,'-')===fragment);
          if(target){event.preventDefault();onNavigate();target.scrollIntoView({block:'start'});}
        }}>{children}</a>;
        if(!href || !/^(https?:|mailto:|tel:|\/\/)/i.test(href))return <span title={href}>{children}</span>;
        return <a href={href} title={title} target="_blank" rel="noopener noreferrer">{children}</a>;
      },
      img:({src,alt})=><MarkdownImage src={typeof src==='string'?src:undefined} alt={alt} root={projectPath} projectId={projectId}/>,
    };
  },[messageId,projectPath,projectId,onOpenFile,onNavigate]);
  const inline=trailingKinds.has(blocks.at(-1)?.kind||'');
  return <ConversationImagePreviewRoot><Streaming.Provider value={streaming}><div className="markdown-preview conversation-markdown">{blocks.map((block,index)=><MarkdownSegment key={block.key} source={block.source} offset={block.offset} components={components} kind={block.kind} footer={inline&&index===blocks.length-1?footer:undefined}/>)}{!inline&&footer&&<div className="conversation-footer-fallback">{footer}</div>}</div></Streaming.Provider></ConversationImagePreviewRoot>;
});
