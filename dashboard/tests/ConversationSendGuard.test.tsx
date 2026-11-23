import {act,cleanup,fireEvent,render,screen,waitFor} from '@testing-library/react';
import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import {useConversationSendGuard} from '../src/lib/use-conversation-send-guard';
import {api,ApiError,type SendGuardCheck} from '../src/lib/api';
import type {CompactionPresentation} from '../src/lib/use-conversation-compaction';
import {parseBriefContext} from '../src/lib/conversation-brief-context';
const check:SendGuardCheck={needs_confirmation:true,required_action:null,switch_account:false,target_account:null,account_remaining_percent:null,matched:true,enabled:true,context_tokens:800,context_window:1000,context_percent:80,idle_minutes:40,last_completed_at:null,observed_at:null,native_id:'native',checked_at:'',can_compact:true,can_new:true,token:'original'};
const done=vi.fn(),start=vi.fn(),newSession=vi.fn();
function Harness({state=null,active=true,sessionId='s'}:{state?:CompactionPresentation|null;active?:boolean;sessionId?:string}){const guard=useConversationSendGuard(sessionId,active,{state,start},newSession);return <><output aria-label="后台等待">{String(guard.background)}</output><button onClick={()=>void guard.confirm({input:'draft'}).then(result=>done(result?.token??null))}>发送</button>{guard.dialog}{guard.notice}</>;}
beforeEach(()=>{vi.spyOn(api.agent,'checkSend').mockResolvedValue(check);start.mockResolvedValue(undefined);newSession.mockResolvedValue('fresh');});
afterEach(async()=>{cleanup();await act(async()=>{});vi.restoreAllMocks();done.mockReset();start.mockReset();newSession.mockReset();});
it('only submits after compaction completion, using a newly checked token',async()=>{
 const view=render(<Harness/>);fireEvent.click(screen.getByRole('button',{name:'发送'}));fireEvent.click(await screen.findByRole('button',{name:'压缩后发送'}));await waitFor(()=>expect(start).toHaveBeenCalledOnce());expect(screen.queryByRole('dialog')).not.toBeInTheDocument();expect(screen.getByText('正在压缩，确认完成后自动发送。')).toBeVisible();expect(done).not.toHaveBeenCalled();
 vi.mocked(api.agent.checkSend).mockResolvedValue({...check,token:'after-compact'});
 view.rerender(<Harness state={{id:'compact',status:'completed',started_at:new Date().toISOString(),completed_at:new Date(Date.now()+1000).toISOString(),duration_ms:100,before:80,after:20}}/>);
 await waitFor(()=>expect(done).toHaveBeenCalledExactlyOnceWith('after-compact'));
});
it('never sends after cancelling an in-flight compaction',async()=>{
 const view=render(<Harness/>);fireEvent.click(screen.getByRole('button',{name:'发送'}));fireEvent.click(await screen.findByRole('button',{name:'压缩后发送'}));await waitFor(()=>expect(start).toHaveBeenCalledOnce());fireEvent.click(screen.getByRole('button',{name:'取消后续发送'}));await waitFor(()=>expect(done).toHaveBeenCalledExactlyOnceWith(null));
 view.rerender(<Harness state={{id:'compact',status:'completed',started_at:null,completed_at:new Date(Date.now()+1000).toISOString(),duration_ms:100,before:80,after:20}}/>);expect(done).toHaveBeenCalledOnce();
});
it('waits for new-session confirmation then rechecks the current native session',async()=>{
 let resolve!:()=>void;newSession.mockReturnValue(new Promise<void>(r=>{resolve=r;}));render(<Harness/>);fireEvent.click(screen.getByRole('button',{name:'发送'}));fireEvent.click(await screen.findByRole('button',{name:'新开后发送'}));expect(done).not.toHaveBeenCalled();vi.mocked(api.agent.checkSend).mockResolvedValue({...check,native_id:'fresh',token:'fresh'});await act(async()=>resolve());await waitFor(()=>expect(done).toHaveBeenCalledExactlyOnceWith('fresh'));
});
it('prepares history before replacing the expected session and checks the exact final payload',async()=>{
 vi.spyOn(api.agent,'conversation').mockResolvedValue({session_id:'s',native_id:'native',available:true,generation:'gen',reset:false,has_more:false,messages:[
  {id:'old-user',role:'user',text:'旧需求',timestamp:null},
  {id:'old-progress',role:'assistant',text:'旧过程',phase:'commentary',timestamp:null},
  {id:'old-final',role:'assistant',text:'旧结论',phase:'final',timestamp:null},
 ]} as any);
 vi.mocked(api.agent.checkSend).mockResolvedValueOnce(check).mockResolvedValueOnce({...check,native_id:'fresh',token:'brief-token'});
 render(<Harness/>);fireEvent.click(screen.getByRole('button',{name:'发送'}));fireEvent.click(await screen.findByRole('button',{name:'简要压缩后发送'}));fireEvent.click(await screen.findByRole('button',{name:'开始简要压缩'}));
 await waitFor(()=>expect(done).toHaveBeenCalledExactlyOnceWith('brief-token'));
 expect(newSession).toHaveBeenCalledExactlyOnceWith('native');
 const payload=vi.mocked(api.agent.checkSend).mock.calls[1][1],brief=parseBriefContext(payload.input)!;
 expect(brief.input).toBe('draft');expect(brief.context.turns).toEqual([{input:'旧需求',progress:'旧过程',conclusion:'旧结论'}]);
});
it('uses the chosen authorized account and model for the new brief conversation',async()=>{
 vi.spyOn(api.codexEnvironments,'forSession').mockResolvedValue({current:'native',environments:[{id:'native',name:'当前账号',enabled:true,can_control:true},{id:'account:other',name:'另一账号',enabled:true,can_control:true}]} as any);
 vi.spyOn(api.codexEnvironments,'sessionPreflight').mockResolvedValue({ok:true,checks:[],models:[{model:'target-model',provider:'target',name:'目标模型',defaultEffort:'high',efforts:[{value:'high'}]}]} as any);
 vi.spyOn(api.agent,'conversation').mockResolvedValue({session_id:'s',native_id:'native',available:true,generation:'gen',reset:false,has_more:false,messages:[{id:'old',role:'user',text:'旧需求',timestamp:null}]} as any);
 vi.mocked(api.agent.checkSend).mockResolvedValueOnce(check).mockResolvedValueOnce({...check,native_id:'fresh',token:'after'});
 render(<Harness/>);fireEvent.click(screen.getByRole('button',{name:'发送'}));fireEvent.click(await screen.findByRole('button',{name:'简要压缩后发送'}));
 await screen.findByRole('option',{name:'另一账号'});fireEvent.change(screen.getByRole('combobox',{name:'简要压缩账号'}),{target:{value:'account:other'}});
 await screen.findByRole('option',{name:'目标模型'});fireEvent.change(screen.getByRole('combobox',{name:'简要压缩模型'}),{target:{value:JSON.stringify(['target','target-model'])}});
 fireEvent.click(screen.getByRole('button',{name:'开始简要压缩'}));await waitFor(()=>expect(done).toHaveBeenCalledExactlyOnceWith('after'));
 expect(newSession).toHaveBeenCalledExactlyOnceWith('native',{model:'target-model',provider:'target',effort:'high'},'account:other');
});
it('changes only the model when the current account is retained',async()=>{
 vi.spyOn(api.agent,'controls').mockResolvedValue({provider:'current',supports_fresh_model:true,models:[{model:'another',provider:'current',name:'另一个模型',defaultEffort:'medium',efforts:[{value:'medium'}]}]} as any);
 vi.spyOn(api.agent,'conversation').mockResolvedValue({session_id:'s',native_id:'native',available:true,generation:'gen',reset:false,has_more:false,messages:[{id:'old',role:'user',text:'旧需求',timestamp:null}]} as any);
 vi.mocked(api.agent.checkSend).mockResolvedValueOnce(check).mockResolvedValueOnce({...check,native_id:'fresh',token:'after'});
 render(<Harness/>);fireEvent.click(screen.getByRole('button',{name:'发送'}));fireEvent.click(await screen.findByRole('button',{name:'简要压缩后发送'}));
 await screen.findByRole('option',{name:'另一个模型'});fireEvent.change(screen.getByRole('combobox',{name:'简要压缩模型'}),{target:{value:JSON.stringify(['current','another'])}});
 fireEvent.click(screen.getByRole('button',{name:'开始简要压缩'}));await waitFor(()=>expect(done).toHaveBeenCalledExactlyOnceWith('after'));
 expect(newSession).toHaveBeenCalledExactlyOnceWith('native',{model:'another',provider:'current',effort:'medium'},undefined);
});
it('keeps the original send option and avoids a dialog in another tab when history fails',async()=>{
 let release!:(page:any)=>void;
 vi.spyOn(api.agent,'conversation').mockReturnValue(new Promise(resolve=>{release=resolve;}));
 const view=render(<Harness/>);fireEvent.click(screen.getByRole('button',{name:'发送'}));fireEvent.click(await screen.findByRole('button',{name:'简要压缩后发送'}));fireEvent.click(await screen.findByRole('button',{name:'开始简要压缩'}));
 view.rerender(<Harness active={false}/>);
 await act(async()=>release({session_id:'s',native_id:'replaced',available:true,generation:'gen',reset:false,has_more:false,messages:[]}));
 expect(await screen.findByRole('alert')).toHaveTextContent('无法读取原会话历史');expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
 expect(newSession).not.toHaveBeenCalled();expect(done).not.toHaveBeenCalled();
 view.rerender(<Harness/>);
 fireEvent.click(screen.getByRole('button',{name:'原样发送'}));await waitFor(()=>expect(done).toHaveBeenCalledExactlyOnceWith('original'));
});
it('can start brief compaction directly without waiting for the risk condition to match',async()=>{
 vi.spyOn(api.agent,'conversation').mockResolvedValue({session_id:'s',native_id:'native',available:true,generation:'gen',reset:false,has_more:false,messages:[{id:'old',role:'user',text:'已完成的需求',timestamp:null}]} as any);
 vi.mocked(api.agent.checkSend).mockResolvedValueOnce({...check,needs_confirmation:false}).mockResolvedValueOnce({...check,native_id:'fresh',token:'after'});
 function Direct(){const guard=useConversationSendGuard('s',true,{state:null,start},newSession);return <><button onClick={()=>void guard.confirm({input:'继续'},'brief').then(result=>done(result?.token))}>简要压缩</button>{guard.dialog}</>;}
 render(<Direct/>);fireEvent.click(screen.getByRole('button',{name:'简要压缩'}));fireEvent.click(await screen.findByRole('button',{name:'开始简要压缩'}));await waitFor(()=>expect(done).toHaveBeenCalledExactlyOnceWith('after'));
 expect(newSession).toHaveBeenCalledExactlyOnceWith('native');expect(parseBriefContext(vi.mocked(api.agent.checkSend).mock.calls[1][1].input)?.input).toBe('继续');
});
it('allows the explicit brief action when send protection is disabled',async()=>{
 vi.spyOn(api.agent,'conversation').mockResolvedValue({session_id:'s',native_id:'native',available:true,generation:'gen',reset:false,has_more:false,messages:[{id:'old',role:'user',text:'已完成的需求',timestamp:null}]} as any);
 vi.mocked(api.agent.checkSend).mockResolvedValueOnce({...check,enabled:false,needs_confirmation:false,can_new:false}).mockResolvedValueOnce({...check,enabled:false,native_id:'fresh',token:'after'});
 function Direct(){const guard=useConversationSendGuard('s',true,{state:null,start},newSession);return <><button onClick={()=>void guard.confirm({input:'继续'},'brief').then(result=>done(result?.token))}>简要压缩</button>{guard.dialog}</>;}
 render(<Direct/>);fireEvent.click(screen.getByRole('button',{name:'简要压缩'}));fireEvent.click(await screen.findByRole('button',{name:'开始简要压缩'}));await waitFor(()=>expect(done).toHaveBeenCalledExactlyOnceWith('after'));
 expect(newSession).toHaveBeenCalledExactlyOnceWith('native');
});
it('does not create a new conversation if the user cancels while history is loading',async()=>{
 let release!:(page:any)=>void;vi.spyOn(api.agent,'conversation').mockReturnValue(new Promise(resolve=>{release=resolve;}));
 render(<Harness/>);fireEvent.click(screen.getByRole('button',{name:'发送'}));fireEvent.click(await screen.findByRole('button',{name:'简要压缩后发送'}));fireEvent.click(await screen.findByRole('button',{name:'开始简要压缩'}));
 expect(await screen.findByText('正在整理已有对话记录…')).toBeVisible();expect(screen.queryByRole('dialog')).not.toBeInTheDocument();fireEvent.click(screen.getByRole('button',{name:'取消后续发送'}));
 await waitFor(()=>expect(done).toHaveBeenCalledExactlyOnceWith(null));
 await act(async()=>release({session_id:'s',native_id:'native',available:true,generation:'gen',reset:false,has_more:false,messages:[{id:'old',role:'user',text:'旧需求',timestamp:null}]}));
 expect(newSession).not.toHaveBeenCalled();expect(done).toHaveBeenCalledOnce();
});
it('continues a confirmed brief send in its original tab after switching away',async()=>{
 let release!:(page:any)=>void;
 vi.spyOn(api.agent,'conversation').mockReturnValue(new Promise(resolve=>{release=resolve;}));
 const view=render(<Harness/>);fireEvent.click(screen.getByRole('button',{name:'发送'}));fireEvent.click(await screen.findByRole('button',{name:'简要压缩后发送'}));fireEvent.click(await screen.findByRole('button',{name:'开始简要压缩'}));
 await screen.findByText('正在整理已有对话记录…');expect(screen.queryByRole('dialog')).toBeNull();
 view.rerender(<Harness active={false}/>);expect(screen.getByLabelText('后台等待')).toHaveTextContent('true');expect(done).not.toHaveBeenCalled();
 vi.mocked(api.agent.checkSend).mockResolvedValue({...check,native_id:'fresh',token:'background-brief'});
 await act(async()=>release({session_id:'s',native_id:'native',available:true,generation:'gen',reset:false,has_more:false,messages:[{id:'old',role:'user',text:'旧需求',timestamp:null}]}));
 await waitFor(()=>expect(done).toHaveBeenCalledExactlyOnceWith('background-brief'));
});
it('does not send a brief request after cancelling while the new session starts',async()=>{
 vi.spyOn(api.agent,'conversation').mockResolvedValue({session_id:'s',native_id:'native',available:true,generation:'gen',reset:false,has_more:false,messages:[{id:'old',role:'user',text:'旧需求',timestamp:null}]} as any);
 let release!:(id:string)=>void;newSession.mockReturnValue(new Promise<string>(resolve=>{release=resolve;}));
 render(<Harness/>);fireEvent.click(screen.getByRole('button',{name:'发送'}));fireEvent.click(await screen.findByRole('button',{name:'简要压缩后发送'}));fireEvent.click(await screen.findByRole('button',{name:'开始简要压缩'}));
 await waitFor(()=>expect(newSession).toHaveBeenCalledOnce());fireEvent.click(screen.getByRole('button',{name:'取消后续发送'}));
 await waitFor(()=>expect(done).toHaveBeenCalledExactlyOnceWith(null));await act(async()=>release('fresh'));expect(done).toHaveBeenCalledOnce();
});
it('never sends brief history when a different fresh conversation replaces the created one',async()=>{
 vi.spyOn(api.agent,'conversation').mockResolvedValue({session_id:'s',native_id:'native',available:true,generation:'gen',reset:false,has_more:false,messages:[{id:'old',role:'user',text:'旧需求',timestamp:null}]} as any);
 vi.mocked(api.agent.checkSend).mockResolvedValueOnce(check).mockResolvedValueOnce({...check,native_id:'unrelated',token:'wrong'});
 render(<Harness/>);fireEvent.click(screen.getByRole('button',{name:'发送'}));fireEvent.click(await screen.findByRole('button',{name:'简要压缩后发送'}));fireEvent.click(await screen.findByRole('button',{name:'开始简要压缩'}));
 expect(await screen.findByRole('alert')).toHaveTextContent('新会话身份尚未确认');expect(done).not.toHaveBeenCalled();
});
it('does not send if the creation result does not identify the new conversation',async()=>{
 vi.spyOn(api.agent,'conversation').mockResolvedValue({session_id:'s',native_id:'native',available:true,generation:'gen',reset:false,has_more:false,messages:[{id:'old',role:'user',text:'旧需求',timestamp:null}]} as any);
 newSession.mockResolvedValueOnce(undefined);
 render(<Harness/>);fireEvent.click(screen.getByRole('button',{name:'发送'}));fireEvent.click(await screen.findByRole('button',{name:'简要压缩后发送'}));fireEvent.click(await screen.findByRole('button',{name:'开始简要压缩'}));
 expect(await screen.findByRole('alert')).toHaveTextContent('新会话身份尚未确认');expect(done).not.toHaveBeenCalled();expect(api.agent.checkSend).toHaveBeenCalledOnce();
});
it('retains unknown operation results without automatic resubmission',async()=>{
 newSession.mockRejectedValue(new ApiError('timeout',503,'unknown'));render(<Harness/>);fireEvent.click(screen.getByRole('button',{name:'发送'}));fireEvent.click(await screen.findByRole('button',{name:'新开后发送'}));expect(await screen.findByRole('alert')).toHaveTextContent('timeout');expect(screen.getByRole('button',{name:'原样发送'})).toBeDisabled();expect(done).not.toHaveBeenCalled();expect(api.agent.checkSend).toHaveBeenCalledOnce();
});
it('cancels an outstanding prompt when its session becomes inactive',async()=>{
 const view=render(<Harness/>);fireEvent.click(screen.getByRole('button',{name:'发送'}));await screen.findByRole('dialog');view.rerender(<Harness active={false}/>);await waitFor(()=>expect(done).toHaveBeenCalledExactlyOnceWith(null));
});

