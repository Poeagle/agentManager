import {useEffect,useState} from 'react';
import {Loader2} from 'lucide-react';
export interface ConversationRetry {
  session_id:string;native_id:string;root_turn_id:string;failed_turn_ids:string[];
  attempt:number;max_attempts:3;status:'waiting'|'submitting'|'running'|'succeeded'|'exhausted'|'cancelled'|'unknown';
  next_retry_at:string|null;
  stop_reason?:string;
}
const reasons:Record<string,string>={user_cancelled:'你已停止自动重试。',new_input:'已收到新的用户输入，旧重试计划已取消。',access_changed:'会话绑定或访问权限已变更。',queued_input:'已有排队输入，将优先处理新的输入。',newer_turn:'会话已开始其他执行轮次。',thread_busy:'原生会话仍在执行，未重复启动任务。',thread_unavailable:'当前原生会话不可用。',turn_finished:'原执行轮次已不再处于失败状态。',non_retryable_error:'当前错误不属于可自动重试的临时容量错误。',final_answer:'该轮已给出最终答复。',interrupted:'原生执行已中断。'};
export function ConversationRetryStatus({retry,onCancel}:{retry:ConversationRetry;onCancel?:()=>Promise<void>}) {
  const [now,setNow]=useState(Date.now),[cancelling,setCancelling]=useState(false),[error,setError]=useState('');
  useEffect(()=>{if(retry.status!=='waiting')return;setNow(Date.now());const timer=setInterval(()=>setNow(Date.now()),1000);return ()=>clearInterval(timer);},[retry.status,retry.next_retry_at]);
  const pending=['waiting','submitting','running'].includes(retry.status);
  const attempt=retry.status==='waiting'?retry.attempt+1:retry.attempt;
  const remaining=Math.max(0,Math.ceil((Date.parse(retry.next_retry_at||'')-now)/1000));
  const label=retry.status==='waiting'?`${remaining>0?`${remaining} 秒后`:'即将'}自动重试（${attempt}/3）`:retry.status==='submitting'||retry.status==='running'?`正在自动重试（${attempt}/3）`:retry.status==='succeeded'?`已自动恢复（${attempt}/3）`:retry.status==='exhausted'?'自动重试已达上限（3/3），请稍后手动继续或切换模型。':retry.status==='unknown'?'提交结果尚未确认，已停止自动重试。请到原始终端核对后再操作。':`自动重试已停止（已尝试 ${retry.attempt}/3 次）。`;
  async function cancel(){setCancelling(true);setError('');try{await onCancel?.();}catch(failure){setError(failure instanceof Error?failure.message:'停止失败');}finally{setCancelling(false);}}
  return <div className="session-chat-retry-status" role="status" aria-live="polite">
    <p>{pending&&<Loader2 size={14} className="session-chat-retry-spinner"/>}{label}</p>
    {retry.status==='cancelled'&&<p>{retry.stop_reason&&reasons[retry.stop_reason]?`停止原因：${reasons[retry.stop_reason]}`:'该历史记录未保存停止原因。'}</p>}
    {pending&&onCancel&&<button type="button" disabled={cancelling} onClick={()=>void cancel()}>{cancelling?'正在停止…':'停止自动重试'}</button>}
    {error&&<p role="alert">{error}</p>}
  </div>;
}
