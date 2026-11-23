import './SettingsPanel.css';
import {useState} from 'react';
import {ArrowDown,ArrowUp,Trash2} from 'lucide-react';
import {useMutation,useQueryClient} from '@tanstack/react-query';
import {api} from '../lib/api';
import {ConditionGroupEditor} from './ConditionGroupEditor';
import {Dialog} from './Dialog';
import {TableFrame,TableStateRow} from './table/DataTable';
import {TableActionButton} from './table/TableActions';
import {
  MAX_AUTOMATIC_SEND_RULES, SEND_GUARD_ACTION_LABELS,
  type AutomaticSendGuardRule, type SendGuardAction, type SendGuardCondition, type SendGuardGroup, type SendGuardPolicy,
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

function describeConditions(group:SendGuardGroup):string {
  return group.conditions.map(condition=>{
    if('conditions' in condition){
      const summary=describeConditions(condition);
      return condition.conditions.length>1?`（${summary}）`:summary;
    }
    const {label,unit}=conditions[condition.type];
    return `${label} ${condition.value}${unit==='%'?unit:` ${unit}`}`;
  }).join(group.operator==='and'?' 且 ':' 或 ')||'未设置条件';
}

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
  const [editor,setEditor]=useState<{index:number;rule:AutomaticSendGuardRule}|null>(null);
  const rules=policy.automatic_rules??[];
  const editable=canEdit&&!mutation.isPending&&!!value;
  const openRule=(index:number)=>setEditor({index,rule:rules[index]});
  const editorTitle=editor?.index===rules.length?'添加自动规则':`${canEdit?'编辑':'查看'}自动规则 ${(editor?.index??0)+1}`;
  const setRules=(automatic_rules:AutomaticSendGuardRule[])=>setPolicy({...policy,automatic_rules});
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
    <div className="space-y-3">
      <fieldset disabled={!editable} className="space-y-3">
        <label className="flex items-center gap-2 text-xs"><input type="checkbox" checked={policy.enabled} onChange={event=>setPolicy({...policy,enabled:event.target.checked})}/>启用发送保护</label>
        <label className="flex items-center gap-2 text-xs"><input type="checkbox" checked={policy.reminder_enabled!==false} onChange={event=>setPolicy({...policy,reminder_enabled:event.target.checked})}/>启用发送提醒</label>
        {policy.reminder_enabled!==false&&<ConditionGroupEditor<SendGuardCondition> layout="expression" group={policy.conditions} onChange={group=>setPolicy({...policy,conditions:group})}
          title="发送提醒条件" heading="什么时候提醒" makeCondition={makeCondition} renderCondition={renderCondition}
          emptyText="请添加至少一条提醒条件。" help="最多 4 层、50 项。闲置从上一轮结束时开始计算。"/>}
      </fieldset>
      <section aria-label="发送保护自动规则" className="space-y-2">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h4 className="text-sm font-semibold">自动规则</h4>
          <button type="button" className="settings-panel-button" disabled={!editable||rules.length>=MAX_AUTOMATIC_SEND_RULES}
            onClick={()=>setEditor({index:rules.length,rule:{action:'brief',conditions:{operator:'and',conditions:[makeCondition()]}}})}>添加自动规则</button>
        </div>
        <p className="text-xs leading-5" style={{color:'var(--text-secondary)'}}>按表格顺序执行首条命中的规则。操作需要会话空闲和相应权限，未完成时保留草稿。新开和简要压缩在新会话就绪后会永久删除旧会话及 Agent 原始对话文件。</p>
        <TableFrame label="自动规则" fitWidth className="send-guard-rule-table"
          columns={<colgroup><col style={{width:42}}/><col/><col style={{width:'24%'}}/>{canEdit&&<col style={{width:100}}/>}</colgroup>}
          header={<><th scope="col">顺序</th><th scope="col">触发条件</th><th scope="col">执行动作</th>{canEdit&&<th scope="col">操作</th>}</>}>
          {!rules.length&&<TableStateRow columnCount={canEdit?4:3}>暂无自动规则</TableStateRow>}
          {rules.map((rule,index)=>{
            const title=`自动规则 ${index+1}`;
            const summary=describeConditions(rule.conditions);
            return <tr key={index} className="cursor-pointer" onClick={event=>{
              if(!(event.target as Element).closest('button'))openRule(index);
            }}>
              <td>{index+1}</td>
              <td><button type="button" aria-haspopup="dialog" aria-label={`${canEdit?'编辑':'查看'}${title}，${summary}`}
                title={summary} className="w-full rounded text-left whitespace-normal focus-visible:outline-2 focus-visible:outline-[var(--accent)]"
                style={{color:'var(--accent)'}} onClick={()=>openRule(index)}>
                <span className="line-clamp-2 [overflow-wrap:anywhere]">{summary}</span>
              </button></td>
              <td><span className="block whitespace-normal">{SEND_GUARD_ACTION_LABELS[rule.action]}</span>
                {rule.target==='available_account'&&<span className="block whitespace-normal" style={{color:'var(--text-secondary)'}}>切换账号</span>}
              </td>
              {canEdit&&<td>
                <div className="flex gap-1">
                  <TableActionButton aria-label={`上移${title}`} title="上移" disabled={!editable||index===0} onClick={()=>moveRule(index,index-1)}><ArrowUp size={13}/></TableActionButton>
                  <TableActionButton aria-label={`下移${title}`} title="下移" disabled={!editable||index===rules.length-1} onClick={()=>moveRule(index,index+1)}><ArrowDown size={13}/></TableActionButton>
                  <TableActionButton aria-label={`删除${title}`} title="删除" disabled={!editable} onClick={()=>setRules(rules.filter((_,i)=>i!==index))}><Trash2 size={13}/></TableActionButton>
                </div>
              </td>}
            </tr>;
          })}
        </TableFrame>
      </section>
      <button type="button" className="settings-panel-button settings-panel-button--primary" disabled={!editable} onClick={()=>mutation.mutate()}>保存发送保护规则</button>
    </div>
    {editor&&<Dialog title={editorTitle} appearance="manager" width={760} onClose={()=>setEditor(null)}>
      <form className="settings-panel-section space-y-3" onSubmit={event=>{
        event.preventDefault();
        if(!editable)return;
        const next=[...rules];
        next[editor.index]=editor.rule;
        setRules(next);
        setEditor(null);
      }}>
        <fieldset disabled={!editable} className="space-y-3">
          <div className="flex flex-wrap items-center gap-3 text-xs">
            <label className="flex items-center gap-2">执行动作
              <select className="settings-panel-control" style={{width:'auto'}} value={editor.rule.action} onChange={event=>{
                const action=event.target.value as SendGuardAction;
                setEditor({...editor,rule:{...editor.rule,action,target:action==='compact'?undefined:editor.rule.target}});
              }}>
                {Object.entries(SEND_GUARD_ACTION_LABELS).map(([key,label])=><option key={key} value={key}>{label}</option>)}
              </select>
            </label>
            {editor.rule.action!=='compact'&&<label className="flex items-center gap-2">
              <input type="checkbox" checked={editor.rule.target==='available_account'} onChange={event=>{
                setEditor({...editor,rule:{...editor.rule,target:event.target.checked?'available_account':undefined}});
              }}/>
              换到有剩余额度的账号
            </label>}
          </div>
          <ConditionGroupEditor<SendGuardCondition> layout="expression" group={editor.rule.conditions}
            onChange={group=>setEditor({...editor,rule:{...editor.rule,conditions:group}})}
            title="触发条件" heading="触发条件" makeCondition={makeCondition} renderCondition={renderCondition}
            emptyText="请添加至少一条触发条件。" help="最多 4 层、50 项。账号额度条件使用可读取的订阅额度。"/>
        </fieldset>
        <div className="flex flex-wrap justify-end gap-2">
          <button type="button" className="settings-panel-button" onClick={()=>setEditor(null)}>{editable?'取消':'关闭'}</button>
          {editable&&<button type="submit" className="settings-panel-button settings-panel-button--primary"
            disabled={!editor.rule.conditions.conditions.length}>应用到表格</button>}
        </div>
      </form>
    </Dialog>}
    {mutation.error&&<p role="alert" className="mt-2 text-xs" style={{color:'var(--error)'}}>{mutation.error.message}</p>}
    {mutation.isSuccess&&<p role="status" className="mt-2 text-xs" style={{color:'var(--success)'}}>发送保护规则已保存</p>}
  </section>;
}
