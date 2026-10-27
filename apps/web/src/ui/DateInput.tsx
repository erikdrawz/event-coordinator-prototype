import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { CalendarDays, ChevronLeft, ChevronRight, Clock } from 'lucide-react';
import { usePopover } from './usePopover';
import './select.css';
import './date-input.css';

/** Same week layout as the Home calendar. */
export const WEEK_STARTS_ON = 0; // 0 = Sunday
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

// Dates are plain 'YYYY-MM-DD' strings, handled in UTC so no time zone can shift them
const parse = (s: string) => new Date(`${s}T00:00:00Z`);
const fmt = (d: Date) => d.toISOString().slice(0, 10);
const addDays = (s: string, n: number) => { const d = parse(s); d.setUTCDate(d.getUTCDate() + n); return fmt(d); };
const addMonths = (s: string, n: number) => {
  const d = parse(s); const day = d.getUTCDate();
  d.setUTCDate(1); d.setUTCMonth(d.getUTCMonth() + n);
  d.setUTCDate(Math.min(day, new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate()));
  return fmt(d);
};
const todayStr = () => { const t = new Date(); return fmt(new Date(Date.UTC(t.getFullYear(), t.getMonth(), t.getDate()))); };
export const formatDate = (s: string) =>
  parse(s).toLocaleDateString('en-GB', { timeZone: 'UTC', weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' }).replace('Sept', 'Sep');

interface A11y { id?: string; 'aria-describedby'?: string; 'aria-invalid'?: boolean; 'aria-label'?: string }

/** A date field with a calendar popup. Value is 'YYYY-MM-DD' or ''. */
export function DateInput({ value, onChange, min, placeholder = 'Choose a date', ...a11y }:
  { value: string; onChange: (v: string) => void; min?: string; placeholder?: string } & A11y) {
  const [open, setOpen] = useState(false);
  const [focus, setFocus] = useState(value || todayStr());
  const { triggerRef, popRef, style } = usePopover<HTMLButtonElement>(open, () => setOpen(false), { width: 296, maxHeight: 380 });
  const gridRef = useRef<HTMLDivElement>(null);

  const openCal = () => { setFocus(value || (min && min > todayStr() ? min : todayStr())); setOpen(true); };
  const close = () => { setOpen(false); triggerRef.current?.focus(); };
  const pick = (d: string) => { if (min && d < min) return; onChange(d); close(); };

  // The popup is placed one render after opening, so wait for `style` before moving focus into it
  const placed = Boolean(style);
  useEffect(() => { if (open && placed) gridRef.current?.querySelector<HTMLElement>(`[data-day="${focus}"]`)?.focus(); }, [open, placed, focus]);

  const month = focus.slice(0, 7);
  const days = useMemo(() => {
    const first = parse(`${month}-01`);
    const start = addDays(`${month}-01`, -((first.getUTCDay() - WEEK_STARTS_ON + 7) % 7));
    return Array.from({ length: 42 }, (_, i) => addDays(start, i));
  }, [month]);

  const onGridKey = (e: KeyboardEvent) => {
    const moves: Record<string, () => string> = {
      ArrowLeft: () => addDays(focus, -1), ArrowRight: () => addDays(focus, 1),
      ArrowUp: () => addDays(focus, -7), ArrowDown: () => addDays(focus, 7),
      PageUp: () => addMonths(focus, -1), PageDown: () => addMonths(focus, 1),
      Home: () => addDays(focus, -((parse(focus).getUTCDay() - WEEK_STARTS_ON + 7) % 7)),
      End: () => addDays(focus, 6 - ((parse(focus).getUTCDay() - WEEK_STARTS_ON + 7) % 7)),
    };
    if (moves[e.key]) { e.preventDefault(); setFocus(moves[e.key]()); }
    else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(); }
  };

  const today = todayStr();
  return (
    <>
      <button ref={triggerRef} type="button" className="input di-trigger" aria-haspopup="dialog" aria-expanded={open}
        {...a11y} onClick={() => (open ? close() : openCal())}
        onKeyDown={(e) => { if (e.key === 'ArrowDown') { e.preventDefault(); openCal(); } }}>
        <CalendarDays size={15} className="di-icon" aria-hidden />
        <span className={value ? 'di-value' : 'di-value di-placeholder'}>{value ? formatDate(value) : placeholder}</span>
      </button>
      {open && style && (
        <div ref={popRef} className="di-pop" style={style} role="dialog" aria-label="Choose a date">
          <div className="di-head">
            <button type="button" className="di-nav" aria-label="Previous month" onClick={() => setFocus(addMonths(focus, -1))}><ChevronLeft size={15} /></button>
            <span className="di-month" aria-live="polite">{parse(focus).toLocaleDateString('en-GB', { timeZone: 'UTC', month: 'long', year: 'numeric' })}</span>
            <button type="button" className="di-nav" aria-label="Next month" onClick={() => setFocus(addMonths(focus, 1))}><ChevronRight size={15} /></button>
          </div>
          <div className="di-grid di-weekdays" aria-hidden>
            {Array.from({ length: 7 }, (_, i) => <span key={i}>{WEEKDAYS[(i + WEEK_STARTS_ON) % 7]}</span>)}
          </div>
          <div ref={gridRef} className="di-grid" role="grid" onKeyDown={onGridKey}>
            {days.map((d) => {
              const disabled = Boolean(min && d < min);
              const cls = ['di-day', d.slice(0, 7) !== month && 'outside', d === today && 'today', d === value && 'selected'].filter(Boolean).join(' ');
              return (
                <button key={d} type="button" data-day={d} className={cls} disabled={disabled} tabIndex={d === focus ? 0 : -1}
                  aria-label={formatDate(d)} aria-pressed={d === value} onClick={() => pick(d)}>
                  {Number(d.slice(8))}
                </button>
              );
            })}
          </div>
          <div className="di-foot">
            <button type="button" className="link" onClick={() => pick(min && today < min ? min : today)}>Today</button>
            {value && <button type="button" className="link di-clear" onClick={() => { onChange(''); close(); }}>Clear</button>}
          </div>
        </div>
      )}
    </>
  );
}

const SLOTS = Array.from({ length: 96 }, (_, i) => `${String(Math.floor(i / 4)).padStart(2, '0')}:${String((i % 4) * 15).padStart(2, '0')}`);

/** Reads "930", "9:30", "09.30", "21", "9:30 pm" as 'HH:mm'; null if it isn't a time. */
export function parseTime(raw: string): string | null {
  const m = raw.trim().toLowerCase().match(/^(\d{1,2})(?:[:.h ]?(\d{2}))?\s*(am|pm)?$/);
  if (!m) return null;
  let h = Number(m[1]); const min = Number(m[2] ?? 0);
  if (m[3] === 'pm' && h < 12) h += 12;
  if (m[3] === 'am' && h === 12) h = 0;
  if (h > 23 || min > 59) return null;
  return `${String(h).padStart(2, '0')}:${String(min).padStart(2, '0')}`;
}

/** A 24-hour time field: type it, or pick from 15-minute steps. Value is 'HH:mm' or ''. */
export function TimeInput({ value, onChange, disabled, ...a11y }: { value: string; onChange: (v: string) => void; disabled?: boolean } & A11y) {
  const [open, setOpen] = useState(false);
  const [text, setText] = useState(value);
  const { triggerRef, popRef, style } = usePopover<HTMLInputElement>(open, () => setOpen(false), { width: 120, maxHeight: 240 });
  const listRef = useRef<HTMLUListElement>(null);

  useEffect(() => setText(value), [value]);
  const placed = Boolean(style);
  useEffect(() => {
    if (!open || !placed) return;
    const near = SLOTS.find((s) => s >= (value || '09:00')) ?? SLOTS[0];
    listRef.current?.querySelector(`[data-slot="${near}"]`)?.scrollIntoView({ block: 'center' });
  }, [open, placed, value]);

  const commit = () => {
    if (text.trim() === '') { if (value) onChange(''); return; }
    const t = parseTime(text);
    if (t) { if (t !== value) onChange(t); setText(t); } else setText(value);
  };
  const pick = (s: string) => { onChange(s); setText(s); setOpen(false); triggerRef.current?.focus(); };

  return (
    <span className="ti-wrap">
      <Clock size={15} className="ti-icon" aria-hidden />
      <input ref={triggerRef} className="input ti-input" inputMode="numeric" placeholder="--:--" value={text} disabled={disabled} {...a11y}
        autoComplete="off" aria-haspopup="listbox" aria-expanded={open}
        onChange={(e) => setText(e.target.value)} onFocus={() => setOpen(true)} onClick={() => setOpen(true)}
        onBlur={(e) => { if (!popRef.current?.contains(e.relatedTarget as Node)) { commit(); setOpen(false); } }}
        onKeyDown={(e) => {
          if (e.key === 'Enter') { e.preventDefault(); commit(); setOpen(false); }
          // Tab moves on with the typed time (the list isn't a tab stop)
          else if (e.key === 'Tab') { commit(); setOpen(false); }
          else if (e.key === 'Escape' && open) { e.preventDefault(); e.stopPropagation(); setText(value); setOpen(false); }
          else if (e.key === 'ArrowDown') { e.preventDefault(); setOpen(true); listRef.current?.querySelector<HTMLElement>('[aria-selected="true"], li')?.focus(); }
        }} />
      {open && style && (
        <div ref={popRef} className="sel-pop" style={style}>
          <ul ref={listRef} className="sel-list" role="listbox" aria-label="Times" tabIndex={-1}>
            {SLOTS.map((s) => (
              <li key={s} data-slot={s} role="option" tabIndex={-1} aria-selected={s === value}
                className="sel-option ti-option" onMouseDown={(e) => e.preventDefault()} onClick={() => pick(s)}
                onKeyDown={(e) => {
                  const li = e.currentTarget;
                  if (e.key === 'ArrowDown') { e.preventDefault(); (li.nextElementSibling as HTMLElement | null)?.focus(); }
                  else if (e.key === 'ArrowUp') { e.preventDefault(); (li.previousElementSibling as HTMLElement | null)?.focus(); }
                  else if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); pick(s); }
                  else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); setOpen(false); triggerRef.current?.focus(); }
                }}>
                {s}
              </li>
            ))}
          </ul>
        </div>
      )}
    </span>
  );
}

/**
 * Date + time side by side. Value is 'YYYY-MM-DDTHH:mm' or ''. Picking a date without a time
 * uses defaultTime; the time field waits for a date.
 */
export function DateTimeInput({ value, onChange, min, defaultTime = '09:00', ...a11y }:
  { value: string; onChange: (v: string) => void; min?: string; defaultTime?: string } & A11y) {
  const [date, time] = value ? value.split('T') : ['', ''];
  return (
    <div className="dti">
      <DateInput {...a11y} value={date} min={min?.slice(0, 10)} onChange={(d) => onChange(d ? `${d}T${time || defaultTime}` : '')} />
      <TimeInput aria-label="Time" disabled={!date} value={time ?? ''} onChange={(t) => date && onChange(`${date}T${t || defaultTime}`)} />
    </div>
  );
}
