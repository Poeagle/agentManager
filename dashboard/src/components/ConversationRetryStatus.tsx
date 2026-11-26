import {useEffect,useState} from 'react';
import {Loader2} from 'lucide-react';
export interface ConversationRetry {
  session_id:string;native_id:string;root_turn_id:string;failed_turn_ids:string[];
  attempt:number;max_attempts:1|3;action?:'quota_handoff';status:'waiting'|'submitting'|'running'|'succeeded'|'exhausted'|'cancelled'|'unknown';
  next_retry_at:string|null;
  stop_reason?:string;
}
const reasons:Record<string,string>={quota_no_account:'没有可确认有额度的其他订阅账号。',quota_handoff_rejected:'换号或接续请求被拒绝，原对话已保留。',quota_brief_failed:'原会话历史暂时不可读。',quota_exhausted:'当前订阅账号额度已用尽。',user_cancelled:'你已停止自动重试。',new_input:'已收到新的用户输入，旧重试计划已取消。',access_changed:'会话绑定或访问权限已变更。',queued_input:'已有排队输入，将优先处理新的输入。',newer_turn:'会话已开始其他执行轮次。',thread_busy:'原生会话仍在执行，未重复启动任务。',thread_unavailable:'当前原生会话不可用。',turn_finished:'原执行轮次已不再处于失败状态。',non_retryable_error:'当前错误不属于可自动重试的临时容量错误。',final_answer:'该轮已给出最终答复。',interrupted:'原生执行已中断。'};
export function ConversationRetryStatus({retry,onCancel}:{retry:ConversationRetry;onCancel?:()=>Promise<void>}) {
  const [now,setNow]=useState(Date.now),[cancelling,setCancelling]=useState(false),[error,setError]=useState('');
  useEffect(()=>{if(retry.status!=='waiting')return;setNow(Date.now());const timer=setInterval(()=>setNow(Date.now()),1000);return ()=>clearInterval(timer);},[retry.status,retry.next_retry_at]);
  const pending=['waiting','submitting','running'].includes(retry.status);
  const attempt=retry.status==='waiting'?retry.attempt+1:retry.attempt;
  const remaining=Math.max(0,Math.ceil((Date.parse(retry.next_retry_at||'')-now)/1000));
  const label=retry.action==='quota_handoff'
    ? pending?'正在简要压缩并切换账号…':retry.status==='succeeded'?'已切换账号并提交接续任务':retry.status==='unknown'?'换号或接续结果待确认':'自动换号已停止'
    : retry.status==='waiting'?`${remaining>0?`${remaining} 秒后`:'即将'}自动重试（${attempt}/3）`:retry.status==='submitting'||retry.status==='running'?`正在自动重试（${attempt}/3）`:retry.status==='succeeded'?`已自动恢复（${attempt}/3）`:retry.status==='exhausted'?'自动重试已达上限（3/3）':retry.status==='unknown'?'提交结果尚未确认，重试已停止':`自动重试已停止（已尝试 ${retry.attempt}/3 次）。`;
  const reason = retry.status === 'cancelled' && retry.stop_reason ? reasons[retry.stop_reason] : undefined;
  async function cancel(){setCancelling(true);setError('');try{await onCancel?.();}catch(failure){setError(failure instanceof Error?failure.message:'停止失败');}finally{setCancelling(false);}}
  return <div className="session-chat-retry-status" role="status" aria-live="polite">
    {pending && <Loader2 size={14} className="session-chat-retry-spinner" aria-hidden="true" />}
    <p title={reason || label}>{retry.action==='quota_handoff'&&reason?`${label} · ${reason}`:label}</p>
    {pending&&onCancel&&<button type="button" disabled={cancelling} onClick={()=>void cancel()}>{cancelling?'正在停止…':retry.action==='quota_handoff'?'取消换号':'停止自动重试'}</button>}
    {error&&<p role="alert">{error}</p>}
  </div>;
}
