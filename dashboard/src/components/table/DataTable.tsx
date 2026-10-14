import { TableActionButton } from './TableActions';
import type { ReactNode } from 'react';
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
  actions?: boolean;
  className?: string;
  loading?: boolean;
  error?: string;
  empty?: boolean;
  emptyMessage?: string;
  onRetry?: () => void;
}

/** All platform lists and nested lists share this structure and state handling. */
export function DataTable<T>({ label, model, children, minWidth = 640, columnWidths, expandable = false, actions = false,
  className = '', loading = false, error, empty = false, emptyMessage = '暂无数据', onRetry }: DataTableProps<T>) {
  const columnCount = model.columns.length + Number(expandable) + Number(actions);
  return <div className={`table-wrap ${className}`}>
    <table className="data-table" aria-label={label} aria-busy={loading} style={{ minWidth }}>
      <thead><tr>
        {expandable && <th className="table-expand-column" aria-label="展开详情" />}
        {model.columns.map((column, index) => <TableColumnHeader key={column.key} table={model} columnKey={column.key} className={columnWidths?.[index]} />)}
        {actions && <th className="table-actions-column">操作</th>}
      </tr></thead>
      <tbody>{loading ? <TableStateRow columnCount={columnCount} loading>加载中…</TableStateRow>
        : error ? <TableStateRow columnCount={columnCount} error onRetry={onRetry}>{error}</TableStateRow>
          : empty ? <TableStateRow columnCount={columnCount}>{emptyMessage}</TableStateRow> : children}</tbody>
    </table>
  </div>;
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
