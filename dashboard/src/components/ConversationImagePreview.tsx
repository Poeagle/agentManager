import {createContext,useCallback,useContext,useEffect,useRef,useState,useMemo,type ReactNode} from 'react';
import {Minus,Plus,Scan} from 'lucide-react';
import {createPortal} from 'react-dom';
import {Dialog} from './Dialog';
import {ConversationFilePreview,type ConversationPreviewFile} from './ConversationFilePreview';
import './ConversationImagePreview.css';

interface PreviewImage {src:string;name:string}
type Selection=({kind:'image'}&PreviewImage)|({kind:'file'}&ConversationPreviewFile);
const Preview=createContext<{image:(image:PreviewImage)=>void;file:(file:ConversationPreviewFile)=>void;hover:{show:(image:PreviewImage,anchor:HTMLElement)=>void;hide:()=>void}}|null>(null);
const sidebarWidthKey='conversation-preview-width';
function savedSidebarWidth(){try{const value=Number(localStorage.getItem(sidebarWidthKey));if(value>=.2&&value<=.7)return value;}catch{/* Storage may be unavailable. */}return .46;}
/** One preview per conversation; hiding/switching a session releases its overlay. */
export function ConversationImagePreviewRoot({children,active=true,onOpen}:{children:ReactNode;active?:boolean;onOpen?:()=>void}) {
  const inherited=useContext(Preview),[selected,setSelected]=useState<Selection|null>(null);
  const [hovered,setHovered]=useState<(PreviewImage&{anchor:DOMRect})|null>(null),[hoverFailed,setHoverFailed]=useState(false);
  const hoverTimer=useRef<ReturnType<typeof setTimeout>|null>(null);
  const hideHover=useCallback(()=>{if(hoverTimer.current)clearTimeout(hoverTimer.current);hoverTimer.current=null;setHovered(null);},[]);
  const hover=useMemo(()=>({hide:hideHover,show:(image:PreviewImage,anchor:HTMLElement)=>{hideHover();hoverTimer.current=setTimeout(()=>{hoverTimer.current=null;if(anchor.isConnected){setHoverFailed(false);setHovered({...image,anchor:anchor.getBoundingClientRect()});}},200);}}),[hideHover]);
  useEffect(()=>()=>{if(hoverTimer.current)clearTimeout(hoverTimer.current);},[]);
  useEffect(()=>{if(!active)hideHover();},[active,hideHover]);
  useEffect(()=>{if(!hovered)return;window.addEventListener('resize',hideHover);window.addEventListener('scroll',hideHover,true);return()=>{window.removeEventListener('resize',hideHover);window.removeEventListener('scroll',hideHover,true);};},[!!hovered,hideHover]);
  const [docked,setDocked]=useState(false),[dock,setDock]=useState<{left:number;top:number;width:number;height:number}>(),[canDock,setCanDock]=useState(false);
  const layout=useRef<HTMLDivElement>(null),sidebar=useRef<HTMLDivElement>(null);
  const [sidebarWidth,setSidebarWidth]=useState(savedSidebarWidth),[dragging,setDragging]=useState(false);
  const drag=useRef<{pointerId:number;startX:number;startWidth:number}|null>(null);
  const setWidth=(pixels:number)=>{
    const total=layout.current?.clientWidth||0;if(total<720)return;
    const ratio=Math.max(300,Math.min(total*.7,total-328,pixels))/total;
    setSidebarWidth(ratio);try{localStorage.setItem(sidebarWidthKey,String(ratio));}catch{/* Keep in-memory sizing. */}
  };
  useEffect(()=>{if(!active||!docked||!selected){drag.current=null;setDragging(false);}},[active,docked,!!selected]);
  useEffect(()=>{
    if(!dragging)return;
    const cursor=document.body.style.cursor,selection=document.body.style.userSelect;
    document.body.style.cursor='col-resize';document.body.style.userSelect='none';
    return()=>{document.body.style.cursor=cursor;document.body.style.userSelect=selection;};
  },[dragging]);
  useEffect(()=>{
    if(inherited)return;
    const measure=()=>{const root=layout.current,side=sidebar.current;if(root){setCanDock(root.clientWidth>=720);if(root.clientWidth>0&&root.clientWidth<720)setDocked(false);}if(side){const r=side.getBoundingClientRect();setDock({left:r.left,top:r.top,width:r.width,height:r.height});}};measure();
    const observer=typeof ResizeObserver==='undefined'?null:new ResizeObserver(measure);if(layout.current)observer?.observe(layout.current);if(sidebar.current)observer?.observe(sidebar.current);window.addEventListener('resize',measure);window.addEventListener('scroll',measure,true);
    return()=>{observer?.disconnect();window.removeEventListener('resize',measure);window.removeEventListener('scroll',measure,true);};
  },[inherited,docked,!!selected]);
  const position=useRef<{node:HTMLElement;top:number;left:number}|null>(null);
  const open=useCallback((image:Selection)=>{
    hideHover();
    const node=document.activeElement instanceof HTMLElement?document.activeElement.closest<HTMLElement>('.session-chat-scroll'):null;
    position.current=node?{node,top:node.scrollTop,left:node.scrollLeft}:null;
    onOpen?.();if(image.kind==='image')setDocked(false);setSelected(image);
  },[onOpen,hideHover]);
  const actions=useMemo(()=>({image:(image:PreviewImage)=>open({...image,kind:'image'}),file:(file:ConversationPreviewFile)=>open({...file,kind:'file'}),hover}),[open,hover]);
  const close=()=>{setSelected(null);setDocked(false);const saved=position.current;position.current=null;if(saved)requestAnimationFrame(()=>{if(saved.node.isConnected){saved.node.scrollTop=saved.top;saved.node.scrollLeft=saved.left;}});};
  useEffect(()=>{if(!active)setSelected(null);},[active]);
  useEffect(()=>{if(!selected||!active||docked)return;const before=document.body.style.overflow;document.body.style.overflow='hidden';return()=>{document.body.style.overflow=before;};},[!!selected,active,docked]);
  if(inherited)return <>{children}</>;
  return <Preview.Provider value={actions}><div ref={layout} className="conversation-preview-layout"><div className="conversation-preview-main">{children}</div>{active&&docked&&selected?.kind==='file'&&<div ref={sidebar} className="conversation-preview-sidebar" style={{width:`${sidebarWidth*100}%`}} aria-hidden="true"/>}</div>{active&&selected&&(selected.kind==='image'?<ImagePreview key={selected.src} image={selected} onClose={close}/>:<ConversationFilePreview key={selected.path} file={selected} onClose={close} dock={docked?dock:undefined} canDock={canDock} onDock={()=>setDocked(value=>!value)}/>)}
    {active&&hovered&&createPortal(<div className="conversation-image-hover" role="tooltip" aria-label={`图片缩略预览 · ${hovered.name}`} style={{left:Math.max(8,Math.min(hovered.anchor.left,window.innerWidth-296)),...(hovered.anchor.top>=230?{bottom:window.innerHeight-hovered.anchor.top+8}:{top:Math.min(hovered.anchor.bottom+8,Math.max(8,window.innerHeight-230))})}}>{hoverFailed?<span>图片加载失败，点击可重试预览</span>:<img src={hovered.src} alt={hovered.name} onError={()=>setHoverFailed(true)}/>}<span>{hovered.name}</span></div>,document.body)}
    {active&&docked&&selected?.kind==='file'&&dock&&createPortal(<>
      {dragging&&<div className="conversation-preview-resize-shield"/>}
      <div className="conversation-preview-resizer" role="separator" aria-label="调整文件预览宽度" aria-orientation="vertical" tabIndex={0} aria-valuemin={300} aria-valuemax={Math.round(Math.min((layout.current?.clientWidth||0)*.7,(layout.current?.clientWidth||0)-328))} aria-valuenow={Math.round(dock.width)} title="左右拖动调整宽度，双击恢复默认"
        style={{left:dock.left-8,top:dock.top,height:dock.height}}
        onPointerDown={event=>{if(event.button!==0)return;event.preventDefault();event.currentTarget.setPointerCapture(event.pointerId);drag.current={pointerId:event.pointerId,startX:event.clientX,startWidth:dock.width};setDragging(true);}}
        onPointerMove={event=>{const current=drag.current;if(current?.pointerId===event.pointerId)setWidth(current.startWidth+current.startX-event.clientX);}}
        onPointerUp={event=>{if(drag.current?.pointerId!==event.pointerId)return;setWidth(drag.current.startWidth+drag.current.startX-event.clientX);drag.current=null;setDragging(false);if(event.currentTarget.hasPointerCapture(event.pointerId))event.currentTarget.releasePointerCapture(event.pointerId);}}
        onPointerCancel={()=>{drag.current=null;setDragging(false);}} onLostPointerCapture={()=>{drag.current=null;setDragging(false);}}
        onDoubleClick={()=>setWidth((layout.current?.clientWidth||0)*.46)}
        onKeyDown={event=>{const total=layout.current?.clientWidth||0,step=event.shiftKey?64:32;let width:number;if(event.key==='ArrowLeft')width=dock.width+step;else if(event.key==='ArrowRight')width=dock.width-step;else if(event.key==='Home')width=300;else if(event.key==='End')width=Math.min(total*.7,total-328);else return;event.preventDefault();setWidth(width);}}/>
    </>,document.body)}
  </Preview.Provider>;
}
export function useConversationImagePreview(){return useContext(Preview)?.image;}
export function useConversationFilePreview(){return useContext(Preview)?.file;}
export function useConversationImageHover(){return useContext(Preview)?.hover;}

