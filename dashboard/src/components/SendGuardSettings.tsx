import './SettingsPanel.css';
import {useState} from 'react';
import {useMutation,useQueryClient} from '@tanstack/react-query';
import {api} from '../lib/api';
import {ConditionGroupEditor} from './ConditionGroupEditor';
import {
  MAX_AUTOMATIC_SEND_RULES, SEND_GUARD_ACTION_LABELS,
  type AutomaticSendGuardRule, type SendGuardAction, type SendGuardCondition, type SendGuardPolicy,
} from '../../../server/src/shared/send-guard';

const conditions = {
  context_percent: {label:'窗口占用率 ≥', unit:'%', min:1, max:100, initial:80},
  context_tokens: {label:'上下文 Token ≥', unit:'Token', min:1, max:2000000, initial:100000},
  idle_minutes: {label:'闲置时间 ≥', unit:'分钟', min:1, max:10080, initial:30},
  account_remaining_percent: {label:'账号额度剩余 ≤', unit:'%', min:0, max:99, initial:0},
};
const makeCondition = ():SendGuardCondition => ({type:'context_percent', value:80});
const renderCondition = (rule:SendGuardCondition, change:(next:SendGuardCondition)=>void, label:string) => {
  const field=conditions[rule.type];
  return <>
    <select className="settings-panel-control" aria-label={label} value={rule.type} onChange={event=>{
      const type=event.target.value as SendGuardCondition['type'];
      change({type,value:conditions[type].initial});
    }}>
      {Object.entries(conditions).map(([type,option])=><option key={type} value={type}>{option.label}</option>)}
    </select>
    <label className="flex items-center gap-2">
      <input aria-label={`${label}数值`} className="settings-panel-control" type="number" min={field.min} max={field.max} value={rule.value} onChange={event=>change({...rule,value:Number(event.target.value)})}/>
      <span className="shrink-0 text-xs">{field.unit}</span>
    </label>
  </>;
};

