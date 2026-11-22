import {useEffect,useState} from 'react';
import {useMutation,useQuery} from '@tanstack/react-query';
import {Save} from 'lucide-react';
import {api,type AgentModelConfig,type DetectedAgentModel} from '../lib/api';
import {ModelCatalogTable,ProviderModelActions,type ModelCatalogRow} from './ModelCatalogTable';
import type {AgentModelMetadata} from '../lib/api';

type ModelOption=Pick<DetectedAgentModel,'model'|'name'>&AgentModelMetadata;
type ModelPatch=Pick<AgentModelConfig,'provider'|'model'>&Partial<Pick<AgentModelConfig,'contextWindow'|'maxContextWindow'|'effectiveContextWindowPercent'|'supportsImages'>>;
type ModelRow=ModelCatalogRow&{config?:AgentModelConfig};
/** A single catalog view owns selection, default model and capability drafts. */
export function ProviderModelTable({agentId,providerId,options,selected,defaultModel,readOnly,selectionReadOnly=false,busy,detecting,canSave,onSelectedChange,onDefaultChange,onDetect,onSave,onDirtyChange,onBusyChange}:{
 agentId:string;providerId:string;options:ModelOption[];selected:string[];defaultModel:string;readOnly:boolean;selectionReadOnly?:boolean;busy:boolean;detecting:boolean;canSave:boolean;
 onSelectedChange:(models:string[])=>void;onDefaultChange:(model:string)=>void;onDetect:()=>void;onSave:(patches:ModelPatch[])=>Promise<void>;onDirtyChange:(dirty:boolean)=>void;onBusyChange:(busy:boolean)=>void;
}){
 const query=useQuery({queryKey:['agent-model-configs',agentId,providerId],queryFn:()=>api.agentManagement.modelConfigs(agentId),retry:false,refetchInterval:300000});
 const [patches,setPatches]=useState<Record<string,Partial<ModelPatch>>>({});
 const [advanced,setAdvanced]=useState(false);
 const configs=(query.data?.models||[]).filter(m=>m.provider===providerId||providerId==='native'&&(!m.provider||m.provider==='wanzhao'));
 const byModel=new Map(options.map(m=>[m.model,m]));
 const models=[...new Set([...selected,...options.map(m=>m.model),...configs.map(m=>m.model)])];
 const rows:ModelRow[]=models.map(model=>{
  const config=configs.find(m=>m.model===model),option=byModel.get(model);
  const name=option?.name&&option.name!==model?option.name:config?.name||model;
  const metadata=option?.context_window||option?.input_modalities||option?.api_pricing?option:config??option;
  const context=option?.context_window,inputs=option?.input_modalities;
  const editable=config?.sourceFile?{...config,
   ...(context?{contextWindow:context,maxContextWindow:context}:{}),
   ...(inputs?.length?{supportsImages:inputs.includes('image')}:{}),...patches[model],
  }:undefined;
  return {model,name,metadata,config:editable,context:editable?.contextWindow??metadata?.context_window,images:editable?.supportsImages};
 });
 const save=useMutation({mutationFn:()=>onSave(configs.filter(c=>patches[c.model]).map(c=>({provider:c.provider,model:c.model,...patches[c.model]}))),onSuccess:()=>setPatches({})});
 const locked=readOnly||busy||save.isPending;
 useEffect(()=>{onDirtyChange(Object.keys(patches).length>0);},[onDirtyChange,patches]);
 useEffect(()=>{onBusyChange(save.isPending);},[onBusyChange,save.isPending]);
 const edit=(model:string,patch:Partial<ModelPatch>)=>setPatches(previous=>({...previous,[model]:{...previous[model],...patch}}));
 const numberField=(row:ModelRow,key:'contextWindow'|'maxContextWindow'|'effectiveContextWindowPercent',label:string)=>row.config&&<div className="provider-model-number">
  <input type="number" aria-label={`${row.model} ${label}`} min={1} max={key==='effectiveContextWindowPercent'?100:undefined} step={1} disabled={locked||!selected.includes(row.model)} value={row.config[key]??''} onChange={event=>edit(row.model,{[key]:event.target.value?Number(event.target.value):null})}/>
  {key==='effectiveContextWindowPercent'&&<span>%</span>}
 </div>;
 const effectiveWindow=(row:ModelRow)=>row.config?.contextWindow&&row.config.effectiveContextWindowPercent?Math.round(row.config.contextWindow*row.config.effectiveContextWindowPercent/100):null;
 return <form className="provider-models" aria-label="Provider 模型配置" onSubmit={event=>{event.preventDefault();if(!locked&&canSave)save.mutate();}}>
  <ProviderModelActions selected={selected.length} total={models.length} disabled={locked} detecting={detecting} onDetect={onDetect}>
   {rows.some(row=>row.config)&&<button type="button" className="agent-management-button" aria-expanded={advanced} onClick={()=>setAdvanced(value=>!value)}>窗口参数</button>}
   {!readOnly&&<button type="submit" className="agent-management-button agent-management-button-primary" disabled={locked||detecting||!canSave}><Save size={13}/>{save.isPending?'保存中…':'保存并重启 Engine'}</button>}
  </ProviderModelActions>
  <ModelCatalogTable rows={rows} selected={selected} defaultModel={defaultModel} locked={locked||selectionReadOnly} loading={query.isPending} error={query.isError?query.error.message:undefined} onRetry={()=>void query.refetch()}
   onSelectedChange={onSelectedChange} onDefaultChange={onDefaultChange}
   renderContext={row=>numberField(row,'contextWindow','上下文长度')??null}
   renderImages={row=>row.config?<input type="checkbox" aria-label={`${row.model} 图片输入`} checked={row.config.supportsImages} disabled={locked||!selected.includes(row.model)} onChange={event=>edit(row.model,{supportsImages:event.target.checked})}/>:null}
   extraColumns={advanced?[
    {key:'maxContextWindow',title:'最大上下文',value:row=>row.config?.maxContextWindow,kind:'number'},
    {key:'percent',title:'有效比例',value:row=>row.config?.effectiveContextWindowPercent,kind:'number'},
    {key:'effective',title:'有效窗口',value:effectiveWindow,kind:'number'},
   ]:[]}
   renderExtra={advanced?row=><><td>{numberField(row,'maxContextWindow','最大上下文')||'—'}</td><td>{numberField(row,'effectiveContextWindowPercent','有效比例')||'—'}</td><td>{effectiveWindow(row)?.toLocaleString()??'—'}</td></>:undefined}/>
  {selectionReadOnly&&<p className="provider-models-note">默认模型由 Codex 配置文件管理。</p>}
 </form>;
}
