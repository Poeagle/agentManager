import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import {mkdirSync,writeFileSync,appendFileSync,statSync} from 'node:fs';
import {join} from 'node:path';
import {createTestDatabase} from './helpers/database.js';
import {getDb} from '../src/db/index.js';
import {rememberConversationInput,linkConversationInputs,boundConversationInputs} from '../src/services/conversation-input-links.js';
import {rememberConversationAttachments,formatConversationInput,nativeConversationInput} from '../src/services/conversation-attachments.js';
import type {ConversationMessage} from '../src/services/conversation-reader.js';
const native='019ff001-1234-7234-8234-123456789abc',binding={cli_type:'codex' as const,codex_session_id:native,claude_session_id:null,project_path:'/project'};
let cleanup:()=>void,file:string;
beforeEach(()=>{const test=createTestDatabase();cleanup=test.cleanup;vi.stubEnv('CODEX_HOME',test.dir);mkdirSync(join(test.dir,'sessions'));file=join(test.dir,'sessions',`rollout-${native}.jsonl`);writeFileSync(file,'older history\n');getDb().prepare("INSERT INTO sessions(id,task,status) VALUES('s','test','running'),('other','test','running')").run();});
afterEach(()=>{vi.unstubAllEnvs();cleanup();});
const message=(id:string,sequence:number,text='ifconfig\n  inet 192.168.1.31'):ConversationMessage=>({id,sequence,text,role:'user',timestamp:null});
it('restores a terminal input client ID through line ending normalization and later replays',async()=>{
  const boundary=statSync(file).size;await rememberConversationInput('s',binding,'client-one','ifconfig\r\n  inet 192.168.1.31\r\n');
  const echo=message('native-one',boundary),result=linkConversationInputs('s',native,[message('older',0),echo]);
  expect(result[0].client_id).toBeUndefined();expect(result[1].client_id).toBe('client-one');expect(linkConversationInputs('s',native,[echo])[0].client_id).toBe('client-one');
  expect(linkConversationInputs('other',native,[echo])[0].client_id).toBeUndefined();expect(linkConversationInputs('s','different-native',[echo])[0].client_id).toBeUndefined();
});
it('binds intentionally repeated inputs one for one without assigning an ID to an unrelated later repeat',async()=>{
  const first=statSync(file).size;await rememberConversationInput('s',binding,'one','same');appendFileSync(file,'native record one\n');
  const second=statSync(file).size;await rememberConversationInput('s',binding,'two','same');
  const echoes=[message('first',first,'same'),message('second',second,'same'),message('manual-repeat',second+50,'same')];
  expect(linkConversationInputs('s',native,echoes).map(m=>m.client_id)).toEqual(['one','two',undefined]);
  expect(linkConversationInputs('s',native,echoes.slice().reverse()).map(m=>m.client_id)).toEqual([undefined,'two','one']);
});
it('stores only a bounded fingerprint journal and preserves the original boundary for retried client identities',async()=>{
  await rememberConversationInput('s',binding,'retry','sensitive body');const before=getDb().prepare('SELECT * FROM conversation_input_links').get();appendFileSync(file,'next\n');await rememberConversationInput('s',binding,'retry','sensitive body');expect(getDb().prepare('SELECT * FROM conversation_input_links').get()).toEqual(before);expect(JSON.stringify(before)).not.toContain('sensitive body');
  await rememberConversationInput('s',binding,'retry','different terminal format','different native format');expect(getDb().prepare('SELECT * FROM conversation_input_links').get()).toEqual(before);
});
it('binds a terminal-generated client ID to the original browser submission after the file boundary',async()=>{
 const boundary=statSync(file).size;await rememberConversationInput('s',binding,'browser','hello');
 const older={...message('older',boundary-1,'hello'),client_id:'terminal-old'},echo={...message('native',boundary,'hello'),client_id:'terminal-new'};
 expect(linkConversationInputs('s',native,[older])[0]).toEqual(older);
 expect(boundConversationInputs('s',native,[echo])).toEqual([{...echo,client_id:'browser',native_client_id:'terminal-new'}]);
 expect(linkConversationInputs('s',native,[echo])[0]).toMatchObject({client_id:'browser',native_client_id:'terminal-new'});
 expect(linkConversationInputs('s',native,[{...message('independent',boundary+1,'hello'),client_id:'other-terminal'}])[0].client_id).toBe('other-terminal');
});
it('updates the pending fingerprint when native input falls back to terminal formatting',async()=>{
 const attachments=[{kind:'image' as const,name:'picture.png',path:'/project/image.png',offset:0},{kind:'file' as const,name:'note.txt',path:'/project/note.txt'}],text='hello';
 const boundary=statSync(file).size;await rememberConversationInput('s',binding,'browser',nativeConversationInput(text,attachments)[0].text);appendFileSync(file,'record\n');
 await rememberConversationInput('s',binding,'browser',formatConversationInput(text,attachments,true),nativeConversationInput(text,attachments)[0].text);
 const echo={...message('native',boundary,formatConversationInput(text,attachments,true)),client_id:'terminal'};
 expect(linkConversationInputs('s',native,[echo])[0]).toMatchObject({client_id:'browser',native_client_id:'terminal'});
});
it('repairs previously journalled attachment fallbacks without guessing from displayed text',async()=>{
 const attachments=[{kind:'image' as const,name:'picture.png',path:'/project/image.png',offset:0},{kind:'file' as const,name:'note.txt',path:'/project/note.txt'}],text='hello';
 const boundary=statSync(file).size;rememberConversationAttachments('s','browser',text,attachments,true);await rememberConversationInput('s',binding,'browser',nativeConversationInput(text,attachments)[0].text);
 expect(linkConversationInputs('s',native,[{...message('native',boundary,formatConversationInput(text,attachments,true)),client_id:'terminal'}])[0]).toMatchObject({client_id:'browser',native_client_id:'terminal'});
});
