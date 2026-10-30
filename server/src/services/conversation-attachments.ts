import {open,realpath,stat} from 'fs/promises';
import {dirname,extname,isAbsolute,join,relative,sep} from 'path';
import {getDb} from '../db/index.js';
import {createHash} from 'crypto';

export interface ConversationAttachment {kind:'image'|'file';name:string;path:string}
const MIB=1024*1024;
export function formatConversationInput(text:string,attachments:ConversationAttachment[],includeImagePaths=false) {
  if(!attachments.length)return text;
  const files=attachments.filter(item=>includeImagePaths || item.kind==='file');
  return (text.trim()?text:'请查看附件。')+(files.length?'\n\n附件：\n'+files.map(item=>`- ${item.name}: ${item.path}`).join('\n'):'');
}

function inputKey(text:string,images:string[]) {
  return createHash('sha256').update(JSON.stringify([text.trim(),[...images].sort()])).digest('hex');
}
/** Display metadata stays in the application database, never in model text. */
export function rememberConversationAttachments(sessionId:string,clientId:string,text:string,attachments:ConversationAttachment[],nativeImages:boolean) {
  if(!attachments.length)return;
  const nativeText=formatConversationInput(text,attachments,!nativeImages);
  getDb().prepare(`INSERT INTO conversation_attachments(session_id,client_id,input_key,input_text,attachments)
    VALUES(?,?,?,?,?) ON CONFLICT(session_id,client_id) DO UPDATE SET input_key=excluded.input_key,input_text=excluded.input_text,attachments=excluded.attachments`)
    .run(sessionId,clientId,inputKey(nativeText,nativeImages?attachments.filter(item=>item.kind==='image').map(item=>item.path):[]),text.trim()?text:'请查看附件。',JSON.stringify(attachments));
}

/** Both native localImage input and persisted image wrappers carry the same
 * uploaded path. Use it to restore metadata even after resume changes item IDs. */
export function conversationImagePaths(content:unknown):string[] {
  if(!Array.isArray(content))return [];
  return content.flatMap((part,index)=>{
    if(part?.type==='localImage' && typeof part.path==='string')return [part.path];
    if(part?.type==='input_text' && content[index+1]?.type==='input_image' && typeof part.text==='string') {
      const path=/^<image name=\[Image #\d+\] path="([\s\S]*)">$/.exec(part.text.trim())?.[1];return path?[path]:[];
    }
    return [];
  });
}

export function decorateConversationAttachments<T extends {role:string;text:string;client_id?:string;image_paths?:string[];attachments?:ConversationAttachment[]}>(sessionId:string,messages:T[]):T[] {
  return messages.map(message=>{
    const {image_paths,...visible}=message;
    if(message.role!=='user'||(!image_paths?.length && !message.client_id && !message.text.includes('\n\n附件：\n')))return visible as T;
    const row=getDb().prepare(`SELECT input_text,attachments FROM conversation_attachments WHERE session_id=? AND
      (client_id=? OR input_key=?) ORDER BY rowid DESC LIMIT 1`).get(sessionId,message.client_id||'',inputKey(message.text,image_paths||[])) as {input_text:string;attachments:string}|undefined;
    return row?{...visible,text:row.input_text,attachments:JSON.parse(row.attachments)} as T:visible as T;
  });
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
