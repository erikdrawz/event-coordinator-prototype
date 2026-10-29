import { useEffect, useMemo, useRef, useState, type MouseEvent, type ReactNode } from 'react';
import './bulk-select.css';

/** Which rows of a list are ticked. Rows that leave the list drop out of the selection. */
export function useRowSelection(ids: string[]) {
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const key = ids.join(',');
  useEffect(() => {
    setSelected((s) => {
      const keep = new Set([...s].filter((id) => ids.includes(id)));
      return keep.size === s.size ? s : keep;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  return useMemo(() => ({
    selected,
    count: selected.size,
    has: (id: string) => selected.has(id),
    toggle: (id: string, on?: boolean) => setSelected((s) => {
      const n = new Set(s);
      if (on ?? !n.has(id)) n.add(id); else n.delete(id);
      return n;
    }),
    all: ids.length > 0 && ids.every((id) => selected.has(id)),
    some: selected.size > 0,
    toggleAll: () => setSelected((s) => (ids.length > 0 && ids.every((id) => s.has(id)) ? new Set() : new Set(ids))),
    clear: () => setSelected(new Set()),
  }), [selected, key]);   // eslint-disable-line react-hooks/exhaustive-deps
}
export type RowSelection = ReturnType<typeof useRowSelection>;

/** The header checkbox: ticks every row, or none; shows "some" as indeterminate. */
export function SelectAllCell({ selection, label }: { selection: RowSelection; label: string }) {
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => { if (ref.current) ref.current.indeterminate = selection.some && !selection.all; }, [selection.some, selection.all]);
  return (
    <th className="bs-cell">
      <input ref={ref} type="checkbox" className="bs-check" aria-label={label} checked={selection.all} onChange={selection.toggleAll} />
    </th>
  );
}
export function SelectRowCell({ selection, id, label }: { selection: RowSelection; id: string; label: string }) {
  return (
    <td className="bs-cell" onClick={(e) => e.stopPropagation()}>
      <input type="checkbox" className="bs-check" aria-label={label} checked={selection.has(id)} onChange={(e) => selection.toggle(id, e.target.checked)} />
    </td>
  );
}

/**
 * Takes the place of a list's header while rows are ticked: how many, Clear, and the bulk actions.
 * `notice` reports the outcome of the last action ("3 attendees updated").
 */
export function BulkBar({ selection, noun, children, notice }: { selection: RowSelection; noun: [string, string]; children: ReactNode; notice?: ReactNode }) {
  return (
    <div className="bs-bar" role="toolbar" aria-label={`Actions for the selected ${noun[1]}`}>
      <span className="bs-count" aria-live="polite">{selection.count} {selection.count === 1 ? noun[0] : noun[1]} selected</span>
      <button type="button" className="link bs-clear" onClick={selection.clear}>Clear</button>
      <span className="bs-actions">{children}</span>
      {notice && <span className="bs-notice" role="status">{notice}</span>}
    </div>
  );
}

/**
 * Row click → open the record's panel, unless the click was on something that acts by itself
 * (a link, a button, an input, a menu).
 */
export function isRowClick(e: MouseEvent) {
  return !(e.target as HTMLElement).closest('a, button, input, textarea, label, select, [role="menu"], [role="listbox"], .sel-pop');
}
