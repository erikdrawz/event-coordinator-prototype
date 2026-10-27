import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { Check, ChevronDown, Search, X } from 'lucide-react';
import { usePopover } from './usePopover';
import type { SelectOption } from './Select';
import './select.css';

interface Props {
  value: string[];
  options: SelectOption[];
  onChange: (value: string[]) => void;
  /** Shown when nothing is chosen, e.g. "All products" when an empty choice means all. */
  placeholder?: string;
  /** Chips shown in the field before collapsing to "+N more". */
  maxChips?: number;
  id?: string;
  disabled?: boolean;
  'aria-label'?: string;
  'aria-describedby'?: string;
}

const norm = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

/** Pick several values from a list: chips in the field, a searchable checklist in the popup. */
export function MultiSelect({ value, options, onChange, placeholder = 'None', maxChips = 6, id, disabled, ...aria }: Props) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const { triggerRef, popRef, style } = usePopover<HTMLDivElement>(open, () => setOpen(false), { maxHeight: 360 });
  const searchRef = useRef<HTMLInputElement>(null);
  const listId = useId();

  const shown = useMemo(() => (query ? options.filter((o) => norm(o.label).includes(norm(query))) : options), [options, query]);
  const labels = new Map(options.map((o) => [o.value, o.label]));
  const chosen = value.filter((v) => labels.has(v));
  const placed = Boolean(style);

  useEffect(() => { if (open && placed) searchRef.current?.focus(); }, [open, placed]);
  useEffect(() => { setActive(0); }, [query]);
  useEffect(() => {
    if (open && placed) popRef.current?.querySelector(`#${CSS.escape(`${listId}-${active}`)}`)?.scrollIntoView({ block: 'nearest' });
  }, [open, placed, active]);

  const toggle = (v: string) => onChange(value.includes(v) ? value.filter((x) => x !== v) : [...value, v]);
  const close = () => { setOpen(false); triggerRef.current?.focus(); };

  const onKey = (e: KeyboardEvent) => {
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(); }
    else if (e.key === 'ArrowDown') { e.preventDefault(); setActive((i) => Math.min(shown.length - 1, i + 1)); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setActive((i) => Math.max(0, i - 1)); }
    else if (e.key === 'Enter') { e.preventDefault(); if (shown[active]) toggle(shown[active].value); }
    else if (e.key === 'Tab') setOpen(false);
  };

  return (
    <>
      <div ref={triggerRef} id={id} role="combobox" tabIndex={disabled ? -1 : 0} aria-haspopup="listbox" aria-expanded={open}
        aria-controls={open ? listId : undefined} aria-disabled={disabled || undefined} {...aria}
        className={`input ms-trigger${disabled ? ' ms-disabled' : ''}`}
        onClick={(e) => { if (!disabled && !(e.target as HTMLElement).closest('.ms-chip-x')) setOpen((o) => !o); }}
        onKeyDown={(e) => { if (!disabled && ['Enter', ' ', 'ArrowDown'].includes(e.key)) { e.preventDefault(); setOpen(true); } }}>
        {chosen.length === 0 ? <span className="sel-placeholder ms-placeholder">{placeholder}</span> : (
          <span className="ms-chips">
            {chosen.slice(0, maxChips).map((v) => (
              <span key={v} className="ms-chip">
                {labels.get(v)}
                {!disabled && <button type="button" className="ms-chip-x" aria-label={`Remove ${labels.get(v)}`} tabIndex={-1}
                  onClick={() => toggle(v)}><X size={12} /></button>}
              </span>
            ))}
            {chosen.length > maxChips && <span className="ms-more">+{chosen.length - maxChips} more</span>}
          </span>
        )}
        <ChevronDown size={15} className="sel-chevron" aria-hidden />
      </div>

      {open && style && (
        <div ref={popRef} className="sel-pop" style={style}>
          <div className="sel-search">
            <Search size={14} aria-hidden />
            <input ref={searchRef} value={query} onChange={(e) => setQuery(e.target.value)} onKeyDown={onKey}
              placeholder="Search" aria-label="Search options" aria-controls={listId}
              aria-activedescendant={shown[active] ? `${listId}-${active}` : undefined} />
          </div>
          <div className="ms-bulk">
            <span>{value.length} selected</span>
            <span>
              <button type="button" className="link" onClick={() => onChange([...new Set([...value, ...shown.map((o) => o.value)])])}>
                {query ? 'Select matches' : 'Select all'}
              </button>
              {value.length > 0 && <button type="button" className="link" onClick={() => onChange([])}>Clear</button>}
            </span>
          </div>
          <ul id={listId} role="listbox" aria-multiselectable className="sel-list">
            {shown.length === 0 && <li className="sel-none">No matches</li>}
            {shown.map((o, i) => {
              const on = value.includes(o.value);
              return (
                <li key={o.value} id={`${listId}-${i}`} role="option" aria-selected={on}
                  className={`sel-option ms-option${i === active ? ' active' : ''}`}
                  onMouseMove={() => setActive(i)} onMouseDown={(e) => e.preventDefault()} onClick={() => toggle(o.value)}>
                  <span className={`ms-box${on ? ' on' : ''}`} aria-hidden>{on && <Check size={12} strokeWidth={3} />}</span>
                  <span className="ms-label">{o.label}</span>
                </li>
              );
            })}
          </ul>
        </div>
      )}
    </>
  );
}
