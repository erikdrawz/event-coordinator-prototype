import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { Check, ChevronDown, Search } from 'lucide-react';
import { usePopover } from './usePopover';
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
 * Esc, and type-to-jump (or type-to-search when searchable). Positioning comes from usePopover.
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
  const { triggerRef, popRef, style } = usePopover<HTMLButtonElement>(open, () => close(false), { minWidth: variant === 'filter' ? 220 : 0 });
  const searchRef = useRef<HTMLInputElement>(null);
  const typed = useRef({ text: '', at: 0 });
  const listId = useId();

  const shown = useMemo(() => (canSearch && query ? all.filter((o) => norm(o.label).includes(norm(query))) : all), [all, canSearch, query]);
  const selected = all.find((o) => o.value === value);
  const optionId = (i: number) => `${listId}-${i}`;

  const openList = () => {
    if (disabled) return;
    setQuery('');
    setActive(Math.max(0, all.findIndex((o) => o.value === value)));
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

  // The list is placed one render after opening; wait for that before focusing or scrolling in it
  const placed = Boolean(style);
  useEffect(() => { if (open && placed && canSearch) searchRef.current?.focus(); }, [open, placed, canSearch]);
  useEffect(() => { setActive(0); }, [query]);
  useEffect(() => {
    if (open && placed) popRef.current?.querySelector(`#${CSS.escape(optionId(active))}`)?.scrollIntoView({ block: 'nearest' });
  }, [open, placed, active]);

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

      {open && style && (
        <div ref={popRef} className="sel-pop" style={style}>
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
