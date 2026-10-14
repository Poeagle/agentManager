import { TableActionButton } from './TableActions';
import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { ArrowDown, ArrowUp, ArrowUpDown, Filter } from 'lucide-react';
import type { TableModel } from './use-table-model';
import './TableColumnHeader.css';

/** The same searchable enum/text filters used by dolphindb_manager SmartTable. */
export function TableColumnHeader<T>({ table, columnKey, className = '' }: {
  table: TableModel<T>; columnKey: string; className?: string;
}) {
  const column = table.columns.find((item) => item.key === columnKey)!;
  const [position, setPosition] = useState<{ left: number; top: number } | null>(null);
  const [text, setText] = useState('');
  const [values, setValues] = useState<string[]>([]);
  const [search, setSearch] = useState('');
  const trigger = useRef<HTMLButtonElement>(null);
  const popup = useRef<HTMLFormElement>(null);
  const options = table.options(columnKey);
  const enums = options.length <= 12 && options.every((option) => option.label.length <= 80);
  const activeSort = table.sort?.key === columnKey;
  const activeFilter = !!table.filters[columnKey];
  useEffect(() => {
    if (!position) return;
    const close = (event: Event) => {
      if (event.type === 'keydown' && (event as KeyboardEvent).key !== 'Escape') return;
      if (event.target instanceof Node && (popup.current?.contains(event.target) || trigger.current?.contains(event.target))) {
        if (event.type !== 'keydown') return;
      }
      setPosition(null);
      if (event.type === 'keydown') { event.preventDefault(); event.stopPropagation(); trigger.current?.focus(); }
    };
    document.addEventListener('mousedown', close);
    document.addEventListener('keydown', close);
    window.addEventListener('resize', close);
    return () => { document.removeEventListener('mousedown', close); document.removeEventListener('keydown', close); window.removeEventListener('resize', close); };
  }, [position]);
  return <th className={className} aria-sort={activeSort ? table.sort?.direction === 'asc' ? 'ascending' : 'descending' : 'none'}>
    <div className="smart-table-heading">
      <button type="button" className="smart-table-sort" aria-label={`${column.title}排序`} title={column.title} onClick={() => table.toggleSort(columnKey)}
        style={{ color: activeSort ? 'var(--accent)' : undefined }}>
        <span>{column.title}</span>{activeSort ? table.sort?.direction === 'asc' ? <ArrowUp /> : <ArrowDown /> : <ArrowUpDown />}
      </button>
      <button ref={trigger} type="button" className="smart-table-filter" aria-label={`筛选${column.title}`} aria-expanded={!!position} aria-haspopup="dialog"
        style={{ color: activeFilter ? 'var(--accent)' : undefined }} onClick={() => {
          if (position) { setPosition(null); return; }
          const rect = trigger.current!.getBoundingClientRect();
          setText(table.filters[columnKey]?.text ?? ''); setValues(table.filters[columnKey]?.values ?? []); setSearch('');
          setPosition({ left: Math.max(8, Math.min(rect.right - 236, window.innerWidth - 244)), top: Math.min(rect.bottom + 4, Math.max(8, window.innerHeight - 340)) });
        }}><Filter /></button>
    </div>
    {position && createPortal(<form ref={popup} role="dialog" aria-label={`${column.title}筛选`} className="smart-table-filter-popup"
      style={{ left: position.left, top: position.top }} onSubmit={(event) => {
        event.preventDefault(); table.setFilter(columnKey, enums ? { values } : { text: text.trim() }); setPosition(null); trigger.current?.focus();
      }}>
      <input autoFocus aria-label={enums ? `搜索${column.title}选项` : `${column.title}关键词`} placeholder={enums ? '搜索选项' : '输入关键词'}
        value={enums ? search : text} onChange={(event) => enums ? setSearch(event.target.value) : setText(event.target.value)} />
      {enums && <div className="smart-table-filter-options">{options.filter((option) => option.label.toLocaleLowerCase().includes(search.toLocaleLowerCase())).map((option) =>
        <label key={option.key}><input type="checkbox" checked={values.includes(option.key)} onChange={(event) => setValues(event.target.checked
          ? [...values, option.key] : values.filter((value) => value !== option.key))} /><span>{option.label}</span></label>)}</div>}
      <div className="smart-table-filter-actions">
        <TableActionButton type="button"  onClick={() => { table.setFilter(columnKey, {}); setPosition(null); trigger.current?.focus(); }}>重置</TableActionButton>
        <TableActionButton type="submit"  style={{ background: 'var(--accent)', borderColor: 'var(--accent)', color: '#fff' }}>筛选</TableActionButton>
      </div>
    </form>, document.body)}
  </th>;
}
