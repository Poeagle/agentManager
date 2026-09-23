import { useId, useState } from 'react';
import { columnName, type PreviewSheet } from '../lib/spreadsheet-preview';

export function SpreadsheetPreview({ sheets }: { sheets: PreviewSheet[] }) {
  const [selected, setSelected] = useState(0);
  const selectId = useId();
  const sheet = sheets[selected] ?? sheets[0];
  const columns = Math.min(100, Math.max(1, ...sheet.rows.map(row => row.reduce((sum, cell) => sum + (cell.colSpan || 1), 0))));
  return <div className="flex-1 min-h-0 flex flex-col" style={{ background: 'var(--bg-primary)' }}>
    <div className="flex items-center gap-2 px-4 py-2 border-b text-xs" style={{ borderColor: 'var(--border)' }}>
      <label htmlFor={selectId}>工作表</label>
      <select id={selectId} aria-label="工作表" value={selected} onChange={event => setSelected(Number(event.target.value))} className="rounded px-2 py-1 max-w-72" style={{ background: 'var(--bg-secondary)', color: 'var(--text-primary)' }}>
        {sheets.map((item, index) => <option key={index} value={index}>{item.name}</option>)}
      </select>
      <span style={{ color: 'var(--text-secondary)' }}>显示 {sheet.rows.length} 行 · {columns} 列</span>
    </div>
    {sheet.truncated && <div className="px-4 py-2 text-xs" style={{ color: 'var(--text-secondary)' }}>预览最多显示 100 个工作表，每张表 1000 行、100 列；完整内容请下载原文件。</div>}
    <div className="flex-1 min-h-0 overflow-auto">
      <table className="border-separate border-spacing-0 text-sm" style={{ minWidth: '100%', color: 'var(--text-primary)' }}>
        <thead className="sticky top-0 z-10"><tr>
          <th className="px-3 py-2 border-b border-r font-normal" style={{ background: 'var(--bg-secondary)', borderColor: 'var(--border)' }}>#</th>
          {Array.from({ length: columns }, (_, index) => <th key={index} className="px-4 py-2 border-b border-r text-center font-medium" style={{ background: 'var(--bg-secondary)', borderColor: 'var(--border)' }}>{columnName(index)}</th>)}
        </tr></thead>
        <tbody>{sheet.rows.map((row, rowIndex) => <tr key={rowIndex}>
          <th className="px-3 py-2 border-b border-r font-normal text-xs" style={{ background: 'var(--bg-secondary)', borderColor: 'var(--border)', color: 'var(--text-secondary)' }}>{rowIndex + 1}</th>
          {row.map((cell, index) => <td key={index} colSpan={cell.colSpan} rowSpan={cell.rowSpan} className="px-4 py-2 border-b border-r align-top whitespace-pre-wrap break-words leading-relaxed" style={{ minWidth: 100, maxWidth: 480, borderColor: 'var(--border)', background: rowIndex % 2 ? 'var(--bg-secondary)' : undefined }}>{cell.text}</td>)}
        </tr>)}</tbody>
      </table>
      {!sheet.rows.length && <p className="p-4 text-sm" style={{ color: 'var(--text-secondary)' }}>空工作表</p>}
    </div>
  </div>;
}
