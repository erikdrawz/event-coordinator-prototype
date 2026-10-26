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
    // en-GB abbreviates September as "Sept"; tiles want three letters
    month: new Intl.DateTimeFormat('en-US', { month: 'short', timeZone }).format(d),
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

/** Compact age for chips: "just now", "40 min ago", "2 h ago", "5 d ago". */
export function shortAgo(iso: string, now = new Date()): string {
  const mins = Math.max(0, Math.round((now.getTime() - new Date(iso).getTime()) / 60000));
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins} min ago`;
  if (mins < 60 * 24) return `${Math.round(mins / 60)} h ago`;
  return `${Math.round(mins / 1440)} d ago`;
}

/** "due today", "due in 3 d", "overdue 4 d" for a date-only due date. */
export function dueLabel(dueDate: string, now = new Date()): { text: string; overdue: boolean } {
  const [y, m, d] = dueDate.split('-').map(Number);
  const days = daysUntil(new Date(y, m - 1, d).toISOString(), now);
  if (days < 0) return { text: `overdue ${-days} d`, overdue: true };
  if (days === 0) return { text: 'due today', overdue: false };
  return { text: `due in ${days} d`, overdue: false };
}

/** YYYY-MM-DD of an instant in a given time zone (calendar keys). */
export function ymdInZone(iso: string | Date, timeZone?: string): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(iso));
}
