import {useEffect,useId,useState} from 'react';
import {useMutation,useQuery} from '@tanstack/react-query';
import {Loader2,Save,Search} from 'lucide-react';
import {api,type AgentModelConfig,type DetectedAgentModel} from '../lib/api';
import {DataTable} from './table/DataTable';
import {useTableModel} from './table/use-table-model';

type ModelOption=Pick<DetectedAgentModel,'model'|'name'>;
type ModelPatch=Pick<AgentModelConfig,'provider'|'model'|'contextWindow'|'maxContextWindow'|'effectiveContextWindowPercent'|'supportsImages'>;
interface ModelRow {model:string;name:string;config?:AgentModelConfig}
/** A single catalog view owns selection, default model and capability drafts. */
export function ProviderModelTable({agentId,providerId,options,selected,defaultModel,readOnly,busy,detecting,canSave,onSelectedChange,onDefaultChange,onDetect,onSave,onDirtyChange,onBusyChange}:{
 agentId:string;providerId:string;options:ModelOption[];selected:string[];defaultModel:string;readOnly:boolean;busy:boolean;detecting:boolean;canSave:boolean;
 onSelectedChange:(models:string[])=>void;onDefaultChange:(model:string)=>void;onDetect:()=>void;onSave:(patches:ModelPatch[])=>Promise<void>;onDirtyChange:(dirty:boolean)=>void;onBusyChange:(busy:boolean)=>void;
}){
 const group=useId(),query=useQuery({queryKey:['agent-model-configs',agentId,providerId],queryFn:()=>api.agentManagement.modelConfigs(agentId),retry:false});
 const [patches,setPatches]=useState<Record<string,Partial<ModelPatch>>>({});
 const configs=(query.data?.models||[]).filter(m=>m.provider===providerId||providerId==='native'&&(!m.provider||m.provider==='wanzhao'));
 const names=new Map(options.map(m=>[m.model,m.name]));
 const models=[...new Set([...selected,...options.map(m=>m.model),...configs.map(m=>m.model)])];
 const rows:ModelRow[]=models.map(model=>{const config=configs.find(m=>m.model===model),name=names.get(model);return {model,name:name&&name!==model?name:config?.name||model,...config?{config:{...config,...patches[model]}}:{}};});
 const resolvedDefault=selected.includes(defaultModel)?defaultModel:selected[0];
 const table=useTableModel(rows,[
  {key:'selected',title:'启用',value:m=>selected.includes(m.model)},
  {key:'default',title:'默认',value:m=>m.model===resolvedDefault},
  {key:'model',title:'模型 ID',value:m=>m.model},
  {key:'name',title:'名称',value:m=>m.name===m.model?null:m.name},
  {key:'contextWindow',title:'上下文长度',value:m=>m.config?.contextWindow,kind:'number'},
  {key:'maxContextWindow',title:'最大上下文',value:m=>m.config?.maxContextWindow,kind:'number'},
  {key:'effectiveContextWindowPercent',title:'有效比例',value:m=>m.config?.effectiveContextWindowPercent,kind:'number'},
  {key:'images',title:'图片输入',value:m=>m.config?.supportsImages},
  {key:'actual',title:'有效窗口',value:m=>m.config?.contextWindow&&m.config.effectiveContextWindowPercent?Math.round(m.config.contextWindow*m.config.effectiveContextWindowPercent/100):null,kind:'number'},
 ]);
 const save=useMutation({mutationFn:()=>onSave(configs.filter(c=>patches[c.model]).map(original=>{const c={...original,...patches[original.model]};return {provider:c.provider,model:c.model,contextWindow:c.contextWindow,maxContextWindow:c.maxContextWindow,effectiveContextWindowPercent:c.effectiveContextWindowPercent,supportsImages:c.supportsImages};})),onSuccess:()=>setPatches({})});
 const locked=readOnly||busy||save.isPending;
 useEffect(()=>{onDirtyChange(Object.keys(patches).length>0);},[onDirtyChange,patches]);
 useEffect(()=>{onBusyChange(save.isPending);},[onBusyChange,save.isPending]);
 const edit=(model:string,patch:Partial<ModelPatch>)=>setPatches(previous=>({...previous,[model]:{...previous[model],...patch}}));
 return <form className="provider-models" aria-label="Provider 模型配置" onSubmit={event=>{event.preventDefault();if(!locked&&canSave)save.mutate();}}>
  <div className="provider-models-toolbar"><h4>模型 <span>{selected.length} / {models.length}</span></h4><div><button type="button" className="agent-management-button" disabled={locked||detecting} title="读取当前 Provider 的模型目录，不发送模型任务。" onClick={onDetect}>{detecting?<Loader2 size={13} className="animate-spin"/>:<Search size={13}/>}探测模型</button>{!readOnly&&<button type="submit" className="agent-management-button agent-management-button-primary" disabled={locked||detecting||!canSave}><Save size={13}/>{save.isPending?'保存中…':'保存并重启 Engine'}</button>}</div></div>
  <DataTable label="Provider 模型" model={table} className="provider-model-table" minWidth={1100} loading={query.isPending} error={query.isError?query.error.message:undefined} onRetry={()=>void query.refetch()} empty={!models.length} emptyMessage="暂无模型，请先探测">
   {table.rows.map(row=>{const c=row.config,enabled=selected.includes(row.model),actual=c?.contextWindow&&c.effectiveContextWindowPercent?Math.round(c.contextWindow*c.effectiveContextWindowPercent/100):null;return <tr key={row.model}>
    <td><input type="checkbox" aria-label={`启用 ${row.model}`} checked={enabled} disabled={locked} onChange={event=>{const next=event.target.checked?[...selected,row.model]:selected.filter(m=>m!==row.model);onSelectedChange(next);if(row.model===resolvedDefault&&!event.target.checked)onDefaultChange(next[0]||'');}}/></td>
    <td><input type="radio" name={group} aria-label={`默认模型 ${row.model}`} checked={row.model===resolvedDefault} disabled={locked||!enabled} onChange={()=>onDefaultChange(row.model)}/></td>
    <td title={row.model}><code>{row.model}</code></td><td title={row.name}>{row.name===row.model?'—':row.name}</td>
    {(['contextWindow','maxContextWindow','effectiveContextWindowPercent'] as const).map((key,i)=><td key={key}>{c?<div className="provider-model-number"><input type="number" aria-label={`${row.model} ${['上下文长度','最大上下文','有效比例'][i]}`} min={1} max={i===2?100:undefined} step={1} disabled={locked||!enabled} value={c[key]??''} onChange={event=>edit(row.model,{[key]:event.target.value?Number(event.target.value):null})}/>{i===2&&<span>%</span>}</div>:<span title="保存此模型后加载能力参数">—</span>}</td>)}
    <td>{c?<input type="checkbox" aria-label={`${row.model} 图片输入`} checked={c.supportsImages} disabled={locked||!enabled} onChange={event=>edit(row.model,{supportsImages:event.target.checked})}/>:<span title="模型目录未提供图片能力">—</span>}</td><td>{actual==null?'—':actual.toLocaleString()}</td>
   </tr>;})}
  </DataTable>
  <p className="provider-models-note">勾选启用，单选默认模型。保存会重启当前 Engine；现有会话不迁移。新增模型保存后加载能力参数。</p>
 </form>;
}
