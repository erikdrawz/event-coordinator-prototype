import { useMemo, useState } from 'react';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { ymdInZone } from '../../lib/format';
import { useCalendarEvents, useMyApprovals, useMyTasks, type Scope } from './queries';

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
type DotKind = 'event' | 'request' | 'milestone';
interface Mark { kind: DotKind; label: string }

/**
 * Month view with a dot per thing on each day: events in the agenda's scope (in the event's time zone),
 * requests waiting on my approval (their date), and my open tasks (due date).
 */
export function MiniCalendar({ meId, scope }: { meId: string; scope: Scope }) {
  const [month, setMonth] = useState(() => { const d = new Date(); return new Date(d.getFullYear(), d.getMonth(), 1); });

  // Six-row grid starting on the Sunday on/before the 1st, trimmed to the weeks the month needs
  const gridStart = new Date(month.getFullYear(), month.getMonth(), 1 - month.getDay());
  const weeks = Math.ceil((month.getDay() + new Date(month.getFullYear(), month.getMonth() + 1, 0).getDate()) / 7);
  const gridEnd = new Date(gridStart.getFullYear(), gridStart.getMonth(), gridStart.getDate() + weeks * 7);

  // Pad by a day either side so events near midnight in other zones still land
  const from = new Date(gridStart.getTime() - 86400000);
  const to = new Date(gridEnd.getTime() + 86400000);
  const { data: events } = useCalendarEvents(meId, scope, from, to);
  const { data: approvals } = useMyApprovals(meId);
  const { data: tasks } = useMyTasks(meId);

  const marks = useMemo(() => {
    const m = new Map<string, Mark[]>();
    const add = (key: string, mark: Mark) => m.set(key, [...(m.get(key) ?? []), mark]);
    events?.forEach((e) => add(ymdInZone(e.starts_at, e.timezone), { kind: 'event', label: e.name }));
    approvals?.forEach((a) => a.request?.event_date && add(a.request.event_date, { kind: 'request', label: `Request: ${a.request.title}` }));
    tasks?.forEach((t) => t.due_date && add(t.due_date, { kind: 'milestone', label: `Task: ${t.title}` }));
    return m;
  }, [events, approvals, tasks]);

  const todayKey = ymdInZone(new Date());
  const days = Array.from({ length: weeks * 7 }, (_, i) => new Date(gridStart.getFullYear(), gridStart.getMonth(), gridStart.getDate() + i));
  const shift = (n: number) => setMonth(new Date(month.getFullYear(), month.getMonth() + n, 1));

  return (
    <section className="card home-cal" aria-label="Calendar">
      <div className="home-cal-head">
        <span className="home-cal-title">{month.toLocaleDateString('en-GB', { month: 'long', year: 'numeric' })}</span>
        <div className="home-cal-nav">
          <button className="home-cal-btn" aria-label="Previous month" onClick={() => shift(-1)}><ChevronLeft size={14} /></button>
          <button className="home-cal-btn" aria-label="Next month" onClick={() => shift(1)}><ChevronRight size={14} /></button>
        </div>
      </div>
      <div className="home-cal-grid home-cal-weekdays">
        {WEEKDAYS.map((d) => <div key={d}>{d}</div>)}
      </div>
      <div className="home-cal-grid">
        {days.map((d) => {
          const key = ymdInZone(d);
          const items = marks.get(key) ?? [];
          const cls = ['home-cal-day', d.getMonth() !== month.getMonth() && 'outside', key === todayKey && 'today'].filter(Boolean).join(' ');
          return (
            <div key={key} className={cls} title={items.map((i) => i.label).join('\n') || undefined}
              aria-label={`${d.getDate()} ${d.toLocaleDateString('en-GB', { month: 'long' })}${items.length ? `, ${items.length} item${items.length > 1 ? 's' : ''}` : ''}`}>
              <span>{d.getDate()}</span>
              <span className="home-cal-dots">
                {items.slice(0, 3).map((i, n) => <span key={n} className={`home-cal-dot dot-${i.kind}`} />)}
              </span>
            </div>
          );
        })}
      </div>
    </section>
  );
}
