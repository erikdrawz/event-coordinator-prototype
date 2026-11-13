import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Link } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { CalendarDays, CheckSquare, ChevronLeft, ChevronRight, FileCheck, MapPin, X } from 'lucide-react';
import { ymdInZone } from '../../lib/format';
import { StatusPill } from '../../components/StatusPill';
import { useTeamRoles } from '../event/team/teamData';
import { calendarQuery, monthGrid, useCalendarEvents, useMyApprovals, useMyTasks, type AgendaEvent, type MyTask, type PendingApproval, type Scope } from './queries';

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const CARD_WIDTH = 300;
const CLOSE_DELAY = 220;

interface DayItems {
  events: { e: AgendaEvent; day: number; days: number }[];
  approvals: PendingApproval[];
  tasks: MyTask[];
}
const count = (d: DayItems | undefined) => d ? d.events.length + d.approvals.length + d.tasks.length : 0;
const addDays = (ymd: string, n: number) => { const d = new Date(`${ymd}T12:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
const dayDiff = (a: string, b: string) => Math.round((Date.parse(`${b}T12:00:00Z`) - Date.parse(`${a}T12:00:00Z`)) / 86400000);
const timeIn = (iso: string, tz: string) => new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit', hour12: false, timeZone: tz }).format(new Date(iso));
const zoneName = (iso: string, tz: string) =>
  new Intl.DateTimeFormat('en-GB', { timeZone: tz, timeZoneName: 'short' }).formatToParts(new Date(iso)).find((p) => p.type === 'timeZoneName')?.value ?? '';

/** What's on one day: events (time in their own zone, where, what, your role), approvals and tasks. */
function DayCard({ ymd, items, pinned, roleLabel, style, onClose, onEnter, onLeave, cardRef }: {
  ymd: string; items: DayItems; pinned: boolean; roleLabel: (code: string) => string; style: React.CSSProperties;
  onClose: () => void; onEnter: () => void; onLeave: () => void; cardRef: React.RefObject<HTMLDivElement | null>;
}) {
  const title = new Date(`${ymd}T12:00:00Z`).toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', timeZone: 'UTC' });
  return createPortal(
    <div ref={cardRef} className={`cal-card${pinned ? ' pinned' : ''}`} style={style} role="dialog" aria-label={title}
      onPointerEnter={onEnter} onPointerLeave={onLeave}>
      <div className="cal-card-head">
        <span className="cal-card-title">{title}</span>
        {pinned && <button type="button" className="icon-button cal-card-close" aria-label="Close" onClick={onClose}><X size={15} /></button>}
      </div>
      {items.events.map(({ e, day, days }) => {
        const role = e.event_team_member[0]?.team_role;
        const where = [e.venue_name, e.city, e.country_code].filter(Boolean).join(', ');
        const time = day === 1
          ? `${timeIn(e.starts_at, e.timezone)}${e.ends_at && days === 1 ? `–${timeIn(e.ends_at, e.timezone)}` : ''} ${zoneName(e.starts_at, e.timezone)}`
          : day === days && e.ends_at ? `Until ${timeIn(e.ends_at, e.timezone)} ${zoneName(e.ends_at, e.timezone)}` : 'All day';
        return (
          <Link key={e.id} to={`/events/${e.id}`} className="cal-item" onClick={onClose}>
            <CalendarDays size={15} className="cal-item-icon ev" aria-hidden />
            <span className="cal-item-main">
              <span className="cal-item-title">{e.name}</span>
              <span className="cal-item-line">{time}{days > 1 && ` · day ${day} of ${days}`}</span>
              {where && <span className="cal-item-line"><MapPin size={11} aria-hidden />{where}</span>}
              <span className="cal-item-line">{[e.event_type?.name, role ? `you're ${roleLabel(role).toLowerCase()}` : e.owner && `owner ${e.owner.display_name}`].filter(Boolean).join(' · ')}</span>
            </span>
            <StatusPill status={e.status} variant="home" />
          </Link>
        );
      })}
      {items.approvals.map((a) => a.request && (
        <Link key={a.id} to={a.request.path} className="cal-item" onClick={onClose}>
          <FileCheck size={15} className="cal-item-icon req" aria-hidden />
          <span className="cal-item-main">
            <span className="cal-item-title">{a.request.title}</span>
            <span className="cal-item-line">Request waiting for your approval{a.submitter && ` · from ${a.submitter.display_name}`}</span>
          </span>
        </Link>
      ))}
      {items.tasks.map((t) => (
        <Link key={t.id} to={t.event ? `/events/${t.event.id}?tab=team` : '/'} className="cal-item" onClick={onClose}>
          <CheckSquare size={15} className="cal-item-icon task" aria-hidden />
          <span className="cal-item-main">
            <span className="cal-item-title">{t.title}</span>
            <span className="cal-item-line">{ymd < ymdInZone(new Date()) ? 'Your task is overdue' : 'Your task is due'}{t.event && ` · ${t.event.name}`}</span>
          </span>
        </Link>
      ))}
      {!pinned && <div className="cal-card-hint">Click the day to keep this open</div>}
    </div>,
    document.body,
  );
}

