import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { Check, ChevronDown, Search } from 'lucide-react';
import './select.css';

export interface SelectOption { value: string; label: string }

interface Props {
  value: string;
  options: SelectOption[];
  onChange: (value: string) => void;
  /** Shown when nothing is chosen. */
  placeholder?: string;
  /** Adds a first option with the empty value, e.g. "None" or "All". */
  emptyLabel?: string;
  /** A search box at the top of the list. Defaults to on for lists longer than 12. */
  searchable?: boolean;
  /** `filter`: compact toolbar control with its label inside, e.g. "Status: All". */
  variant?: 'field' | 'filter';
  /** Filter variant: the label shown inside the control. */
  label?: string;
  id?: string;
  disabled?: boolean;
  'aria-label'?: string;
  'aria-describedby'?: string;
  'aria-invalid'?: boolean;
}

const norm = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

/**
 * A select in the app's style: a button that opens a listbox. Keyboard: arrows, Home/End, Enter,
 * Esc, and type-to-jump (or type-to-search when searchable). The list is fixed-positioned so it
 * isn't clipped by a scrolling modal body, and flips upwards when there's no room below.
 */
export function Select({
  value, options, onChange, placeholder = 'Choose…', emptyLabel, searchable, variant = 'field', label,
  id, disabled, ...aria
}: Props) {
  const all = useMemo(() => (emptyLabel != null ? [{ value: '', label: emptyLabel }, ...options] : options), [options, emptyLabel]);
  const canSearch = searchable ?? options.length > 12;
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const [pos, setPos] = useState<{ left: number; width: number; top?: number; bottom?: number; maxHeight: number } | null>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const popRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const typed = useRef({ text: '', at: 0 });
  const listId = useId();

  const shown = useMemo(() => (canSearch && query ? all.filter((o) => norm(o.label).includes(norm(query))) : all), [all, canSearch, query]);
  const selected = all.find((o) => o.value === value);
  const optionId = (i: number) => `${listId}-${i}`;

  const place = () => {
    const r = triggerRef.current?.getBoundingClientRect();
    if (!r) return;
    const below = window.innerHeight - r.bottom - 8;
    const above = r.top - 8;
    const up = below < 220 && above > below;
    const width = Math.max(r.width, variant === 'filter' ? 220 : 0);
    const left = Math.min(r.left, window.innerWidth - width - 8);
    setPos(up ? { left, width, bottom: window.innerHeight - r.top + 4, maxHeight: Math.min(320, above) }
              : { left, width, top: r.bottom + 4, maxHeight: Math.min(320, below) });
  };

  const openList = () => {
    if (disabled) return;
    setQuery('');
    setActive(Math.max(0, all.findIndex((o) => o.value === value)));
    place();
    setOpen(true);
  };
  const close = (refocus = true) => {
    setOpen(false);
    if (refocus) triggerRef.current?.focus();
  };
  const choose = (o: SelectOption | undefined) => {
    if (!o) return;
    if (o.value !== value) onChange(o.value);
    close();
  };

  // Follow the trigger while open; close on outside clicks
  useLayoutEffect(() => {
    if (!open) return;
    const onMove = () => place();
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node;
      if (!popRef.current?.contains(t) && !triggerRef.current?.contains(t)) close(false);
    };
    window.addEventListener('resize', onMove);
    window.addEventListener('scroll', onMove, true);
    document.addEventListener('mousedown', onDown);
    return () => {
      window.removeEventListener('resize', onMove);
      window.removeEventListener('scroll', onMove, true);
      document.removeEventListener('mousedown', onDown);
    };
  });

  useEffect(() => { if (open && canSearch) searchRef.current?.focus(); }, [open, canSearch]);
  useEffect(() => { setActive(0); }, [query]);
  useEffect(() => {
    if (open) popRef.current?.querySelector(`#${CSS.escape(optionId(active))}`)?.scrollIntoView({ block: 'nearest' });
  }, [open, active]);

  const onKey = (e: KeyboardEvent) => {
    if (!open) {
      if (['ArrowDown', 'ArrowUp', 'Enter', ' '].includes(e.key)) { e.preventDefault(); openList(); }
      return;
    }
    switch (e.key) {
      case 'Escape': e.preventDefault(); e.stopPropagation(); close(); return;   // don't close a surrounding modal
      case 'Tab': close(false); return;
      case 'ArrowDown': e.preventDefault(); setActive((i) => Math.min(shown.length - 1, i + 1)); return;
      case 'ArrowUp': e.preventDefault(); setActive((i) => Math.max(0, i - 1)); return;
      case 'Home': if (!canSearch) { e.preventDefault(); setActive(0); } return;
      case 'End': if (!canSearch) { e.preventDefault(); setActive(shown.length - 1); } return;
      case 'Enter': e.preventDefault(); choose(shown[active]); return;
    }
    // Type-to-jump when there's no search box
    if (!canSearch && e.key.length === 1 && !e.metaKey && !e.ctrlKey) {
      const now = Date.now();
      typed.current = { text: (now - typed.current.at < 600 ? typed.current.text : '') + norm(e.key), at: now };
      const i = shown.findIndex((o) => norm(o.label).startsWith(typed.current.text));
      if (i >= 0) setActive(i);
    }
  };

  return (
    <>
      <button ref={triggerRef} id={id} type="button" disabled={disabled}
        className={variant === 'filter' ? `sel-filter${value ? ' active' : ''}` : 'input sel-trigger'}
        role="combobox" aria-haspopup="listbox" aria-expanded={open} aria-controls={open ? listId : undefined}
        aria-activedescendant={open && !canSearch && shown[active] ? optionId(active) : undefined}
        aria-label={aria['aria-label']} aria-describedby={aria['aria-describedby']} aria-invalid={aria['aria-invalid']}
        onClick={() => (open ? close() : openList())} onKeyDown={onKey}>
        {variant === 'filter' && label && <span className="sel-filter-label">{label}</span>}
        <span className={`sel-value${selected && selected.value !== '' || variant === 'filter' ? '' : ' sel-placeholder'}`}>
          {selected?.label ?? placeholder}
        </span>
        <ChevronDown size={15} className="sel-chevron" aria-hidden />
      </button>

      {open && pos && (
        <div ref={popRef} className="sel-pop"
          style={{ left: pos.left, width: pos.width, top: pos.top, bottom: pos.bottom, maxHeight: pos.maxHeight }}>
          {canSearch && (
            <div className="sel-search">
              <Search size={14} aria-hidden />
              <input ref={searchRef} value={query} onChange={(e) => setQuery(e.target.value)} onKeyDown={onKey}
                placeholder="Search" aria-label="Search options" role="searchbox" aria-controls={listId}
                aria-activedescendant={shown[active] ? optionId(active) : undefined} />
            </div>
          )}
          <ul id={listId} role="listbox" className="sel-list" aria-label={label ?? aria['aria-label']}>
            {shown.length === 0 && <li className="sel-none">No matches</li>}
            {shown.map((o, i) => (
              <li key={o.value || '∅'} id={optionId(i)} role="option" aria-selected={o.value === value}
                className={`sel-option${i === active ? ' active' : ''}${o.value === '' ? ' sel-empty' : ''}`}
                onMouseMove={() => setActive(i)} onMouseDown={(e) => e.preventDefault()} onClick={() => choose(o)}>
                <span>{o.label}</span>
                {o.value === value && <Check size={14} className="sel-check" aria-hidden />}
              </li>
            ))}
          </ul>
        </div>
      )}
    </>
  );
}
