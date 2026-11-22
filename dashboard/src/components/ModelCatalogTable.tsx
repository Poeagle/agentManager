import {useId,type ReactNode} from 'react';
import {Loader2,Search} from 'lucide-react';
import type {AgentModelMetadata} from '../lib/api';
import {DataTable} from './table/DataTable';
import {useTableModel,type TableColumn} from './table/use-table-model';
import {ModelPricing,modelImageLabel,modelMultiplierLabel} from './ModelPricing';

export interface ModelCatalogRow {
 model:string;
 name?:string;
 metadata?:AgentModelMetadata;
 context?:number|null;
 images?:boolean;
}

export function ProviderModelActions({selected,total,disabled,detecting,onDetect,children}: {
 selected:number;total:number;disabled?:boolean;detecting?:boolean;onDetect:()=>void;children?:ReactNode;
}) {
 return <div className="provider-models-toolbar"><h4>模型 <span>{selected} / {total}</span></h4><div>
  <button type="button" className="agent-management-button" disabled={disabled||detecting} onClick={onDetect}>{detecting?<Loader2 size={13} className="animate-spin"/>:<Search size={13}/>}探测模型</button>
  {children}
 </div></div>;
}

export function ModelCatalogTable<Row extends ModelCatalogRow>({rows,selected,defaultModel,locked,loading,error,onRetry,onSelectedChange,onDefaultChange,renderContext,renderImages,extraColumns=[],renderExtra}: {
 rows:Row[];selected:string[];defaultModel:string;locked?:boolean;loading?:boolean;error?:string;onRetry?:()=>void;
 onSelectedChange:(models:string[])=>void;onDefaultChange:(model:string)=>void;
 renderContext?:(row:Row)=>ReactNode;renderImages?:(row:Row)=>ReactNode;
 extraColumns?:TableColumn<Row>[];renderExtra?:(row:Row)=>ReactNode;
}) {
 const group=useId(),chosen=new Set(selected),resolvedDefault=chosen.has(defaultModel)?defaultModel:selected[0];
 const table=useTableModel(rows,[
  {key:'selected',title:'启用',value:row=>chosen.has(row.model),interactive:false},
  {key:'default',title:'默认',value:row=>row.model===resolvedDefault,interactive:false},
  {key:'model',title:'模型 ID',value:row=>`${row.model} ${row.name??''}`.trim()},
  {key:'context',title:'上下文长度',value:row=>row.context,kind:'number'},
  {key:'images',title:'图片输入',value:row=>row.images??(row.metadata?.input_modalities?.length?row.metadata.input_modalities.includes('image'):undefined)},
  {key:'released',title:'发布时间',value:row=>row.metadata?.release_date},
  {key:'official',title:'官方计费标准',value:row=>row.metadata?.api_pricing?.currency},
  {key:'provider',title:'第三方 API 费率',value:row=>row.metadata?.provider_pricing?.currency},
  {key:'multiplier',title:'手填倍率',value:row=>row.metadata?.api_pricing?.provider_multiplier,kind:'number'},
  ...extraColumns,
 ]);
 return <DataTable label="Provider 模型" model={table} className="provider-model-table" minWidth={extraColumns.length?1260:900} loading={loading} error={error} onRetry={onRetry} empty={!rows.length} emptyMessage="暂无模型，请先探测">
  {table.rows.map(row=>{
   const enabled=chosen.has(row.model),officialWindow=row.metadata?.official_context_window;
   return <tr key={row.model}>
    <td><input type="checkbox" aria-label={`启用 ${row.model}`} checked={enabled} disabled={locked} onChange={event=>{
     const next=event.target.checked?[...selected,row.model]:selected.filter(model=>model!==row.model);
     onSelectedChange(next);
     if(!next.includes(resolvedDefault))onDefaultChange(next[0]||'');
    }}/></td>
    <td><input type="radio" name={group} aria-label={`默认模型 ${row.model}`} checked={row.model===resolvedDefault} disabled={locked||!enabled} onChange={()=>onDefaultChange(row.model)}/></td>
    <td><code>{row.model}</code>{row.name&&row.name!==row.model&&<small className="provider-model-subtitle">{row.name}</small>}</td>
    <td>{renderContext?.(row)??row.context?.toLocaleString()??'未提供'}{officialWindow!=null&&officialWindow!==row.context&&<small className="provider-model-subtitle">官方 {officialWindow.toLocaleString()}</small>}</td>
    <td>{renderImages?.(row)??(row.images==null?modelImageLabel(row.metadata?.input_modalities):row.images?'支持':'不支持')}</td>
    <td>{row.metadata?.release_date??'未提供'}</td>
    <td><ModelPricing pricing={row.metadata?.api_pricing}/></td><td>{row.metadata?.provider_pricing?<ModelPricing pricing={row.metadata.provider_pricing}/>: '—'}</td><td>{modelMultiplierLabel(row.metadata)}</td>
    {renderExtra?.(row)}
   </tr>;
  })}
 </DataTable>;
}
