import {memo,useEffect,useId,useMemo,useRef,useState,type RefObject} from 'react';
import {ChevronUp} from 'lucide-react';
import {parseConversationInput} from '../lib/conversation-attachments';
import type {ConversationMessage} from '../lib/api';

const DEFAULT_WIDTH=784;
export function readingWidth(preference:number|null,available:number) {
  const maximum=Math.max(0,available-(available>=760?144:32));
  return Math.min(maximum,Math.max(Math.min(480,maximum),preference??DEFAULT_WIDTH));
}

export function ConversationWidthHandles({root,scroll,active,storageKey}:{
  root:RefObject<HTMLElement|null>;scroll:RefObject<HTMLDivElement|null>;active:boolean;storageKey:string;
}) {
  const preference=useRef<number|null>(null);
  const [size,setSize]=useState(DEFAULT_WIDTH);
  const [maximum,setMaximum]=useState(DEFAULT_WIDTH);
  const gesture=useRef<{side:'left'|'right';origin:number;base:number;pointer:number;element:HTMLElement;latest:number;anchor:Element|null;offset:number}|null>(null);
  const frame=useRef<number|null>(null);
  const publish=useRef<(value:number|null)=>number>(()=>DEFAULT_WIDTH);
  const commit=useRef<(value:number|null)=>void>(()=>{});
  const cancel=useRef<()=>void>(()=>{});
  useEffect(()=>{
    const element=root.current;if(!element)return;
    try {const stored=localStorage.getItem(storageKey);const parsed=Number(stored);preference.current=stored!==null && Number.isFinite(parsed) && parsed>0?parsed:null;}catch{preference.current=null;}
    publish.current=(value)=>{
      if(element.clientWidth<=0)return value??DEFAULT_WIDTH;
      const width=readingWidth(value,element.clientWidth);
      element.style.setProperty('--chat-reading-width',`${width}px`);
      setSize(width);setMaximum(readingWidth(Number.MAX_SAFE_INTEGER,element.clientWidth));
      return width;
    };
    commit.current=value=>{preference.current=value;publish.current(value);try{if(value===null)localStorage.removeItem(storageKey);else localStorage.setItem(storageKey,String(value));}catch{/* Optional local preference. */}};
    cancel.current=()=>{
      if(frame.current!==null)cancelAnimationFrame(frame.current);frame.current=null;
      const current=gesture.current;gesture.current=null;
      if(current?.element.hasPointerCapture?.(current.pointer))current.element.releasePointerCapture(current.pointer);
      delete element.dataset.readingResize;publish.current(preference.current);
    };
    const resize=()=>{if(!gesture.current)publish.current(preference.current);};
    resize();const observer=typeof ResizeObserver==='undefined'?null:new ResizeObserver(resize);observer?.observe(element);
    window.addEventListener('resize',resize);window.addEventListener('blur',cancel.current);
    const onBlur=cancel.current;
    return ()=>{observer?.disconnect();window.removeEventListener('resize',resize);window.removeEventListener('blur',onBlur);cancel.current();};
  },[root,storageKey]);
  useEffect(()=>{
    if(!active){cancel.current();return;}
    try{const stored=localStorage.getItem(storageKey);const value=Number(stored);preference.current=stored!==null && Number.isFinite(value) && value>0?value:null;}catch{/* Keep the in-memory preference when storage is unavailable. */}
    publish.current(preference.current);
  },[active,storageKey]);
  function apply() {
    frame.current=null;const current=gesture.current;if(!current)return;
    publish.current(current.base+(current.latest-current.origin)*(current.side==='right'?2:-2));
    if(current.anchor && scroll.current)scroll.current.scrollTop+=current.anchor.getBoundingClientRect().top-current.offset;
  }
  return <>{(['left','right'] as const).map(side=><div key={side} className={`conversation-width-handle ${side}`} role="separator" tabIndex={0}
    aria-label={side==='left'?'左侧阅读宽度':'右侧阅读宽度'} aria-orientation="vertical" aria-valuemin={Math.min(480,maximum)} aria-valuemax={Math.round(maximum)} aria-valuenow={Math.round(size)}
    title="拖动调整阅读宽度；双击恢复默认；方向键微调"
    onPointerDown={event=>{
      if(event.button!==0)return;event.preventDefault();
      const area=scroll.current;const top=area?.getBoundingClientRect().top??0;
      let anchor:Element|null=null;let distance=Infinity;
      for(const node of area?.querySelectorAll('.session-chat-message p, [data-chat-heading], .session-chat-user-text')||[]) {
        const rect=node.getBoundingClientRect();if(rect.bottom<top)continue;
        const candidate=Math.abs(rect.top-top);if(candidate<distance){distance=candidate;anchor=node;}
      }
      gesture.current={side,origin:event.clientX,base:size,pointer:event.pointerId,element:event.currentTarget,latest:event.clientX,anchor,offset:anchor?.getBoundingClientRect().top??0};
      event.currentTarget.setPointerCapture?.(event.pointerId);if(root.current)root.current.dataset.readingResize='true';
    }}
    onPointerMove={event=>{const current=gesture.current;if(!current||current.pointer!==event.pointerId)return;current.latest=event.clientX;if(frame.current===null)frame.current=requestAnimationFrame(apply);}}
    onPointerUp={event=>{
      const current=gesture.current;if(!current||current.pointer!==event.pointerId)return;
      current.latest=event.clientX;if(frame.current!==null)cancelAnimationFrame(frame.current);apply();
      gesture.current=null;if(event.currentTarget.hasPointerCapture?.(event.pointerId))event.currentTarget.releasePointerCapture(event.pointerId);
      if(root.current)delete root.current.dataset.readingResize;
      if(current.origin!==current.latest)commit.current(readingWidth(current.base+(current.latest-current.origin)*(side==='right'?2:-2),root.current?.clientWidth??0));
    }}
    onPointerCancel={()=>cancel.current()} onLostPointerCapture={()=>{if(gesture.current)cancel.current();}}
    onDoubleClick={()=>commit.current(null)}
    onKeyDown={event=>{let next:number|null;if(event.key==='ArrowLeft')next=size-32;else if(event.key==='ArrowRight')next=size+32;else if(event.key==='Home')next=480;else if(event.key==='End')next=maximum;else if(event.key==='Enter')next=null;else return;event.preventDefault();commit.current(next===null?null:readingWidth(next,root.current?.clientWidth??0));}}
  ><span/></div>)}</>;
}

