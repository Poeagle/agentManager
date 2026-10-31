import {useEffect,useState} from 'react';
import {useQuery,useQueryClient} from '@tanstack/react-query';
import {ChevronDown,Info,RefreshCw} from 'lucide-react';
import {api,type ConversationControlsData} from '../lib/api';
import {Dialog} from './Dialog';

const effortNames:Record<string,string>={none:'无',minimal:'最低',low:'低',medium:'中',high:'高',xhigh:'更高',max:'最高',ultra:'极高'};
const number=(value:number|null|undefined)=>value==null?'未提供':value.toLocaleString('zh-CN');
const compact=(value:number)=>new Intl.NumberFormat('en',{notation:'compact',maximumFractionDigits:1}).format(value);
const stamp=(value:string|null)=>value?new Date(value).toLocaleString('zh-CN',{hour12:false}):'未提供';
const permissions:Record<string,string>={'danger-full-access':'完整访问','workspace-write':'工作区可写','read-only':'只读'};
export function ConversationControls({sessionId,active}:{sessionId:string;active:boolean}) {
  const queryClient=useQueryClient(),[expanded,setExpanded]=useState(false),[saving,setSaving]=useState(false),[error,setError]=useState('');
  const query=useQuery({queryKey:['conversation-controls',sessionId],queryFn:()=>api.agent.controls(sessionId),enabled:active,refetchInterval:active?5000:false,retry:false});
  useEffect(()=>{if(!active)setExpanded(false);},[active]);
  const data=query.data,selected=data?.pending||{model:data?.model||'',effort:data?.effort||''};
  const model=data?.models.find(m=>m.model===selected.model),usage=data?.usage;
  const context=usage?.window&&usage.last.total_tokens!=null?Math.min(100,Math.round(100*usage.last.total_tokens/usage.window)):null;
  const weekly=data?.limits.find(limit=>limit.minutes>=6*24*60);
  async function save(value:{model:string;effort:string}|null) {
    if(saving)return;setSaving(true);setError('');
    try {const result=await api.agent.setControls(sessionId,value);queryClient.setQueryData<ConversationControlsData>(['conversation-controls',sessionId],previous=>previous?{...previous,pending:result.pending}:previous);}
    catch(failure){setError(failure instanceof Error?failure.message:'设置失败，请重试');}
    finally{setSaving(false);}
  }
  return <div className="conversation-controls-wrap">
    <div className="conversation-controls" aria-label="模型和会话信息">
      {data?<>
        <label className="conversation-control-select"><span>模型</span><select aria-label="选择模型" value={selected.model} disabled={!data.can_edit||saving} title={model?.description||(!data.can_edit?'此会话暂不可切换模型，可查看原始终端':undefined)} onChange={event=>{const next=data.models.find(m=>m.model===event.target.value);if(next)void save({model:next.model,effort:next.efforts.some(e=>e.value===selected.effort)?selected.effort:next.defaultEffort});}}>
          {!model&&<option value={selected.model}>{selected.model||'未提供'}</option>}{data.models.map(m=><option key={m.model} value={m.model}>{m.name}</option>)}
        </select><ChevronDown size={12}/></label>
        <label className="conversation-control-select"><span>强度</span><select aria-label="选择推理强度" value={selected.effort} disabled={!data.can_edit||!model||saving} onChange={event=>void save({model:selected.model,effort:event.target.value})}>
          {!model?.efforts.some(e=>e.value===selected.effort)&&<option value={selected.effort}>{selected.effort||'未提供'}</option>}{model?.efforts.map(e=><option key={e.value} value={e.value}>{effortNames[e.value]||e.value}（{e.value}）</option>)}
        </select><ChevronDown size={12}/></label>
        {data.pending&&<span className="conversation-control-pending" title="下次开始新任务时生效；进行中的任务和追问继续使用当前设置。">下轮生效 <button type="button" disabled={saving} onClick={()=>void save(null)}>撤销</button></span>}
        {context!==null&&<span className="conversation-control-context" title="最近一次模型请求的 Token 数占上下文窗口的比例，下一次请求可能变化。"><i><b style={{width:`${context}%`}}/></i>上下文 {context}%</span>}
        {weekly&&<span title={weekly.resets_at?`重置时间：${new Date(weekly.resets_at*1000).toLocaleString('zh-CN',{hour12:false})}`:undefined}>周额度剩余 {Math.round(100-weekly.used_percent)}%</span>}
        <button className="conversation-control-details" type="button" onClick={()=>setExpanded(true)}><Info size={13}/>详情</button>
      </>:<><span>{query.isPending?'读取会话信息…':'会话信息暂不可用'}</span>{query.isError&&<button type="button" onClick={()=>void query.refetch()}><RefreshCw size={13}/>重试</button>}</>}
    </div>
    {error&&<p className="session-chat-error" role="alert">{error}</p>}
    {expanded&&data&&<ControlDetails data={data} onClose={()=>setExpanded(false)} onRefresh={()=>void query.refetch()} refreshing={query.isFetching}/>}
  </div>;
}
function ControlDetails({data,onClose,onRefresh,refreshing}:{data:ConversationControlsData;onClose:()=>void;onRefresh:()=>void;refreshing:boolean}) {
  const fields=[['当前模型',data.model],['当前推理强度',data.effort?`${effortNames[data.effort]||data.effort}（${data.effort}）`:null],['模型服务',data.provider],['访问权限',data.permission?permissions[data.permission]||data.permission:null],['执行确认',data.approval==='never'?'无需逐次确认':data.approval],['服务层级',data.service_tier],['工作目录',data.cwd],['当前分支',data.git?.branch],['工作区状态',data.git?data.git.changes?`${data.git.changes} 项变更`:'无变更':null],['会话状态',data.state==='active'?'执行中':data.state==='idle'?'等待输入':data.state==='notLoaded'?'未接入实时控制':data.state],['Codex 服务版本',data.engine_version],['会话创建版本',data.cli_version],['原生会话编号',data.native_id]];
  return <Dialog title="会话详情" size="lg" onClose={onClose} actions={<button className="conversation-preview-dock" type="button" onClick={onRefresh} disabled={refreshing}><RefreshCw size={14} className={refreshing?'animate-spin':''}/>刷新</button>}>
    {data.pending&&<p className="conversation-controls-note">下次新任务：{data.pending.model} · {data.pending.effort}。当前运行保持现有设置。</p>}
    {data.warning&&<p role="status" className="conversation-controls-note">{data.warning}</p>}
    {!data.can_edit&&<p className="conversation-controls-note">当前显示只读信息。可在原始终端查看或修改该会话支持的设置。</p>}
    <dl className="conversation-controls-details">{fields.map(([label,value])=><div key={label}><dt>{label}</dt><dd>{value||'未提供'}</dd></div>)}</dl>
    <h4 className="conversation-controls-heading">Token 用量</h4>
    <p className="conversation-controls-note">上下文窗口 {number(data.usage?.window)} Token；最近一次用量记录：{stamp(data.usage_observed_at)}。累计用量包含此前请求，可能超过窗口容量。</p>
    <table className="conversation-controls-tokens"><thead><tr><th>指标</th><th>最近一次请求</th><th>会话累计</th></tr></thead><tbody>{[['总量','total_tokens'],['输入','input_tokens'],['缓存命中输入','cached_input_tokens'],['输出','output_tokens'],['推理输出','reasoning_output_tokens']].map(([label,key])=><tr key={key}><th>{label}</th><td>{number(data.usage?.last[key])}</td><td>{number(data.usage?.total[key])}</td></tr>)}</tbody></table>
    {data.limits.length>0&&<><h4 className="conversation-controls-heading">可用额度</h4><ul className="conversation-controls-limits">{data.limits.map((limit,index)=><li key={index}><strong>{limit.minutes>=6*24*60?'周额度':limit.minutes>=60?`${compact(limit.minutes/60)} 小时额度`:`${limit.minutes} 分钟额度`}</strong><span>剩余 {Math.round(100-limit.used_percent)}%</span><span>{limit.resets_at?`重置：${new Date(limit.resets_at*1000).toLocaleString('zh-CN',{hour12:false})}`:'未提供重置时间'}</span></li>)}</ul></>}
    <p className="conversation-controls-note">信息读取时间：{stamp(data.checked_at)}。未提供的数据不作估算。</p>
  </Dialog>;
}
