import {useEffect,useMemo,useState} from 'react';
import {useMutation,useQuery,useQueryClient} from '@tanstack/react-query';
import {CircleAlert} from 'lucide-react';
import {api,type AgentManagementState, type AgentModelConfig,type AgentModelMetadata,type AgentProviderState,type DetectedAgentModel} from '../lib/api';
import {modelCapabilitiesPayload} from './ModelPricing';
import {ProviderModelTable} from './ProviderModelTable';

type ModelOption=Pick<DetectedAgentModel,'model'|'name'>&AgentModelMetadata;
type ModelPatch=Pick<AgentModelConfig,'provider'|'model'>&Partial<Pick<AgentModelConfig,'contextWindow'|'maxContextWindow'|'effectiveContextWindowPercent'|'supportsImages'>>;

export function ProviderModelsExpansion({agentId,provider,readOnly,detected,onChanged}:{agentId:string;provider:AgentProviderState;readOnly:boolean;detected:DetectedAgentModel[];onChanged:(state:AgentManagementState)=>void}){
 const client=useQueryClient();
 const [selected,setSelected]=useState(provider.models);
 const [defaultModel,setDefaultModel]=useState(provider.defaultModel??'');
 const [dirty,setDirty]=useState(false);
 const catalogQuery=useQuery({queryKey:['agent-model-catalog'],queryFn:api.agentManagement.modelCatalog,staleTime:5*60*1000});
 const catalog=useMemo(()=>new Map((catalogQuery.data?.models??[]).map(model=>[model.model,model])),[catalogQuery.data]);
 useEffect(()=>{setSelected(provider.models);setDefaultModel(provider.defaultModel??'');},[provider.id,provider.models,provider.defaultModel]);
 const options:ModelOption[]=useMemo(()=>{
  const discovered=detected.map(item=>item.model);
  const modelIds=discovered.length&&!provider.models.some(model=>discovered.includes(model))?discovered:[...provider.models,...discovered];
  return [...new Set(modelIds)].map(model=>{
  const observation=detected.find(item=>item.model===model),metadata=catalog.get(model);
  return {model,name:observation?.name??model,...metadata,...observation};
  });
 },[catalog,detected,provider.models]);
 const updateState=(state:AgentManagementState)=>{
  client.setQueryData(['agent-management',agentId],{state});
  onChanged(state);
  void Promise.all([
   client.invalidateQueries({queryKey:['agent-management-list']}),
   client.invalidateQueries({queryKey:['agent-model-configs',agentId]}),
   client.invalidateQueries({queryKey:['agent-model-catalog']}),
   client.invalidateQueries({queryKey:['conversation-controls']}),
  ]);
 };
 const save=useMutation({mutationFn:async(patches:ModelPatch[])=>{
  const configs=await api.agentManagement.modelConfigs(agentId);
  const byModel=new Map(configs.models.map(model=>[model.model,model]));
  const filePatches=patches.filter(patch=>byModel.get(patch.model)?.sourceFile);
  if(filePatches.length)await api.agentManagement.updateModelConfigs(agentId,filePatches);
  const capabilityPatches=patches.filter(patch=>!byModel.get(patch.model)?.sourceFile);
  const capabilities=options.map(model=>{
   const patch=capabilityPatches.find(item=>item.model===model.model);
   return {...model,
    ...(patch?.contextWindow!==undefined?{context_window:patch.contextWindow??undefined}:{}),
    ...(patch?.supportsImages!==undefined?(patch.supportsImages===null?{input_modalities:undefined}:{input_modalities:patch.supportsImages?['text','image']:['text']}):{}),
   };
  });
  const result=await api.agentManagement.updateProvider(agentId,provider.id,{fields:{models:selected,defaultModel:defaultModel||selected[0]||'',...modelCapabilitiesPayload(capabilities)}});
  updateState(result.state);setDirty(false);
 }});
 const busy=save.isPending;
 return <div className="provider-model-expansion">
  {provider?<ProviderModelTable agentId={agentId} providerId={provider.id} options={options} selected={selected}
   readOnly={readOnly} busy={busy} canSave={!readOnly&&!busy&&(dirty||selected.join('\0')!==provider.models.join('\0')||defaultModel!==(provider.defaultModel??''))}
   onSelectedChange={models=>{setSelected(models);setDefaultModel(model=>models.includes(model)?model:models[0]||'');}}
   onSave={patches=>save.mutateAsync(patches)} onDirtyChange={setDirty} onBusyChange={()=>{}}/>
   :<div className="provider-model-expansion-empty">暂无模型</div>}
  {save.isError&&<p className="agent-management-error-box" role="alert"><CircleAlert size={13}/>{save.error.message}</p>}
 </div>;
}
