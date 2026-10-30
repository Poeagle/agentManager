import {open,realpath,stat} from 'fs/promises';
import {dirname,extname,isAbsolute,join,relative,sep} from 'path';
import {getDb} from '../db/index.js';

export interface ConversationAttachment {kind:'image'|'file';name:string;path:string}
const MIB=1024*1024;
export function formatConversationInput(text:string,attachments:ConversationAttachment[]) {
  if(!attachments.length)return text;
  return `${text.trim()?text:'请查看附件。'}\n\n<agentmanager_attachments>\n${JSON.stringify(attachments.map(({kind,name,path})=>({kind,name,path})))}\n</agentmanager_attachments>`;
}

/** Only files saved by the existing project-scoped paste/upload endpoints
 * can be sent as native images. Resolve symlinks before trusting a path. */
export async function validateConversationAttachments(sessionId:string,value:unknown):Promise<ConversationAttachment[]> {
  if(value===undefined)return [];
  if(!Array.isArray(value)||value.length>8)throw new Error('每条消息最多支持 8 个附件');
  if(!value.length)return [];
  const project=getDb().prepare('SELECT p.path FROM sessions s JOIN projects p ON p.id=s.project_id WHERE s.id=?').get(sessionId) as {path:string}|undefined;
  if(!project)throw new Error('当前会话没有可用的项目目录');
  try {
    const root=await realpath(project.path),directory=await realpath(join(root,'.agentmanager','pastes'));
    const child=relative(root,directory);if(!child||isAbsolute(child)||child==='..'||child.startsWith(`..${sep}`))throw new Error();
    const attachments:ConversationAttachment[]=[];let total=0,images=0;
    for(const item of value) {
      if(!item || !['image','file'].includes(item.kind) || typeof item.name!=='string' || !item.name.trim() || item.name.length>255 || /[\0\r\n]/.test(item.name) || typeof item.path!=='string' || item.path.length>4096)throw new Error();
      const path=await realpath(item.path);if(dirname(path)!==directory)throw new Error();
      const info=await stat(path);if(!info.isFile()||info.size>35*MIB)throw new Error();
      total+=info.size;
      if(item.kind==='image') {
        if(info.size>10*MIB)throw new Error();images+=info.size;
        const handle=await open(path,'r');const header=Buffer.alloc(16);try{await handle.read(header,0,16,0);}finally{await handle.close();}
        const extension=extname(path).toLowerCase();
        const valid=extension==='.png' && header.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10]))
          || ['.jpg','.jpeg'].includes(extension) && header[0]===255 && header[1]===216 && header[2]===255
          || extension==='.gif' && ['GIF87a','GIF89a'].includes(header.subarray(0,6).toString())
          || extension==='.webp' && header.subarray(0,4).toString()==='RIFF' && header.subarray(8,12).toString()==='WEBP';
        if(!valid)throw new Error();
      }
      attachments.push({kind:item.kind,name:item.name,path});
    }
    if(total>50*MIB || images>10*MIB)throw new Error('附件总大小最多 50 MB，其中图片总大小最多 10 MB');
    return attachments;
  } catch(error) {
    if(error instanceof Error && error.message.startsWith('附件总大小'))throw error;
    throw new Error('附件不可用，请通过当前会话重新上传');
  }
}