export interface ConversationOutlineItem {id:string;prompt:string;question:string;response:string;answers:string[];streaming:boolean}
function excerpt(text:string,limit:number) {return text.slice(0,limit*3).replace(/\[([^\]]+)\]\([^)]*\)/g,'$1').replace(/[*_#>`~]/g,'').replace(/\s+/g,' ').trim().slice(0,limit);}
export function conversationOutline(messages:ConversationMessage[]):ConversationOutlineItem[] {
  const items:ConversationOutlineItem[]=[];
  for(const message of messages) {
    if(message.role==='user')items.push({id:message.id,prompt:excerpt(parseConversationInput(message.text).text,140)||'未命名提问',question:parseConversationInput(message.text).text.slice(0,4000)||'附件提问',response:'',answers:[],streaming:false});
    else {
      if(!items.length)items.push({id:message.id,prompt:'较早的回复',question:'',response:'',answers:[],streaming:false});
      const item=items[items.length-1];item.answers.push(message.id);item.streaming ||= !!message.streaming;
      if(message.text.trim())item.response=excerpt(message.text,200);
    }
  }
  return items;
}

export const ConversationNavigator=memo(function ConversationNavigator({messages,scroll,active,hasMore,loadingOlder,onLoadOlder,onNavigate}:{
  messages:ConversationMessage[];scroll:RefObject<HTMLDivElement|null>;active:boolean;hasMore:boolean;loadingOlder:boolean;onLoadOlder:()=>void;onNavigate:()=>void;
}) {
  // Rail previews have a bounded vocabulary; later stream chunks do not rebuild
  // hundreds of marks just because the answer's trailing text grew.
  const signature=JSON.stringify(conversationOutline(messages));
  const items=useMemo(()=>JSON.parse(signature) as ConversationOutlineItem[],[signature]);
  const [current,setCurrent]=useState<string|null>(null);
  const [preview,setPreview]=useState<{id:string;top:number;headings:Array<{id:string;text:string;level:number}>}|null>(null);
  const nav=useRef<HTMLElement>(null);const ladder=useRef<HTMLDivElement>(null);const hovering=useRef(false);const previewId=useId();
  function target(id:string) {return [...(scroll.current?.querySelectorAll<HTMLElement>('[data-chat-message-id]')||[])].find(node=>node.dataset.chatMessageId===id)||null;}
  useEffect(()=>{
    const area=scroll.current;if(!active||!area)return;
    let frame:number|null=null;
    const measure=()=>{
      frame=null;let selected=items[0]?.id||null;const top=area.getBoundingClientRect().top+48;
      for(const item of items){const node=target(item.answers.at(-1)||item.id);if(node && node.getBoundingClientRect().top<=top)selected=item.id;}
      if(area.scrollHeight-area.scrollTop-area.clientHeight<24)selected=items.at(-1)?.id||selected;
      setCurrent(selected);
    };
    const schedule=()=>{if(frame===null)frame=requestAnimationFrame(measure);};
    measure();area.addEventListener('scroll',schedule,{passive:true});
    const observer=typeof ResizeObserver==='undefined'?null:new ResizeObserver(schedule);const feed=area.firstElementChild;if(feed)observer?.observe(feed);
    return ()=>{area.removeEventListener('scroll',schedule);observer?.disconnect();if(frame!==null)cancelAnimationFrame(frame);};
  },[active,items,scroll]);
  useEffect(()=>{
    if(hovering.current || !current || !ladder.current)return;
    const mark=ladder.current.querySelector<HTMLElement>('[aria-current="location"]');
    if(mark && (mark.offsetTop<ladder.current.scrollTop || mark.offsetTop>ladder.current.scrollTop+ladder.current.clientHeight-16))ladder.current.scrollTop=mark.offsetTop-ladder.current.clientHeight/2;
  },[current]);
  function show(item:ConversationOutlineItem,button:HTMLButtonElement) {
    const headings=item.answers.flatMap(id=>[...(target(id)?.querySelectorAll<HTMLElement>('[data-chat-heading]')||[])].map(node=>({id:node.id,text:node.textContent||'',level:Number(node.dataset.chatHeading)})));
    const bounds=nav.current?.getBoundingClientRect();const area=scroll.current?.getBoundingClientRect();
    const top=button.getBoundingClientRect().top-(bounds?.top||0);
    const height=Math.min(420,Math.max(96,(area?.height||420)-16));
    setPreview({id:item.id,top:Math.max((area?.top||0)-(bounds?.top||0)+8,Math.min(top,(area?.bottom||innerHeight)-(bounds?.top||0)-height-8)),headings});
  }
  function jump(node:HTMLElement|null) {
    const area=scroll.current;if(!node||!area)return;onNavigate();
    const reduce=window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    area.scrollTo({top:Math.max(0,area.scrollTop+node.getBoundingClientRect().top-area.getBoundingClientRect().top-20),behavior:reduce?'auto':'smooth'});
    setPreview(null);
  }
  const item=items.find(entry=>entry.id===preview?.id);
  if(items.length<2&&!hasMore)return null;
  return <nav ref={nav} className="conversation-navigator" aria-label="对话目录" onPointerEnter={()=>{hovering.current=true;}} onPointerLeave={()=>{hovering.current=false;setPreview(null);}} onKeyDown={event=>{if(event.key==='Escape')setPreview(null);}}>
    {hasMore && <button className="conversation-older-mark" title="加载更早对话" aria-label="目录加载更早对话" disabled={loadingOlder} onClick={onLoadOlder}><ChevronUp size={13}/></button>}
    <div className="conversation-navigator-scroll" ref={ladder}>{items.map((entry,index)=><button key={entry.id} className="conversation-nav-mark" aria-label={`跳转到第 ${index+1} 段对话：${entry.prompt}`} aria-current={current===entry.id?'location':undefined} aria-haspopup="dialog" aria-expanded={preview?.id===entry.id} data-streaming={entry.streaming}
      onPointerEnter={event=>show(entry,event.currentTarget)} onFocus={event=>show(entry,event.currentTarget)} onBlur={event=>{if(!nav.current?.contains(event.relatedTarget))setPreview(null);}}
      onClick={()=>jump(target(entry.answers.at(-1)||entry.id))}><span/></button>)}</div>
    {item && preview && <div className="conversation-nav-preview" style={{top:preview.top}} role="dialog" aria-label="对话预览" id={previewId}><div className="conversation-nav-preview-content" style={{maxHeight:Math.min(394,Math.max(64,(scroll.current?.clientHeight||316)-42)),overflowY:'auto',overflowX:'hidden'}}>
      {item.question&&<div className="conversation-nav-title conversation-nav-question-label">你的问题</div>}
      {item.question&&<button className="conversation-nav-question" onClick={()=>jump(target(item.id))}>{item.question}</button>}
      <div className="conversation-nav-title">Agent 输出</div>
      <button className="conversation-nav-response" disabled={!item.answers.length} onClick={()=>jump(target(item.answers.at(-1)||item.id))}>{item.response||'Agent 尚未回复'}</button>
      {preview.headings.length>0 && <div className="conversation-nav-headings" aria-label="回复章节">{preview.headings.map(heading=><button key={heading.id} style={{paddingLeft:Math.min(heading.level-1,3)*8}} onClick={()=>jump([...(scroll.current?.querySelectorAll<HTMLElement>('[data-chat-heading]')||[])].find(node=>node.id===heading.id)||null)}>{heading.text}</button>)}</div>}
    </div></div>}
  </nav>;
});
