import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { supabase } from '../lib/supabase';
import { useAuth } from '../lib/auth';
import { eventDateParts } from '../lib/format';
import { DateTile } from '../components/DateTile';
import { StatusPill } from '../components/StatusPill';
import type { EventStatus } from '../lib/types';
import './home.css';

interface AgendaRow {
  id: string; name: string; status: EventStatus; starts_at: string; timezone: string;
  city: string | null; country_code: string | null;
  event_type: { name: string } | null;
  event_team_member: { team_role: string; user_id: string }[];
}

const ROLE_NOTE: Record<string, string> = { owner: 'you own', co_host: 'co-host' };

function greeting() {
  const h = new Date().getHours();
  return h < 12 ? 'Good morning' : h < 18 ? 'Good afternoon' : 'Good evening';
}

/** Phase 0 Home: live agenda only. The full 4a layout (calendar, actions, requests) lands in Phase 1. */
export function HomePage() {
  const { me } = useAuth();
  const { data, isLoading } = useQuery({
    queryKey: ['agenda', me?.id],
    enabled: Boolean(me),
    queryFn: async () => {
      const { data, error } = await supabase.from('event')
        .select('id,name,status,starts_at,timezone,city,country_code,event_type(name),event_team_member!inner(team_role,user_id)')
        .eq('event_team_member.user_id', me!.id)
        .gte('starts_at', new Date().toISOString())
        .not('status', 'eq', 'cancelled')
        .order('starts_at');
      if (error) throw error;
      return data as unknown as AgendaRow[];
    },
  });

  return (
    <main className="page">
      <div className="page-header">
        <h1 className="page-title">{greeting()}, {me?.first_name}</h1>
        <Link to="/events" className="btn btn-primary">Browse events</Link>
      </div>
      <section className="card agenda-card">
        <div className="card-header" style={{ flexDirection: 'column', alignItems: 'flex-start', gap: 2 }}>
          <h2 className="card-title" style={{ fontSize: 'var(--text-2xl)' }}>Your agenda</h2>
          <span className="card-sub">Upcoming events you own or work on</span>
        </div>
        {isLoading ? <div className="empty-state">Loading…</div> : !data?.length ? (
          <div className="empty-state">
            <div className="empty-state-title">Your agenda is clear</div>
            Events you own or co-host appear here as soon as they're created.
          </div>
        ) : (
          <ul className="agenda-list">
            {data.map((e) => {
              const p = eventDateParts(e.starts_at, e.timezone);
              const role = ROLE_NOTE[e.event_team_member[0]?.team_role ?? ''];
              return (
                <li key={e.id}>
                  <Link to={`/events/${e.id}`} className="agenda-row">
                    <DateTile iso={e.starts_at} timeZone={e.timezone} />
                    <span className="agenda-main">
                      <span className="agenda-title">{e.name}</span>
                      <span className="agenda-meta">
                        {[p.weekday, e.event_type?.name, [e.city, e.country_code].filter(Boolean).join(', '), role].filter(Boolean).join(' · ')}
                      </span>
                    </span>
                    <StatusPill status={e.status} variant="home" />
                  </Link>
                </li>
              );
            })}
          </ul>
        )}
      </section>
    </main>
  );
}
