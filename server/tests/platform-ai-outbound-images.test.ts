import {mkdirSync,writeFileSync,symlinkSync,truncateSync} from 'fs';
import {join} from 'path';
import {afterEach,beforeEach,expect,it} from 'vitest';
import {createUser} from '../src/auth.js';
import {getDb} from '../src/db/index.js';
import {saveSharedResources} from '../src/services/shared-resources/store.js';
import {prepareOutboundImages,readOutboundImage} from '../src/services/platform-ai/outbound-images.js';
import {MAX_IMAGE_BYTES} from '../src/services/platform-ai/attachments.js';
import {receiveMessage} from '../src/services/platform-ai/store.js';
import {createTestDatabase} from './helpers/database.js';

const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6CsAAAAAASUVORK5CYII=','base64');
let cleanup:()=>void,root:string,outside:string,member:string,admin:string;
beforeEach(()=>{
 const db=createTestDatabase();cleanup=db.cleanup;root=join(db.dir,'project');outside=join(db.dir,'reports');mkdirSync(root);mkdirSync(outside);
 member=createUser({username:'member',password:'password1'}).id;admin=createUser({username:'admin',password:'password1',role:'admin'}).id;
 getDb().prepare('INSERT INTO projects(id,name,path,owner_id) VALUES(?,?,?,?)').run('p','Project',root,member);
});
afterEach(()=>cleanup());
function notice(content:string){
 const conversation=receiveMessage({userId:member,externalUserId:member,chatId:'fixture',messageId:'in',content:'test'}).conversation_id;
 const item={id:'parent',conversation_id:conversation,dedupe_key:'fixture',content,reply_context:'{}'};
 getDb().prepare('INSERT INTO platform_ai_outbox(id,conversation_id,dedupe_key,content) VALUES(?,?,?,?)').run(item.id,conversation,item.dedupe_key,content);
 return item;
}
const parts=()=>getDb().prepare("SELECT id,content,status,reply_context FROM platform_ai_outbox WHERE id!='parent' ORDER BY rowid").all() as Array<{id:string;content:string;status:string;reply_context:string}>;

