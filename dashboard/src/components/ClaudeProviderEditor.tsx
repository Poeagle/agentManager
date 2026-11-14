import {useState} from 'react';
import {useMutation,useQueryClient} from '@tanstack/react-query';
import {Check,CircleAlert,Loader2,Plus,Save,Search,Trash2} from 'lucide-react';
import {api,type AgentManagementState,type AgentProviderState} from '../lib/api';

type Draft={id:string;name:string;baseUrl:string;apiKey:string;models:string[];defaultModel:string;contextWindow:string;maxOutputTokens:string};
const empty=():Draft=>({id:'',name:'',baseUrl:'',apiKey:'',models:[],defaultModel:'',contextWindow:'',maxOutputTokens:''});
const field=(provider:AgentProviderState,key:string)=>String(provider.fields.find(item=>item.key===key)?.value??'');
const fromProvider=(provider:AgentProviderState):Draft=>({id:provider.id,name:provider.name,baseUrl:field(provider,'baseUrl'),apiKey:'',models:provider.models,defaultModel:provider.defaultModel||'',contextWindow:field(provider,'contextWindow'),maxOutputTokens:field(provider,'maxOutputTokens')});
const statusLabel:Record<string,string>={ready:'正常',warning:'需配置',error:'异常',unavailable:'不可用',unknown:'待检测'};
const statusTone=(status:string)=>status==='ready'?'ready':status==='error'?'error':status==='warning'?'warning':'unknown';

