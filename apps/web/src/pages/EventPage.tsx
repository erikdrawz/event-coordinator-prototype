import { Link, useParams, useSearchParams } from 'react-router-dom';
import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Ban, Check, ChevronDown, Lock, MapPin, Clock, Pill, Send, Undo2, Users, X } from 'lucide-react';
import { supabase } from '../lib/supabase';
import { daysUntil, eventDateParts } from '../lib/format';
import { DateTile } from '../components/DateTile';
import { useEventStatuses, useStatusTransitions } from '../components/StatusPill';
import { Menu, type MenuItem } from '../ui/Menu';
import { ConfirmDialog } from '../ui/ConfirmDialog';
import { DecideDialog, type Decision } from '../components/DecideDialog';
import { useAuth } from '../lib/auth';
import { can } from '../lib/permissions';
import { useEventForm } from './event/EventFormProvider';
import { EventDetailsTab } from './event/EventDetailsTab';
import { OverviewTab } from './event/OverviewTab';
import { CancelEventDialog } from './event/CancelEventDialog';
import { TeamTab } from './event/team/TeamTab';
import { AttendeesTab } from './event/attendees/AttendeesTab';
import { DocumentsTab } from './event/content/DocumentsTab';
import { SpendTab } from './event/spend/SpendTab';
import { EventAccessContext, useMyEventAccess } from './event/eventAccess';
import type { EventStatus } from '../lib/types';
import './event.css';

interface EventDetail {
  id: string; name: string; status: EventStatus; starts_at: string | null; ends_at: string | null; timezone: string;
  city: string | null; country_code: string | null; venue_name: string | null; cancel_reason: string | null;
  event_type: { name: string } | null; country: { name: string } | null;
  event_product: { product: { name: string } | null }[];
  owner: { display_name: string } | null;
}

