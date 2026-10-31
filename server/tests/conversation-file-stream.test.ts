import {afterEach,expect,it,vi} from 'vitest';
import {mkdtempSync,mkdirSync,writeFileSync,appendFileSync,rmSync} from 'fs';
import {tmpdir} from 'os';
import {join} from 'path';
import {observeConversationFile,type ConversationHistoryFrame} from '../src/services/conversation-file-stream.js';
let close:(()=>void)|undefined,dir:string|undefined;
afterEach(()=>{close?.();vi.unstubAllEnvs();if(dir)rmSync(dir,{recursive:true,force:true});});
it('pushes new public legacy conversation records on file writes and stops when closed',async()=>{
 dir=mkdtempSync(join(tmpdir(),'conversation-file-'));vi.stubEnv('CODEX_HOME',dir);mkdirSync(join(dir,'sessions'));
 const native='019ff001-2345-7345-8345-234523452345',file=join(dir,'sessions',`rollout-${native}.jsonl`),record=(payload:any)=>JSON.stringify({type:'event_msg',timestamp:new Date().toISOString(),payload})+'\n';
 writeFileSync(file,record({type:'user_message',message:'检查推送'}));const frames:ConversationHistoryFrame[]=[];
 close=observeConversationFile({cli_type:'codex',codex_session_id:native,claude_session_id:null,project_path:dir},frame=>frames.push(frame));
 await vi.waitFor(()=>expect(frames.flatMap(f=>f.messages).map(m=>m.text)).toContain('检查推送'));
 const started=Date.now();appendFileSync(file,record({type:'agent_message',message:'新进展立即推送',phase:'commentary'}));
 await vi.waitFor(()=>expect(frames.flatMap(f=>f.messages).map(m=>m.text)).toContain('新进展立即推送'),{timeout:1000,interval:20});expect(Date.now()-started).toBeLessThan(1000);
 expect(frames.flatMap(f=>f.messages).filter(m=>m.text==='检查推送')).toHaveLength(1);close();const count=frames.length;appendFileSync(file,record({type:'agent_message',message:'关闭后不再推送'}));await new Promise(r=>setTimeout(r,100));expect(frames).toHaveLength(count);
});
