import {beforeEach,describe,expect,it,vi} from 'vitest';
import {readConversationPreview,humanSessionTask} from '../src/services/conversation-preview.js';
import {readConversation} from '../src/services/conversation-reader.js';
vi.mock('../src/services/conversation-reader.js',()=>({readConversation:vi.fn()}));
let serial=0;
const binding=()=>({cli_type:'codex',codex_session_id:`test-${serial++}`});
const page=(text:string)=>({messages:[{id:'q',role:'user',text:'用户的问题',timestamp:null},{id:'a',role:'assistant',phase:'commentary',text,timestamp:'2026-10-31T02:00:00Z'}]}) as any;
beforeEach(()=>vi.clearAllMocks());
describe('public conversation summaries',()=>{
  it('uses assistant messages and caches duplicate reads without touching PTY output',async()=>{
    vi.mocked(readConversation).mockResolvedValue(page('**正在核对配置**，随后给出结果。'));const session=binding();
    const result=await Promise.all([readConversationPreview(session),readConversationPreview(session)]);expect(result[0]).toEqual({text:'正在核对配置，随后给出结果。',timestamp:'2026-10-31T02:00:00Z',phase:'commentary'});expect(result[1]).toEqual(result[0]);expect(readConversation).toHaveBeenCalledOnce();
    await readConversationPreview(session);expect(readConversation).toHaveBeenCalledOnce();expect(await readConversationPreview({cli_type:'claude'})).toBeNull();expect(humanSessionTask('任务描述 [Platform task reference: abc-123]')).toBe('任务描述');
  });
  it('keeps file reads bounded when many session cards load together',async()=>{
    const releases:Array<()=>void>=[];let active=0,maximum=0;
    vi.mocked(readConversation).mockImplementation(()=>{active++;maximum=Math.max(active,maximum);return new Promise(resolve=>releases.push(()=>{active--;resolve(page('进展'));}));});
    const jobs=Array.from({length:8},()=>readConversationPreview(binding()));
    for(let batch=0;batch<4;batch++){await vi.waitFor(()=>expect(releases).toHaveLength(2));for(const release of releases.splice(0))release();}
    await Promise.all(jobs);expect(maximum).toBe(2);
  });
  it('returns no fabricated content when native history is missing',async()=>{
    vi.mocked(readConversation).mockResolvedValue({messages:[]} as any);expect(await readConversationPreview(binding())).toBeNull();
  });
});
