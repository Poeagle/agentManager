import { fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { TableColumnHeader } from '../src/components/table/TableColumnHeader';
import { tableTime, useTableModel } from '../src/components/table/use-table-model';

const data = [
  { id: 'empty', client: 'Claude', number: null, time: null, content: 'x'.repeat(100) },
  { id: 'item10', client: 'Codex', number: 10, time: '2026-10-13 08:00:00', content: 'a'.repeat(90) + 'Alpha' },
  { id: 'item2', client: 'Codex', number: 2, time: '2026-10-13T15:00:00+08:00', content: 'b'.repeat(90) + 'Beta' },
];
function Harness() {
  const table = useTableModel(data, [
    { key: 'name', title: '名称', value: (row) => row.id },
    { key: 'client', title: '客户端', value: (row) => row.client },
    { key: 'number', title: '数量', value: (row) => row.number },
    { key: 'time', title: '时间', value: (row) => row.time, kind: 'date' },
    { key: 'content', title: '内容', value: (row) => row.content },
  ]);
  return <table><thead><tr>{table.columns.map((column) => <TableColumnHeader key={column.key} table={table} columnKey={column.key} />)}</tr></thead>
    <tbody>{table.rows.map((row) => <tr key={row.id}><td>{row.id}</td></tr>)}</tbody></table>;
}
const ids = () => screen.getAllByRole('row').slice(1).map((row) => row.textContent);

describe('shared table sorting and filtering', () => {
  it('sorts numbers numerically in both directions, puts missing values last, then restores the original order', async () => {
    const user = userEvent.setup(); render(<Harness />);
    await user.click(screen.getByRole('button', { name: '数量排序' }));
    expect(ids()).toEqual(['item2', 'item10', 'empty']);
    expect(screen.getByRole('columnheader', { name: /数量/ })).toHaveAttribute('aria-sort', 'ascending');
    await user.click(screen.getByRole('button', { name: '数量排序' }));
    expect(ids()).toEqual(['item10', 'item2', 'empty']);
    await user.click(screen.getByRole('button', { name: '数量排序' }));
    expect(ids()).toEqual(['empty', 'item10', 'item2']);
  });

  it('sorts natural names and timestamps across UTC and timezone offsets', async () => {
    const user = userEvent.setup(); render(<Harness />);
    await user.click(screen.getByRole('button', { name: '名称排序' }));
    expect(ids()).toEqual(['empty', 'item2', 'item10']);
    await user.click(screen.getByRole('button', { name: '时间排序' }));
    expect(ids()).toEqual(['item2', 'item10', 'empty']);
    expect(tableTime('2026-10-13 08:00:00')).toBe(Date.parse('2026-10-13T08:00:00Z'));
    expect(tableTime('2026-10-13')).toBe(Date.parse('2026-10-13T00:00:00Z'));
    expect(tableTime('invalid')).toBeNull();
  });

  it('applies searchable enum selections only on confirmation and combines filters across columns', async () => {
    const user = userEvent.setup(); render(<Harness />);
    await user.click(screen.getByRole('button', { name: '筛选客户端' }));
    let popup = screen.getByRole('dialog', { name: '客户端筛选' });
    await user.type(within(popup).getByRole('textbox'), 'cod');
    expect(within(popup).queryByRole('checkbox', { name: 'Claude' })).not.toBeInTheDocument();
    await user.click(within(popup).getByRole('checkbox', { name: 'Codex' }));
    expect(ids()).toHaveLength(3);
    await user.click(within(popup).getByRole('button', { name: '筛选', exact: true }));
    expect(ids()).toEqual(['item10', 'item2']);
    await user.click(screen.getByRole('button', { name: '筛选数量' }));
    popup = screen.getByRole('dialog', { name: '数量筛选' });
    await user.click(within(popup).getByRole('checkbox', { name: '2', exact: true }));
    await user.click(within(popup).getByRole('button', { name: '筛选', exact: true }));
    expect(ids()).toEqual(['item2']);
    await user.click(screen.getByRole('button', { name: '筛选数量' }));
    await user.click(within(screen.getByRole('dialog')).getByRole('button', { name: '重置' }));
    expect(ids()).toEqual(['item10', 'item2']);
  });

  it('uses keyword filtering for long content and closes on Escape without closing its parent', async () => {
    const user = userEvent.setup(); render(<Harness />);
    const parentEscape = vi.fn(); window.addEventListener('keydown', parentEscape);
    try {
      await user.click(screen.getByRole('button', { name: '筛选内容' }));
      fireEvent.change(screen.getByRole('textbox', { name: '内容关键词' }), { target: { value: 'ALPHA' } });
      fireEvent.submit(screen.getByRole('dialog'));
      expect(ids()).toEqual(['item10']);
      await user.click(screen.getByRole('button', { name: '筛选内容' }));
      await user.keyboard('{Escape}');
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
      expect(parentEscape).not.toHaveBeenCalled();
      expect(screen.getByRole('button', { name: '筛选内容' })).toHaveFocus();
    } finally { window.removeEventListener('keydown', parentEscape); }
  });
});
