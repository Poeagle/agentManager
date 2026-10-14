import { useMemo, useState } from 'react';

export type TableValue = string | number | boolean | null | undefined;
export interface TableColumn<T> {
  key: string;
  title: string;
  value: (row: T) => TableValue;
  kind?: 'text' | 'number' | 'date';
  format?: (value: TableValue) => string;
}
export type ColumnFilter = { text?: string; values?: string[] };
const collator = new Intl.Collator('zh-CN', { numeric: true, sensitivity: 'base' });
export const filterKey = (value: TableValue): string => value == null || value === '' ? 'empty:' : `${typeof value}:${value}`;
export const filterLabel = (value: TableValue): string => value == null || value === '' ? '（空）' : typeof value === 'boolean' ? value ? '是' : '否' : String(value);

export function tableTime(value: TableValue): number | null {
  if (value == null || value === '') return null;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  const text = String(value).replace(' ', 'T');
  const normalized = /Z$|[+-]\d\d:\d\d$/.test(text) ? text : text.includes('T') ? `${text}Z` : `${text}T00:00:00Z`;
  const parsed = Date.parse(normalized);
  return Number.isFinite(parsed) ? parsed : null;
}

export function useTableModel<T>(data: readonly T[], columns: readonly TableColumn<T>[], defaultSort?: { key: string; direction: 'asc' | 'desc' }) {
  const [sort, setSort] = useState<{ key: string; direction: 'asc' | 'desc' } | null>(defaultSort ?? null);
  const [filters, setFilters] = useState<Record<string, ColumnFilter>>({});
  const rows = useMemo(() => {
    const filtered = data.filter((row) => columns.every((column) => {
      const filter = filters[column.key];
      if (!filter) return true;
      const value = column.value(row);
      if (filter.values?.length && !filter.values.includes(filterKey(value))) return false;
      return !filter.text || `${filterLabel(value)} ${column.format?.(value) ?? ''}`.toLocaleLowerCase().includes(filter.text.toLocaleLowerCase());
    }));
    const column = columns.find((item) => item.key === sort?.key);
    if (!column || !sort) return filtered;
    return filtered.map((row, index) => ({ row, index })).sort((a, b) => {
      const rawLeft = column.value(a.row);
      const rawRight = column.value(b.row);
      const left = column.kind === 'date' ? tableTime(rawLeft) : rawLeft === '' ? null : rawLeft;
      const right = column.kind === 'date' ? tableTime(rawRight) : rawRight === '' ? null : rawRight;
      if (left == null) return right == null ? a.index - b.index : 1;
      if (right == null) return -1;
      const comparison = typeof left === 'number' && typeof right === 'number' ? left - right
          : column.kind === 'number' ? Number(left) - Number(right)
            : collator.compare(String(left), String(right));
      return (sort.direction === 'asc' ? comparison : -comparison) || a.index - b.index;
    }).map((item) => item.row);
  }, [data, columns, sort, filters]);
  return {
    rows, columns, sort, filters,
    active: !!sort || Object.keys(filters).length > 0,
    toggleSort(key: string) {
      setSort((current) => current?.key !== key ? { key, direction: 'asc' }
        : current.direction === 'asc' ? { key, direction: 'desc' } : null);
    },
    setFilter(key: string, filter: ColumnFilter) {
      setFilters((current) => {
        const next = { ...current };
        if (!filter.text && !filter.values?.length) delete next[key];
        else next[key] = filter;
        return next;
      });
    },
    options(key: string) {
      const column = columns.find((item) => item.key === key);
      const unique = new Map<string, { key: string; label: string; value: TableValue }>();
      if (column) for (const row of data) {
        const value = column.value(row);
        unique.set(filterKey(value), { key: filterKey(value), label: column.format?.(value) ?? filterLabel(value), value });
      }
      return [...unique.values()].sort((a, b) => typeof a.value === 'number' && typeof b.value === 'number'
        ? a.value - b.value : collator.compare(a.label, b.label));
    },
    reset() { setSort(null); setFilters({}); },
  };
}

export type TableModel<T> = ReturnType<typeof useTableModel<T>>;
