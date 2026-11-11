import { TableActionButton } from './TableActions';
import type { CSSProperties,ReactNode } from 'react';
import { Loader2 } from 'lucide-react';
import { TableColumnHeader } from './TableColumnHeader';
import type { TableModel } from './use-table-model';

interface DataTableProps<T> {
  label: string;
  model: TableModel<T>;
  children?: ReactNode;
  minWidth?: number;
  columnWidths?: readonly string[];
  expandable?: boolean;
  selectionHeader?:ReactNode;
  actions?: boolean;
  className?: string;
  loading?: boolean;
  error?: string;
  empty?: boolean;
  emptyMessage?: string;
  onRetry?: () => void;
}

export function TableHeaders<T>({model}:{model:TableModel<T>}){
 return <>{model.columns.map(column=><TableColumnHeader key={column.key} table={model} columnKey={column.key}/>)}</>;
}

/** Shared table frame for list models and hierarchical aggregate views. */
export function TableFrame({label,header,children,columns,className='',tableClassName='data-table',loading=false,style}:{label:string;header:ReactNode;children:ReactNode;columns?:ReactNode;className?:string;tableClassName?:string;loading?:boolean;style?:CSSProperties}){
 return <div className={`table-wrap ${className}`} role="region" aria-label={`${label}，可横向滚动查看全部列`} tabIndex={0}><table className={tableClassName} aria-label={label} aria-busy={loading} style={style}
  onMouseOver={event=>{if(!event.currentTarget.closest('.manager-ui'))return;const cell=(event.target as HTMLElement).closest('td');if(cell?.closest('table')!==event.currentTarget||cell.colSpan>1||cell.querySelector('button,input,select,textarea'))return;cell.title=cell.textContent?.trim()||'';}}>
  {columns}<thead><tr>{header}</tr></thead><tbody>{children}</tbody>
 </table></div>;
}
/** All platform lists and nested lists share this structure and state handling. */
export function DataTable<T>({ label, model, children, minWidth = 640, columnWidths, expandable = false, actions = false,
  selectionHeader, className = '', loading = false, error, empty = false, emptyMessage = '暂无数据', onRetry }: DataTableProps<T>) {
  const columnCount = model.columns.length + Number(expandable) + Number(actions) + Number(selectionHeader!==undefined);
  const textWidth=(value:string)=>{let width=0;for(const c of value){width+=c.charCodeAt(0)>255?12:7;if(width>=300)break;}return width;};
  const widths=model.columns.map(column=>model.rows.reduce((width,row)=>Math.min(320,Math.max(width,textWidth(String(column.format?.(column.value(row))??column.value(row)??''))+20)),Math.max(/授权|级别/.test(column.title)?160:96,textWidth(column.title)+48)));
  const actionWidth=className.includes('user-management-table')?264:140;
  const natural=widths.reduce((n,w)=>n+w,0)+(expandable?28:0)+(selectionHeader!==undefined?32:0)+(actions?actionWidth:0);
  return <TableFrame label={label} className={className} loading={loading}
    style={{minWidth:`var(--manager-table-minimum,${minWidth}px)`,'--table-requested':`${minWidth}px`,'--table-natural':`${natural}px`} as CSSProperties}
    columns={!columnWidths&&<colgroup>{selectionHeader!==undefined&&<col style={{width:32}}/>}{expandable&&<col style={{'--column-width':'28px'} as CSSProperties}/>}{widths.map((width,i)=><col key={i} style={{'--column-width':`${width}px`} as CSSProperties}/>)}{actions&&<col style={{'--column-width':`${actionWidth}px`} as CSSProperties}/>}</colgroup>}
    header={<>{selectionHeader!==undefined&&<th style={{width:32}}>{selectionHeader}</th>}{expandable&&<th className="table-expand-column" aria-label="展开详情"/>}{model.columns.map((column,index)=><TableColumnHeader key={column.key} table={model} columnKey={column.key} className={columnWidths?.[index]}/>)}{actions&&<th className="table-actions-column">操作</th>}</>}>
    {loading?<TableStateRow columnCount={columnCount} loading>加载中…</TableStateRow>:error?<TableStateRow columnCount={columnCount} error onRetry={onRetry}>{error}</TableStateRow>:empty?<TableStateRow columnCount={columnCount}>{emptyMessage}</TableStateRow>:children}
  </TableFrame>;
}

export function TableDetailRow({ columnCount, children }: { columnCount: number; children: ReactNode }) {
  return <tr className="table-detail-row"><td colSpan={columnCount} className="detail-cell">{children}</td></tr>;
}

export function TableExpandButton({ expanded, label, onClick }: { expanded: boolean; label: string; onClick: () => void }) {
  return <button type="button" className="row-expand" aria-expanded={expanded} aria-label={`${expanded ? '收起' : '展开'}${label}`}
    title={expanded ? '收起详情' : '展开详情'} onClick={onClick}>{expanded ? '−' : '+'}</button>;
}

export function TableStateRow({ columnCount, children, loading = false, error = false, onRetry }: {
  columnCount: number; children: ReactNode; loading?: boolean; error?: boolean; onRetry?: () => void;
}) {
  return <tr><td colSpan={columnCount} className="table-state-cell">
    <div className="table-state" role={error ? 'alert' : 'status'} style={error ? { color: 'var(--error)' } : undefined}>
      {loading && <Loader2 className="h-3.5 w-3.5 animate-spin" />}{children}
      {error && onRetry && <TableActionButton type="button"  onClick={onRetry}>重试</TableActionButton>}
    </div>
  </td></tr>;
}
