import {expect,it,vi,beforeEach} from 'vitest';
import {readCodexContextBreakdown} from '../src/services/agents/codex/context-breakdown.js';
import type {AgentContext} from '../src/services/agents/types.js';
const state=vi.hoisted(()=>({id:'a',calls:vi.fn(),local:vi.fn(),request:vi.fn()}));
vi.mock('../src/services/agents/codex/engine-context.js',()=>({currentCodexEngine:()=>({socket:'/fixture/'+state.id,environmentId:state.id,accountHome:'/fixture/'+state.id})}));
vi.mock('../src/services/agents/codex/environments.js',()=>({getCodexEnvironment:(id:string)=>({id,kind:'account',connection:{username:id,codexHome:'/fixture/'+id}}),environmentConnection:(e:any)=>e.connection}));
vi.mock('../src/services/agents/codex/account-files.js',()=>({localHome:()=>'/fixture/native'}));
vi.mock('../src/services/agents/codex/account-transport.js',()=>({accountCommandInput:state.calls,localCommandInput:state.local}));
vi.mock('../src/services/agents/codex/stream.js',()=>({withCodexConnection:async(action:any)=>action(state.request)}));
const fixture={categories:[{id:'user',name:'用户消息',tokens:30,count:1,detail:[]}],usage:{last:{total_tokens:100},window:1000},warnings:[],files_read:1};
beforeEach(()=>{vi.clearAllMocks();state.calls.mockResolvedValue(JSON.stringify(fixture));state.request.mockImplementation(async()=>({thread:{path:'/fixture/'+state.id+'/sessions/file.jsonl'}}));});
const context=(id:string)=>({nativeId:id,session:{id},projectPath:'/project'}) as AgentContext;
it('uses the selected account SSH channel, caches counts, and coalesces concurrent dialog reads',async()=>{
 state.id='cache-account';const ctx=context('cache-thread');await Promise.all([readCodexContextBreakdown(ctx),readCodexContextBreakdown(ctx)]);await readCodexContextBreakdown(ctx);
 expect(state.calls).toHaveBeenCalledTimes(1);expect(state.local).not.toHaveBeenCalled();expect(state.calls).toHaveBeenCalledWith(expect.objectContaining({username:'cache-account'}),expect.any(String),expect.stringContaining('/fixture/cache-account'),expect.objectContaining({maxOutputBytes:512*1024}));
 await readCodexContextBreakdown({...ctx,force:true});expect(state.calls).toHaveBeenCalledTimes(2);
});
it('never reuses another account cache for the same native thread identity',async()=>{
 const ctx=context('shared-native');state.id='first';await readCodexContextBreakdown(ctx);state.id='second';await readCodexContextBreakdown(ctx);expect(state.calls).toHaveBeenCalledTimes(2);expect(state.calls.mock.calls[1][0].username).toBe('second');
});
it('returns only allowlisted metadata and classifies transport failures as failures',async()=>{
 state.id='sanitized';state.calls.mockResolvedValueOnce(JSON.stringify({...fixture,secret:'never-return',usage:{...fixture.usage,private:'never-return'},categories:[{...fixture.categories[0],content:'never-return'}]}));const result=await readCodexContextBreakdown(context('sanitized-thread'));expect(JSON.stringify(result)).not.toContain('never-return');expect(result).toMatchObject({exact:false,method:'characters_div_3',usage:{last:{total_tokens:100}}});
 state.calls.mockRejectedValueOnce(Error('unavailable'));await expect(readCodexContextBreakdown({...context('sanitized-thread'),force:true})).rejects.toThrow('unavailable');
});
