import type {ReactNode} from 'react';
import {Loader2,Search} from 'lucide-react';
import type {AgentModelMetadata} from '../lib/api';
import {DataTable} from './table/DataTable';
import {useTableModel,type TableColumn} from './table/use-table-model';

export interface ModelCatalogRow {
 model:string;
 name?:string;
 metadata?:AgentModelMetadata;
 context?:number|null;
 images?:boolean|null;
}

export function ProviderModelActions({selected,total,disabled,detecting,onDetect,children}: {
 selected:number;total:number;disabled?:boolean;detecting?:boolean;onDetect?:()=>void;children?:ReactNode;
}) {
 return <div className="provider-models-toolbar"><h4>模型 <span>{selected} / {total}</span></h4><div>
  {onDetect&&<button type="button" className="agent-management-button" disabled={disabled||detecting} onClick={onDetect}>{detecting?<Loader2 size={13} className="animate-spin"/>:<Search size={13}/>}探测模型</button>}
  {children}
 </div></div>;
}

export function ModelCatalogTable<Row extends ModelCatalogRow>({rows,selected,locked,loading,error,onRetry,onSelectedChange,renderContext,renderImages,extraColumns=[],renderExtra}: {
 rows:Row[];selected:string[];locked?:boolean;loading?:boolean;error?:string;onRetry?:()=>void;
 onSelectedChange?:(models:string[])=>void;
 renderContext?:(row:Row)=>ReactNode;renderImages?:(row:Row)=>ReactNode;
 extraColumns?:TableColumn<Row>[];renderExtra?:(row:Row)=>ReactNode;
}) {
 const chosen=new Set(selected);
 const table=useTableModel(rows,[
  ...onSelectedChange?[{key:'selected',title:'启用',value:(row:Row)=>chosen.has(row.model),interactive:false}]:[],
  {key:'model',title:'模型 ID',value:row=>`${row.model} ${row.name??''}`.trim()},
  {key:'context',title:'上下文长度',value:row=>row.context,kind:'number'},
  {key:'images',title:'图片输入',value:row=>row.images??(row.metadata?.input_modalities?.length?row.metadata.input_modalities.includes('image'):undefined)},
  {key:'released',title:'发布时间',value:row=>row.metadata?.release_date},
  ...extraColumns,
 ]);
 return <DataTable label="Provider 模型" model={table} className="provider-model-table" minWidth={extraColumns.length?980:720} loading={loading} error={error} onRetry={onRetry} empty={!rows.length} emptyMessage="暂无模型，请先探测">
  {table.rows.map(row=>{
   const enabled=chosen.has(row.model),officialWindow=row.metadata?.official_context_window;
   return <tr key={row.model}>
    {onSelectedChange&&<td><input type="checkbox" aria-label={`启用 ${row.model}`} checked={enabled} disabled={locked} onChange={event=>{
     const next=event.target.checked?[...selected,row.model]:selected.filter(model=>model!==row.model);
     onSelectedChange(next);
    }}/></td>}
    <td><code>{row.model}</code>{row.name&&row.name!==row.model&&<small className="provider-model-subtitle">{row.name}</small>}</td>
    <td>{renderContext?.(row)??row.context?.toLocaleString()??'未提供'}{officialWindow!=null&&officialWindow!==row.context&&<small className="provider-model-subtitle">官方 {officialWindow.toLocaleString()}</small>}</td>
    <td>{renderImages?.(row)??(row.images===true?'支持':row.images===false?'不支持':'未提供')}</td>
    <td>{row.metadata?.release_date??'未提供'}</td>
    {renderExtra?.(row)}
   </tr>;
  })}
 </DataTable>;
}