export function SendGuardSettings({value,canEdit}:{value:string|undefined;canEdit:boolean}) {
  const client=useQueryClient();
  const [policy,setPolicy]=useState<SendGuardPolicy>(()=>{
    const fallback:SendGuardPolicy={enabled:false,conditions:{operator:'or',conditions:[]}};
    try{return JSON.parse(value||'null')||fallback;}catch{return fallback;}
  });
  const mutation=useMutation({
    mutationFn:()=>api.settings.update({conversation_send_guard:JSON.stringify(policy)}),
    onSuccess:result=>client.setQueryData(['settings'],{settings:result.settings}),
  });
  const rules=policy.automatic_rules??[];
  const setRules=(automatic_rules:AutomaticSendGuardRule[])=>setPolicy({...policy,automatic_rules});
  const updateRule=(index:number,rule:AutomaticSendGuardRule)=>setRules(rules.map((previous,i)=>i===index?rule:previous));
  const moveRule=(from:number,to:number)=>{
    const ordered=[...rules];
    [ordered[from],ordered[to]]=[ordered[to],ordered[from]];
    setRules(ordered);
  };

  return <section className="settings-panel-section">
    <div className="settings-panel-section-heading">
      <div>
        <h4 className="text-sm font-semibold">发送保护</h4>
        <p className="mt-1 text-xs leading-5" style={{color:'var(--text-secondary)'}}>发送消息前检查上下文、闲置时间和可用额度。先执行首条命中的自动规则，再按提醒条件处理未命中自动规则的消息。</p>
      </div>
    </div>
    {!canEdit&&<p className="mb-3 text-xs" style={{color:'var(--text-muted)'}}>只有管理员可以修改此平台规则。</p>}
    <fieldset disabled={!canEdit||mutation.isPending||!value} className="space-y-3">
      <label className="flex items-center gap-2 text-xs"><input type="checkbox" checked={policy.enabled} onChange={event=>setPolicy({...policy,enabled:event.target.checked})}/>启用发送保护</label>
      <label className="flex items-center gap-2 text-xs"><input type="checkbox" checked={policy.reminder_enabled!==false} onChange={event=>setPolicy({...policy,reminder_enabled:event.target.checked})}/>启用发送提醒</label>
      {policy.reminder_enabled!==false&&<ConditionGroupEditor<SendGuardCondition> layout="expression" group={policy.conditions} onChange={group=>setPolicy({...policy,conditions:group})}
        title="发送提醒条件" heading="什么时候提醒" makeCondition={makeCondition} renderCondition={renderCondition}
        emptyText="请添加至少一条提醒条件。" help="最多 4 层、50 项。闲置从上一轮结束时开始计算。"/>}
      <section aria-label="发送保护自动规则" className="space-y-2">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h4 className="text-sm font-semibold">自动规则</h4>
          <button type="button" className="settings-panel-button" disabled={rules.length>=MAX_AUTOMATIC_SEND_RULES}
            onClick={()=>setRules([...rules,{action:'brief',conditions:{operator:'and',conditions:[makeCondition()]}}])}>添加自动规则</button>
        </div>
        <p className="text-xs leading-5" style={{color:'var(--text-secondary)'}}>按从上到下的顺序执行。操作需要会话空闲和相应权限，未完成时保留草稿。新开和简要压缩在新会话就绪后会永久删除旧会话及 Agent 原始对话文件。</p>
        {rules.map((rule,index)=>{
          const title=`自动规则 ${index+1}`;
          return <section aria-label={title} key={index} className="space-y-1 rounded-md border p-2" style={{borderColor:'var(--border)'}}>
            <div className="flex flex-wrap items-center gap-2 text-xs">
              <label className="flex flex-wrap items-center gap-2">{title}
                <select className="settings-panel-control" aria-label={`${title} 的操作`} value={rule.action} onChange={event=>{
                  const action=event.target.value as SendGuardAction;
                  updateRule(index,{...rule,action,target:action==='compact'?undefined:rule.target});
                }}>
                  {Object.entries(SEND_GUARD_ACTION_LABELS).map(([key,label])=><option key={key} value={key}>{label}</option>)}
                </select>
              </label>
              {rule.action!=='compact'&&<label className="flex items-center gap-2">
                <input type="checkbox" checked={rule.target==='available_account'} onChange={event=>updateRule(index,{...rule,target:event.target.checked?'available_account':undefined})}/>
                换到有剩余额度的账号
              </label>}
              <div className="flex flex-wrap gap-1 sm:ml-auto">
                <button type="button" className="settings-panel-button" aria-label={`上移${title}`} disabled={index===0} onClick={()=>moveRule(index,index-1)}>上移</button>
                <button type="button" className="settings-panel-button" aria-label={`下移${title}`} disabled={index===rules.length-1} onClick={()=>moveRule(index,index+1)}>下移</button>
                <button type="button" className="settings-panel-button" aria-label={`删除${title}`} onClick={()=>setRules(rules.filter((_,i)=>i!==index))}>删除</button>
              </div>
            </div>
            <ConditionGroupEditor<SendGuardCondition> layout="expression" group={rule.conditions} onChange={group=>updateRule(index,{...rule,conditions:group})}
              title={`${title} 条件`} heading="触发条件" makeCondition={makeCondition} renderCondition={renderCondition}
              emptyText="请添加至少一条触发条件。" help="最多 4 层、50 项。账号额度条件使用可读取的订阅额度。"/>
          </section>;
        })}
      </section>
      <button type="button" className="settings-panel-button settings-panel-button--primary" onClick={()=>mutation.mutate()}>保存发送保护规则</button>
    </fieldset>
    {mutation.error&&<p role="alert" className="mt-2 text-xs" style={{color:'var(--error)'}}>{mutation.error.message}</p>}
    {mutation.isSuccess&&<p role="status" className="mt-2 text-xs" style={{color:'var(--success)'}}>发送保护规则已保存</p>}
  </section>;
}
