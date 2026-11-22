import {useEffect,useState} from 'react';
import {useMutation,useQuery,useQueryClient} from '@tanstack/react-query';
import {Check,CircleAlert,Loader2,Plus,Save,Trash2} from 'lucide-react';
import {api,type AgentManagementState,type AgentModelMetadata,type AgentProviderState} from '../lib/api';
import {modelCapabilitiesPayload} from './ModelPricing';
import {ProviderAdvancedSettings,ProviderConnectionFields} from './ProviderConnectionFields';
import {ModelCatalogTable,ProviderModelActions} from './ModelCatalogTable';

type Draft={id:string;name:string;baseUrl:string;apiKey:string;models:string[];defaultModel:string;haikuModel:string;subagentModel:string;effort:string;autoCompactWindow:string;contextWindow:string;maxOutputTokens:string;providerRateMultiplier:string};
const empty=():Draft=>({id:'',name:'',baseUrl:'',apiKey:'',models:[],defaultModel:'',haikuModel:'',subagentModel:'',effort:'',autoCompactWindow:'',contextWindow:'',maxOutputTokens:'',providerRateMultiplier:''});
const field=(provider:AgentProviderState,key:string)=>String(provider.fields.find(item=>item.key===key)?.value??'');
const fromProvider=(provider:AgentProviderState):Draft=>{
 return {id:provider.id,name:provider.name,baseUrl:field(provider,'baseUrl'),apiKey:'',models:provider.models,defaultModel:provider.defaultModel||'',haikuModel:field(provider,'haikuModel'),subagentModel:field(provider,'subagentModel'),effort:field(provider,'effort'),autoCompactWindow:field(provider,'autoCompactWindow'),contextWindow:field(provider,'contextWindow'),maxOutputTokens:field(provider,'maxOutputTokens'),providerRateMultiplier:field(provider,'providerRateMultiplier')};
};
const statusLabel:Record<string,string>={ready:'正常',warning:'需配置',error:'异常',unavailable:'不可用',unknown:'待检测'};
const statusTone=(status:string)=>status==='ready'?'ready':status==='error'?'error':status==='warning'?'warning':'unknown';

