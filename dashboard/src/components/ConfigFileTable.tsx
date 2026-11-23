import {ChevronRight} from 'lucide-react';
import {TableFrame} from './table/DataTable';
import {TableActionButton} from './table/TableActions';

interface ConfigFileRow {
  label: string;
  path: string;
  format: string;
  status: string;
  description?: string;
}

export function ConfigFileTable<Row extends ConfigFileRow>({rows, onOpen}: {rows: Row[]; onOpen: (row: Row) => void}) {
  return <TableFrame label="配置文件" className="agent-management-file-table" style={{minWidth: 780}}
    columns={<colgroup>
      <col style={{width: '17%'}}/><col style={{width: '34%'}}/><col style={{width: 82}}/>
      <col style={{width: 126}}/><col/><col style={{width: 76}}/>
    </colgroup>}
    header={<><th scope="col">文件</th><th scope="col">路径</th><th scope="col">格式</th>
      <th scope="col">状态</th><th scope="col">说明</th><th scope="col">操作</th></>}>
    {rows.map((row) => <tr key={row.path}>
      <td title={row.label}>{row.label}</td>
      <td title={row.path}><code>{row.path}</code></td>
      <td>{row.format}</td>
      <td>{row.status}</td>
      <td title={row.description}>{row.description || '—'}</td>
      <td><TableActionButton aria-label={`查看 ${row.label}`} onClick={() => onOpen(row)}>
        查看<ChevronRight size={12} aria-hidden="true"/>
      </TableActionButton></td>
    </tr>)}
  </TableFrame>;
}
