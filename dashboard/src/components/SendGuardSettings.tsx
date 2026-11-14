import './SettingsPanel.css';
import {useState} from 'react';
import {useMutation,useQueryClient} from '@tanstack/react-query';
import {api} from '../lib/api';
import {ConditionGroupEditor,type ConditionGroup} from './ConditionGroupEditor';
type Rule={type:'context_percent'|'context_tokens'|'idle_minutes';value:number};
interface Policy {enabled:boolean;conditions:ConditionGroup<Rule>}
export function SendGuardSettings({value,canEdit}:{value:string|undefined;canEdit:boolean}){
 const client=useQueryClient();
 const [policy,setPolicy]=useState<Policy>(()=>{try{return JSON.parse(value||'null')||{enabled:false,conditions:{operator:'or',conditions:[]}};}catch{return {enabled:false,conditions:{operator:'or',conditions:[]}};}});
 const mutation=useMutation({mutationFn:()=>api.settings.update({conversation_send_guard:JSON.stringify(policy)}),onSuccess:result=>client.setQueryData(['settings'],{settings:result.settings})});
 return <section className="settings-panel-section"><div className="settings-panel-section-heading"><div><h4 className="text-sm font-semibold">发送保护</h4><p className="mt-1 text-xs leading-5" style={{color:'var(--text-secondary)'}}>发送新消息前检查上下文和闲置时间，提示保留原会话、压缩或新开会话。条件用于风险提醒，不代表缓存已过期。</p></div></div>
 {!canEdit&&<p className="mb-3 text-xs" style={{color:'var(--text-muted)'}}>只有管理员可以修改此平台规则。</p>}
 <fieldset disabled={!canEdit||mutation.isPending||!value} className="space-y-3"><label className="flex items-center gap-2 text-xs"><input type="checkbox" checked={policy.enabled} onChange={e=>setPolicy({...policy,enabled:e.target.checked})}/>启用发送前上下文检查</label>
 <ConditionGroupEditor<Rule> group={policy.conditions} onChange={conditions=>setPolicy({...policy,conditions})} title="发送提醒条件" heading="什么时候提醒" makeCondition={()=>({type:'context_percent',value:80})} emptyText="请添加至少一条提醒条件。" help="支持且／或嵌套分组，最多 4 层、50 项。上轮仍在运行时，闲置时间保持未知。"
 renderCondition={(rule,change,label)=><><select className="settings-panel-control" aria-label={label} value={rule.type} onChange={e=>{const type=e.target.value as Rule['type'];change({type,value:type==='idle_minutes'?30:type==='context_tokens'?100000:80});}}><option value="context_percent">窗口占用率 ≥</option><option value="context_tokens">上下文 Token ≥</option><option value="idle_minutes">上轮结束后闲置 ≥</option></select><label className="flex items-center gap-2"><input aria-label={`${label}数值`} className="settings-panel-control" type="number" min={1} max={rule.type==='context_percent'?100:rule.type==='idle_minutes'?10080:2000000} value={rule.value} onChange={e=>change({...rule,value:Number(e.target.value)})}/><span className="shrink-0 text-xs">{rule.type==='context_percent'?'%':rule.type==='idle_minutes'?'分钟':'Token'}</span></label></>}/>
 <button type="button" className="settings-panel-button settings-panel-button--primary" onClick={()=>mutation.mutate()}>保存发送保护规则</button></fieldset>
 {mutation.error&&<p role="alert" className="mt-2 text-xs" style={{color:'var(--error)'}}>{mutation.error.message}</p>}{mutation.isSuccess&&<p role="status" className="mt-2 text-xs" style={{color:'var(--success)'}}>发送保护规则已保存</p>}
 </section>;
}
