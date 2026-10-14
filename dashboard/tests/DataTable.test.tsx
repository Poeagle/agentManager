import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { expect, it, vi } from 'vitest';
import { DataTable, TableDetailRow } from '../src/components/table/DataTable';
import { useTableModel } from '../src/components/table/use-table-model';

function List({ loading = false, error, empty = false, onRetry }: { loading?: boolean; error?: string; empty?: boolean; onRetry?: () => void }) {
  const model = useTableModel([{ name: 'B' }, { name: 'A' }], [{ key: 'name', title: '名称', value: (row) => row.name }]);
  return <DataTable label="测试列表" model={model} expandable actions loading={loading} error={error} empty={empty} onRetry={onRetry} emptyMessage="暂无记录">
    {model.rows.map((row) => <tr key={row.name}><td>+</td><td>{row.name}</td><td>查看</td></tr>)}
    <TableDetailRow columnCount={3}><span>展开内容</span></TableDetailRow>
  </DataTable>;
}

it('preserves headers and nested row structure through loading, empty, and failed states', async () => {
  const user = userEvent.setup();
  const retry = vi.fn();
  const view = render(<List loading />);
  const table = screen.getByRole('table', { name: '测试列表' });
  expect(within(table).getAllByRole('columnheader')).toHaveLength(3);
  expect(table).toHaveAttribute('aria-busy', 'true');
  view.rerender(<List empty />);
  expect(screen.getByRole('table', { name: '测试列表' })).toBe(table);
  expect(within(table).getByRole('status')).toHaveTextContent('暂无记录');
  view.rerender(<List error="请求失败" onRetry={retry} />);
  expect(within(table).getByRole('alert')).toHaveTextContent('请求失败');
  await user.click(within(table).getByRole('button', { name: '重试' }));
  expect(retry).toHaveBeenCalledOnce();
  view.rerender(<List />);
  await user.click(within(table).getByRole('button', { name: '名称排序' }));
  expect(within(table).getAllByRole('row')[1]).toHaveTextContent('A');
  expect(within(table).getByText('展开内容').closest('td')).toHaveAttribute('colspan', '3');
});