it('reads only authorized regular PNG/JPEG files, including administrator-owned report paths',async()=>{
 const path=join(root,'shot.png'),report=join(outside,'report.png');writeFileSync(path,png);writeFileSync(report,png);
 expect((await readOutboundImage(member,path)).data.equals(png)).toBe(true);
 await expect(readOutboundImage(member,report)).rejects.toThrow('权限');
 expect((await readOutboundImage(admin,report)).data.equals(png)).toBe(true);
 symlinkSync(report,join(root,'escape.png'));await expect(readOutboundImage(member,join(root,'escape.png'))).rejects.toThrow('权限');
});
it('rejects private resources even for an administrator, oversized files, wrong magic and changed content',async()=>{
 const secret=join(outside,'credentials.png');writeFileSync(secret,png);
 saveSharedResources(admin,{directory:outside,scope_path:outside,env_file:secret,instructions:'',enabled:true,revision:0});
 await expect(readOutboundImage(admin,secret)).rejects.toThrow('权限');
 const path=join(root,'shot.png');writeFileSync(path,png);const original=await readOutboundImage(member,path);
 writeFileSync(path,Buffer.concat([png,Buffer.from('changed')]));await expect(readOutboundImage(member,path,original.sha256)).rejects.toThrow('已变化');
 writeFileSync(path,'not an image');await expect(readOutboundImage(member,path)).rejects.toThrow('有效');
 truncateSync(path,MAX_IMAGE_BYTES+1);await expect(readOutboundImage(member,path)).rejects.toThrow('8 MB');
 await expect(readOutboundImage(member,join(root,'missing.png'))).rejects.toThrow();
});
it('turns linked and embedded local screenshots into independent ordered queue rows, preserving external links',async()=>{
 const one=join(root,'one.png'),two=join(root,'two image.png');writeFileSync(one,png);writeFileSync(two,png);
 const item=notice(`[查看正式截图](${one})\n![第二张](<${two}>)\n[MR](https://example.com/mr)\n![外部](https://example.com/image.png)`);
 const text=await prepareOutboundImages(item,member,root);
 expect(text).not.toContain(root);expect(text).toContain('图片见下方');expect(text).toContain('[MR](https://example.com/mr)');expect(text).toContain('https://example.com/image.png');
 expect(parts()).toHaveLength(2);
 const first=JSON.parse(parts()[0].reply_context).outbound_image,second=JSON.parse(parts()[1].reply_context).outbound_image;
 expect(first).toMatchObject({parent_id:'parent',after_id:'parent',path:one,filename:'screenshot.png'});expect(first.sha256).toHaveLength(64);
 expect(second.after_id).toBe(parts()[0].id);
 expect(await prepareOutboundImages(item,member,root)).toBe(text);expect(parts()).toHaveLength(2);
});
it('handles encoded, relative, file and sandbox paths, deduplicating repeated references',async()=>{
 const path=join(root,'with space.png');writeFileSync(path,png);
 const item=notice(`[a](./with%20space.png) [relative](with%20space.png) [b](file://${encodeURI(path)}) [c](sandbox:${encodeURI(path)})`);
 await prepareOutboundImages(item,member,root);expect(parts()).toHaveLength(1);
});
it('does not read links inside code examples or turn external URLs into downloads',async()=>{
 const path=join(root,'missing.png'),item=notice('```md\nexample\n![example]('+path+')\n```\n`[inline]('+path+')`\n[remote](https://example.com/private.png)\n~~~md\n![unclosed]('+path+')');
 expect(await prepareOutboundImages(item,member,root)).toBe(item.content);expect(parts()).toHaveLength(0);
});
it('replaces Mermaid with an ordered image part and keeps the original Markdown for the web view',async()=>{
 const path=join(root,'shot.png');writeFileSync(path,png);
 const diagram='flowchart LR\n A["字段详情"] --> B["业务概念"]';
 const item=notice('开头\n\n```mermaid\n'+diagram+'\n```\n\n[截图]('+path+')\n\n结尾');
 const text=await prepareOutboundImages(item,member,root);
 expect(text).toBe('开头\n\n流程图见下方\n\n截图（图片见下方）\n\n结尾');
 expect(parts()).toHaveLength(2);
 expect(JSON.parse(parts()[0].reply_context).outbound_image).toMatchObject({diagram,filename:'diagram.png',after_id:'parent'});
 expect(JSON.parse(parts()[1].reply_context).outbound_image).toMatchObject({path,after_id:parts()[0].id});
 expect(getDb().prepare('SELECT content FROM platform_ai_outbox WHERE id=?').get(item.id)).toEqual({content:item.content});
 expect(await prepareOutboundImages(item,member,root)).toBe(text);expect(parts()).toHaveLength(2);
});
it('leaves Mermaid examples inside other fences and applies one image limit to diagrams and screenshots',async()=>{
 const example='````md\n```mermaid\nflowchart LR\n A-->B\n```\n````';
 const item=notice(example+'\n\n'+Array.from({length:5},(_,index)=>'~~~Mermaid\nflowchart LR\n A-->'+index+'\n~~~~').join('\n\n'));
 const text=await prepareOutboundImages(item,member,root);
 expect(text).toContain(example);expect(text).not.toContain('A-->4');
 expect(text).toContain('流程图未附上，请在平台查看');
 expect(parts()).toHaveLength(4);
});
it('bounds image count and makes missing or unsupported screenshots explicit without losing the text',async()=>{
 for(let n=0;n<5;n++)writeFileSync(join(root,`s${n}.png`),png);
 const item=notice('任务完成。\n'+Array.from({length:5},(_,n)=>`[截图](${join(root,`s${n}.png`)})`).join('\n'));
 const text=await prepareOutboundImages(item,member,root);expect(parts()).toHaveLength(4);expect(text).toContain('最多 4 张');expect(text).toContain('任务完成。');
});
it('records inaccessible and unsupported image parts as failures to be reported independently',async()=>{
 const missing=join(root,'missing.png'),svg=join(root,'vector.svg'),item=notice(`[missing](${missing}) [svg](${svg})`);
 const text=await prepareOutboundImages(item,member,root);expect(text).toContain('未发送');expect(parts()).toHaveLength(2);
 expect(JSON.parse(parts()[0].reply_context).outbound_image.problem).toContain('不存在');
 expect(JSON.parse(parts()[1].reply_context).outbound_image.problem).toContain('PNG/JPEG');
});
