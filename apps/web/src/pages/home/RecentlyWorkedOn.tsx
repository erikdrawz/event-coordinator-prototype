import { Link } from 'react-router-dom';
import { DateTile } from '../../components/DateTile';
import { useEventStatuses } from '../../components/StatusPill';
import { useRecentlyWorkedOn } from './queries';

export function RecentlyWorkedOn({ meId }: { meId: string }) {
  const { data, isLoading } = useRecentlyWorkedOn(meId);
  const { data: statuses } = useEventStatuses();

  return (
    <section aria-labelledby="recent-title">
      <div className="home-recent-head">
        <h2 id="recent-title" className="home-recent-title">Recently worked on</h2>
        <Link to="/events" className="link">See all</Link>
      </div>
      <div className="card home-recent-card">
        {isLoading ? <div className="home-empty">Loading…</div> : !data?.length ? (
          <div className="home-empty-block">
            <span className="home-empty-title">Nothing here yet</span>
            <span className="home-empty-text">Events you edit will show up here.</span>
          </div>
        ) : (
          <ul className="home-list">
            {data.map((e) => (
              <li key={e.id}>
                <Link to={`/events/${e.id}`} className="home-recent-row">
                  {e.starts_at ? <DateTile iso={e.starts_at} timeZone={e.timezone} size="sm" /> : <span className="date-tile-sm" />}
                  <span className="home-row-main">
                    <span className="home-recent-name">{e.name}</span>
                    <span className="home-recent-meta">
                      {[[e.city, e.country_code].filter(Boolean).join(', '), statuses?.find((s) => s.code === e.status)?.home_label]
                        .filter(Boolean).join(' · ')}
                    </span>
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}
