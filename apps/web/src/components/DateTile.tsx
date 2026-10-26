import { eventDateParts } from '../lib/format';

export function DateTile({ iso, timeZone, muted }: { iso: string; timeZone: string; muted?: boolean }) {
  const p = eventDateParts(iso, timeZone);
  return (
    <span className={`date-tile${muted ? ' muted' : ''}`} aria-label={`${p.day} ${p.monthLong}`}>
      <span className="date-tile-month">{p.month}</span>
      <span className="date-tile-day">{p.day}</span>
    </span>
  );
}