export function ClaudeProviderEditor({provider,readOnly,onSaved,onCancel,onDirtyChange,onBusyChange,inDialog=false}:{provider?:AgentProviderState;readOnly:boolean;onSaved:(id?:string)=>void;onCancel?:()=>void;onDirtyChange?:(dirty:boolean)=>void;onBusyChange?:(busy:boolean)=>void;inDialog?:boolean}){
 const client=useQueryClient(),[draft,setDraft]=useState<Draft>(()=>provider?fromProvider(provider):empty());
 const [detected,setDetected]=useState<string[]>(provider?.models||[]),[manualModel,setManualModel]=useState(''),[error,setError]=useState(''),[saved,setSaved]=useState(false),[confirmDelete,setConfirmDelete]=useState(false);
 const [probed,setProbed]=useState<Array<AgentModelMetadata & {model:string;name?:string}>>([]);
 const [editingModels,setEditingModels]=useState(false);
 const configs=useQuery({queryKey:['agent-model-configs','claude',provider?.id],queryFn:()=>api.agentManagement.modelConfigs('claude'),enabled:!!provider,retry:false,refetchInterval:300000});
 const byModel=new Map(provider&&draft.baseUrl.trim()===field(provider,'baseUrl')?configs.data?.models.filter(model=>model.provider===provider.id).map(model=>[model.model,model]):[]);
 const byProbe=new Map(probed.map(model=>[model.model,model]));
 const modelRows=[...new Set([...detected,...draft.models])].map(model=>{
  const saved=byModel.get(model),probe=byProbe.get(model);
  const metadata={...saved,...probe};
  return {model,name:probe?.name??saved?.name,metadata,context:probe?.context_window??saved?.contextWindow,
    images:probe?.input_modalities?.length?probe.input_modalities.includes('image'):metadata.input_modalities?.length?metadata.input_modalities.includes('image'):saved?.supportsImages??null};
 });
 const original=provider?fromProvider(provider):empty();
 const dirty=JSON.stringify(draft)!==JSON.stringify(original)||!!confirmDelete||!!Object.keys(modelCapabilitiesPayload(probed)).length;
 const change=(patch:Partial<Draft>)=>{setSaved(false);setError('');onDirtyChange?.(true);setDraft(previous=>({...previous,...patch}));};
 const updateState=(result:{state:AgentManagementState})=>{client.setQueryData(['agent-management','claude'],result);void client.invalidateQueries({queryKey:['agent-management-list']});void client.invalidateQueries({queryKey:['session-environments']});};
 const detect=useMutation({mutationFn:()=>api.agentManagement.detectModels('claude',{endpoint:draft.baseUrl.trim(),apiKey:draft.apiKey.trim()||undefined,providerId:provider?.id}),onSuccess:result=>{
  const models=[...new Set(result.models.map(item=>item.model))];
  setDetected(models);
  setProbed(result.models);
  setEditingModels(false);
  setDraft(previous=>{
    const selected=previous.models.filter(model=>models.includes(model));
    const next=selected.length?selected:models;
    return {...previous,models:next,defaultModel:next.includes(previous.defaultModel)?previous.defaultModel:next[0]||''};
  });
  onDirtyChange?.(true);
 },onError:(failure:Error)=>setError(failure.message)});
 const addManualModel=()=>{
  const model=manualModel.trim();if(!model)return;
  if(!/^[A-Za-z0-9][A-Za-z0-9._:/@+\-[\]]{0,199}$/.test(model)){setError('模型 ID 格式无效');return;}
  setDetected(previous=>[...new Set([...previous,model])]);
  change({models:[...new Set([...draft.models,model])],defaultModel:draft.defaultModel||model});
  setManualModel('');setError('');
 };
 const refreshSessionControls=()=>{
  void client.invalidateQueries({queryKey:['conversation-controls']});
  void client.invalidateQueries({queryKey:['session-environments']});
 };
 const save=useMutation<{state:AgentManagementState},Error,void>({mutationFn:async()=>{
  if(!provider&&!draft.id.trim())throw Error('请填写 Provider ID');
  if(!draft.baseUrl.trim())throw Error('请填写 API 地址');
  if(!provider&&!draft.apiKey.trim())throw Error('请填写 API Key');
  const discovery=await api.agentManagement.detectModels('claude',{endpoint:draft.baseUrl.trim(),apiKey:draft.apiKey.trim()||undefined,providerId:provider?.id})
   .catch(error=>{if(provider||!draft.models.length)throw error;return {models:[]};});
  if(provider&&!discovery.models.length)throw Error('Provider 未返回可用模型，当前配置未保存');
  const discovered=discovery.models.length?discovery.models.map(model=>model.model):draft.models;
  if(!discovered.length)throw Error('至少探测或手工添加一个模型');
  // Detection refreshes the catalog; the checked rows are the user's explicit
  // selection and must be the only models persisted or preflighted.
  const models=[...new Set(draft.models.filter(model=>discovered.includes(model)))];
  if(!models.length)throw Error('请至少勾选一个探测返回的模型');
  const defaultModel=draft.defaultModel&&models.includes(draft.defaultModel)?draft.defaultModel:models[0];
  const fields={baseUrl:draft.baseUrl.trim(),models,defaultModel,haikuModel:draft.haikuModel.trim(),subagentModel:draft.subagentModel.trim(),effort:draft.effort.trim(),autoCompactWindow:draft.autoCompactWindow.trim(),contextWindow:draft.contextWindow.trim(),maxOutputTokens:draft.maxOutputTokens.trim(),...(provider?.fields.some(item=>item.key==='providerRateMultiplier')?{providerRateMultiplier:draft.providerRateMultiplier.trim()}:{}),...modelCapabilitiesPayload(discovery.models)};
  const input={name:draft.name.trim()||draft.id.trim(),kind:provider?.kind||'anthropic-compatible',enabled:provider?.enabled??true,...draft.apiKey.trim()?{apiKey:draft.apiKey.trim()}:{},fields};
  return provider?api.agentManagement.updateProvider('claude',provider.id,input):api.agentManagement.createProvider('claude',{...input,id:draft.id.trim()});
 },onSuccess:result=>{updateState(result);refreshSessionControls();setSaved(true);setError('');setEditingModels(false);onDirtyChange?.(false);onSaved(provider?.id||draft.id.trim());},onError:(failure:Error)=>setError(failure.message)});
 const remove=useMutation({mutationFn:()=>api.agentManagement.deleteProvider('claude',provider!.id),onSuccess:result=>{updateState(result);setConfirmDelete(false);onDirtyChange?.(false);onSaved(undefined);},onError:(failure:Error)=>setError(failure.message)});
 const toggle=useMutation({mutationFn:(enabled:boolean)=>api.agentManagement.providerAction('claude',provider!.id,enabled?'enable':'disable'),onSuccess:updateState,onError:(failure:Error)=>setError(failure.message)});
 const busy=save.isPending||remove.isPending||toggle.isPending||detect.isPending;
 useEffect(()=>{onBusyChange?.(busy);},[busy,onBusyChange]);
 const detectDisabled=readOnly||busy||!draft.baseUrl.trim();
 const displayLocked=readOnly||busy||!editingModels;
 return <form className="claude-provider-editor" aria-label="Claude Provider 配置" onSubmit={event=>{event.preventDefault();if(!readOnly&&!busy){setError('');save.mutate();}}}>
  {onCancel&&<button type="button" className="agent-management-button claude-provider-back" disabled={busy} onClick={onCancel}>返回详情</button>}
  {!inDialog&&<header className="claude-provider-editor-heading">
   <div><div className="flex items-center gap-2"><h3>{provider?provider.name:'添加提供商'}</h3>{provider&&<span className={`agent-management-pill ${statusTone(provider.status)}`}>{statusLabel[provider.status]||provider.status}</span>}</div><p>{provider?provider.statusText:'配置 Anthropic 兼容提供商；密钥只加密保存在本机。'}</p></div>
   <div className="agent-management-status-row">{!readOnly&&provider&&<button type="button" className="agent-management-button" disabled={busy||!dirty} onClick={()=>{setError('');save.mutate();}}>{save.isPending?<Loader2 size={13} className="animate-spin"/>:<Save size={13}/>}保存</button>}</div>
  </header>}
  <section className="agent-management-section agent-management-engine-settings">
   <div className="agent-management-section-title"><h4>连接配置</h4></div>
   <ProviderConnectionFields id={provider?undefined:draft.id} name={draft.name} endpoint={draft.baseUrl} apiKey={draft.apiKey}
    labelPrefix="Claude " endpointHint="Anthropic 兼容 API 根地址" configured={provider?.authentication.status==='authenticated'} disabled={readOnly||busy}
    onChange={(key,value)=>{
     change({[key==='endpoint'?'baseUrl':key]:value});
     if(key==='endpoint'){setDetected([]);setProbed([]);}
     if(key==='apiKey')setProbed([]);
    }}/>
   <ProviderAdvancedSettings label="Claude Code 设置">
   <div className="agent-management-form agent-management-engine-form">
    {provider?.fields.some(item=>item.key==='providerRateMultiplier')&&<label className="agent-management-field"><span>Provider 计费倍率</span><input aria-label="Provider 计费倍率" inputMode="decimal" value={draft.providerRateMultiplier} placeholder="按官方参考价折算，留空使用原价" disabled={readOnly||busy} onChange={event=>change({providerRateMultiplier:event.target.value})}/></label>}
    <label className="agent-management-field"><span>Haiku 模型</span><input aria-label="Claude Haiku 模型" value={draft.haikuModel} placeholder="可选，例如 deepseek-flash" disabled={readOnly||busy} onChange={event=>change({haikuModel:event.target.value})}/></label>
    <label className="agent-management-field"><span>子 Agent 模型</span><input aria-label="Claude 子 Agent 模型" value={draft.subagentModel} placeholder="可选，例如 deepseek-flash" disabled={readOnly||busy} onChange={event=>change({subagentModel:event.target.value})}/></label>
    <label className="agent-management-field"><span>Effort 等级</span><input aria-label="Claude Effort 等级" value={draft.effort} placeholder="可选，例如 max" disabled={readOnly||busy} onChange={event=>change({effort:event.target.value})}/></label>
    <label className="agent-management-field"><span>自动压缩窗口</span><input aria-label="Claude 自动压缩窗口" inputMode="numeric" value={draft.autoCompactWindow} placeholder="可选，例如 786432" disabled={readOnly||busy} onChange={event=>change({autoCompactWindow:event.target.value})}/></label>
    <label className="agent-management-field"><span>上下文窗口</span><input aria-label="Claude 上下文窗口" inputMode="numeric" value={draft.contextWindow} placeholder="可选，例如 200000" disabled={readOnly||busy} onChange={event=>change({contextWindow:event.target.value})}/></label>
    <label className="agent-management-field"><span>最大输出 Token</span><input aria-label="Claude 最大输出 Token" inputMode="numeric" value={draft.maxOutputTokens} placeholder="可选" disabled={readOnly||busy} onChange={event=>change({maxOutputTokens:event.target.value})}/></label>
   </div>
   </ProviderAdvancedSettings>
  </section>
 {(!provider||editingModels||!!modelRows.length)&&<section className="provider-models" aria-label="Provider 模型配置">
   <ProviderModelActions selected={draft.models.length} total={modelRows.length} detecting={detect.isPending}
    disabled={detectDisabled} onDetect={()=>{setError('');detect.mutate();}}>
    {!readOnly&&!editingModels&&!!modelRows.length&&<button type="button" className="agent-management-button" onClick={()=>setEditingModels(true)}>编辑模型</button>}
    {!readOnly&&!editingModels&&!modelRows.length&&<button type="button" className="agent-management-button" onClick={()=>{setEditingModels(true);setProbed([]);}}>填写模型</button>}
    {editingModels&&<button type="button" className="agent-management-button" onClick={()=>{setEditingModels(false);setProbed([]);}}>取消</button>}
   </ProviderModelActions>
   <ModelCatalogTable rows={modelRows} selected={draft.models} locked={displayLocked}
    loading={!!provider&&configs.isPending&&!modelRows.length} error={!modelRows.length&&configs.isError?configs.error.message:undefined} onRetry={()=>void configs.refetch()}
    onSelectedChange={models=>change({models,defaultModel:models.includes(draft.defaultModel)?draft.defaultModel:models[0]||''})}/>
   {editingModels&&<p className="provider-models-note">上下文和图片能力来自探测结果，或在重新探测后自动更新。默认模型随所选模型自动维护。</p>}
   {editingModels&&!readOnly&&<div className="provider-model-settings">
    <ProviderAdvancedSettings label="手工添加模型"><div className="provider-manual-model">
     <input aria-label="手工添加 Claude 模型" value={manualModel} placeholder="模型 ID" disabled={busy} onChange={event=>setManualModel(event.target.value)} onKeyDown={event=>{if(event.key==='Enter'){event.preventDefault();addManualModel();}}}/>
     <button type="button" className="agent-management-button" disabled={busy||!manualModel.trim()} onClick={addManualModel}>添加</button>
    </div></ProviderAdvancedSettings>
   </div>}
  </section>}
  {(error||saved)&&<div className={`agent-management-operation ${error?'error':'success'}`} role={error?'alert':'status'}>{error?<CircleAlert size={13}/>:<Check size={13}/>}<span>{error||'Claude Provider 已保存'}</span></div>}
  <footer className="claude-provider-editor-actions">
   {provider&&!readOnly&&provider.id!=='anthropic'&&<div>{confirmDelete?<><span>确定彻底删除？</span><button type="button" className="agent-management-button agent-management-button-danger" disabled={busy} onClick={()=>remove.mutate()}>{remove.isPending?<Loader2 size={13} className="animate-spin"/>:<Trash2 size={13}/>}确认删除</button><button type="button" className="agent-management-button" disabled={busy} onClick={()=>setConfirmDelete(false)}>取消</button></>:<button type="button" className="agent-management-button" disabled={busy} onClick={()=>toggle.mutate(!provider.enabled)}>{toggle.isPending?<Loader2 size={13} className="animate-spin"/>:null}{provider.enabled?'停用':'启用'}</button>}<button type="button" className="agent-management-button" disabled={busy} onClick={()=>setConfirmDelete(true)}><Trash2 size={13}/>删除</button></div>}
   {dirty&&<span>有未保存修改</span>}
   {!readOnly&&<button type="submit" className="agent-management-button agent-management-button-primary" disabled={busy||detect.isPending||!provider&&(!draft.id.trim()||!draft.baseUrl.trim()||!draft.apiKey.trim()||!draft.models.length)||!!provider&&!dirty}>{save.isPending?<Loader2 size={13} className="animate-spin"/>:provider?<Save size={13}/>:<Plus size={13}/>} {provider?'保存 Provider':'添加 Provider'}</button>}
  </footer>
 </form>;
}