it('releases a pending prompt when another session reuses the component',async()=>{
 const view=render(<Harness/>);fireEvent.click(screen.getByRole('button',{name:'发送'}));await screen.findByRole('dialog');view.rerender(<Harness sessionId="different"/>);await waitFor(()=>expect(done).toHaveBeenCalledExactlyOnceWith(null));expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
});

it('does not send when new-session acceptance has not changed the native identity',async()=>{
 render(<Harness/>);fireEvent.click(screen.getByRole('button',{name:'发送'}));fireEvent.click(await screen.findByRole('button',{name:'新开后发送'}));expect(await screen.findByRole('alert')).toHaveTextContent('新会话身份尚未确认');expect(done).not.toHaveBeenCalled();expect(screen.getByRole('button',{name:'原样发送'})).toBeDisabled();
});

it('dismisses the modal before the compaction request returns and stays nonmodal during recheck',async()=>{
 let resolve!:()=>void;start.mockReturnValue(new Promise<void>(r=>{resolve=r;}));const view=render(<Harness/>);fireEvent.click(screen.getByRole('button',{name:'发送'}));fireEvent.click(await screen.findByRole('button',{name:'压缩后发送'}));expect(screen.queryByRole('dialog')).not.toBeInTheDocument();expect(screen.getByRole('button',{name:'发送'})).toBeEnabled();fireEvent.click(screen.getByRole('button',{name:'发送'}));expect(start).toHaveBeenCalledOnce();expect(api.agent.checkSend).toHaveBeenCalledOnce();await act(async()=>resolve());
 let release!:(value:SendGuardCheck)=>void;vi.mocked(api.agent.checkSend).mockReturnValueOnce(new Promise(r=>{release=r;}));view.rerender(<Harness state={{id:'compact',status:'completed',started_at:null,completed_at:new Date(Date.now()+1000).toISOString(),duration_ms:100,before:80,after:20}}/>);await screen.findByText('压缩完成，正在检查后发送…');expect(screen.queryByRole('dialog')).not.toBeInTheDocument();await act(async()=>release({...check,token:'after'}));await waitFor(()=>expect(done).toHaveBeenCalledWith('after'));expect(screen.queryByText('压缩完成，正在检查后发送…')).not.toBeInTheDocument();
});
it.each(['failed','interrupted','unknown','rejected'] as const)('keeps %s compaction results inline and never sends after a late completion',async(status)=>{
 const view=render(<Harness/>);fireEvent.click(screen.getByRole('button',{name:'发送'}));fireEvent.click(await screen.findByRole('button',{name:'压缩后发送'}));view.rerender(<Harness state={{id:'compact',status,started_at:null,completed_at:null,duration_ms:null,before:80,after:null,error:'压缩失败，草稿已保留'}}/>);expect(await screen.findByRole('alert')).toHaveTextContent('压缩失败');expect(screen.queryByRole('dialog')).not.toBeInTheDocument();expect(done).not.toHaveBeenCalled();view.rerender(<Harness state={{id:'compact',status:'completed',started_at:null,completed_at:new Date(Date.now()+1000).toISOString(),duration_ms:100,before:80,after:20}}/>);expect(done).not.toHaveBeenCalled();fireEvent.click(screen.getByRole('button',{name:'关闭提示'}));await waitFor(()=>expect(done).toHaveBeenCalledWith(null));
});

