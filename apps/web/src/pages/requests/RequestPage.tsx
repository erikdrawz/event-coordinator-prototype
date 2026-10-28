import { useState, type ReactNode } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { CalendarDays, ChevronDown, Clock, FileText, Pencil, Send, Stethoscope, Trash2, UserRound, Users } from 'lucide-react';
import { supabase } from '../../lib/supabase';
import { useAuth } from '../../lib/auth';
import { can } from '../../lib/permissions';
import { Avatar } from '../../components/Avatar';
import { Menu, type MenuItem } from '../../ui/Menu';
import { formatDate } from '../../ui/DateInput';
import { ymdInZone } from '../../lib/format';
import { EligibilityPill } from '../experts/EligibilityPill';
import { ConfirmDialog } from '../../ui/ConfirmDialog';
import { Discussion } from '../event/team/Discussion';
import { TeamPanel } from '../event/team/TeamPanel';
import type { Person } from '../event/team/teamData';
import { RequestFormModal } from './RequestFormModal';
import { RequestStatusPill } from './RequestStatusPill';
import { missingForSubmit, useMyRequestAccess, useRequest, useRequestDurations, useRequestKinds } from './requestData';
import '../event.css';
import './requests.css';

const listOf = (items: string[]) => new Intl.ListFormat('en-GB', { type: 'conjunction' }).format(items);
const empty = <span className="text-muted">—</span>;

function Row({ label, children }: { label: string; children: ReactNode }) {
  return <div className="details-row"><dt>{label}</dt><dd>{children}</dd></div>;
}
const PersonValue = ({ p }: { p: Person | null }) => p
  ? <span className="dt-person"><Avatar size={22} initials={p.initials} color={p.avatar_color} isAgent={p.user_type === 'agent'} />{p.display_name}</span> : empty;

/**
 * A request: what's asked for (an event: name, type, when; a tiering review: the expert and the
 * event they're needed for), why, its status, and the team's discussion. Drafts can be edited,
 * submitted for approval or deleted; after that the details are fixed.
 */
