import {useRef} from 'react';
import {act,render,waitFor} from '@testing-library/react';
import {afterEach,expect,it,vi} from 'vitest';
import {notificationApi} from '../src/lib/notifications';
import {useConversationNotificationVisibility} from '../src/lib/use-conversation-notification-visibility';

afterEach(()=>{vi.restoreAllMocks();vi.unstubAllGlobals();});
it('clears only visible message identities when the browser is foreground, including after a notification arrives',async()=>{
  let callback:IntersectionObserverCallback=()=>{};
  vi.stubGlobal('IntersectionObserver',class {constructor(cb:IntersectionObserverCallback){callback=cb;} observe(){} disconnect(){}});
  const focus=vi.spyOn(document,'hasFocus').mockReturnValue(false);
  const read=vi.spyOn(notificationApi,'readVisible').mockResolvedValue({ok:true});
  function Probe(){const root=useRef<HTMLDivElement>(null);useConversationNotificationVisibility(root,'session','native',true,'v');return <div ref={root}><article data-chat-message-id="visible" data-question-ids='["q"]'/><article data-chat-message-id="offscreen"/></div>;}
  const view=render(<Probe/>),node=view.container.querySelector('[data-chat-message-id="visible"]')!;
  act(()=>callback([{target:node,isIntersecting:true,intersectionRect:{height:80},boundingClientRect:{height:100}} as IntersectionObserverEntry],{} as IntersectionObserver));
  expect(read).not.toHaveBeenCalled();focus.mockReturnValue(true);act(()=>window.dispatchEvent(new Event('focus')));
  await waitFor(()=>expect(read).toHaveBeenCalledWith({session_id:'session',native_id:'native',message_ids:['visible'],question_ids:['q']}));
  read.mockClear();act(()=>window.dispatchEvent(new Event('agentmanager:notifications-changed')));
  await waitFor(()=>expect(read).toHaveBeenCalledTimes(1));view.unmount();
});
