import { Link } from 'react-router-dom';
import { Check } from 'lucide-react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { supabase } from '../../lib/supabase';
import { dueLabel, shortAgo } from '../../lib/format';
import { Avatar } from '../../components/Avatar';
import { useMyApprovals, useMyTasks } from './queries';

const MAX_ROWS = 5;

export function NeedsMyAction({ meId }: { meId: string }) {
  const approvals = useMyApprovals(meId);
  const tasks = useMyTasks(meId);
  const qc = useQueryClient();

  // A plain table update through the API; RLS decides whether I may complete it.
  const complete = useMutation({
    mutationFn: async (id: string) => {
      const { error } = await supabase.from('event_task').update({ done_at: new Date().toISOString() }).eq('id', id);
      if (error) throw error;
    },
    onSettled: () => qc.invalidateQueries({ queryKey: ['home'] }),
  });

  const loading = approvals.isLoading || tasks.isLoading;
  const error = approvals.error ?? tasks.error ?? complete.error;
  const total = (approvals.data?.length ?? 0) + (tasks.data?.length ?? 0);
  const rows = [
    ...(approvals.data ?? []).map((a) => ({ kind: 'approval' as const, a })),
    ...(tasks.data ?? []).map((t) => ({ kind: 'task' as const, t })),
  ].slice(0, MAX_ROWS);

  return (
    <section className="card home-side-card" aria-labelledby="action-title">
      <div className="home-side-head">
        <h2 id="action-title" className="home-side-title">Needs my action</h2>
        <span className="card-sub">{loading ? '' : total ? `${total} waiting` : 'Nothing waiting'}</span>
      </div>

      {error && <div className="form-error">{error.message}</div>}
      {loading ? <div className="home-empty">Loading…</div> : !total ? (
        <div className="home-caught-up">
          <span className="home-caught-up-icon"><Check size={16} strokeWidth={2.6} /></span>
          <span>
            <span className="home-empty-title">You're all caught up</span>
            <span className="home-empty-text">Approvals and tasks assigned to you land here.</span>
          </span>
        </div>
      ) : (
        <ul className="home-list">
          {rows.map((r) => r.kind === 'approval' ? (
            <li key={r.a.id}>
              {/* Approving happens on the request itself (with approvals), so this row only opens it */}
              <Link to={r.a.request ? `/requests/${r.a.request.id}` : "/requests"} className="home-action-row">
                <span className="home-check" aria-hidden />
                <span className="home-row-main">
                  <span className="home-action-title">Approve {r.a.request?.title ?? 'request'}</span>
                  <span className="home-chip">
                    {r.a.submitter && <Avatar size={16} initials={r.a.submitter.initials} color={r.a.submitter.avatar_color}
                      isAgent={r.a.submitter.user_type === 'agent'} title={r.a.submitter.display_name} />}
                    {shortAgo(r.a.submitted_at)}
                  </span>
                </span>
              </Link>
            </li>
          ) : (
            <li key={r.t.id} className="home-action-row">
              <button className="home-check" aria-label={`Mark "${r.t.title}" done`}
                disabled={complete.isPending} onClick={() => complete.mutate(r.t.id)} />
              <Link to={r.t.event ? `/events/${r.t.event.id}` : '/events'} className="home-row-main home-action-link">
                <span className="home-action-title">{r.t.title}</span>
                <span className="home-chip">
                  {r.t.creator && <Avatar size={16} initials={r.t.creator.initials} color={r.t.creator.avatar_color}
                    isAgent={r.t.creator.user_type === 'agent'} title={r.t.creator.display_name} />}
                  {[r.t.event?.name, r.t.due_date && dueLabel(r.t.due_date).text].filter(Boolean).join(' · ')}
                </span>
              </Link>
            </li>
          ))}
        </ul>
      )}

      <div className="home-card-foot"><Link to="/requests" className="link">View all approvals</Link></div>
    </section>
  );
}