export function ClaudeProviderEditor({provider,readOnly,onSaved,onCancel,onDirtyChange}:{provider?:AgentProviderState;readOnly:boolean;onSaved:(id?:string)=>void;onCancel?:()=>void;onDirtyChange?:(dirty:boolean)=>void}){
 const client=useQueryClient(),[draft,setDraft]=useState<Draft>(()=>provider?fromProvider(provider):empty());
 const [detected,setDetected]=useState<string[]>(provider?.models||[]),[error,setError]=useState(''),[saved,setSaved]=useState(false),[confirmDelete,setConfirmDelete]=useState(false);
 const original=provider?fromProvider(provider):empty();
 const dirty=JSON.stringify(draft)!==JSON.stringify(original)||!!confirmDelete;
 const change=(patch:Partial<Draft>)=>{setSaved(false);setError('');onDirtyChange?.(true);setDraft(previous=>({...previous,...patch}));};
 const updateState=(result:{state:AgentManagementState})=>{client.setQueryData(['agent-management','claude'],result);void client.invalidateQueries({queryKey:['agent-management-list']});void client.invalidateQueries({queryKey:['session-environments']});};
 const detect=useMutation({mutationFn:()=>api.agentManagement.detectModels('claude',{endpoint:draft.baseUrl.trim(),apiKey:draft.apiKey.trim()||undefined,providerId:provider?.id}),onSuccess:result=>{
  const models=[...new Set(result.models.map(item=>item.model))];
  setDetected(models);
  setDraft(previous=>{
    const selected=previous.models.filter(model=>models.includes(model));
    const next=selected.length?selected:models;
    return {...previous,models:next,defaultModel:models.includes(previous.defaultModel)?previous.defaultModel:next[0]||''};
  });
  onDirtyChange?.(true);
 },onError:(failure:Error)=>setError(failure.message)});
 const refreshSessionControls=()=>{
  void client.invalidateQueries({queryKey:['conversation-controls']});
  void client.invalidateQueries({queryKey:['session-environments']});
 };
 const save=useMutation<{state:AgentManagementState},Error,void>({mutationFn:()=>{
  if(!provider&&!draft.id.trim())throw Error('请填写 Provider ID');
  if(!draft.baseUrl.trim())throw Error('请填写 API 地址');
  if(!provider&&!draft.apiKey.trim())throw Error('请填写 API Key');
  if(!draft.models.length)throw Error('请至少选择一个模型');
  const fields={baseUrl:draft.baseUrl.trim(),models:draft.models,defaultModel:draft.defaultModel||draft.models[0]||'',contextWindow:draft.contextWindow.trim(),maxOutputTokens:draft.maxOutputTokens.trim()};
  const input={name:draft.name.trim()||draft.id.trim(),kind:provider?.kind||'anthropic-compatible',enabled:provider?.enabled??true,...draft.apiKey.trim()?{apiKey:draft.apiKey.trim()}:{},fields};
  return provider?api.agentManagement.updateProvider('claude',provider.id,input):api.agentManagement.createProvider('claude',{...input,id:draft.id.trim()});
 },onSuccess:result=>{updateState(result);refreshSessionControls();setSaved(true);setError('');onDirtyChange?.(false);onSaved(provider?.id||draft.id.trim());},onError:(failure:Error)=>setError(failure.message)});
 const remove=useMutation({mutationFn:()=>api.agentManagement.deleteProvider('claude',provider!.id),onSuccess:result=>{updateState(result);setConfirmDelete(false);onDirtyChange?.(false);onSaved(undefined);},onError:(failure:Error)=>setError(failure.message)});
 const toggle=useMutation({mutationFn:(enabled:boolean)=>api.agentManagement.providerAction('claude',provider!.id,enabled?'enable':'disable'),onSuccess:updateState,onError:(failure:Error)=>setError(failure.message)});
 const busy=save.isPending||remove.isPending||toggle.isPending||detect.isPending;
 return <form className="claude-provider-editor" aria-label="Claude Provider 配置" onSubmit={event=>{event.preventDefault();if(!readOnly&&!busy){setError('');save.mutate();}}}>
  {onCancel&&<button type="button" className="agent-management-button claude-provider-back" disabled={busy} onClick={onCancel}>返回详情</button>}
  <header className="claude-provider-editor-heading">
   <div><div className="flex items-center gap-2"><h3>{provider?provider.name:'添加提供商'}</h3>{provider&&<span className={`agent-management-pill ${statusTone(provider.status)}`}>{statusLabel[provider.status]||provider.status}</span>}</div><p>{provider?provider.statusText:'配置 Anthropic 兼容提供商；密钥只加密保存在本机。'}</p></div>
   <div className="agent-management-status-row">{!readOnly&&provider&&<button type="button" className="agent-management-button" disabled={busy||!dirty} onClick={()=>{setError('');save.mutate();}}>{save.isPending?<Loader2 size={13} className="animate-spin"/>:<Save size={13}/>}保存</button>}</div>
  </header>
  <section className="agent-management-section agent-management-engine-settings">
   <div className="agent-management-section-title"><h4>连接配置</h4><span className="agent-management-section-badge">{provider?.authentication.status==='authenticated'?'API 凭据已配置':'API 凭据未配置'}</span></div>
   <div className="agent-management-form agent-management-engine-form">
    {!provider&&<label className="agent-management-field"><span>提供商 ID<b>*</b></span><input aria-label="Claude Provider ID" autoFocus value={draft.id} placeholder="例如 xindu" disabled={readOnly||busy} onChange={event=>change({id:event.target.value.toLowerCase().replace(/[^a-z0-9_.-]/g,'')})}/></label>}
    <label className="agent-management-field"><span>显示名称</span><input aria-label="Claude Provider 名称" value={draft.name} placeholder="例如 Xindu" disabled={readOnly||busy} onChange={event=>change({name:event.target.value})}/></label>
    <label className="agent-management-field agent-management-field-baseUrl"><span>API 地址<b>*</b></span><input aria-label="Claude API 地址" inputMode="url" value={draft.baseUrl} placeholder="https://gateway.example" disabled={readOnly||busy} onChange={event=>{change({baseUrl:event.target.value});setDetected([]);}}/><small>Anthropic 兼容网关根地址，不要填写 `/v1/messages`。</small></label>
    <label className="agent-management-field"><span>API Key{provider?.authentication.status==='authenticated'&&<small className="agent-management-configured">已配置</small>}{!provider&&<b>*</b>}</span><input aria-label="Claude API Key" type="password" autoComplete="new-password" value={draft.apiKey} placeholder={provider?.authentication.status==='authenticated'?'留空保持不变':'输入 API Key'} disabled={readOnly||busy} onChange={event=>change({apiKey:event.target.value})}/></label>
    <label className="agent-management-field"><span>上下文窗口</span><input aria-label="Claude 上下文窗口" inputMode="numeric" value={draft.contextWindow} placeholder="可选，例如 200000" disabled={readOnly||busy} onChange={event=>change({contextWindow:event.target.value})}/></label>
    <label className="agent-management-field"><span>最大输出 Token</span><input aria-label="Claude 最大输出 Token" inputMode="numeric" value={draft.maxOutputTokens} placeholder="可选" disabled={readOnly||busy} onChange={event=>change({maxOutputTokens:event.target.value})}/></label>
   </div>
  </section>
  <section className="claude-provider-models agent-management-section" aria-labelledby="claude-provider-models-title">
   <div className="claude-provider-models-heading"><div><h4 id="claude-provider-models-title">模型</h4><p>{detected.length?`已探测 ${detected.length} 个，勾选此 Provider 可用的模型。`:provider?'输入新密钥后可重新探测，现有模型仍可编辑。':'填写地址和密钥后探测模型。'}</p></div><div className="agent-management-status-row"><button type="button" className="agent-management-button" disabled={readOnly||busy||!draft.baseUrl.trim()||(!provider&&!draft.apiKey.trim())} onClick={()=>{setError('');detect.mutate();}}>{detect.isPending?<Loader2 size={13} className="animate-spin"/>:<Search size={13}/>}探测模型</button></div></div>
   {detected.length?<div className="claude-provider-model-grid">{detected.map(model=><label className={draft.models.includes(model)?'selected':''} key={model}><input type="checkbox" aria-label={`启用模型 ${model}`} checked={draft.models.includes(model)} disabled={readOnly||busy} onChange={event=>{const models=event.target.checked?[...draft.models,model]:draft.models.filter(item=>item!==model);change({models,defaultModel:models.includes(draft.defaultModel)?draft.defaultModel:models[0]||''});}}/><span>{model}</span>{draft.defaultModel===model&&<small>默认</small>}</label>)}</div>:<div className="provider-models-note">暂无模型，请先探测 Provider 模型目录。</div>}
   <label className="agent-management-field claude-provider-default"><span>默认模型</span><select aria-label="Claude Provider 默认模型" value={draft.defaultModel} disabled={readOnly||busy||!draft.models.length} onChange={event=>change({defaultModel:event.target.value})}><option value="">使用第一个可用模型</option>{draft.models.map(model=><option key={model} value={model}>{model}</option>)}</select></label>
  </section>
  {(error||saved)&&<div className={`agent-management-operation ${error?'error':'success'}`} role={error?'alert':'status'}>{error?<CircleAlert size={13}/>:<Check size={13}/>}<span>{error||'Claude Provider 已保存'}</span></div>}
  <footer className="claude-provider-editor-actions">
   {provider&&!readOnly&&provider.id!=='anthropic'&&<div>{confirmDelete?<><span>确定彻底删除？</span><button type="button" className="agent-management-button agent-management-button-danger" disabled={busy} onClick={()=>remove.mutate()}>{remove.isPending?<Loader2 size={13} className="animate-spin"/>:<Trash2 size={13}/>}确认删除</button><button type="button" className="agent-management-button" disabled={busy} onClick={()=>setConfirmDelete(false)}>取消</button></>:<button type="button" className="agent-management-button" disabled={busy} onClick={()=>toggle.mutate(!provider.enabled)}>{toggle.isPending?<Loader2 size={13} className="animate-spin"/>:null}{provider.enabled?'停用':'启用'}</button>}<button type="button" className="agent-management-button" disabled={busy} onClick={()=>setConfirmDelete(true)}><Trash2 size={13}/>删除</button></div>}
   <span>{dirty?'有未保存修改':provider?'配置已保存':''}</span>
   {!readOnly&&<button type="submit" className="agent-management-button agent-management-button-primary" disabled={busy||detect.isPending||!provider&&(!draft.id.trim()||!draft.baseUrl.trim()||!draft.apiKey.trim()||!draft.models.length)||!!provider&&!dirty}>{save.isPending?<Loader2 size={13} className="animate-spin"/>:provider?<Save size={13}/>:<Plus size={13}/>} {provider?'保存 Provider':'添加 Provider'}</button>}
  </footer>
 </form>;
}
