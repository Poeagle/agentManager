import {afterEach,beforeEach,describe,expect,it} from 'vitest';
import {mkdirSync,writeFileSync,truncateSync,symlinkSync} from 'fs';
import {join} from 'path';
import {createTestDatabase} from './helpers/database.js';
import {getDb} from '../src/db/index.js';
import {formatConversationInput,validateConversationAttachments} from '../src/services/conversation-attachments.js';
let cleanup:()=>void,root:string,directory:string;
const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9hZsEAAAAASUVORK5CYII=','base64');
beforeEach(()=>{
  const fixture=createTestDatabase();cleanup=fixture.cleanup;root=join(fixture.dir,'project');directory=join(root,'.agentmanager','pastes');mkdirSync(directory,{recursive:true});
  getDb().prepare("INSERT INTO projects(id,name,path) VALUES('p','P',?)").run(root);getDb().prepare("INSERT INTO sessions(id,project_id,task,status,mode) VALUES('s','p','Test','running','session')").run();
  writeFileSync(join(directory,'image.png'),png);writeFileSync(join(directory,'note.txt'),'test attachment');
});
afterEach(()=>cleanup());
describe('conversation attachment validation',()=>{
  it('accepts uploaded image and file paths and preserves an attachment-only message',async()=>{
    const items=await validateConversationAttachments('s',[{kind:'image',name:'截图.png',path:join(directory,'image.png')},{kind:'file',name:'note.txt',path:join(directory,'note.txt')}]);
    expect(items).toHaveLength(2);expect(formatConversationInput('',items)).toContain('请查看附件。');expect(formatConversationInput('看附件',items)).toContain('截图.png');expect(formatConversationInput('plain',[])).toBe('plain');
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