it('keeps a compaction timeout nonmodal and ignores a late completion',async()=>{
 const view=render(<Harness/>);fireEvent.click(screen.getByRole('button',{name:'发送'}));const compact=await screen.findByRole('button',{name:'压缩后发送'});vi.useFakeTimers();
 try{fireEvent.click(compact);await act(async()=>vi.advanceTimersByTime(120000));expect(screen.getByRole('alert')).toHaveTextContent('操作结果暂未确认');expect(screen.queryByRole('dialog')).not.toBeInTheDocument();view.rerender(<Harness state={{id:'compact',status:'completed',started_at:null,completed_at:new Date().toISOString(),duration_ms:120000,before:80,after:20}}/>);expect(done).not.toHaveBeenCalled();}finally{vi.useRealTimers();}
});

it('continues confirmed compaction and recheck while the session tab is inactive',async()=>{
 const view=render(<Harness/>);fireEvent.click(screen.getByRole('button',{name:'发送'}));fireEvent.click(await screen.findByRole('button',{name:'压缩后发送'}));view.rerender(<Harness active={false}/>);expect(done).not.toHaveBeenCalled();expect(screen.getByLabelText('后台等待')).toHaveTextContent('true');
 let release!:(value:SendGuardCheck)=>void;vi.mocked(api.agent.checkSend).mockReturnValueOnce(new Promise(r=>{release=r;}));view.rerender(<Harness active={false} state={{id:'compact',status:'completed',started_at:null,completed_at:new Date(Date.now()+1000).toISOString(),duration_ms:100,before:80,after:20}}/>);await screen.findByText('压缩完成，正在检查后发送…');expect(screen.getByLabelText('后台等待')).toHaveTextContent('true');await act(async()=>release({...check,token:'background-token'}));await waitFor(()=>expect(done).toHaveBeenCalledExactlyOnceWith('background-token'));expect(screen.getByLabelText('后台等待')).toHaveTextContent('false');
});
it('does not transfer compact-and-send to a replaced native conversation',async()=>{
 const view=render(<Harness/>);fireEvent.click(screen.getByRole('button',{name:'发送'}));fireEvent.click(await screen.findByRole('button',{name:'压缩后发送'}));vi.mocked(api.agent.checkSend).mockResolvedValue({...check,native_id:'replacement'});view.rerender(<Harness active={false} state={{id:'compact',status:'completed',started_at:null,completed_at:new Date(Date.now()+1000).toISOString(),duration_ms:100,before:80,after:20}}/>);expect(await screen.findByRole('alert')).toHaveTextContent('原生会话已变化');expect(done).not.toHaveBeenCalled();expect(screen.getByLabelText('后台等待')).toHaveTextContent('false');
});

