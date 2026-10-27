import { Plus } from 'lucide-react';

export const dayLabel = (d: string) => new Date(`${d}T00:00:00Z`).toLocaleDateString('en-GB', { timeZone: 'UTC', weekday: 'short', day: 'numeric', month: 'short' }).replace('Sept', 'Sep');
export const nextDay = (d: string) => new Date(Date.parse(`${d}T00:00:00Z`) + 86400000).toISOString().slice(0, 10);

/** The event's own dates (in its zone) plus any other days given, sorted. */
export function agendaDays(eventStart: string | null, eventEnd: string | null, others: string[]) {
  const set = new Set(others);
  if (eventStart) {
    const last = eventEnd ?? eventStart;
    for (let d = eventStart, i = 0; d <= last && i < 14; i++, d = nextDay(d)) set.add(d);
  }
  return [...set].sort();
}

/** Day tabs over the agenda; "+" adds the next day (edit mode only). */
export function AgendaDays({ days, current, onPick, onAddDay }: {
  days: string[]; current: string | null; onPick: (d: string) => void; onAddDay?: () => void;
}) {
  if (days.length === 0 || (days.length === 1 && !onAddDay)) return null;
  return (
    <div className="segmented agenda-days" role="tablist" aria-label="Agenda day">
      {days.map((d, i) => (
        <button key={d} type="button" role="tab" aria-selected={d === current} aria-pressed={d === current} onClick={() => onPick(d)}>
          Day {i + 1}<span className="agenda-day-date">{dayLabel(d)}</span>
        </button>
      ))}
      {onAddDay && <button type="button" className="agenda-add-day" aria-label="Add a day" title="Add a day" onClick={onAddDay}><Plus size={13} strokeWidth={2.6} /></button>}
    </div>
  );
}
