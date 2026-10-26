import { Link } from 'react-router-dom';
import { Plus } from 'lucide-react';
import { eventDateParts } from '../../lib/format';
import { DateTile } from '../../components/DateTile';
import { StatusPill } from '../../components/StatusPill';
import { useAgenda, type AgendaEvent, type Scope, type When } from './queries';

const ROLE_NOTE: Record<string, string> = { owner: 'you own', co_host: 'co-host' };

const SUB: Record<Scope, Record<When, string>> = {
  mine: { upcoming: 'Events you own or work on, next 90 days', past: 'Events you owned or worked on, last 90 days' },
  all: { upcoming: 'All events you can see, next 90 days', past: 'All events you can see, last 90 days' },
};

function meta(e: AgendaEvent) {
  const p = eventDateParts(e.starts_at, e.timezone);
  const mine = e.event_team_member[0]?.team_role;
  const who = mine ? ROLE_NOTE[mine] : e.owner ? `owner ${e.owner.display_name}` : null;
  return [p.weekday, e.event_type?.name, [e.city, e.country_code].filter(Boolean).join(', '), who].filter(Boolean).join(' · ');
}

interface Props {
  meId: string;
  scope: Scope; onScope: (s: Scope) => void;
  when: When; onWhen: (w: When) => void;
  canCreate: boolean;
}

export function Agenda({ meId, scope, onScope, when, onWhen, canCreate }: Props) {
  const { data, isLoading, error } = useAgenda(meId, scope, when);
  const today = new Date();

  return (
    <section className="card home-agenda" aria-labelledby="agenda-title">
      <div className="home-agenda-head">
        <div>
          <h1 id="agenda-title" className="home-agenda-title">Your agenda</h1>
          <div className="card-sub">{SUB[scope][when]}</div>
        </div>
        <div className="home-agenda-toggles">
          <div className="segmented" role="group" aria-label="Whose events">
            <button aria-pressed={scope === 'mine'} onClick={() => onScope('mine')}>My events</button>
            <button aria-pressed={scope === 'all'} onClick={() => onScope('all')}>All</button>
          </div>
          <div className="segmented" role="group" aria-label="Time range">
            <button aria-pressed={when === 'upcoming'} onClick={() => onWhen('upcoming')}>Upcoming</button>
            <button aria-pressed={when === 'past'} onClick={() => onWhen('past')}>Past</button>
          </div>
        </div>
      </div>

      {isLoading ? <div className="home-empty">Loading…</div>
        : error ? <div className="home-empty">Couldn't load events: {error.message}</div>
        : !data?.length ? (
          <div className="home-agenda-empty">
            <span className="home-empty-tile" aria-hidden>
              <span>{today.toLocaleDateString('en-GB', { month: 'short' })}</span>
              <span>{today.getDate()}</span>
            </span>
            {when === 'past' ? (
              <>
                <span className="home-agenda-empty-title">Nothing in the last 90 days</span>
                <span className="home-agenda-empty-text">Past events show up here with their final status.</span>
              </>
            ) : scope === 'mine' ? (
              <>
                <span className="home-agenda-empty-title">Your agenda is clear</span>
                <span className="home-agenda-empty-text">
                  Events you own or co-host appear here as soon as they're created, with their status alongside.
                </span>
                {canCreate && <Link to="/events/new" className="btn btn-primary home-agenda-empty-cta"><Plus size={14} strokeWidth={2.6} />Create your first event</Link>}
                <button className="link" onClick={() => onScope('all')}>Browse team events</button>
              </>
            ) : (
              <>
                <span className="home-agenda-empty-title">No events in the next 90 days</span>
                <span className="home-agenda-empty-text">New events appear here once they have a date.</span>
              </>
            )}
          </div>
        ) : (
          <ul className="home-agenda-list">
            {data.map((e) => (
              <li key={e.id}>
                <Link to={`/events/${e.id}`} className="home-agenda-row">
                  <DateTile iso={e.starts_at} timeZone={e.timezone} />
                  <span className="home-row-main">
                    <span className="home-agenda-name">{e.name}</span>
                    <span className="home-agenda-meta">{meta(e)}</span>
                  </span>
                  <StatusPill status={e.status} variant="home" />
                </Link>
              </li>
            ))}
          </ul>
        )}

      <div className="home-card-foot"><Link to="/events" className="link home-foot-link">Open full calendar</Link></div>
    </section>
  );
}