export function ImagePreview({image,onClose}:{image:PreviewImage;onClose:()=>void}) {
  const stage=useRef<HTMLDivElement>(null),[natural,setNatural]=useState({width:0,height:0}),[available,setAvailable]=useState({width:800,height:500});
  const [viewport,setViewport]=useState(()=>({width:window.innerWidth,height:window.innerHeight}));
  const [zoom,setZoom]=useState<number|null>(null),[failed,setFailed]=useState(false);
  useEffect(()=>{
    const node=stage.current;if(!node)return;
    const measure=()=>{setViewport({width:window.innerWidth,height:window.innerHeight});if(node.clientWidth&&node.clientHeight)setAvailable({width:node.clientWidth,height:node.clientHeight});};measure();
    const observer=typeof ResizeObserver==='undefined'?null:new ResizeObserver(measure);observer?.observe(node);window.addEventListener('resize',measure);
    return ()=>{observer?.disconnect();window.removeEventListener('resize',measure);};
  },[]);
  const maxWidth=Math.max(100,Math.min(1600,viewport.width*.92)-34),maxHeight=Math.max(80,Math.min(900,viewport.height*.72,viewport.height-190));
  const fit=natural.width?Math.min(1,(maxWidth-24)/natural.width,(maxHeight-24)/natural.height):1;
  const scale=zoom??fit;
  const width=natural.width?Math.max(360,natural.width*scale+58):420,height=natural.height?Math.min(maxHeight,Math.max(48,natural.height*scale+24)):120;
  return <Dialog title={`图片预览 · ${image.name}`} size="image" width={width} onClose={onClose}>
    <div className="conversation-image-preview-toolbar" role="group" aria-label="图片缩放">
      <span>{natural.width?`${natural.width} × ${natural.height}`:'正在加载…'}</span>
      <button type="button" disabled={!natural.width||scale<=.1} aria-label="缩小图片" onClick={()=>setZoom(Math.max(.1,scale/1.25))}><Minus size={15}/></button>
      <output aria-label="图片缩放比例">{Math.round(scale*100)}%</output>
      <button type="button" disabled={!natural.width||scale>=4} aria-label="放大图片" onClick={()=>setZoom(Math.min(4,scale*1.25))}><Plus size={15}/></button>
      <button type="button" disabled={!natural.width} onClick={()=>setZoom(null)}><Scan size={15}/>适应窗口</button>
    </div>
    <div ref={stage} className="conversation-image-preview-stage" style={{height}} tabIndex={0} aria-label="图片预览区域">
      {failed?<p role="alert">图片加载失败，请关闭后重试。</p>:<div className="conversation-image-preview-canvas" style={{width:Math.max(available.width,natural.width*scale),height:Math.max(available.height,natural.height*scale)}}>
        <img src={image.src} alt={image.name} draggable={false} onLoad={event=>setNatural({width:event.currentTarget.naturalWidth,height:event.currentTarget.naturalHeight})} onError={()=>setFailed(true)} style={{width:natural.width?natural.width*scale:undefined,height:natural.height?natural.height*scale:undefined}}/>
      </div>}
    </div>
    <p className="conversation-image-preview-hint">放大后可滚动查看 · Esc 或点击遮罩关闭</p>
  </Dialog>;
}
