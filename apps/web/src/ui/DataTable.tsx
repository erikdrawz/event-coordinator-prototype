import { useMemo, useState, type ReactNode } from 'react';
import { ArrowDown, ArrowUp, ArrowUpDown } from 'lucide-react';
import './data-table.css';

export type SortDir = 'asc' | 'desc';
export interface SortState { columnId: string; dir: SortDir }
type SortValue = string | number | null | undefined;

export interface Column<T> {
  id: string;
  header: string;
  cell: (row: T) => ReactNode;
  /** Makes the column sortable. Return null for "no value"; those rows always sort last. */
  sortValue?: (row: T) => SortValue;
  /** CSS width, e.g. '160px' or '30%'. */
  width?: string;
  align?: 'left' | 'right';
}

interface Props<T> {
  columns: Column<T>[];
  rows: T[] | undefined;
  rowKey: (row: T) => string;
  /** Accessible name for the table. */
  label: string;
  sort?: SortState | null;
  onSortChange?: (sort: SortState) => void;
  loading?: boolean;
  error?: Error | null;
  /** Shown when there are no rows (after filtering). */
  empty?: ReactNode;
}

/**
 * The standard list: a card-wrapped table with sortable headers, loading, error and empty states.
 * It renders rows in the order given. Sort client-side with useTableSort, or pass the sort state
 * to a server query for large lists.
 */
export function DataTable<T>({ columns, rows, rowKey, label, sort, onSortChange, loading, error, empty }: Props<T>) {
  const status = error ? `Couldn't load: ${error.message}` : loading ? 'Loading…' : null;

  return (
    <div className="dt-card">
      <div className="dt-scroll">
        <table className="dt" aria-label={label} aria-busy={loading || undefined}>
          <colgroup>{columns.map((c) => <col key={c.id} style={c.width ? { width: c.width } : undefined} />)}</colgroup>
          <thead>
            <tr>
              {columns.map((c) => {
                const active = sort?.columnId === c.id ? sort.dir : null;
                const align = c.align === 'right' ? 'dt-right' : undefined;
                if (!c.sortValue || !onSortChange) return <th key={c.id} scope="col" className={align}>{c.header}</th>;
                const next: SortDir = active === 'asc' ? 'desc' : 'asc';
                const Icon = active === 'asc' ? ArrowUp : active === 'desc' ? ArrowDown : ArrowUpDown;
                return (
                  <th key={c.id} scope="col" className={align}
                    aria-sort={active === 'asc' ? 'ascending' : active === 'desc' ? 'descending' : 'none'}>
                    <button className={`dt-sort${active ? ' active' : ''}`} onClick={() => onSortChange({ columnId: c.id, dir: next })}>
                      {c.header}<Icon size={13} aria-hidden />
                    </button>
                  </th>
                );
              })}
            </tr>
          </thead>
          <tbody>
            {status ? (
              <tr><td colSpan={columns.length} className="dt-message">{status}</td></tr>
            ) : !rows?.length ? (
              <tr><td colSpan={columns.length} className="dt-message">{empty ?? 'Nothing to show.'}</td></tr>
            ) : rows.map((r) => (
              <tr key={rowKey(r)}>
                {columns.map((c) => <td key={c.id} className={c.align === 'right' ? 'dt-right' : undefined}>{c.cell(r)}</td>)}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

const collator = new Intl.Collator('en', { sensitivity: 'base', numeric: true });

/** Client-side sorting for lists small enough to load whole. Rows without a value sort last either way. */
export function useTableSort<T>(rows: T[] | undefined, columns: Column<T>[], initial: SortState | null) {
  const [sort, setSort] = useState<SortState | null>(initial);
  const sorted = useMemo(() => {
    const col = columns.find((c) => c.id === sort?.columnId);
    if (!rows || !col?.sortValue || !sort) return rows;
    const get = col.sortValue;
    const sign = sort.dir === 'asc' ? 1 : -1;
    return [...rows].sort((a, b) => {
      const va = get(a), vb = get(b);
      if (va == null || va === '') return vb == null || vb === '' ? 0 : 1;
      if (vb == null || vb === '') return -1;
      return sign * (typeof va === 'number' && typeof vb === 'number' ? va - vb : collator.compare(String(va), String(vb)));
    });
  }, [rows, columns, sort]);
  return { rows: sorted, sort, setSort };
}
