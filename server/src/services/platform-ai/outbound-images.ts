import {createHash} from 'crypto';
import {constants} from 'fs';
import {open,realpath,stat} from 'fs/promises';
import {extname,isAbsolute,resolve} from 'path';
import {fileURLToPath} from 'url';
import {nanoid} from 'nanoid';
import {getDb} from '../../db/index.js';
import {userOwnsFilesystemPath,userProjectIds} from '../../auth.js';
import {isProjectAttachment,isProjectUploadPath} from '../attachment-storage.js';
import {privateResourcePath} from '../shared-resources/path-guard.js';
import {imageMime,MAX_IMAGES,MAX_IMAGE_BYTES} from './attachments.js';
import {ChannelError} from './channels.js';

interface Link {start:number;end:number;path:string;label:string}
export interface OutboundImage {
  parent_id:string;after_id:string;path:string;sha256?:string;filename:string;problem?:string;
  media_id?:string;expires_at?:number;bot_id?:string;
}
interface OutboxSource {id:string;conversation_id:string;dedupe_key:string;content:string;reply_context:string;destination_channel_id?:string|null}

function localImagePath(target:string,projectPath?:string):string|null {
  try {
    let path=target;
    if(/^file:/i.test(path)) {const url=new URL(path);if(url.host||url.search||url.hash)return null;path=fileURLToPath(url);}
    else {if(/^sandbox:\//i.test(path))path=path.slice('sandbox:'.length);path=decodeURIComponent(path);}
    if(path.length>4096||/[\x00-\x1f]/.test(path)||/^[a-z][\w+.-]*:/i.test(path))return null;
    if(!isAbsolute(path)&&!projectPath)return null;
    if(!/\.(?:png|jpe?g|gif|webp|bmp|svg|avif)$/i.test(path))return null;
    return resolve(projectPath||'/',path);
  }catch{return null;}
}

/** Explicit Markdown image links and ordinary screenshot links only. Code
 * examples are masked; external URLs never become server-side downloads. */
function imageLinks(text:string,projectPath?:string):Link[] {
  const source=text.slice(0,32768);
  const masked=source.replace(/^ {0,3}(`{3,}|~{3,})[^\n]*\n[\s\S]*?(?:\n {0,3}\1[^\n]*(?=\n|$)|(?![\s\S]))/gm,m=>' '.repeat(m.length))
    .replace(/(`+)[^\n]*?\1/g,m=>' '.repeat(m.length));
  const pattern=/!?\[([^\]\n]*)\]\((?:<([^>\n]+)>|([^\s)]+))(?:[ \t]+["'][^\n]*?["'])?\)/g;
  const links:Link[]=[];
  for(const match of masked.matchAll(pattern)) {
    const path=localImagePath(match[2]||match[3],projectPath);
    if(path)links.push({start:match.index!,end:match.index!+match[0].length,path,label:match[1]||'截图'});
    if(links.length>=64)break;
  }
  return links;
}

function canReadImage(userId:string,path:string):boolean {
  if(privateResourcePath(path))return false;
  if(userOwnsFilesystemPath(userId,path))return true;
  const allowed=userProjectIds(userId);
  return (getDb().prepare('SELECT id,path FROM projects').all() as Array<{id:string;path:string}>).some(project=>allowed.has(project.id)
    &&(isProjectAttachment(path,project.path,true)||isProjectUploadPath(path,project.path)));
}

export function assertOutboundImageAccess(userId:string,path:string):void {
  if(!canReadImage(userId,path))throw new ChannelError('截图无访问权限',403,true);
}

/** Open a bounded regular file and authorize the actual descriptor target,
 * closing symlink/ancestor swaps without reading arbitrary host paths. */
export async function readOutboundImage(userId:string,path:string,expectedHash?:string):Promise<{path:string;data:Buffer;sha256:string;filename:string}> {
  assertOutboundImageAccess(userId,path);
  if(!/^\.(?:png|jpe?g)$/i.test(extname(path)))throw new ChannelError('截图仅支持 PNG/JPEG 格式',415,true);
  let handle:Awaited<ReturnType<typeof open>>|undefined;
  try {
    const canonical=await realpath(path);
    if(!canReadImage(userId,canonical))throw new ChannelError('截图无访问权限',403,true);
    handle=await open(canonical,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);
    const info=await handle.stat();
    if(!info.isFile()||!info.size||info.size>MAX_IMAGE_BYTES)throw new ChannelError('截图必须为非空普通文件，每张最多 8 MB',413,true);
    // Linux is the supported host for local Agent clients; on other systems
    // compare the open file identity with the current canonical path instead.
    const actual=process.platform==='linux'?await realpath(`/proc/self/fd/${handle.fd}`):await realpath(canonical);
    const current=await stat(canonical);
    if(actual!==canonical||current.dev!==info.dev||current.ino!==info.ino||!canReadImage(userId,actual))throw new ChannelError('截图路径已变化或无访问权限',403,true);
    const buffer=Buffer.alloc(info.size+1);let size=0;
    while(size<buffer.length){const read=await handle.read(buffer,size,buffer.length-size,size);if(!read.bytesRead)break;size+=read.bytesRead;}
    const after=await handle.stat();
    if(size!==info.size||after.size!==info.size||after.mtimeMs!==info.mtimeMs)throw new ChannelError('截图在读取期间变化，请重新发送',409,true);
    const data=buffer.subarray(0,size),mime=imageMime(data);
    if(!['image/png','image/jpeg'].includes(mime||''))throw new ChannelError('截图不是有效的 PNG/JPEG 图片',415,true);
    const sha256=createHash('sha256').update(data).digest('hex');
    if(expectedHash&&expectedHash!==sha256)throw new ChannelError('截图内容已变化，未发送替换后的文件',409,true);
    return {path:canonical,data,sha256,filename:mime==='image/png'?'screenshot.png':'screenshot.jpg'};
  }catch(error){
    if(error instanceof ChannelError)throw error;
    throw new ChannelError('截图不存在或无法读取，请在平台查看',404,true);
  }finally{await handle?.close();}
}

/** Text and each image reuse independent durable outbox rows. Dependencies
 * preserve order; retrying an image never resends an acknowledged text/image. */
export async function prepareOutboundImages(item:OutboxSource,userId:string,projectPath?:string):Promise<string> {
  const saved=JSON.parse((getDb().prepare('SELECT reply_context FROM platform_ai_outbox WHERE id=?').get(item.id) as {reply_context:string}).reply_context);
  if(saved.outbound_images_prepared)return saved.wecom_image_text;
  const links=imageLinks(item.content,projectPath);
  if(!links.length)return item.content;
  const paths=[...new Set(links.map(link=>link.path))].slice(0,MAX_IMAGES);
  const images:Array<Omit<OutboundImage,'parent_id'|'after_id'>>=[];
  for(const path of paths) {
    try {const image=await readOutboundImage(userId,path);images.push({path:image.path,sha256:image.sha256,filename:image.filename});}
    catch(error){images.push({path,filename:'screenshot.png',problem:error instanceof ChannelError?error.message:'截图无法读取'});}
  }
  let text=item.content;
  for(const link of links.slice().reverse()) {
    const index=paths.indexOf(link.path),problem=index<0?'超过 4 张图片上限':images[index].problem;
    const label=link.label+(problem?'（图片未发送，请在平台查看）':'（图片见下方）');
    text=text.slice(0,link.start)+label+text.slice(link.end);
  }
  if(images.some(image=>image.problem)||new Set(links.map(link=>link.path)).size>MAX_IMAGES)text+='\n\n> 部分截图无法自动发送；支持有权限读取的 PNG/JPEG，每条最多 4 张、每张最多 8 MB。';
  getDb().transaction(()=>{
    let afterId=item.id;
    images.forEach((image,index)=>{
      const id=nanoid(16),metadata={outbound_image:{...image,parent_id:item.id,after_id:afterId}};
      getDb().prepare(`INSERT OR IGNORE INTO platform_ai_outbox(id,conversation_id,dedupe_key,content,reply_context,destination_channel_id)
        VALUES(?,?,?,?,?,?)`).run(id,item.conversation_id,`${item.dedupe_key}:image:${index}`,`截图 ${index+1}`,JSON.stringify(metadata),item.destination_channel_id||null);
      afterId=(getDb().prepare('SELECT id FROM platform_ai_outbox WHERE dedupe_key=?').get(`${item.dedupe_key}:image:${index}`) as {id:string}).id;
    });
    getDb().prepare("UPDATE platform_ai_outbox SET reply_context=json_set(reply_context,'$.outbound_images_prepared',1,'$.wecom_image_text',?) WHERE id=?").run(text,item.id);
  })();
  return text;
}
