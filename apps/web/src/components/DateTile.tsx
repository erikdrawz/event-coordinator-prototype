import { eventDateParts } from '../lib/format';

export function DateTile({ iso, timeZone, muted, size }: { iso: string; timeZone: string; muted?: boolean; size?: 'sm' }) {
  const p = eventDateParts(iso, timeZone);
  const cls = size === 'sm' ? 'date-tile-sm' : `date-tile${muted ? ' muted' : ''}`;
  return (
    <span className={cls} aria-label={`${p.day} ${p.monthLong}`}>
      <span className="date-tile-month">{p.month}</span>
      <span className="date-tile-day">{p.day}</span>
    </span>
  );
}
