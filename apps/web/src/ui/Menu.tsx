import { useEffect, useId, useMemo, useState, type ReactNode } from 'react';
import { Search } from 'lucide-react';
import { usePopover } from './usePopover';
import './select.css';

export interface MenuItem {
  key: string;
  label: ReactNode;
  /** Plain text for search and accessibility when label isn't a string. */
  text?: string;
  icon?: ReactNode;
  danger?: boolean;
  disabled?: boolean;
  onSelect: () => void;
}

interface Props {
  /** The button that opens the menu. */
  trigger: (props: { ref: (el: HTMLButtonElement | null) => void; onClick: () => void; 'aria-expanded': boolean; 'aria-haspopup': 'menu' }) => ReactNode;
  items: MenuItem[];
  label: string;
  /** Search box at the top; defaults to on for more than 8 items. */
  searchable?: boolean;
  empty?: string;
  width?: number;
  /** Extra class on the popup, e.g. `menu-row` to lay items out in a row (emoji). */
  className?: string;
}

/** A button that opens a list of actions, e.g. a row's ⋮ menu or "+ Speaker". */
export function Menu({ trigger, items, label, searchable, empty = 'Nothing to choose', width = 220, className }: Props) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const { triggerRef, popRef, style } = usePopover<HTMLButtonElement>(open, () => setOpen(false), { width, maxHeight: 320 });
  const id = useId();
  const canSearch = searchable ?? items.length > 8;
  const textOf = (i: MenuItem) => i.text ?? (typeof i.label === 'string' ? i.label : i.key);
  const shown = useMemo(() => (query ? items.filter((i) => textOf(i).toLowerCase().includes(query.toLowerCase())) : items), [items, query]);
  const placed = Boolean(style);

  useEffect(() => {
    if (!open || !placed) return;
    if (canSearch) popRef.current?.querySelector<HTMLInputElement>('input')?.focus();
    else popRef.current?.querySelector<HTMLElement>('[role="menuitem"]:not([aria-disabled="true"])')?.focus();
  }, [open, placed, canSearch]);
  useEffect(() => { setActive(0); }, [query]);

  const close = () => { setOpen(false); setQuery(''); triggerRef.current?.focus(); };
  const pick = (i: MenuItem | undefined) => { if (!i || i.disabled) return; close(); i.onSelect(); };
  const onKey = (e: React.KeyboardEvent) => {
    const els = [...(popRef.current?.querySelectorAll<HTMLElement>('[role="menuitem"]') ?? [])];
    const at = els.indexOf(document.activeElement as HTMLElement);
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(); }
    else if (e.key === 'ArrowDown') { e.preventDefault(); if (canSearch && at < 0) setActive((x) => Math.min(shown.length - 1, x + 1)); else els[Math.min(els.length - 1, at + 1)]?.focus(); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); if (canSearch && at < 0) setActive((x) => Math.max(0, x - 1)); else els[Math.max(0, at - 1)]?.focus(); }
    else if (e.key === 'Enter' && canSearch && at < 0) { e.preventDefault(); pick(shown[active]); }
    else if (e.key === 'Tab') setOpen(false);
  };

  return (
    <>
      {trigger({ ref: (el) => { triggerRef.current = el; }, onClick: () => (open ? close() : setOpen(true)), 'aria-expanded': open, 'aria-haspopup': 'menu' })}
      {open && style && (
        <div ref={popRef} className={`sel-pop${className ? ` ${className}` : ''}`} style={style} onKeyDown={onKey}>
          {canSearch && (
            <div className="sel-search"><Search size={14} aria-hidden />
              <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search" aria-label={`Search ${label}`} /></div>
          )}
          <ul id={id} role="menu" aria-label={label} className="sel-list">
            {shown.length === 0 && <li className="sel-none">{empty}</li>}
            {shown.map((i, n) => (
              <li key={i.key} role="menuitem" tabIndex={-1} aria-disabled={i.disabled || undefined}
                className={`sel-option menu-option${n === active && canSearch ? ' active' : ''}${i.danger ? ' danger' : ''}${i.disabled ? ' disabled' : ''}`}
                onMouseDown={(e) => e.preventDefault()} onMouseMove={() => setActive(n)} onClick={() => pick(i)}
                onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); pick(i); } }}>
                {i.icon}<span className="ms-label">{i.label}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </>
  );
}
