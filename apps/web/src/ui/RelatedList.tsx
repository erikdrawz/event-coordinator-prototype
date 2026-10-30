import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { ArrowRight } from 'lucide-react';
import type { Column } from './DataTable';
import './related-list.css';

/** How many rows a related list shows on its parent record. */
export const RELATED_LIMIT = 5;

/** The newest rows of a related list, inside the parent record's card. The full list is a page of its own. */
export function RelatedTable<T>({ label, columns, rows, rowKey, rowClass, className = '' }: {
  label: string; columns: Column<T>[]; rows: T[]; rowKey: (row: T) => string; rowClass?: (row: T) => string | undefined; className?: string;
}) {
  return (
    <div className="table-scroll">
      <table className={`agenda-table ${className}`} aria-label={label}>
        <thead><tr>{columns.map((c) => <th key={c.id} className={c.align === 'right' ? 'num' : undefined}>{c.header}</th>)}</tr></thead>
        <tbody>
          {rows.slice(0, RELATED_LIMIT).map((r) => (
            <tr key={rowKey(r)} className={rowClass?.(r)}>
              {columns.map((c) => <td key={c.id} className={c.align === 'right' ? 'num' : undefined}>{c.cell(r)}</td>)}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** The way to the full list; shows only when some rows don't fit on the parent record. */
export function ViewAll({ to, total }: { to: string; total: number }) {
  if (total <= RELATED_LIMIT) return null;
  return <div className="rl-foot"><Link to={to} className="link rl-all">View all {total}<ArrowRight size={14} aria-hidden /></Link></div>;
}

/** The page a related list opens on: where it belongs, its name and count, then the list. */
export function RelatedPage({ crumbs, title, sub, children }: { crumbs: { to: string; label: string }[]; title: string; sub?: ReactNode; children: ReactNode }) {
  return (
    <main className="page">
      <nav className="crumbs rl-crumbs">
        {crumbs.map((c) => <span key={c.to} className="rl-crumb"><Link to={c.to}>{c.label}</Link><span>/</span></span>)}
        <span>{title}</span>
      </nav>
      <div className="page-header">
        <div>
          <h1 className="page-title">{title}</h1>
          {sub && <div className="card-sub">{sub}</div>}
        </div>
      </div>
      {children}
    </main>
  );
}
