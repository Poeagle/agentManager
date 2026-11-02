export interface ConversationAttachment {kind:'image'|'file';name:string;path:string;offset?:number}
export function formatConversationInput(text:string,attachments:ConversationAttachment[]) {
  if(!attachments.length)return text;
  return `${text.trim()?text:'请查看附件。'}\n\n<agentmanager_attachments>\n${JSON.stringify(attachments.map(({kind,name,path})=>({kind,name,path})))}\n</agentmanager_attachments>`;
}
export function parseConversationInput(text:string):{text:string;attachments:ConversationAttachment[]} {
  const marker='\n\n<agentmanager_attachments>\n',position=text.lastIndexOf(marker);
  if(position<0 || !text.endsWith('\n</agentmanager_attachments>'))return {text,attachments:[]};
  try {
    const items:unknown=JSON.parse(text.slice(position+marker.length,-'\n</agentmanager_attachments>'.length));
    if(!Array.isArray(items)||items.length>8||items.some(item=>!item || !['image','file'].includes(item.kind)||typeof item.name!=='string'||item.name.length>255||typeof item.path!=='string'||item.path.length>4096||!item.path.startsWith('/')))return {text,attachments:[]};
    return {text:text.slice(0,position),attachments:items};
  }catch{return {text,attachments:[]};}
}