export function RequestPage() {
  const { id } = useParams();
  const { me } = useAuth();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const { data: r, isLoading } = useRequest(id);
  const access = useMyRequestAccess(id);
  const durations = useRequestDurations();
  const kinds = useRequestKinds();
  const [editing, setEditing] = useState(false);
  const [confirm, setConfirm] = useState<'submit' | 'delete' | null>(null);

  const refresh = () => {
    qc.invalidateQueries({ queryKey: ['request', id] });
    qc.invalidateQueries({ queryKey: ['requests'] });
    qc.invalidateQueries({ queryKey: ['home'] });
  };
  const submit = useMutation({
    mutationFn: async () => {
      const { error } = await supabase.from('event_request').update({ status: 'review' }).eq('id', id!);
      if (error) throw new Error(error.message);
    },
    onSuccess: () => { refresh(); setConfirm(null); },
  });
  const remove = useMutation({
    mutationFn: async () => {
      const { error, count } = await supabase.from('event_request').delete({ count: 'exact' }).eq('id', id!);
      if (error) throw new Error(error.message);
      if (!count) throw new Error("This request couldn't be deleted. Only drafts can be deleted, by the requester or an organizer.");
    },
    onSuccess: () => { qc.removeQueries({ queryKey: ['request', id] }); qc.invalidateQueries({ queryKey: ['requests'] }); qc.invalidateQueries({ queryKey: ['home'] }); navigate('/requests'); },
  });

  if (isLoading) return <main className="page"><div className="empty-state">Loading…</div></main>;
  if (!r) return <main className="page"><div className="card empty-state"><div className="empty-state-title">Request not found</div>It may have been deleted, or you don't have access.</div></main>;

  const isDraft = r.status === 'draft';
  const canEdit = access.data?.access === 'edit' && can(me, 'event_request', 'edit');
  const missing = missingForSubmit(r);
  const actions: MenuItem[] = canEdit && isDraft ? [
    { key: 'submit', label: 'Submit for approval', icon: <Send size={14} />, onSelect: () => setConfirm('submit') },
    ...(can(me, 'event_request', 'delete') ? [{ key: 'delete', label: 'Delete request', icon: <Trash2 size={14} />, danger: true, onSelect: () => setConfirm('delete') }] : []),
  ] : [];
  const board = { kind: 'request' as const, id: r.id };
  const durationLabel = durations.data?.find((x) => x.code === r.duration)?.label ?? null;
  const when = r.event_date ? [formatDate(r.event_date), durationLabel].filter(Boolean).join(' · ') : 'Date to be confirmed';
  const isTiering = r.request_type === 'tiering';
  const kindLabel = kinds.data?.find((k) => k.code === r.request_type)?.label;
  const ev = r.related_event;
  const evDate = ev?.starts_at ? formatDate(ymdInZone(ev.starts_at, ev.timezone)) : null;
  const noActions = !canEdit ? "You can view this request; the requester and organizers act on it"
    : isDraft ? 'No actions available' : 'Approving and rejecting come with approvals';

  return (
    <main className="page">
      <section className="card event-head request-head">
        <nav className="crumbs"><Link to="/requests">Requests</Link><span>/</span><span>{r.title}</span></nav>
        <div className="event-head-row">
          <div className="event-head-main">
            <div className="event-title-row">
              <h1 className="event-title">{r.title}</h1>
              <RequestStatusPill status={r.status} />
            </div>
            <div className="event-meta">
              <span><FileText size={15} />{r.request_number}</span>
              {isTiering ? <>
                <span><Stethoscope size={15} />{kindLabel}</span>
                {r.hcp && <span><UserRound size={15} /><Link to={`/experts/${r.hcp.id}`} className="expert-link">{r.hcp.display_name}</Link></span>}
                {ev && <span><CalendarDays size={15} /><Link to={`/events/${ev.id}`} className="expert-link">{ev.name}</Link></span>}
              </> : <>
                <span><Users size={15} />{r.event_type?.name}</span>
                <span><Clock size={15} />{when}</span>
              </>}
              <span><UserRound size={15} />Requested by {r.requester?.display_name ?? 'a former user'}</span>
            </div>
          </div>
          <div className="event-actions">
            {canEdit && isDraft && <button className="btn" onClick={() => setEditing(true)}>Edit request</button>}
            {actions.length > 0 ? (
              <Menu label="Request actions" width={220} items={actions}
                trigger={(t) => <button type="button" className="btn btn-primary" {...t}>Actions <ChevronDown size={16} /></button>} />
            ) : (
              <button type="button" className="btn btn-primary" disabled title={noActions}>Actions <ChevronDown size={16} /></button>
            )}
          </div>
        </div>
      </section>

      <div className="request-body">
        <div className="request-main">
          <section className="card details-card" aria-labelledby="request-details-title">
            <div className="details-head">
              <h2 id="request-details-title" className="card-title">Request details</h2>
              {canEdit && isDraft && <button className="btn" onClick={() => setEditing(true)}><Pencil size={14} />Edit</button>}
            </div>
            <dl className="details-grid request-details">
              <Row label="Type">{kindLabel ?? empty}</Row>
              {isTiering ? <>
                <Row label="Expert">{r.hcp ? <>
                  <span className="request-expert"><Link to={`/experts/${r.hcp.id}`}>{r.hcp.display_name}</Link><EligibilityPill value={r.hcp.eligibility} />{r.hcp.tier && <span className="pill pill-grey">{r.hcp.tier}</span>}</span>
                  {r.hcp.eligibility !== 'eligible' && r.hcp.eligibility_note && <div className="dt-sub">{r.hcp.eligibility_note}</div>}
                </> : empty}</Row>
                <Row label="Event">{ev ? <><Link to={`/events/${ev.id}`}>{ev.name}</Link>{evDate && <div className="dt-sub">{evDate}</div>}</> : empty}</Row>
              </> : <>
                <Row label="Name">{r.title}</Row>
                <Row label="Event type">{r.event_type?.name ?? empty}</Row>
                <Row label="Date">{r.event_date ? formatDate(r.event_date) : empty}</Row>
                <Row label="Duration">{durationLabel ?? empty}</Row>
              </>}
              <Row label="Business justification">{r.rationale ? <span className="details-text">{r.rationale}</span> : empty}</Row>
              <Row label="Requested by"><PersonValue p={r.requester} /></Row>
              <Row label="Assignee">{r.coordinator ? <PersonValue p={r.coordinator} /> : <span className="text-muted">{isDraft ? '—' : 'Unassigned'}</span>}</Row>
            </dl>
            {isDraft && canEdit && missing.length > 0 && (
              <p className="request-note">Add the {listOf(missing)} before you submit this request for approval.</p>
            )}
          </section>
          <Discussion board={board} name={r.title} canModerate={canEdit && can(me, 'request_post', 'delete')} />
        </div>
        <TeamPanel board={board} canEdit={canEdit} />
      </div>

      {editing && <RequestFormModal request={r} onClose={() => setEditing(false)} />}

      {confirm === 'submit' && (missing.length ? (
        <ConfirmDialog title="Complete the request first" confirmLabel="Edit request" danger={false}
          onConfirm={() => { setConfirm(null); setEditing(true); }} onCancel={() => setConfirm(null)}>
          Add the {listOf(missing)} before you submit it for approval.
        </ConfirmDialog>
      ) : (
        <ConfirmDialog title="Submit for approval?" confirmLabel="Submit for approval" danger={false}
          pending={submit.isPending} error={submit.error?.message}
          onConfirm={() => submit.mutate()} onCancel={() => { submit.reset(); setConfirm(null); }}>
          <strong>{r.title}</strong> goes to review, and home office can see it. Its details can't be changed after this;
          the team and the discussion stay open.
        </ConfirmDialog>
      ))}
      {confirm === 'delete' && (
        <ConfirmDialog title="Delete this request?" confirmLabel="Delete request"
          pending={remove.isPending} error={remove.error?.message}
          onConfirm={() => remove.mutate()} onCancel={() => { remove.reset(); setConfirm(null); }}>
          <strong>{r.title}</strong> is deleted with its team and discussion. This can't be undone.
        </ConfirmDialog>
      )}
    </main>
  );
}
