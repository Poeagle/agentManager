import './SettingsPanel.css';
import {useState} from 'react';
import {ArrowDown,ArrowUp,Trash2} from 'lucide-react';
import {useMutation,useQuery,useQueryClient} from '@tanstack/react-query';
import {api} from '../lib/api';
import {ConditionGroupEditor} from './ConditionGroupEditor';
import {Dialog} from './Dialog';
import {TableFrame,TableStateRow} from './table/DataTable';
import {TableActionButton} from './table/TableActions';
import {
  MAX_AUTOMATIC_SEND_RULES, MAX_REMINDER_SEND_RULES, MAX_SEND_GUARD_PROVIDERS, SEND_GUARD_ACTION_LABELS,
  normalizeSendGuardPolicy, sendGuardProviderKey,
  type SendGuardPolicy, type SendGuardCondition, type SendGuardGroup, type SendGuardRule,
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

const actionLabels = {remind:'发送提醒',...SEND_GUARD_ACTION_LABELS};
const defaultGroup = ():SendGuardGroup => ({operator:'and',conditions:[makeCondition()]});
const orderRules = (rules:SendGuardRule[]) => [
  ...rules.filter(rule=>rule.action!=='remind'),
  ...rules.filter(rule=>rule.action==='remind'),
];

export function SendGuardSettings({value,canEdit}:{value:string|undefined;canEdit:boolean}) {
  const client=useQueryClient();
  const [policy,setPolicy]=useState<SendGuardPolicy>(()=>{
    const fallback:SendGuardPolicy={enabled:false,rules:[]};
    try {
      const parsed=normalizeSendGuardPolicy(JSON.parse(value||'null')||fallback);
      return {...parsed,rules:orderRules(parsed.rules)};
    } catch {return fallback;}
  });
  const mutation=useMutation({
    mutationFn:()=>api.settings.update({conversation_send_guard:JSON.stringify(policy)}),
    onSuccess:result=>client.setQueryData(['settings'],{settings:result.settings}),
  });
  const [editor,setEditor]=useState<{index:number;rule:SendGuardRule}|null>(null);
  const rules=policy.rules;
  const catalog=useQuery({
    queryKey:['agent-management-list'],queryFn:api.agentManagement.list,
    enabled:editor!==null||rules.some(rule=>rule.provider_ids!==undefined),retry:false,
  });
  const providers=new Map<string,string>(catalog.data?.agents.flatMap(({agent,state})=>(state.providers??[]).map(provider=>[
    sendGuardProviderKey(agent.id,provider.id),`${agent.label} · ${provider.name}`,
  ] as const)));
  const providerChoices=new Map(providers);
  for(const id of editor?.rule.provider_ids??[])if(!providerChoices.has(id))providerChoices.set(id,id);
  const editable=canEdit&&!mutation.isPending&&!!value;
  const automaticCount=rules.filter(rule=>rule.action!=='remind').length;
  const canApplyAction=(action:SendGuardRule['action'])=>{
    const reminder=action==='remind';
    const limit=reminder?MAX_REMINDER_SEND_RULES:MAX_AUTOMATIC_SEND_RULES;
    const others=rules.filter((rule,index)=>index!==editor?.index&&(rule.action==='remind')===reminder).length;
    return others<limit;
  };
  const setRules=(rules:SendGuardRule[])=>setPolicy({...policy,rules});
  const titleFor=(index:number)=>index===rules.length?'添加规则':`${canEdit?'编辑':'查看'}规则 ${index+1}`;
  const moveRule=(from:number,to:number)=>{
    const ordered=[...rules];
    [ordered[from],ordered[to]]=[ordered[to],ordered[from]];
    setRules(ordered);
  };
  const canApply=editable&&editor&&editor.rule.conditions.conditions.length>0&&
    editor.rule.provider_ids?.length!==0&&canApplyAction(editor.rule.action);

  return <section className="settings-panel-section">
    <div className="settings-panel-section-heading">
      <div>
        <h4 className="text-sm font-semibold">发送保护</h4>
        <p className="mt-1 text-xs leading-5" style={{color:'var(--text-secondary)'}}>发送前按当前 Provider 检查规则。首条命中的自动规则优先执行，任一适用的提醒规则命中时弹出提醒。</p>
      </div>
    </div>
    {!canEdit&&<p className="mb-3 text-xs" style={{color:'var(--text-muted)'}}>只有管理员可以修改此平台规则。</p>}
    <div className="space-y-3">
      <fieldset disabled={!editable} className="flex flex-wrap items-center gap-x-4 gap-y-2 text-xs">
        <label className="flex items-center gap-2"><input type="checkbox" checked={policy.enabled} onChange={event=>setPolicy({...policy,enabled:event.target.checked})}/>启用发送保护</label>
        <label className="flex items-center gap-2"><input type="checkbox" checked={policy.reminder_enabled!==false} onChange={event=>setPolicy({...policy,reminder_enabled:event.target.checked})}/>启用发送提醒</label>
        <button type="button" className="settings-panel-button sm:ml-auto" disabled={rules.length>=MAX_REMINDER_SEND_RULES+MAX_AUTOMATIC_SEND_RULES}
          onClick={()=>setEditor({index:rules.length,rule:{action:'remind',conditions:defaultGroup()}})}>添加规则</button>
      </fieldset>
      <TableFrame label="发送保护规则" fitWidth className="send-guard-rule-table"
        columns={<colgroup><col style={{width:42}}/><col style={{width:'22%'}}/><col/><col style={{width:'21%'}}/>{canEdit&&<col style={{width:90}}/>}</colgroup>}
        header={<><th scope="col">顺序</th><th scope="col">Provider</th><th scope="col">触发条件</th><th scope="col">执行动作</th>{canEdit&&<th scope="col">操作</th>}</>}>
        {!rules.length&&<TableStateRow columnCount={canEdit?5:4}>暂无发送保护规则</TableStateRow>}
        {rules.map((rule,index)=>{
          const automatic=rule.action!=='remind';
          const title=`规则 ${index+1}`;
          const summary=describeConditions(rule.conditions);
          const providerSummary=rule.provider_ids?.map(id=>providers.get(id)??id).join('、')??'全部 Provider';
          const open=()=>setEditor({index,rule});
          return <tr key={index} className="cursor-pointer" onClick={event=>{
            if(!(event.target as Element).closest('button'))open();
          }}>
            <td>{automatic?index+1:'—'}</td>
            <td><span className="line-clamp-2 whitespace-normal [overflow-wrap:anywhere]" title={providerSummary}>{providerSummary}</span></td>
            <td><button type="button" aria-haspopup="dialog" aria-label={`${titleFor(index)}，${summary}`}
              title={summary} className="w-full rounded text-left whitespace-normal focus-visible:outline-2 focus-visible:outline-[var(--accent)]"
              style={{color:'var(--accent)'}} onClick={open}>
              <span className="line-clamp-2 [overflow-wrap:anywhere]">{summary}</span>
            </button></td>
            <td><span className="block whitespace-normal">{actionLabels[rule.action]}</span>
              {rule.target==='available_account'&&<span className="block whitespace-normal" style={{color:'var(--text-secondary)'}}>切换账号</span>}
              {!automatic&&policy.reminder_enabled===false&&<span style={{color:'var(--text-secondary)'}}>已停用</span>}
            </td>
            {canEdit&&<td><div className="flex gap-1">
              {automatic&&<>
                <TableActionButton aria-label={`上移${title}`} title="上移" disabled={!editable||index===0} onClick={()=>moveRule(index,index-1)}><ArrowUp size={13}/></TableActionButton>
                <TableActionButton aria-label={`下移${title}`} title="下移" disabled={!editable||index>=automaticCount-1} onClick={()=>moveRule(index,index+1)}><ArrowDown size={13}/></TableActionButton>
              </>}
              <TableActionButton aria-label={`删除${title}`} title="删除" disabled={!editable}
                onClick={()=>setRules(rules.filter((_,i)=>i!==index))}><Trash2 size={13}/></TableActionButton>
            </div></td>}
          </tr>;
        })}
      </TableFrame>
      <p className="text-xs leading-5" style={{color:'var(--text-secondary)'}}>自动操作需要会话空闲和相应权限，未完成时保留草稿。新开和简要压缩在新会话就绪后会永久删除旧会话及 Agent 原始对话文件。</p>
      <button type="button" className="settings-panel-button settings-panel-button--primary" disabled={!editable} onClick={()=>mutation.mutate()}>保存发送保护规则</button>
    </div>
    {editor&&<Dialog title={titleFor(editor.index)} appearance="manager" size="lg" width={760} onClose={()=>setEditor(null)}>
      <form className="settings-panel-section space-y-3" onSubmit={event=>{
        event.preventDefault();
        if(!canApply)return;
        const next=[...rules];
        next[editor.index]=editor.rule;
        setRules(orderRules(next));
        setEditor(null);
      }}>
        <fieldset disabled={!editable} className="space-y-3">
          <div className="flex flex-wrap items-center gap-3 text-xs">
            <label className="flex items-center gap-2">Provider 范围
              <select className="settings-panel-control" style={{width:'auto'}} value={editor.rule.provider_ids?'selected':'all'}
                onChange={event=>setEditor({...editor,rule:{...editor.rule,provider_ids:event.target.value==='all'?undefined:[]}})}>
                <option value="all">全部 Provider</option>
                <option value="selected">指定 Provider</option>
              </select>
            </label>
            <label className="flex items-center gap-2">执行动作
              <select className="settings-panel-control" style={{width:'auto'}} value={editor.rule.action} onChange={event=>{
                const action=event.target.value as SendGuardRule['action'];
                const target=action==='new'||action==='brief'?editor.rule.target:undefined;
                setEditor({...editor,rule:{...editor.rule,action,target}});
              }}>
                {Object.entries(actionLabels).map(([key,label])=><option key={key} value={key}>{label}</option>)}
              </select>
            </label>
            {(editor.rule.action==='brief'||editor.rule.action==='new')&&<label className="flex items-center gap-2">
              <input type="checkbox" checked={editor.rule.target==='available_account'} onChange={event=>{
                setEditor({...editor,rule:{...editor.rule,target:event.target.checked?'available_account':undefined}});
              }}/>
              换到有剩余额度的账号
            </label>}
          </div>
          {editor.rule.provider_ids&&<fieldset className="rounded border px-2 pb-2" style={{borderColor:'var(--border)'}}>
            <legend className="px-1 text-xs">适用 Provider（可多选）</legend>
            {!providerChoices.size&&<p className="text-xs">{catalog.isPending?'正在读取 Provider…':'没有可选择的 Provider'}</p>}
            <div className="flex max-h-40 flex-wrap items-center gap-x-4 gap-y-2 overflow-y-auto text-xs">
              {[...providerChoices].map(([id,label])=>{
                const ids=editor.rule.provider_ids!;
                const selected=ids.includes(id);
                return <label key={id} className="flex min-w-0 items-center gap-2 [overflow-wrap:anywhere]">
                  <input type="checkbox" checked={selected} disabled={!selected&&ids.length>=MAX_SEND_GUARD_PROVIDERS}
                    onChange={event=>setEditor({...editor,rule:{...editor.rule,provider_ids:event.target.checked?[...ids,id]:ids.filter(item=>item!==id)}})}/>
                  {label}
                </label>;
              })}
            </div>
            {catalog.isError&&<p role="alert" className="text-xs" style={{color:'var(--error)'}}>Provider 列表加载失败</p>}
          </fieldset>}
          <ConditionGroupEditor<SendGuardCondition> layout="expression" group={editor.rule.conditions}
            onChange={conditions=>setEditor({...editor,rule:{...editor.rule,conditions}})}
            title="触发条件" heading="触发条件" makeCondition={makeCondition} renderCondition={renderCondition}
            emptyText="请添加至少一条触发条件。" help="最多 4 层、50 项。闲置从上一轮结束时开始计算。"/>
        </fieldset>
        {editable&&!canApplyAction(editor.rule.action)&&<p role="alert" className="text-xs" style={{color:'var(--error)'}}>此类规则已达到数量上限。</p>}
        <div className="flex flex-wrap justify-end gap-2">
          <button type="button" className="settings-panel-button" onClick={()=>setEditor(null)}>{editable?'取消':'关闭'}</button>
          {editable&&<button type="submit" className="settings-panel-button settings-panel-button--primary" disabled={!canApply}>应用到表格</button>}
        </div>
      </form>
    </Dialog>}
    {mutation.error&&<p role="alert" className="mt-2 text-xs" style={{color:'var(--error)'}}>{mutation.error.message}</p>}
    {mutation.isSuccess&&<p role="status" className="mt-2 text-xs" style={{color:'var(--success)'}}>发送保护规则已保存</p>}
  </section>;
}