/**
 * Month view with a dot per thing on each day: events in the agenda's scope (every day they run, in
 * the event's time zone), requests waiting on my approval (their date), and my open tasks (due date).
 * Hovering or focusing a day shows what's on it at once; clicking keeps the card open to follow a link.
 * Neighbouring months are fetched ahead, so moving between months is instant.
 */
export function MiniCalendar({ meId, scope }: { meId: string; scope: Scope }) {
  const qc = useQueryClient();
  const [month, setMonth] = useState(() => { const d = new Date(); return new Date(d.getFullYear(), d.getMonth(), 1); });
  const { start: gridStart, weeks } = monthGrid(month);
  const { data: events } = useCalendarEvents(meId, scope, month);
  const { data: approvals } = useMyApprovals(meId);
  const { data: tasks } = useMyTasks(meId);
  const roles = useTeamRoles();
  const roleLabel = (code: string) => roles.data?.find((r) => r.code === code)?.label ?? code;

  // Fetch the months either side before they're asked for
  useEffect(() => {
    for (const n of [-1, 1]) qc.prefetchQuery(calendarQuery(meId, scope, new Date(month.getFullYear(), month.getMonth() + n, 1)));
  }, [qc, meId, scope, month]);

  const byDay = useMemo(() => {
    const m = new Map<string, DayItems>();
    const at = (key: string) => { let d = m.get(key); if (!d) m.set(key, d = { events: [], approvals: [], tasks: [] }); return d; };
    events?.forEach((e) => {
      const first = ymdInZone(e.starts_at, e.timezone);
      // An event ending at midnight doesn't run into the next day
      const last = e.ends_at ? ymdInZone(new Date(new Date(e.ends_at).getTime() - 60000), e.timezone) : first;
      const days = Math.max(1, Math.min(31, dayDiff(first, last) + 1));
      for (let i = 0; i < days; i++) at(addDays(first, i)).events.push({ e, day: i + 1, days });
    });
    approvals?.forEach((a) => a.request?.event_date && at(a.request.event_date).approvals.push(a));
    tasks?.forEach((t) => t.due_date && at(t.due_date).tasks.push(t));
    return m;
  }, [events, approvals, tasks]);

  // The open card: which day, whether it was clicked open, and where it goes
  const [open, setOpen] = useState<{ ymd: string; pinned: boolean } | null>(null);
  const [style, setStyle] = useState<React.CSSProperties>({});
  const calRef = useRef<HTMLElement>(null);
  const cardRef = useRef<HTMLDivElement>(null);
  const cellRefs = useRef(new Map<string, HTMLButtonElement>());
  const closeTimer = useRef<number | undefined>(undefined);
  const keep = () => window.clearTimeout(closeTimer.current);
  const closeSoon = () => { keep(); closeTimer.current = window.setTimeout(() => setOpen((o) => (o?.pinned ? o : null)), CLOSE_DELAY); };
  useEffect(() => () => window.clearTimeout(closeTimer.current), []);

  // Beside the calendar when there's room, so moving across days isn't covered; else under the day
  useLayoutEffect(() => {
    if (!open) return;
    const place = () => {
      const cell = cellRefs.current.get(open.ymd)?.getBoundingClientRect();
      const cal = calRef.current?.getBoundingClientRect();
      if (!cell || !cal) return;
      const h = cardRef.current?.offsetHeight ?? 200;
      const beside = window.innerWidth - cal.right >= CARD_WIDTH + 16;
      const left = beside ? cal.right + 8 : Math.max(8, Math.min(cell.left, window.innerWidth - CARD_WIDTH - 8));
      const want = beside ? cell.top - 12 : cell.bottom + 6;
      setStyle({ left, width: Math.min(CARD_WIDTH, window.innerWidth - 16), top: Math.max(8, Math.min(want, window.innerHeight - h - 8)) });
    };
    place();
    window.addEventListener('resize', place);
    window.addEventListener('scroll', place, true);
    return () => { window.removeEventListener('resize', place); window.removeEventListener('scroll', place, true); };
  }, [open, byDay]);

  // A clicked-open card closes on Esc or a click elsewhere
  useEffect(() => {
    if (!open?.pinned) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { setOpen(null); cellRefs.current.get(open.ymd)?.focus(); } };
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node;
      if (!cardRef.current?.contains(t) && ![...cellRefs.current.values()].some((c) => c.contains(t))) setOpen(null);
    };
    document.addEventListener('keydown', onKey);
    document.addEventListener('mousedown', onDown);
    return () => { document.removeEventListener('keydown', onKey); document.removeEventListener('mousedown', onDown); };
  }, [open]);

  const todayKey = ymdInZone(new Date());
  const days = Array.from({ length: weeks * 7 }, (_, i) => new Date(gridStart.getFullYear(), gridStart.getMonth(), gridStart.getDate() + i));
  const shift = (n: number) => { setOpen(null); setMonth(new Date(month.getFullYear(), month.getMonth() + n, 1)); };
  const openItems = open ? byDay.get(open.ymd) : undefined;

  return (
    <section className="card home-cal" aria-label="Calendar" ref={calRef}>
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
          const items = byDay.get(key);
          const n = count(items);
          const cls = ['home-cal-day', d.getMonth() !== month.getMonth() && 'outside', key === todayKey && 'today', n && 'has-items',
                       open?.ymd === key && 'open'].filter(Boolean).join(' ');
          const label = `${d.getDate()} ${d.toLocaleDateString('en-GB', { month: 'long' })}${n ? `, ${n} item${n > 1 ? 's' : ''}` : ''}`;
          const dots = (
            <span className="home-cal-dots">
              {items?.events.slice(0, 3).map((x) => <span key={x.e.id} className="home-cal-dot dot-event" />)}
              {(items?.approvals.length ?? 0) > 0 && <span className="home-cal-dot dot-request" />}
              {(items?.tasks.length ?? 0) > 0 && <span className="home-cal-dot dot-milestone" />}
            </span>
          );
          if (!n) return <div key={key} className={cls} aria-label={label}><span>{d.getDate()}</span>{dots}</div>;
          return (
            <button key={key} type="button" className={cls} aria-label={label} aria-expanded={open?.ymd === key}
              ref={(el) => { if (el) cellRefs.current.set(key, el); else cellRefs.current.delete(key); }}
              onPointerEnter={(e) => { if (e.pointerType === 'touch') return; keep(); setOpen((o) => (o?.pinned ? o : { ymd: key, pinned: false })); }}
              onPointerLeave={(e) => { if (e.pointerType !== 'touch') closeSoon(); }}
              onFocus={() => { keep(); setOpen((o) => (o?.pinned ? o : { ymd: key, pinned: false })); }}
              onBlur={(e) => { if (!cardRef.current?.contains(e.relatedTarget as Node)) closeSoon(); }}
              onClick={() => { keep(); setOpen((o) => (o?.ymd === key && o.pinned ? null : { ymd: key, pinned: true })); }}>
              <span>{d.getDate()}</span>{dots}
            </button>
          );
        })}
      </div>
      {open && openItems && (
        <DayCard ymd={open.ymd} items={openItems} pinned={open.pinned} roleLabel={roleLabel} style={style} cardRef={cardRef}
          onClose={() => setOpen(null)} onEnter={keep} onLeave={closeSoon} />
      )}
    </section>
  );
}
