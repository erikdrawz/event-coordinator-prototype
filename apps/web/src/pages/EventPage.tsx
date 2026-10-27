import { Link, useParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { ChevronDown, MapPin, Clock, Users, Ban } from 'lucide-react';
import { supabase } from '../lib/supabase';
import { daysUntil, eventDateParts } from '../lib/format';
import { DateTile } from '../components/DateTile';
import { useEventStatuses } from '../components/StatusPill';
import { useAuth } from '../lib/auth';
import { can } from '../lib/permissions';
import { useEventForm } from './event/EventFormProvider';
import type { EventStatus } from '../lib/types';
import './event.css';

interface EventDetail {
  id: string; name: string; status: EventStatus; starts_at: string | null; ends_at: string | null; timezone: string;
  city: string | null; country_code: string | null; venue_name: string | null; cancel_reason: string | null;
  event_type: { name: string } | null; country: { name: string } | null;
}

function whenLine(e: EventDetail): string {
  if (!e.starts_at) return 'Date to be confirmed';
  const s = eventDateParts(e.starts_at, e.timezone);
  const tz = new Intl.DateTimeFormat('en-GB', { timeZone: e.timezone, timeZoneName: 'short' }).formatToParts(new Date(e.starts_at)).find((p) => p.type === 'timeZoneName')?.value;
  const off = new Intl.DateTimeFormat('en-GB', { timeZone: e.timezone, timeZoneName: 'shortOffset' }).formatToParts(new Date(e.starts_at)).find((p) => p.type === 'timeZoneName')?.value;
  let dur = '';
  if (e.ends_at) {
    const mins = Math.round((new Date(e.ends_at).getTime() - new Date(e.starts_at).getTime()) / 60000);
    dur = mins >= 1440 ? `${Math.ceil(mins / 1440)} days` : `${Math.floor(mins / 60)} h ${String(mins % 60).padStart(2, '0')} min`;
  }
  return [`${s.weekday} ${s.day} ${s.month}`, s.time, dur, tz && off && tz !== off ? `${tz} (${off})` : off].filter(Boolean).join(' · ');
}

function countdown(iso: string | null): string | null {
  if (!iso) return null;
  const d = daysUntil(iso);
  if (d === 0) return 'Today';
  if (d === 1) return 'Tomorrow';
  if (d > 1) return `In ${d} days`;
  return d === -1 ? 'Yesterday' : `${-d} days ago`;
}

const TABS = ['Overview', 'Team', 'Attendees', 'Documents', 'Event details'];

/** Phase 0: header, lifecycle stepper and tabs on live data. Tab content is built in Phase 1. */
export function EventPage() {
  const { id } = useParams();
  const { data: statuses } = useEventStatuses();
  const { me } = useAuth();
  const { openEditEvent } = useEventForm();
  const { data: e, isLoading } = useQuery({
    queryKey: ['event', id],
    queryFn: async () => {
      const { data, error } = await supabase.from('event')
        .select('id,name,status,starts_at,ends_at,timezone,city,country_code,venue_name,cancel_reason,event_type(name),country(name)')
        .eq('id', id!).maybeSingle();
      if (error) throw error;
      return data as unknown as EventDetail | null;
    },
  });

  if (isLoading) return <main className="page"><div className="empty-state">Loading…</div></main>;
  if (!e) return <main className="page"><div className="card empty-state"><div className="empty-state-title">Event not found</div>It may have been deleted, or you don't have access.</div></main>;

  const stages = (statuses ?? []).filter((s) => s.code !== 'cancelled');
  const current = stages.findIndex((s) => s.code === e.status);
  const when = countdown(e.starts_at);

  return (
    <main className="page">
      <section className="card event-head">
        <nav className="crumbs"><Link to="/events">Events</Link><span>/</span><span>{e.name}</span></nav>
        <div className="event-head-row">
          {e.starts_at && <DateTile iso={e.starts_at} timeZone={e.timezone} />}
          <div className="event-head-main">
            <div className="event-title-row">
              <h1 className="event-title">{e.name}</h1>
              {when && e.status !== 'cancelled' && <span className="pill pill-grey">{when}</span>}
            </div>
            <div className="event-meta">
              <span><Users size={15} />{e.event_type?.name}</span>
              <span><MapPin size={15} />{[e.venue_name ?? e.city, e.country?.name].filter(Boolean).join(' · ')}</span>
              <span><Clock size={15} />{whenLine(e)}</span>
            </div>
          </div>
          <div className="event-actions">
            {can(me, 'event', 'edit') && <button className="btn" onClick={() => openEditEvent(e.id)}>Edit event</button>}
            <button className="btn btn-primary" disabled title="Status changes come next">Actions <ChevronDown size={16} /></button>
          </div>
        </div>
        {e.status === 'cancelled' ? (
          <div className="event-cancelled"><Ban size={16} /> Cancelled{e.cancel_reason ? ` — ${e.cancel_reason}` : ''}</div>
        ) : (
          <ol className="stepper" aria-label="Event lifecycle">
            {stages.map((s, i) => (
              <li key={s.code} className={i < current ? 'done' : i === current ? 'current' : ''} aria-current={i === current ? 'step' : undefined}>
                {s.label}
              </li>
            ))}
          </ol>
        )}
        <div className="tabs" role="tablist">
          {TABS.map((t, i) => <button key={t} role="tab" aria-selected={i === 0} className={`tab${i === 0 ? ' active' : ''}`}>{t}</button>)}
        </div>
      </section>
      <section className="card empty-state" style={{ marginTop: 18 }}>
        <div className="empty-state-title">Agenda, speakers and content come next</div>
        The Overview, Team, Attendees, Documents and Event details tabs are built in Phase 1 on this same data.
      </section>
    </main>
  );
}
