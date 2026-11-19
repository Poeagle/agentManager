import {useEffect,type RefObject} from 'react';
import {notificationApi,setVisibleConversation} from './notifications';

/** Only content actually visible in an active foreground conversation counts
 * as read. Hidden project panes and off-screen messages remain unread. */
export function useConversationNotificationVisibility(root:RefObject<HTMLElement|null>,sessionId:string,nativeId:string|null,active:boolean,version:string) {
  useEffect(()=>{
    if(!active||!nativeId||!root.current||typeof IntersectionObserver==='undefined')return;
    const owner={},visible=new Set<HTMLElement>(),boundNative=nativeId;
    let timer:ReturnType<typeof setTimeout>|undefined;
    const sync=()=>{
      if(timer||document.visibilityState!=='visible'||!document.hasFocus())return;
      timer=setTimeout(()=>{timer=undefined;if(document.visibilityState!=='visible'||!document.hasFocus())return;
        const messageIds=new Set<string>(),questionIds=new Set<string>();
        for(const node of visible){const id=node.dataset.chatMessageId||node.dataset.interactionId;if(id)messageIds.add(id);
          try{for(const q of JSON.parse(node.dataset.questionIds||'[]'))if(typeof q==='string')questionIds.add(q);}catch{/* Ignore malformed metadata. */}}
        if(messageIds.size||questionIds.size)void notificationApi.readVisible({session_id:sessionId,native_id:boundNative,message_ids:[...messageIds].slice(0,200),question_ids:[...questionIds].slice(0,200)}).catch(()=>{});
      },100);
    };
    const publish=()=>{
      const messageIds=new Set<string>(),questionIds=new Set<string>();
      for(const node of visible){
        const id=node.dataset.chatMessageId||node.dataset.interactionId;if(id)messageIds.add(id);
        try{for(const id of JSON.parse(node.dataset.questionIds||'[]'))if(typeof id==='string')questionIds.add(id);}catch{/* Invalid DOM metadata does not mark content read. */}
      }
      setVisibleConversation(owner,{sessionId,nativeId:boundNative,messageIds,questionIds});sync();
    };
    const observer=new IntersectionObserver(entries=>{
      for(const entry of entries){const node=entry.target as HTMLElement;
        if(entry.isIntersecting&&entry.intersectionRect.height>=Math.min(60,entry.boundingClientRect.height*.5))visible.add(node);else visible.delete(node);
      }publish();
    },{root:root.current,threshold:[0,.1,.5,1]});
    window.addEventListener('focus',sync);document.addEventListener('visibilitychange',sync);window.addEventListener('agentmanager:notifications-changed',sync);
    root.current.querySelectorAll<HTMLElement>('[data-chat-message-id],[data-interaction-id]').forEach(node=>observer.observe(node));
    return()=>{clearTimeout(timer);observer.disconnect();window.removeEventListener('focus',sync);document.removeEventListener('visibilitychange',sync);window.removeEventListener('agentmanager:notifications-changed',sync);setVisibleConversation(owner,null);};
  },[root,sessionId,nativeId,active,version]);
}
