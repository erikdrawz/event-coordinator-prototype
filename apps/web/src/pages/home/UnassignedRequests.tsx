import { Link } from 'react-router-dom';
import { timeAgo } from '../../lib/format';
import { Avatar } from '../../components/Avatar';
import { useUnassignedRequests } from './queries';

export function UnassignedRequests() {
  const { data, isLoading, error } = useUnassignedRequests();

  return (
    <section className="card home-side-card" aria-labelledby="unassigned-title">
      <div className="home-side-head">
        <h2 id="unassigned-title" className="home-side-title">Unassigned requests</h2>
        {data && <span className="card-sub">{data.total} open</span>}
      </div>

      {error && <div className="form-error">{error.message}</div>}
      {isLoading ? <div className="home-empty">Loading…</div> : !data?.rows.length ? (
        <div className="home-empty-block">
          <span className="home-empty-title">No open requests</span>
          <span className="home-empty-text">New requests from the field wait here until someone takes them.</span>
        </div>
      ) : (
        <ul className="home-list">
          {data.rows.map((q) => (
            <li key={q.id}>
              <Link to={`/requests/${q.id}`} className="home-request-row">
                <Avatar size={30} initials={q.requester?.initials} color={q.requester?.avatar_color}
                  isAgent={q.requester?.user_type === 'agent'} title={q.requester?.display_name} />
                <span className="home-row-main">
                  <span className="home-request-title">{q.title}</span>
                  <span className="home-request-meta">
                    {[q.requester?.display_name, q.event_type?.name, q.submitted_at && timeAgo(q.submitted_at)].filter(Boolean).join(' · ')}
                  </span>
                </span>
              </Link>
            </li>
          ))}
        </ul>
      )}

      <div className="home-card-foot"><Link to="/requests" className="link">View all requests</Link></div>
    </section>
  );
}
