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
import {MAX_MERMAID_CHARS} from './outbound-mermaid.js';

interface Link {start:number;end:number;path:string;label:string}
type ImageSource = {path:string;sha256?:string}|{diagram:string};
type ImagePart = ImageSource & {filename:string;problem?:string};
export type OutboundImage = ImagePart & {
  parent_id:string;after_id:string;
  media_id?:string;expires_at?:number;bot_id?:string;
};
interface CodeBlock {
  start:number;end:number;sourceStart:number;sourceEnd:number;language:string;closed:boolean;
}
interface OutboxSource {id:string;conversation_id:string;dedupe_key:string;content:string;reply_context:string;destination_channel_id?:string|null}

function fencedCodeBlocks(text:string):CodeBlock[] {
  const blocks:CodeBlock[]=[];
  let opener:{marker:string;start:number;sourceStart:number;language:string}|undefined;
  for(const line of text.matchAll(/^ {0,3}(`{3,}|~{3,})([^\r\n]*)/gm)){
    const [,marker,info]=line;
    const end=line.index+line[0].length;
    if(opener){
      if(marker[0]!==opener.marker[0]||marker.length<opener.marker.length||info.trim())continue;
      blocks.push({...opener,end,sourceEnd:line.index,closed:true});
      opener=undefined;
    }else if(marker[0]!=='`'||!info.includes('`')){
      const newline=text.indexOf('\n',end);
      opener={marker,start:line.index,sourceStart:newline<0?text.length:newline+1,language:info.trim().toLowerCase()};
    }
  }
  if(opener)blocks.push({...opener,end:text.length,sourceEnd:text.length,closed:false});
  return blocks;
}

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
function imageLinks(text:string,blocks:CodeBlock[],projectPath?:string):Link[] {
  let masked='';
  let cursor=0;
  for(const block of blocks){
    masked+=text.slice(cursor,block.start)+' '.repeat(block.end-block.start);
    cursor=block.end;
  }
  masked=(masked+text.slice(cursor)).replace(/(`+)[^\n]*?\1/g,m=>' '.repeat(m.length));
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
  const source=item.content.slice(0,32768);
  const blocks=fencedCodeBlocks(source);
  const references=[...imageLinks(source,blocks,projectPath),...blocks
    .filter(block=>block.closed&&block.language==='mermaid')
    .map(block=>({start:block.start,end:block.end,diagram:source.slice(block.sourceStart,block.sourceEnd).trim()}))]
    .sort((a,b)=>a.start-b.start);
  if(!references.length)return item.content;

  const images=new Map<string,ImagePart>();
  let text='',cursor=0,screenshotOmitted=false;
  for(const reference of references){
    const diagram='diagram' in reference;
    const key=diagram?'diagram:'+reference.diagram:reference.path;
    let image=images.get(key);
    if(!image&&images.size<MAX_IMAGES){
      if(diagram){
        image={diagram:reference.diagram,filename:'diagram.png'};
        if(!reference.diagram||reference.diagram.length>MAX_MERMAID_CHARS)image.problem='流程图源码为空或超过长度限制';
      }else{
        try {
          const file=await readOutboundImage(userId,reference.path);
          image={path:file.path,sha256:file.sha256,filename:file.filename};
        }catch(error){
          image={path:reference.path,filename:'screenshot.png',problem:error instanceof ChannelError?error.message:'截图无法读取'};
        }
      }
      images.set(key,image);
    }
    const omitted=!image||!!image.problem;
    if(!diagram&&omitted)screenshotOmitted=true;
    const label=diagram
      ? (omitted?'流程图未附上，请在平台查看':'流程图见下方')
      : reference.label+(omitted?'（图片未发送，请在平台查看）':'（图片见下方）');
    text+=item.content.slice(cursor,reference.start)+label;
    cursor=reference.end;
  }
  text+=item.content.slice(cursor);
  if(screenshotOmitted)text+='\n\n> 部分截图无法自动发送。支持有权限读取的 PNG/JPEG，每条最多 4 张、每张最多 8 MB。';
  getDb().transaction(()=>{
    let afterId=item.id;
    [...images.values()].forEach((image,index)=>{
      const id=nanoid(16),metadata={outbound_image:{...image,parent_id:item.id,after_id:afterId}};
      const label='diagram' in image?'流程图':'截图';
      getDb().prepare(`INSERT OR IGNORE INTO platform_ai_outbox(id,conversation_id,dedupe_key,content,reply_context,destination_channel_id)
        VALUES(?,?,?,?,?,?)`).run(id,item.conversation_id,`${item.dedupe_key}:image:${index}`,`${label} ${index+1}`,JSON.stringify(metadata),item.destination_channel_id||null);
      afterId=(getDb().prepare('SELECT id FROM platform_ai_outbox WHERE dedupe_key=?').get(`${item.dedupe_key}:image:${index}`) as {id:string}).id;
    });
    getDb().prepare("UPDATE platform_ai_outbox SET reply_context=json_set(reply_context,'$.outbound_images_prepared',1,'$.wecom_image_text',?) WHERE id=?").run(text,item.id);
  })();
  return text;
}
