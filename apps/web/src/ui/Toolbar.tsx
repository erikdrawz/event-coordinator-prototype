import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Search, X } from 'lucide-react';
import './toolbar.css';

/** A row of list controls above a DataTable: search, segmented choices, selects, clear. */
export function Toolbar({ children, label = 'Filters' }: { children: ReactNode; label?: string }) {
  return <div className="toolbar" role="search" aria-label={label}>{children}</div>;
}

/**
 * Text search. Keeps its own text so typing stays immediate even when `value` lives in the URL,
 * and reports changes after a short pause.
 */
export function SearchInput({ value, onChange, placeholder = 'Search' }: { value: string; onChange: (v: string) => void; placeholder?: string }) {
  const [text, setText] = useState(value);
  const sent = useRef(value);
  const report = useRef(onChange);
  report.current = onChange;

  // Follow outside changes (e.g. Clear filters)
  useEffect(() => { if (value !== sent.current) { sent.current = value; setText(value); } }, [value]);
  useEffect(() => {
    if (text === sent.current) return;
    const t = setTimeout(() => { sent.current = text; report.current(text); }, 200);
    return () => clearTimeout(t);
  }, [text]);

  return (
    <label className="tb-search">
      <Search size={15} aria-hidden />
      <input type="search" value={text} placeholder={placeholder} aria-label={placeholder} onChange={(e) => setText(e.target.value)} />
    </label>
  );
}

export interface Option { value: string; label: string }

/** A labelled native select. The empty value means "any". */
export function FilterSelect({ label, value, options, onChange, anyLabel = 'All' }:
  { label: string; value: string; options: Option[]; onChange: (v: string) => void; anyLabel?: string }) {
  return (
    <label className={`tb-select${value ? ' active' : ''}`}>
      <span className="tb-select-label">{label}</span>
      <select value={value} aria-label={label} onChange={(e) => onChange(e.target.value)}>
        <option value="">{anyLabel}</option>
        {options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
      </select>
    </label>
  );
}

/** Mutually exclusive choices, e.g. My events / All. Uses the shared .segmented style. */
export function Segmented<V extends string>({ label, value, options, onChange }:
  { label: string; value: V; options: { value: V; label: string }[]; onChange: (v: V) => void }) {
  return (
    <div className="segmented" role="group" aria-label={label}>
      {options.map((o) => <button key={o.value} aria-pressed={value === o.value} onClick={() => onChange(o.value)}>{o.label}</button>)}
    </div>
  );
}

export function ClearFilters({ onClick }: { onClick: () => void }) {
  return <button className="tb-clear" onClick={onClick}><X size={14} aria-hidden />Clear filters</button>;
}
