import {useId,useRef,useState} from 'react';
import {useQuery} from '@tanstack/react-query';
import {Bot,CheckCircle2,Code2,Globe,RefreshCw,Terminal,AlertCircle} from 'lucide-react';
import {fetchJSON} from '../lib/api';
import type {AiSource,AiClientDiscovery} from '../lib/ai-source';
import './AiSourceFields.css';
const sources=[{kind:'codex',name:'Codex',description:'使用服务器登录',Icon:Bot},{kind:'claude',name:'Claude',description:'使用服务器登录',Icon:Terminal},{kind:'api',name:'外部 API',description:'连接模型服务',Icon:Globe},{kind:'command',name:'自定义适配器',description:'其他已接入程序',Icon:Code2}] as const;
export function AiSourceFields({value,onChange,disabled=false,model,onModelChange}:{value?:AiSource;onChange:(value:AiSource,defaultModel?:string)=>void;disabled?:boolean;model?:string;onModelChange?:(model:string)=>void}) {
 const source=value||{kind:'api'},force=useRef(false),group=useId(),[manualFor,setManualFor]=useState<string|null>(null);
 const query=useQuery({queryKey:['ai-sources','discovery'],queryFn:({signal})=>{const refresh=force.current;force.current=false;return fetchJSON<{clients:AiClientDiscovery[]}>(`/ai-sources${refresh?'?refresh=true':''}`,{signal});},staleTime:60000,retry:false,refetchOnWindowFocus:false});
 const client=query.data?.clients.find(client=>client.kind===source.kind),local=source.kind==='codex'||source.kind==='claude',clientModels=client?.models||[];
 const custom=!!source.executable?.trim()&&source.executable!==source.kind&&source.executable!==client?.executable;
 const manual=manualFor===source.kind||!!(client&&model&&!clientModels.some(item=>item.id===model));
 const login=client?.login==='detected',credentials=client?.credential_source==='environment'?'已检测到服务器 API 凭据':'已检测到本地登录信息';
 const changeKind=(kind:AiSource['kind'])=>{setManualFor(null);onChange({kind},query.data?.clients.find(client=>client.kind===kind)?.default_model||'');};
 const connectionFields=<div className="ai-source-advanced-fields">
  {client?.executable&&<p className="ai-source-path">程序路径：{client.executable}</p>}
  {client?.default_model&&<p className="ai-source-help">本机配置模型：{client.default_model}</p>}
  <label className="ai-source-field">{source.kind==='command'?'适配器程序路径':'自定义客户端路径'}<input aria-label="AI 程序路径" disabled={disabled} value={source.executable||''} placeholder={source.kind==='command'?'/path/to/adapter':client?.executable||source.kind} onChange={event=>onChange({...source,executable:event.target.value})}/></label>
  {source.kind==='command'&&<><label className="ai-source-field">程序参数（JSON 数组）<textarea aria-label="AI 程序参数" disabled={disabled} value={source.arguments_json||'[]'} onChange={event=>onChange({...source,arguments_json:event.target.value})}/></label><label className="ai-source-field">适配器登录来源<select aria-label="适配器登录来源" disabled={disabled} value={source.credential_profile||'none'} onChange={event=>onChange({...source,credential_profile:event.target.value as AiSource['credential_profile']})}><option value="none">不提供账号凭据</option><option value="codex">仅 Codex 当前访问凭据</option><option value="claude">仅 Claude 当前访问凭据</option></select></label></>}
  <label className="ai-source-field">额外模型域名<input aria-label="额外模型域名" disabled={disabled} value={source.allowed_hosts_json||'[]'} onChange={event=>onChange({...source,allowed_hosts_json:event.target.value})}/></label>
  <p className="ai-source-help">官方模型域名已内置。其他域名填写 JSON 数组。自定义程序不会自动执行，需通过测试确认。</p>
 </div>;
 return <div className="ai-source-fields"><fieldset className="ai-source-picker"><legend>AI 来源</legend><div className="ai-source-options">{sources.map(({kind,name,description,Icon})=><label key={kind} className="ai-source-option" data-selected={source.kind===kind}><input type="radio" name={group} value={kind} checked={source.kind===kind} disabled={disabled} onChange={()=>changeKind(kind)}/><Icon size={18}/><span><strong>{name}</strong><small>{description}</small></span>{source.kind===kind&&<CheckCircle2 size={14} className="ai-source-check"/>}</label>)}</div></fieldset>
 {local&&<section aria-label="客户端自动探测" className="ai-source-status">
  <div className="ai-source-status-heading"><strong>{query.isFetching?'正在探测客户端…':client?.installed?`已找到 ${client.kind}${client.version?' '+client.version:''}`:'客户端自动探测'}</strong><button type="button" disabled={disabled||query.isFetching} onClick={()=>{force.current=true;void query.refetch();}}><RefreshCw size={13} className={query.isFetching?'animate-spin':''}/>重新探测</button></div>
  {query.isError?<p role="status" className="ai-source-warning">探测暂不可用，可重新探测或手动填写配置。</p>:client&&<>
   <div className="ai-source-status-tags"><span data-ok={client.installed}>{client.installed?<CheckCircle2 size={13}/>:<AlertCircle size={13}/>}{client.installed?'程序已找到':'客户端未安装'}</span><span data-ok={login}>{login?<CheckCircle2 size={13}/>:<AlertCircle size={13}/>}{login?credentials:client.login==='expired'?'登录信息已过期':'未检测到登录信息'}</span></div>
   {!client.installed&&<p className="ai-source-help">未找到默认客户端，不会自动安装。</p>}
   {custom&&<p className="ai-source-warning">正在使用自定义程序路径，自动探测结果仅供参考。</p>}
  </>}
 </section>}
 {local&&onModelChange&&<div className="ai-source-model"><label className="ai-source-field">模型<select aria-label="客户端模型" disabled={disabled} value={manual?'__custom__':model||''} onChange={event=>{const next=event.target.value;if(next==='__custom__'){setManualFor(source.kind);if(clientModels.some(item=>item.id===model))onModelChange('');}else{setManualFor(null);onModelChange(next);}}}><option value="">使用客户端默认模型</option>{clientModels.map(item=><option key={item.id} value={item.id}>{item.name===item.id?item.id:`${item.name} · ${item.id}`}</option>)}<option value="__custom__">手动输入模型名称…</option></select></label>
   {manual&&<label className="ai-source-field ai-source-custom-model">模型名称<input aria-label="模型名称" disabled={disabled} value={model||''} onChange={event=>onModelChange(event.target.value)} placeholder="输入完整模型 ID"/></label>}
   <p className="ai-source-help">{manual?'当前使用自定义模型名称，请测试后保存。':clientModels.length?`已发现 ${clientModels.length} 个模型候选，来自本机配置与客户端缓存。`:'留空由客户端选择默认模型，也可手动输入模型名称。'}</p>
 </div>}
 {local?<details className="ai-source-advanced"><summary>高级设置：程序路径与额外域名</summary>{connectionFields}<p className="ai-source-help">探测只读本机记录，不调用模型或刷新登录。运行时沿用既有沙箱与工具权限。</p></details>:source.kind==='command'?<><p className="ai-source-help">程序按 octoally.ai.v1 协议接入，平台操作仍由现有权限校验。</p>{connectionFields}</>:null}
 </div>;
}