it.each(['new','brief'] as const)('applies the required %s action without prompting and sends to the confirmed identity',async action=>{
 const history=vi.spyOn(api.agent,'conversation').mockResolvedValue({session_id:'s',native_id:'native',available:true,generation:'gen',reset:false,has_more:false,messages:[{id:'old',role:'user',text:'旧需求',timestamp:null}]} as any);
 vi.mocked(api.agent.checkSend)
  .mockResolvedValueOnce({...check,required_action:action,token:null})
  .mockResolvedValueOnce({...check,required_action:null,native_id:'fresh',token:'after-automatic'});
 render(<Harness/>);
 fireEvent.click(screen.getByRole('button',{name:'发送'}));
 await waitFor(()=>expect(done).toHaveBeenCalledExactlyOnceWith('after-automatic'));
 expect(newSession).toHaveBeenCalledExactlyOnceWith('native');
 expect(screen.queryByRole('dialog')).toBeNull();
 expect(history).toHaveBeenCalledTimes(action==='brief'?1:0);
 const sent=vi.mocked(api.agent.checkSend).mock.calls[1][1].input;
 expect(action==='brief'?parseBriefContext(sent)?.input:sent).toBe('draft');
});

it('waits for automatic native compaction and does not loop when an automatic rule still matches',async()=>{
 const automatic={...check,required_action:'compact' as const,token:null};
 vi.mocked(api.agent.checkSend).mockResolvedValue(automatic);
 const view=render(<Harness/>);
 fireEvent.click(screen.getByRole('button',{name:'发送'}));
 await waitFor(()=>expect(start).toHaveBeenCalledExactlyOnceWith('native'));
 expect(screen.queryByRole('dialog')).toBeNull();
 expect(done).not.toHaveBeenCalled();
 view.rerender(<Harness state={{id:'compact',status:'completed',started_at:null,completed_at:new Date(Date.now()+1000).toISOString(),duration_ms:100,before:80,after:75}}/>);
 expect(await screen.findByRole('alert')).toHaveTextContent('仍命中自动规则');
 expect(done).not.toHaveBeenCalled();
 expect(start).toHaveBeenCalledOnce();
 expect(api.agent.checkSend).toHaveBeenCalledTimes(2);
});

