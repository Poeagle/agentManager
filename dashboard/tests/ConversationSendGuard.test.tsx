import {act,cleanup,fireEvent,render,screen,waitFor} from '@testing-library/react';
import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import {useConversationSendGuard} from '../src/lib/use-conversation-send-guard';
import {api,ApiError,type SendGuardCheck} from '../src/lib/api';
import type {CompactionPresentation} from '../src/lib/use-conversation-compaction';
const check:SendGuardCheck={needs_confirmation:true,matched:true,enabled:true,context_tokens:800,context_window:1000,context_percent:80,idle_minutes:40,last_completed_at:null,observed_at:null,native_id:'native',checked_at:'',can_compact:true,can_new:true,token:'original'};
const done=vi.fn(),start=vi.fn(),newSession=vi.fn();
function Harness({state=null,active=true,sessionId='s'}:{state?:CompactionPresentation|null;active?:boolean;sessionId?:string}){const guard=useConversationSendGuard(sessionId,active,{state,start},newSession);return <><output aria-label="后台等待">{String(guard.background)}</output><button onClick={()=>void guard.confirm({input:'draft'}).then(result=>done(result?.token??null))}>发送</button>{guard.dialog}{guard.notice}</>;}
beforeEach(()=>{vi.spyOn(api.agent,'checkSend').mockResolvedValue(check);start.mockResolvedValue(undefined);newSession.mockResolvedValue(undefined);});
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
