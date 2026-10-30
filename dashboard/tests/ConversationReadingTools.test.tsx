import {createRef} from 'react';
import {fireEvent,render,screen} from '@testing-library/react';
import {describe,expect,it,vi} from 'vitest';
import {ConversationNavigator,ConversationWidthHandles,conversationOutline,readingWidth} from '../src/components/ConversationReadingTools';
import type {ConversationMessage} from '../src/lib/api';

describe('conversation reading controls',()=>{
  it('clamps widths to the available column without losing a wider saved preference',()=>{
    expect(readingWidth(null,1400)).toBe(784);expect(readingWidth(1200,1400)).toBe(1200);
    expect(readingWidth(1200,900)).toBe(756);expect(readingWidth(1200,390)).toBe(358);
    expect(readingWidth(200,1400)).toBe(480);
  });
  it('adjusts width with the keyboard, saves it and resets without changing messages',()=>{
    const root=createRef<HTMLElement>();const scroll=createRef<HTMLDivElement>();
    const layout=render(<section ref={root}><div ref={scroll}/><ConversationWidthHandles root={root} scroll={scroll} active storageKey="reader-width"/></section>);
    Object.defineProperty(root.current,'clientWidth',{value:1400});fireEvent(window,new Event('resize'));
    const control=screen.getByRole('separator',{name:'右侧阅读宽度'});fireEvent.keyDown(control,{key:'ArrowRight'});
    expect(localStorage.getItem('reader-width')).toBe('816');expect(root.current?.style.getPropertyValue('--chat-reading-width')).toBe('816px');
    layout.rerender(<section ref={root}><div ref={scroll}/><ConversationWidthHandles root={root} scroll={scroll} active={false} storageKey="reader-width"/></section>);
    localStorage.setItem('reader-width','936');
    layout.rerender(<section ref={root}><div ref={scroll}/><ConversationWidthHandles root={root} scroll={scroll} active storageKey="reader-width"/></section>);
    expect(root.current?.style.getPropertyValue('--chat-reading-width')).toBe('936px');
    fireEvent.doubleClick(control);expect(localStorage.getItem('reader-width')).toBeNull();expect(root.current?.style.getPropertyValue('--chat-reading-width')).toBe('784px');layout.unmount();
  });
  it('previews only agent output and navigates to the exact anchor',()=>{
    const messages:ConversationMessage[]=[{id:'u1',role:'user',text:'先分析项目',timestamp:null},{id:'a1',role:'assistant',text:'## 结构\n项目说明',timestamp:null},{id:'u2',role:'user',text:'再看部署',timestamp:null},{id:'a2',role:'assistant',text:'部署方式',timestamp:null}];
    const outline=conversationOutline(messages);expect(outline.map(item=>item.answers)).toEqual([['a1'],['a2']]);
    const scroll=createRef<HTMLDivElement>();const navigate=vi.fn();const scrollTo=vi.fn();
    render(<><div ref={scroll}><article data-chat-message-id="u1">first</article><article data-chat-message-id="a1"><h2 id="structure" data-chat-heading="2">结构</h2></article><article data-chat-message-id="u2">second</article></div><ConversationNavigator messages={messages} scroll={scroll} active hasMore={false} loadingOlder={false} onLoadOlder={()=>{}} onNavigate={navigate}/></>);
    scroll.current!.scrollTo=scrollTo;
    const mark=screen.getByRole('button',{name:'跳转到第 1 段对话：先分析项目'});fireEvent.focus(mark);
    expect(screen.getByRole('dialog',{name:'对话预览'})).toHaveTextContent('项目说明');expect(screen.getByRole('dialog',{name:'对话预览'})).not.toHaveTextContent('先分析项目');fireEvent.click(screen.getByRole('button',{name:'结构',exact:true}));
    expect(navigate).toHaveBeenCalledOnce();expect(scrollTo).toHaveBeenCalled();
  });
  it('jumps to the agent reply and never substitutes a pending question for output',()=>{
    const messages:ConversationMessage[]=[{id:'u1',role:'user',text:'用户的问题',timestamp:null},{id:'a1',role:'assistant',text:'Agent 的回答',timestamp:null},{id:'u2',role:'user',text:'还没答的问题',timestamp:null}];
    const scroll=createRef<HTMLDivElement>(),scrollTo=vi.fn();
    render(<><div ref={scroll}><article data-chat-message-id="u1"/><article data-chat-message-id="a1"/><article data-chat-message-id="u2"/></div><ConversationNavigator messages={messages} scroll={scroll} active hasMore={false} loadingOlder={false} onLoadOlder={()=>{}} onNavigate={()=>{}}/></>);
    scroll.current!.scrollTo=scrollTo;
    const answer=scroll.current!.querySelector<HTMLElement>('[data-chat-message-id="a1"]')!;answer.getBoundingClientRect=()=>({top:200,bottom:240,height:40,left:0,right:100,width:100,x:0,y:200,toJSON:()=>({})});
    fireEvent.click(screen.getByRole('button',{name:'跳转到第 1 段对话：用户的问题'}));expect(scrollTo).toHaveBeenCalledWith(expect.objectContaining({top:180}));
    fireEvent.focus(screen.getByRole('button',{name:'跳转到第 2 段对话：还没答的问题'}));const preview=screen.getByRole('dialog',{name:'对话预览'});expect(preview).toHaveTextContent('Agent 尚未回复');expect(preview).not.toHaveTextContent('还没答的问题');
  });

});
