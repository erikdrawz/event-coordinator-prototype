const rtf = new Intl.RelativeTimeFormat('en', { numeric: 'auto' });

/** "2 hours ago", "yesterday", "3 days ago". */
export function timeAgo(iso: string, now = new Date()): string {
  const diff = (new Date(iso).getTime() - now.getTime()) / 1000;
  const abs = Math.abs(diff);
  if (abs < 60) return 'just now';
  if (abs < 3600) return rtf.format(Math.round(diff / 60), 'minute');
  if (abs < 86400) return rtf.format(Math.round(diff / 3600), 'hour');
  if (abs < 86400 * 30) return rtf.format(Math.round(diff / 86400), 'day');
  return new Date(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
}

/** Parts of a date in the event's own time zone, for date tiles and headers. */
export function eventDateParts(iso: string, timeZone: string) {
  const d = new Date(iso);
  const get = (o: Intl.DateTimeFormatOptions) => new Intl.DateTimeFormat('en-GB', { ...o, timeZone }).format(d);
  return {
    month: get({ month: 'short' }),
    day: get({ day: 'numeric' }),
    weekday: get({ weekday: 'short' }),
    time: get({ hour: '2-digit', minute: '2-digit', hour12: false }),
    monthLong: get({ month: 'long' }),
  };
}

/** Whole days from today (local) to an instant; negative in the past. */
export function daysUntil(iso: string, now = new Date()): number {
  const start = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const d = new Date(iso);
  const target = new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  return Math.round((target - start) / 86400000);
}