it('preserves the draft and offers no override when the required action is unavailable',async()=>{
 vi.mocked(api.agent.checkSend).mockResolvedValue({...check,required_action:'new',can_new:false,token:null});
 render(<Harness/>);
 fireEvent.click(screen.getByRole('button',{name:'发送'}));
 expect(await screen.findByRole('alert')).toHaveTextContent('自动新开');
 expect(screen.queryByRole('button',{name:'原样发送'})).toBeNull();
 expect(done).not.toHaveBeenCalled();
 expect(newSession).not.toHaveBeenCalled();
 fireEvent.click(screen.getByRole('button',{name:'关闭提示'}));
 await waitFor(()=>expect(done).toHaveBeenCalledExactlyOnceWith(null));
});

it('stops a quota switch if the new account quota becomes unknown before sending',async()=>{
 vi.mocked(api.agent.checkSend)
  .mockResolvedValueOnce({...check,required_action:'new',switch_account:true,target_account:{id:'account:backup',label:'备用账号'},token:null})
  .mockResolvedValueOnce({...check,native_id:'fresh',required_action:null,account_remaining_percent:null,token:'after'});
 render(<Harness/>);
 fireEvent.click(screen.getByRole('button',{name:'发送'}));
 expect(await screen.findByRole('alert')).toHaveTextContent('无法确认新账号有剩余额度');
 expect(newSession).toHaveBeenCalledExactlyOnceWith('native',undefined,'account:backup');
 expect(done).not.toHaveBeenCalled();
});
