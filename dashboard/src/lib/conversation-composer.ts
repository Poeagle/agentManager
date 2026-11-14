const SPACE='\u200b';
function composerContents(root:Node):{text:string;positions:Array<[string,number]>} {
  if(root.nodeType===Node.TEXT_NODE)return {text:(root.textContent||'').replaceAll(SPACE,''),positions:[]};
  if(root instanceof HTMLElement&&root.dataset.attachmentId)return {text:'',positions:[[root.dataset.attachmentId,0]]};
  if(root instanceof HTMLBRElement)return {text:'\n',positions:[]};
  let text='',previousBlock=false,occupied=false;const positions:Array<[string,number]>=[];
  for(const child of root.childNodes){const part=composerContents(child);if(!part.text&&!part.positions.length)continue;const block=child instanceof HTMLElement&&['DIV','P'].includes(child.tagName);if(occupied&&(block||previousBlock)&&!text.endsWith('\n'))text+='\n';for(const [id,offset] of part.positions)positions.push([id,text.length+offset]);text+=part.text;previousBlock=block;occupied=true;}
  return {text,positions};
}
export function composerPlainText(root:Node):string{return composerContents(root).text;}
export function composerAttachmentPositions(root:Node){return new Map(composerContents(root).positions);}
