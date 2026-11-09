import {afterEach,beforeEach,describe,expect,it} from 'vitest';
import {mkdirSync,writeFileSync,truncateSync,symlinkSync} from 'fs';
import {join} from 'path';
import {createTestDatabase} from './helpers/database.js';
import {getDb} from '../src/db/index.js';
import {conversationImagePaths,decorateConversationAttachments,rememberConversationAttachments,nativeConversationInput,formatConversationInput,validateConversationAttachments,validateConversationAnswerAttachments} from '../src/services/conversation-attachments.js';
import {conversationQuestionReply} from '../src/services/conversation-question-reply.js';
let cleanup:()=>void,root:string,directory:string;
const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9hZsEAAAAASUVORK5CYII=','base64');
beforeEach(()=>{
  const fixture=createTestDatabase();cleanup=fixture.cleanup;root=join(fixture.dir,'project');directory=join(root,'.agentmanager','pastes');mkdirSync(directory,{recursive:true});
  getDb().prepare("INSERT INTO projects(id,name,path) VALUES('p','P',?)").run(root);getDb().prepare("INSERT INTO sessions(id,project_id,task,status,mode) VALUES('s','p','Test','running','session')").run();
  writeFileSync(join(directory,'image.png'),png);writeFileSync(join(directory,'note.txt'),'test attachment');
});
afterEach(()=>cleanup());
describe('conversation attachment validation',()=>{
  it('keeps answer-editor image offsets outside the structured question reply envelope',()=>{
    const id=JSON.stringify(['request_user_input_async','ask',0]),text='<send_user_message_question_reply>'+JSON.stringify([{questionItemId:id,question:'查看截图？',answer:'是的'}])+'</send_user_message_question_reply>';
    for(const offset of [0,3,15,text.length]){
      const input=nativeConversationInput(text,[{kind:'image',name:'image.png',path:join(directory,'image.png'),offset},{kind:'file',name:'note.txt',path:join(directory,'note.txt')}]);
      expect(input[0].text.startsWith(text)).toBe(true);expect(conversationQuestionReply(input[0].text)?.answers).toEqual([{question_id:id,question:'查看截图？',answer:'是的'}]);expect(input[1]).toEqual({type:'localImage',path:join(directory,'image.png')});
    }
  });
  it('validates answer attachments across question groups with the same path and total-count rules',async()=>{
    const file={kind:'file',name:'report.txt',path:join(directory,'note.txt')};
    expect(await validateConversationAnswerAttachments('s',{question:[file]})).toEqual({question:[file]});
    await expect(validateConversationAnswerAttachments('s',{one:Array(5).fill(file),two:Array(4).fill(file)})).rejects.toThrow('最多支持 8');
    await expect(validateConversationAnswerAttachments('s',{question:[{...file,path:'/etc/passwd'}]})).rejects.toThrow('附件不可用');
  });
  it('accepts uploaded image and file paths and preserves an attachment-only message',async()=>{
    const items=await validateConversationAttachments('s',[{kind:'image',name:'截图.png',path:join(directory,'image.png')},{kind:'file',name:'note.txt',path:join(directory,'note.txt')}]);
    expect(items).toHaveLength(2);expect(formatConversationInput('',items)).toContain('请查看附件。');expect(formatConversationInput('看附件',items)).toContain('note.txt');expect(formatConversationInput('plain',[])).toBe('plain');
    expect(formatConversationInput('只看图',items.slice(0,1))).toBe('只看图');expect(formatConversationInput('只看图',items.slice(0,1),true)).toContain('image.png');
    expect(formatConversationInput('看附件',items)).not.toContain('agentmanager_attachments');
  });
  it('accepts files up to 100 MB and enforces the same total across messages and answer fields',async()=>{
    const file={kind:'file',name:'large.zip',path:join(directory,'large.zip')};
    writeFileSync(file.path,'');truncateSync(file.path,100*1024*1024);
    expect(await validateConversationAttachments('s',[file])).toEqual([file]);
    expect(await validateConversationAnswerAttachments('s',{one:[file]})).toEqual({one:[file]});
    const extra={kind:'file',name:'note.txt',path:join(directory,'note.txt')};
    await expect(validateConversationAttachments('s',[file,extra])).rejects.toThrow('附件总大小最多 100 MB');
    await expect(validateConversationAnswerAttachments('s',{one:[file],two:[extra]})).rejects.toThrow('附件总大小最多 100 MB');
    truncateSync(file.path,100*1024*1024+1);
    await expect(validateConversationAttachments('s',[file])).rejects.toThrow('附件不可用');
  });
  it('stores attachment metadata separately and restores both stream and history without leaking it across sessions',()=>{
    const attachments=[{kind:'image' as const,name:'截图.png',path:join(directory,'image.png')},{kind:'file' as const,name:'说明.txt',path:join(directory,'note.txt')}];
    rememberConversationAttachments('s','client-image','看图',attachments,true);
    const nativeText=nativeConversationInput('看图',attachments)[0].text!,paths=conversationImagePaths([{type:'input_text',text:`<image name=[Image #1] path="${attachments[0].path}">`},{type:'input_image',image_url:'data:private'},{type:'input_text',text:'</image>'}]);
    const saved=decorateConversationAttachments('s',[{role:'user',text:nativeText,image_paths:paths}])[0];
    expect(saved).toEqual({role:'user',text:'看图',attachments});expect(JSON.stringify(saved)).not.toContain('data:private');
    expect(decorateConversationAttachments('s',[{role:'user',text:nativeText,client_id:'client-image'}])[0]).toMatchObject({text:'看图',attachments});
    expect(decorateConversationAttachments('other',[{role:'user',text:nativeText,image_paths:paths}])[0]).not.toHaveProperty('attachments');
    rememberConversationAttachments('s','legacy','',attachments,false);
    expect(decorateConversationAttachments('s',[{role:'user',text:formatConversationInput('',attachments,true)}])[0]).toMatchObject({text:'请查看附件。',attachments});
    getDb().prepare("DELETE FROM sessions WHERE id='s'").run();expect(getDb().prepare('SELECT COUNT(*) n FROM conversation_attachments').get()).toEqual({n:0});
  });
  it('validates and durably restores text positions without adding them to model input',async()=>{
    const items=await validateConversationAttachments('s',[{kind:'image',name:'first.png',path:join(directory,'image.png'),offset:0},{kind:'file',name:'middle.txt',path:join(directory,'note.txt'),offset:2}]);rememberConversationAttachments('s','offsets','前文后文',items,true);expect(decorateConversationAttachments('s',[{role:'user',text:nativeConversationInput('前文后文',items)[0].text!,image_paths:[items[0].path]}])[0]).toMatchObject({attachments:[{offset:0},{offset:2}]});expect(formatConversationInput('前文后文',items)).not.toContain('offset');for(const offset of [-1,0.5,65537,'2'])await expect(validateConversationAttachments('s',[{...items[0],offset}])).rejects.toThrow();
  });
  it('preserves inline image order and native byte ranges with Chinese and emoji text',()=>{
    const later={kind:'image' as const,name:'later.png',path:'/later.png',offset:4},first={kind:'image' as const,name:'first.png',path:'/first.png',offset:0};
    const input=nativeConversationInput('前😀文后',[later,first]);
    expect(input).toEqual([{type:'text',text:'[Image #2]前😀文[Image #1]后',text_elements:[{byteRange:{start:0,end:10},placeholder:'[Image #2]'},{byteRange:{start:20,end:30},placeholder:'[Image #1]'}]},{type:'localImage',path:'/later.png'},{type:'localImage',path:'/first.png'}]);
    expect(input[0].text).not.toContain('\n');
    expect(nativeConversationInput('前\n后',[{...first,offset:2}])[0].text).toBe('前\n[Image #1]后');
  });
  it('rejects host files, escaped directories and symlinked attachments',async()=>{
    const outside=join(root,'private.txt');writeFileSync(outside,'private');symlinkSync(outside,join(directory,'link.txt'));
    for(const path of [outside,join(directory,'link.txt'),'/etc/passwd'])await expect(validateConversationAttachments('s',[{kind:'file',name:'file',path}])).rejects.toThrow('附件不可用');
  });
  it('rejects invalid image bytes, oversized inputs and malformed attachment metadata',async()=>{
    writeFileSync(join(directory,'bad.png'),'not an image');await expect(validateConversationAttachments('s',[{kind:'image',name:'bad.png',path:join(directory,'bad.png')}])).rejects.toThrow();
    for(const name of ['one.png','two.png']){writeFileSync(join(directory,name),png);truncateSync(join(directory,name),6*1024*1024);}
    await expect(validateConversationAttachments('s',['one.png','two.png'].map(name=>({kind:'image',name,path:join(directory,name)})))).rejects.toThrow('图片总大小');
    await expect(validateConversationAttachments('s',Array(9).fill({}))).rejects.toThrow('最多支持 8');
    await expect(validateConversationAttachments('s',[{kind:'audio',name:'a',path:join(directory,'note.txt')}])).rejects.toThrow();
    await expect(validateConversationAttachments('s',[{kind:'file',name:'bad\nname',path:join(directory,'note.txt')}])).rejects.toThrow();
  });
});