/** "Brevair", "Brevair, Telia", "Brevair, Telia +2"; the full list goes in the tooltip. */
function ProductsMeta({ e }: { e: EventDetail }) {
  const names = e.event_product.map((p) => p.product?.name).filter((n): n is string => Boolean(n)).sort((a, b) => a.localeCompare(b));
  if (names.length === 0) return <span className="text-muted"><Pill size={15} />No product</span>;
  const shown = names.length > 2 ? `${names.slice(0, 2).join(', ')} +${names.length - 2}` : names.join(', ');
  return <span data-tip={names.length > 2 ? names.join(', ') : undefined} aria-label={`Products: ${names.join(', ')}`}><Pill size={15} />{shown}</span>;
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

const TABS = [
  { id: 'overview', label: 'Overview' }, { id: 'team', label: 'Collaboration' }, { id: 'attendees', label: 'Attendees' }, { id: 'spend', label: 'Spend' },
  { id: 'documents', label: 'Documents' }, { id: 'details', label: 'Details' },
] as const;
type TabId = (typeof TABS)[number]['id'];

/** Header, lifecycle stepper and tabs. The open tab is in the URL (?tab=details) so it can be linked to. */
export function EventPage() {
  const { id } = useParams();
  const { data: statuses } = useEventStatuses();
  const { data: transitions } = useStatusTransitions();
  const [cancelling, setCancelling] = useState(false);
  const [confirm, setConfirm] = useState<'submit' | 'withdraw' | Decision | null>(null);
  const qc = useQueryClient();
  const myAccess = useMyEventAccess(id);
  const { me } = useAuth();
  const { openEditEvent } = useEventForm();
  const [params, setParams] = useSearchParams();
  const tab = (TABS.find((t) => t.id === params.get('tab'))?.id ?? 'overview') as TabId;
  const pickTab = (t: TabId) => setParams((p) => { const n = new URLSearchParams(p); if (t === 'overview') n.delete('tab'); else n.set('tab', t); return n; }, { replace: true });
  const { data: e, isLoading } = useQuery({
    queryKey: ['event', id],
    queryFn: async () => {
      const { data, error } = await supabase.from('event')
        .select('id,name,status,starts_at,ends_at,timezone,city,country_code,venue_name,cancel_reason,event_type(name),country(name),event_product(product(name)),owner:app_user!event_owner_id_fkey(display_name)')
        .eq('id', id!).maybeSingle();
      if (error) throw error;
      return data as unknown as EventDetail | null;
    },
  });

  // Submit for approval (Draft → Review) and withdraw (Review → Draft) are status moves; the database
  // starts or cancels the approval and refuses a submission no process covers
  const move = useMutation({
    mutationFn: async (status: 'review' | 'draft') => {
      const { error } = await supabase.rpc('change_event_status', { p_event_id: id, p_status: status });
      if (error) throw new Error(error.message);
    },
    onSuccess: () => { refresh(); setConfirm(null); },
  });
  const refresh = () => {
    qc.invalidateQueries({ queryKey: ['event', id] });
    qc.invalidateQueries({ queryKey: ['events'] });
    qc.invalidateQueries({ queryKey: ['home'] });
  };

  if (isLoading) return <main className="page"><div className="empty-state">Loading…</div></main>;
  if (!e) return <main className="page"><div className="card empty-state"><div className="empty-state-title">Event not found</div>It may have been deleted, or you don't have access.</div></main>;

  const stages = (statuses ?? []).filter((s) => s.code !== 'cancelled');
  const current = stages.findIndex((s) => s.code === e.status);
  const when = countdown(e.starts_at);
  const cancelled = e.status === 'cancelled';
  // Profile allows editing events, and the Team gives me edit access to this one
  const onTeamEdit = myAccess.data?.access === 'edit';
  const canEdit = can(me, 'event', 'edit') && onTeamEdit;
  const locked = Boolean(myAccess.data?.locked);
  const canDecide = e.status === 'review' && Boolean(myAccess.data?.can_decide);
  // Only moves the lifecycle allows from here: submit, withdraw, decide, cancel
  const actions: MenuItem[] = [
    ...(canEdit && e.status === 'draft' ? [{ key: 'submit', label: 'Submit for approval', icon: <Send size={14} />, onSelect: () => setConfirm('submit') }] : []),
    ...(canDecide ? [
      { key: 'approve', label: 'Approve event', icon: <Check size={14} />, onSelect: () => setConfirm('approved') },
      { key: 'reject', label: 'Reject event', icon: <X size={14} />, danger: true, onSelect: () => setConfirm('rejected') },
    ] : []),
    ...(canEdit && e.status === 'review' ? [{ key: 'withdraw', label: 'Withdraw to draft', icon: <Undo2 size={14} />, onSelect: () => setConfirm('withdraw') }] : []),
    ...(canEdit && transitions?.some((t) => t.from_status === e.status && t.to_status === 'cancelled')
      ? [{ key: 'cancel', label: 'Cancel event', icon: <Ban size={14} />, danger: true, onSelect: () => setCancelling(true) }] : []),
  ];

  return (
    <main className="page">
      <section className="card event-head">
        <nav className="crumbs"><Link to="/events">Events</Link><span>/</span><span>{e.name}</span></nav>
        <div className="event-head-row">
          {e.starts_at && <DateTile iso={e.starts_at} timeZone={e.timezone} />}
          <div className="event-head-main">
            <div className="event-title-row">
              <h1 className="event-title">{e.name}</h1>
              {when && <span className="pill pill-grey">{when}</span>}
              {cancelled && <span className="pill pill-grey" title={e.cancel_reason ?? undefined}>Cancelled</span>}
            </div>
            <div className="event-meta">
              <span><Users size={15} />{e.event_type?.name}</span>
              <ProductsMeta e={e} />
              <span><MapPin size={15} />{[e.venue_name ?? e.city, e.country?.name].filter(Boolean).join(' · ')}</span>
              <span><Clock size={15} />{whenLine(e)}</span>
            </div>
          </div>
          <div className="event-actions">
            {canEdit && !locked && <button className="btn" onClick={() => openEditEvent(e.id)}>Edit event</button>}
            {actions.length > 0 ? (
              <Menu label="Event actions" width={210} items={actions}
                trigger={(t) => <button type="button" className="btn btn-primary" {...t}>Actions <ChevronDown size={16} /></button>} />
            ) : (
              <button type="button" className="btn btn-primary" disabled title={cancelled ? 'No actions for a cancelled event' : 'No actions available'}>Actions <ChevronDown size={16} /></button>
            )}
          </div>
        </div>
        {/* A cancelled event keeps the stepper, greyed out */}
        <ol className={`stepper${cancelled ? ' is-cancelled' : ''}`} aria-label={cancelled ? 'Event lifecycle (cancelled)' : 'Event lifecycle'}>
          {stages.map((s, i) => (
            <li key={s.code} className={cancelled ? '' : i < current ? 'done' : i === current ? 'current' : ''} aria-current={!cancelled && i === current ? 'step' : undefined}>
              {s.label}
            </li>
          ))}
        </ol>
        {e.status === 'review' && (
          <p className="event-review-note">
            <Lock size={14} aria-hidden />
            <span>In review: the details, agenda and experts are locked until it's approved or withdrawn.{' '}
              <button type="button" className="link" onClick={() => pickTab('details')}>See the approval</button></span>
          </p>
        )}
        {cancelling && <CancelEventDialog event={e} onClose={() => setCancelling(false)} />}
        {confirm === 'submit' && (
          <ConfirmDialog title="Submit for approval?" confirmLabel="Submit for approval" danger={false}
            pending={move.isPending} error={move.error?.message}
            onConfirm={() => move.mutate('review')} onCancel={() => { move.reset(); setConfirm(null); }}>
            <strong>{e.name}</strong> goes to Review through the approval process that applies to it, and its approvers are notified.
            Its details, agenda and experts are locked until it's approved, or until you withdraw it.
          </ConfirmDialog>
        )}
        {confirm === 'withdraw' && (
          <ConfirmDialog title="Withdraw to draft?" confirmLabel="Withdraw to draft" danger={false}
            pending={move.isPending} error={move.error?.message}
            onConfirm={() => move.mutate('draft')} onCancel={() => { move.reset(); setConfirm(null); }}>
            <strong>{e.name}</strong> goes back to Draft and its approval is cancelled, so you can make changes. Submit it again when it's ready.
          </ConfirmDialog>
        )}
        {(confirm === 'approved' || confirm === 'rejected') && (
          <DecideDialog kind="event" record={{ id: e.id, title: e.name, owner: e.owner?.display_name ?? null }} decision={confirm}
            onDone={() => { refresh(); setConfirm(null); }} onClose={() => setConfirm(null)} />
        )}
        <div className="tabs" role="tablist" aria-label="Event sections">
          {TABS.map((t) => (
            <button key={t.id} id={`tab-${t.id}`} role="tab" aria-selected={tab === t.id} aria-controls="event-tabpanel"
              className={`tab${tab === t.id ? ' active' : ''}`} onClick={() => pickTab(t.id)}>{t.label}</button>
          ))}
        </div>
      </section>
      <div id="event-tabpanel" role="tabpanel" aria-labelledby={`tab-${tab}`} className="event-tabpanel">
        <EventAccessContext.Provider value={{ canEdit: onTeamEdit, teamRole: myAccess.data?.team_role ?? null, locked }}>
        {tab === 'details' ? <EventDetailsTab eventId={e.id} /> : tab === 'overview' ? <OverviewTab event={e} /> : tab === 'team' ? <TeamTab event={e} /> : tab === 'attendees' ? <AttendeesTab event={e} /> : tab === 'spend' ? <SpendTab event={e} /> : <DocumentsTab event={e} />}
        </EventAccessContext.Provider>
      </div>
    </main>
  );
}
