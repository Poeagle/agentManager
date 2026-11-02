import {useLayoutEffect,useRef} from 'react';
import {api} from '../lib/api';
import type {DraftAttachment} from './ConversationAttachments';
import {useConversationImagePreview,useConversationFilePreview} from './ConversationImagePreview';
const SPACE='\u200b';
export function composerPlainText(root:Node):string {
  if(root.nodeType===Node.TEXT_NODE)return (root.textContent||'').replaceAll(SPACE,'');
  if(root instanceof HTMLElement&&root.dataset.attachmentId)return '';
  if(root instanceof HTMLBRElement)return '\n';
  let result='',previousBlock=false;
  for(const child of root.childNodes){const text=composerPlainText(child);if(!text)continue;const block=child instanceof HTMLElement&&['DIV','P'].includes(child.tagName);if(result&&(block||previousBlock)&&!result.endsWith('\n'))result+='\n';result+=text;previousBlock=block;}
  return result;
}
export function ConversationComposerEditor({value,items,disabled,placeholder,projectId,projectPath,onChange,onRemove,onFiles,onSubmit}:{value:string;items:DraftAttachment[];disabled:boolean;placeholder:string;projectId:string|null;projectPath?:string;onChange:(value:string)=>void;onRemove:(id:string)=>void;onFiles:(files:File[])=>void;onSubmit:()=>void}) {
  const root=useRef<HTMLDivElement>(null),composing=useRef(false),known=useRef(new Set<string>()),savedRange=useRef<Range|null>(null);
  const preview=useConversationImagePreview(),filePreview=useConversationFilePreview();
  const props=useRef({value,items,disabled,onChange,onRemove,onFiles,onSubmit,projectId,projectPath});props.current={value,items,disabled,onChange,onRemove,onFiles,onSubmit,projectId,projectPath};
  function rememberCaret(){const selection=window.getSelection(),node=root.current;if(node&&selection?.rangeCount&&node.contains(selection.anchorNode))savedRange.current=selection.getRangeAt(0).cloneRange();}
  function syncText(){const node=root.current;if(!node)return;const ids=new Set([...node.querySelectorAll<HTMLElement>('[data-attachment-id]')].map(token=>token.dataset.attachmentId!));for(const id of known.current)if(!ids.has(id))props.current.onRemove(id);for(const token of node.querySelectorAll<HTMLElement>('[data-attachment-id]'))if(!props.current.items.some(item=>item.id===token.dataset.attachmentId))token.remove();props.current.onChange(composerPlainText(node));}
  useLayoutEffect(()=>{
    const node=root.current;if(!node||composing.current)return;
    if(composerPlainText(node)!==value){node.textContent=value;savedRange.current=null;}
    let insertion=savedRange.current?.cloneRange();if(!insertion||!node.contains(insertion.startContainer)){insertion=document.createRange();insertion.selectNodeContents(node);insertion.collapse(false);}
    const container=insertion.startContainer instanceof HTMLElement?insertion.startContainer:insertion.startContainer.parentElement;const atom=container?.closest('[data-attachment-id]');if(atom){insertion.setStartAfter(atom);insertion.collapse(true);}
    const added=items.some(item=>!known.current.has(item.id));
    for(const token of node.querySelectorAll<HTMLElement>('[data-attachment-id]'))if(!items.some(item=>item.id===token.dataset.attachmentId))token.remove();
    let last:HTMLElement|undefined;
    for(const [index,item] of items.entries()) {
      let token=[...node.querySelectorAll<HTMLElement>('[data-attachment-id]')].find(value=>value.dataset.attachmentId===item.id);
      if(!token){token=document.createElement('span');token.contentEditable='false';token.dataset.attachmentId=item.id;token.className='session-chat-inline-attachment';token.tabIndex=0;token.setAttribute('role','button');const fragment=document.createDocumentFragment();fragment.append(document.createTextNode(SPACE),token,document.createTextNode(SPACE));insertion.deleteContents();insertion.insertNode(fragment);insertion.setStartAfter(token);insertion.collapse(true);}
      const number=items.slice(0,index+1).filter(other=>other.kind===item.kind).length;
      token.textContent=`${item.kind==='image'?'图片':'文件'} ${number}${item.status==='uploading'?'（上传中）':item.status==='error'?'（上传失败）':''}`;
      token.setAttribute('aria-label',`${item.kind==='image'?'预览待发送图片':'预览待发送文件'} ${item.name}`);token.title=`${item.name} · 点击预览，Backspace/Delete 删除`;token.dataset.status=item.status;last=token;
    }
    known.current=new Set(items.map(item=>item.id));
    if(added&&last&&!disabled){node.focus({preventScroll:true});const range=document.createRange();range.setStartAfter(last);range.collapse(true);const selection=window.getSelection();selection?.removeAllRanges();selection?.addRange(range);savedRange.current=range.cloneRange();}
  },[value,items,disabled]);
  function open(token:HTMLElement){const item=props.current.items.find(item=>item.id===token.dataset.attachmentId);if(!item)return;if(item.kind==='image'){const src=item.path?api.files.previewUrl(item.path,projectId||undefined):item.thumbnail;if(src)preview?.({src,name:item.name});}else if(item.path&&projectPath)filePreview?.({path:item.path,rootPath:projectPath,projectId,name:item.name});}
  function insert(text:string){const node=root.current,selection=window.getSelection();if(!node||!selection)return;node.focus();const range=selection.rangeCount&&node.contains(selection.anchorNode)?selection.getRangeAt(0):document.createRange();if(!node.contains(range.startContainer)){range.selectNodeContents(node);range.collapse(false);}range.deleteContents();const textNode=document.createTextNode(text);range.insertNode(textNode);range.setStartAfter(textNode);range.collapse(true);selection.removeAllRanges();selection.addRange(range);syncText();}
  function deleteToken(event:React.KeyboardEvent<HTMLDivElement>){
    const node=root.current,selection=window.getSelection();if(!node||!selection)return;
    const target=event.target instanceof HTMLElement?event.target.closest<HTMLElement>('[data-attachment-id]'):null;
    let token=target;
    const caret=selection.rangeCount?selection.getRangeAt(0):document.createRange();
    if(!token&&selection.isCollapsed){const atoms=[...node.querySelectorAll<HTMLElement>('[data-attachment-id]')];if(event.key==='Backspace')atoms.reverse();for(const atom of atoms){try{const relation=caret.comparePoint(atom,0);if(event.key==='Backspace'?relation>=0:relation<=0)continue;const between=document.createRange();if(event.key==='Backspace'){between.setStartAfter(atom);between.setEnd(caret.startContainer,caret.startOffset);}else{between.setStart(caret.startContainer,caret.startOffset);between.setEndBefore(atom);}const fragment=between.cloneContents();if(!(fragment.textContent||'').replaceAll(SPACE,'')&&!fragment.querySelector('[data-attachment-id]')){token=atom;break;}}catch{/* Caret and token can move during an IME update. */}}}
    if(!token)return;event.preventDefault();const parent=token.parentNode!,offset=[...parent.childNodes].indexOf(token);const id=token.dataset.attachmentId!;token.remove();props.current.onRemove(id);known.current.delete(id);node.focus({preventScroll:true});const next=document.createRange();next.setStart(parent,Math.min(offset,parent.childNodes.length));next.collapse(true);selection.removeAllRanges();selection.addRange(next);props.current.onChange(composerPlainText(node));
  }
  return <><div ref={root} className="session-chat-editor" role="textbox" aria-label="发送给当前 Agent 的消息" aria-multiline="true" aria-disabled={disabled} contentEditable={!disabled} suppressContentEditableWarning tabIndex={disabled?-1:0} spellCheck={false} data-placeholder={placeholder}
    onInput={()=>{if(!composing.current)syncText();rememberCaret();}} onKeyUp={rememberCaret} onMouseUp={rememberCaret} onBlur={rememberCaret}
    onCompositionStart={()=>{composing.current=true;}} onCompositionEnd={()=>{composing.current=false;syncText();}}
    onClick={event=>{const token=event.target instanceof HTMLElement?event.target.closest<HTMLElement>('[data-attachment-id]'):null;if(token)open(token);}}
    onPaste={event=>{event.preventDefault();if(disabled)return;const files=Array.from(event.clipboardData.files);if(files.length){rememberCaret();onFiles(files);}else insert(event.clipboardData.getData('text/plain'));}}
    onDrop={event=>{if(!event.dataTransfer.files.length){event.preventDefault();if(!disabled)insert(event.dataTransfer.getData('text/plain'));}}}
    onKeyDown={event=>{if(disabled||event.nativeEvent.isComposing||composing.current)return;const token=event.target instanceof HTMLElement?event.target.closest<HTMLElement>('[data-attachment-id]'):null;if(token&&(event.key==='Enter'||event.key===' ')){event.preventDefault();open(token);return;}if(['Backspace','Delete'].includes(event.key))deleteToken(event);else if(event.key==='Enter'){event.preventDefault();if(event.shiftKey)insert('\n');else onSubmit();}else if((event.ctrlKey||event.metaKey)&&['b','i','u'].includes(event.key.toLowerCase()))event.preventDefault();}}
  />{items.some(item=>item.error)&&<p role="alert" className="session-chat-error">{items.filter(item=>item.error).map(item=>`${item.name}：${item.error}`).join('；')}</p>}</>;
}
