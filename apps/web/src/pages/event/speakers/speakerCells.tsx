import { useEffect, useState } from 'react';
import { currencySymbol, hours, money, rateRange, type RatePolicy } from './speakersData';

/** The honorarium inputs, shared by the Experts grid and the expert's side panel. */

export const rateProblem = (v: number, p: RatePolicy) =>
  Number.isNaN(v) ? 'Enter the rate as a number'
    : p.source === 'none' && v !== 0 ? "This expert has no FMV rate for the event's date. Record one on their expert page to set a rate"
    : p.mode === 'fixed' && v !== p.default ? `The rate is fixed at ${money(p.default, p.currency)} per hour`
      : v < p.min || v > p.max ? `The rate must be between ${money(p.min, p.currency)} and ${money(p.max, p.currency)} per hour` : null;

/** The hourly rate, editable within the rate policy; an out-of-range value is refused and put back. */
export function RateCell({ value, currency, policy, onSave, onInvalid, label, disabled }: {
  value: number | null; currency: string; policy: RatePolicy | undefined; onSave: (v: number) => void; onInvalid: (m: string) => void; label: string; disabled?: boolean;
}) {
  const shown = value == null ? '' : String(value);
  const [text, setText] = useState(shown);
  useEffect(() => setText(shown), [shown]);
  if (disabled || policy?.mode === 'fixed') {
    const tip = policy?.source === 'none' ? rateRange(policy) : undefined;
    return <span data-tip={tip} tabIndex={tip ? 0 : undefined}>{value != null ? money(value, currency) : '—'}</span>;
  }
  const commit = () => {
    if (text.trim() === '') { setText(shown); return; }
    const v = Math.round(Number(text.replace(',', '.')) * 100) / 100;
    const bad = policy ? rateProblem(v, policy) : null;
    if (bad) { onInvalid(bad); setText(shown); return; }
    setText(String(v));
    if (v !== value) onSave(v);
  };
  return (
    <span className="money-input" data-tip={policy ? rateRange(policy) : undefined}>
      <span aria-hidden>{currencySymbol(currency)}</span>
      <input className="hours-input" inputMode="decimal" aria-label={label} value={text}
        onChange={(e) => setText(e.target.value)} onBlur={commit}
        onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); (e.target as HTMLInputElement).blur(); } if (e.key === 'Escape') setText(shown); }} />
    </span>
  );
}

/** Read-only: service hours come from the agenda. */
export function ServiceHours({ value, sessions }: { value: number; sessions: number }) {
  const tip = sessions ? `From the agenda: ${sessions} session${sessions === 1 ? '' : 's'}` : 'From the agenda';
  return <span className="service-h" tabIndex={0} data-tip={tip} aria-label={`${hours(value)} service hours, ${tip.toLowerCase()}`}>{hours(value)}</span>;
}

/** An hours figure typed straight into the grid; saves on Enter or when leaving the field. */
export function HoursCell({ value, onSave, label, disabled }: { value: number; onSave: (v: number) => void; label: string; disabled?: boolean }) {
  const [text, setText] = useState(hours(value));
  useEffect(() => setText(hours(value)), [value]);
  if (disabled) return <>{hours(value)}</>;
  const commit = () => {
    const v = text.trim() === '' ? 0 : Number(text.replace(',', '.'));
    if (Number.isNaN(v) || v < 0) { setText(hours(value)); return; }
    const rounded = Math.round(v * 100) / 100;
    setText(hours(rounded));
    if (rounded !== value) onSave(rounded);
  };
  return (
    <input className="hours-input" inputMode="decimal" aria-label={label} value={text}
      onChange={(e) => setText(e.target.value)} onBlur={commit}
      onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); (e.target as HTMLInputElement).blur(); } if (e.key === 'Escape') { setText(hours(value)); } }} />
  );
}
