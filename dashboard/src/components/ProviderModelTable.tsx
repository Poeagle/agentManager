import {useEffect,useState} from 'react';
import {useMutation,useQuery} from '@tanstack/react-query';
import {Pencil,Save,X} from 'lucide-react';
import {api,type AgentModelConfig,type DetectedAgentModel} from '../lib/api';
import {ModelCatalogTable,ProviderModelActions,type ModelCatalogRow} from './ModelCatalogTable';
import type {AgentModelMetadata} from '../lib/api';

type ModelOption=Pick<DetectedAgentModel,'model'|'name'>&AgentModelMetadata;
type ModelPatch=Pick<AgentModelConfig,'provider'|'model'>&Partial<Pick<AgentModelConfig,'contextWindow'|'maxContextWindow'|'effectiveContextWindowPercent'|'supportsImages'>>;
type ModelRow=ModelCatalogRow&{config?:AgentModelConfig};
/** A single catalog view owns selection, default model and capability drafts. */
export function ProviderModelTable({agentId,providerId,options,selected,readOnly,selectionReadOnly=false,busy,detecting,canSave,onSelectedChange,onDetect,onSave,onDirtyChange,onBusyChange}:{
 agentId:string;providerId:string;options:ModelOption[];selected:string[];readOnly:boolean;selectionReadOnly?:boolean;busy:boolean;detecting:boolean;canSave:boolean;
 onSelectedChange:(models:string[])=>void;onDetect:()=>void;onSave:(patches:ModelPatch[])=>Promise<void>;onDirtyChange:(dirty:boolean)=>void;onBusyChange:(busy:boolean)=>void;
}){
 const query=useQuery({queryKey:['agent-model-configs',agentId,providerId],queryFn:()=>api.agentManagement.modelConfigs(agentId),retry:false,refetchInterval:300000});
 const [patches,setPatches]=useState<Record<string,Partial<ModelPatch>>>({});
 const [editing,setEditing]=useState(false);
 const configs=(query.data?.models||[]).filter(m=>(m.provider===providerId||providerId==='native'&&(!m.provider||m.provider==='wanzhao'))&&
  (selected.includes(m.model)||options.some(option=>option.model===m.model)));
 const byModel=new Map(options.map(m=>[m.model,m]));
 const models=[...new Set([...selected,...options.map(m=>m.model),...configs.map(m=>m.model)])];
 const rows:ModelRow[]=models.map(model=>{
  const config=configs.find(m=>m.model===model),option=byModel.get(model);
  const name=option?.name&&option.name!==model?option.name:config?.name||model;
  const metadata=option?.context_window||option?.input_modalities||option?.api_pricing?option:config??option;
  const context=option?.context_window,inputs=option?.input_modalities;
  const editable=config?{...config,
   ...(config.contextWindow==null&&context?{contextWindow:context}:{}),
   ...(config.maxContextWindow==null&&context?{maxContextWindow:context}:{}),
   ...(config.supportsImages==null&&inputs?.length?{supportsImages:inputs.includes('image')}:{}),...patches[model],
  }:undefined;
  const confirmedImages=metadata?.input_modalities?.length?metadata.input_modalities.includes('image'):undefined;
  return {model,name,metadata,config:editable,context:editable?.contextWindow??metadata?.context_window,
    images:inputs?.length?inputs.includes('image'):confirmedImages??editable?.supportsImages??null};
 });
 const save=useMutation({mutationFn:()=>onSave(configs.filter(c=>patches[c.model]).map(c=>({provider:c.provider,model:c.model,...patches[c.model]}))),onSuccess:()=>setPatches({})});
 const locked=readOnly||busy||save.isPending;
 const displayLocked=locked||selectionReadOnly||!editing;
 useEffect(()=>{onDirtyChange(Object.keys(patches).length>0);},[onDirtyChange,patches]);
 useEffect(()=>{onBusyChange(save.isPending);},[onBusyChange,save.isPending]);
 const edit=(model:string,patch:Partial<ModelPatch>)=>setPatches(previous=>({...previous,[model]:{...previous[model],...patch}}));
 const numberField=(row:ModelRow,key:'contextWindow'|'maxContextWindow'|'effectiveContextWindowPercent',label:string)=>row.config&&<div className="provider-model-number">
  <input type="number" aria-label={`${row.model} ${label}`} min={1} max={key==='effectiveContextWindowPercent'?100:undefined} step={1} disabled={locked||!selected.includes(row.model)} value={row.config[key]??''} onChange={event=>edit(row.model,{[key]:event.target.value?Number(event.target.value):null})}/>
  {key==='effectiveContextWindowPercent'&&<span>%</span>}
 </div>;
 return <form className="provider-models" aria-label="Provider 模型配置" onSubmit={event=>{event.preventDefault();if(!locked&&canSave)save.mutate();}}>
  <ProviderModelActions selected={selected.length} total={models.length} disabled={readOnly||selectionReadOnly} detecting={detecting} onDetect={onDetect}>
   {!readOnly&&!editing&&<button type="button" className="agent-management-button" onClick={()=>setEditing(true)}><Pencil size={13}/>编辑模型</button>}
   {editing&&<button type="button" className="agent-management-button" onClick={()=>{setPatches({});setEditing(false);}}><X size={13}/>取消</button>}
   {editing&&<button type="submit" className="agent-management-button agent-management-button-primary" disabled={locked||detecting||!canSave}><Save size={13}/>{save.isPending?'保存中…':'保存并重启 Engine'}</button>}
  </ProviderModelActions>
   <ModelCatalogTable rows={rows} selected={selected} locked={displayLocked} loading={query.isPending} error={query.isError?query.error.message:undefined} onRetry={()=>void query.refetch()}
   onSelectedChange={!readOnly&&!selectionReadOnly?onSelectedChange:undefined}
   renderContext={row=>(editing&&row.config?numberField(row,'contextWindow','上下文长度'):undefined)??row.context?.toLocaleString()??'未提供'}
   renderImages={row=>editing&&row.config?<span className="provider-model-image-control">
    <input type="checkbox" aria-label={`${row.model} 图片输入`} checked={row.config.supportsImages===true}
      disabled={locked||!selected.includes(row.model)}
      onChange={event=>edit(row.model,{supportsImages:event.target.checked})}/>
    {row.config.supportsImages==null?'未知':row.config.supportsImages?'支持':'不支持'}
   </span>:row.images==null?'未提供':row.images?'支持':'不支持'}/>
  {editing&&<p className="provider-models-note">上下文和图片能力来自探测结果；保存后重启 Engine 生效。默认模型会随所选模型自动维护。</p>}
 </form>;
}
