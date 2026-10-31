import {createContext,useCallback,useContext,useEffect,useRef,useState,useMemo,type ReactNode} from 'react';
import {Minus,Plus,Scan} from 'lucide-react';
import {Dialog} from './Dialog';
import {ConversationFilePreview,type ConversationPreviewFile} from './ConversationFilePreview';
import './ConversationImagePreview.css';

interface PreviewImage {src:string;name:string}
type Selection=({kind:'image'}&PreviewImage)|({kind:'file'}&ConversationPreviewFile);
const Preview=createContext<{image:(image:PreviewImage)=>void;file:(file:ConversationPreviewFile)=>void}|null>(null);
/** One preview per conversation; hiding/switching a session releases its overlay. */
export function ConversationImagePreviewRoot({children,active=true,onOpen}:{children:ReactNode;active?:boolean;onOpen?:()=>void}) {
  const inherited=useContext(Preview),[selected,setSelected]=useState<Selection|null>(null);
  const position=useRef<{node:HTMLElement;top:number;left:number}|null>(null);
  const open=useCallback((image:Selection)=>{
    const node=document.activeElement instanceof HTMLElement?document.activeElement.closest<HTMLElement>('.session-chat-scroll'):null;
    position.current=node?{node,top:node.scrollTop,left:node.scrollLeft}:null;
    onOpen?.();setSelected(image);
  },[onOpen]);
  const actions=useMemo(()=>({image:(image:PreviewImage)=>open({...image,kind:'image'}),file:(file:ConversationPreviewFile)=>open({...file,kind:'file'})}),[open]);
  const close=()=>{setSelected(null);const saved=position.current;position.current=null;if(saved)requestAnimationFrame(()=>{if(saved.node.isConnected){saved.node.scrollTop=saved.top;saved.node.scrollLeft=saved.left;}});};
  useEffect(()=>{if(!active)setSelected(null);},[active]);
  useEffect(()=>{if(!selected||!active)return;const before=document.body.style.overflow;document.body.style.overflow='hidden';return()=>{document.body.style.overflow=before;};},[!!selected,active]);
  if(inherited)return <>{children}</>;
  return <Preview.Provider value={actions}>{children}{active&&selected&&(selected.kind==='image'?<ImagePreview key={selected.src} image={selected} onClose={close}/>:<ConversationFilePreview key={selected.path} file={selected} onClose={close}/>)}</Preview.Provider>;
}
export function useConversationImagePreview(){return useContext(Preview)?.image;}
export function useConversationFilePreview(){return useContext(Preview)?.file;}

function ImagePreview({image,onClose}:{image:PreviewImage;onClose:()=>void}) {
  const stage=useRef<HTMLDivElement>(null),[natural,setNatural]=useState({width:0,height:0}),[available,setAvailable]=useState({width:800,height:500});
  const [zoom,setZoom]=useState<number|null>(null),[failed,setFailed]=useState(false);
  useEffect(()=>{
    const node=stage.current;if(!node)return;
    const measure=()=>{if(node.clientWidth&&node.clientHeight)setAvailable({width:node.clientWidth,height:node.clientHeight});};measure();
    const observer=typeof ResizeObserver==='undefined'?null:new ResizeObserver(measure);observer?.observe(node);window.addEventListener('resize',measure);
    return ()=>{observer?.disconnect();window.removeEventListener('resize',measure);};
  },[]);
  const fit=natural.width?Math.min(1,Math.max(.05,(available.width-24)/natural.width),Math.max(.05,(available.height-24)/natural.height)):1;
  const scale=zoom??fit;
  return <Dialog title={`图片预览 · ${image.name}`} size="image" onClose={onClose}>
    <div className="conversation-image-preview-toolbar" role="group" aria-label="图片缩放">
      <span>{natural.width?`${natural.width} × ${natural.height}`:'正在加载…'}</span>
      <button type="button" disabled={!natural.width||scale<=.1} aria-label="缩小图片" onClick={()=>setZoom(Math.max(.1,scale/1.25))}><Minus size={15}/></button>
      <output aria-label="图片缩放比例">{Math.round(scale*100)}%</output>
      <button type="button" disabled={!natural.width||scale>=4} aria-label="放大图片" onClick={()=>setZoom(Math.min(4,scale*1.25))}><Plus size={15}/></button>
      <button type="button" disabled={!natural.width} onClick={()=>setZoom(null)}><Scan size={15}/>适应窗口</button>
    </div>
    <div ref={stage} className="conversation-image-preview-stage" tabIndex={0} aria-label="图片预览区域">
      {failed?<p role="alert">图片加载失败，请关闭后重试。</p>:<div className="conversation-image-preview-canvas" style={{width:Math.max(available.width,natural.width*scale),height:Math.max(available.height,natural.height*scale)}}>
        <img src={image.src} alt={image.name} draggable={false} onLoad={event=>setNatural({width:event.currentTarget.naturalWidth,height:event.currentTarget.naturalHeight})} onError={()=>setFailed(true)} style={{width:natural.width?natural.width*scale:undefined,height:natural.height?natural.height*scale:undefined}}/>
      </div>}
    </div>
    <p className="conversation-image-preview-hint">放大后可滚动查看 · Esc 或点击遮罩关闭</p>
  </Dialog>;
}
