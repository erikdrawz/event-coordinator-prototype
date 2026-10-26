import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { supabase } from '../lib/supabase';
import { eventDateParts } from '../lib/format';
import { Avatar } from '../components/Avatar';
import { StatusPill } from '../components/StatusPill';
import type { EventStatus } from '../lib/types';
import './events.css';

interface EventRow {
  id: string; event_number: string; name: string; status: EventStatus; starts_at: string | null; timezone: string;
  city: string | null; country_code: string | null;
  event_type: { name: string } | null;
  owner: { display_name: string; initials: string | null; avatar_color: string | null } | null;
}

/** Phase 0 list: everything you can see, soonest first. Sorting/filtering comes in Phase 1. */
export function EventsPage() {
  const { data, isLoading, error } = useQuery({
    queryKey: ['events'],
    queryFn: async () => {
      const { data, error } = await supabase.from('event')
        .select('id,event_number,name,status,starts_at,timezone,city,country_code,event_type(name),owner:app_user!event_owner_id_fkey(display_name,initials,avatar_color)')
        .order('starts_at', { ascending: true });
      if (error) throw error;
      return data as unknown as EventRow[];
    },
  });

  return (
    <main className="page">
      <div className="page-header">
        <h1 className="page-title">Events</h1>
      </div>
      <section className="card" style={{ padding: 0 }}>
        {error ? <div className="empty-state">Couldn't load events: {(error as Error).message}</div> :
         isLoading ? <div className="empty-state">Loading…</div> : (
          <div className="table-scroll"><table className="table">
            <thead>
              <tr><th>Event</th><th>Type</th><th>Status</th><th>Date</th><th>Location</th><th>Owner</th></tr>
            </thead>
            <tbody>
              {data!.map((e) => {
                const p = e.starts_at ? eventDateParts(e.starts_at, e.timezone) : null;
                return (
                  <tr key={e.id}>
                    <td><Link to={`/events/${e.id}`} className="table-primary">{e.name}</Link><div className="table-sub">{e.event_number}</div></td>
                    <td>{e.event_type?.name}</td>
                    <td><StatusPill status={e.status} /></td>
                    <td>{p ? `${p.weekday} ${p.day} ${p.month} · ${p.time}` : '—'}</td>
                    <td>{[e.city, e.country_code].filter(Boolean).join(', ') || '—'}</td>
                    <td>{e.owner && <span className="table-person"><Avatar initials={e.owner.initials} color={e.owner.avatar_color} size={24} />{e.owner.display_name}</span>}</td>
                  </tr>
                );
              })}
            </tbody>
          </table></div>
        )}
      </section>
    </main>
  );
}
