import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { ChevronDown, MoreVertical, Plus, Trash2, UserRound } from 'lucide-react';
import { supabase } from '../../../lib/supabase';
import { useAuth } from '../../../lib/auth';
import { can } from '../../../lib/permissions';
import { avatarColorFor } from '../../../lib/avatar';
import { Avatar } from '../../../components/Avatar';
import { Menu } from '../../../ui/Menu';
import { ConfirmDialog } from '../../../ui/ConfirmDialog';
import { useEventAccess } from '../eventAccess';
import { AddAttendeesModal } from './AddAttendeesModal';
import { attendeeName, attendeesKey, useAttendeeCrmStatuses, useAttendees, useRsvps, type Attendee, type Rsvp } from './attendeesData';
import './attendees.css';

const initialsOf = (n: string) => n.replace(/^(Dr|Prof)\.?\s+/i, '').split(/\s+/).map((w) => w[0]).slice(0, 2).join('').toUpperCase();

/** Who's invited to the event and how they answered. HCPs are added in bulk from EC or the CRMs. */
export function AttendeesTab({ event }: { event: { id: string; name: string } }) {
  const { me } = useAuth();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const { canEdit: canEditEvent } = useEventAccess();
  const attendees = useAttendees(event.id);
  const rsvps = useRsvps().data;
  const crmStatuses = useAttendeeCrmStatuses().data;
  const [adding, setAdding] = useState(false);
  const [removing, setRemoving] = useState<Attendee | null>(null);
  const canAdd = canEditEvent && can(me, 'event_attendee', 'create');
  const canEdit = canEditEvent && can(me, 'event_attendee', 'edit');
  const canDelete = canEditEvent && can(me, 'event_attendee', 'delete');

  const setRsvp = useMutation({
    mutationFn: async ({ id, rsvp }: { id: string; rsvp: Rsvp }) => {
      const { error } = await supabase.from('event_attendee').update({ rsvp }).eq('id', id);
      if (error) throw new Error(error.message);
    },
    onSettled: () => qc.invalidateQueries({ queryKey: attendeesKey(event.id) }),
  });
  const remove = useMutation({
    mutationFn: async (a: Attendee) => {
      const { error } = await supabase.from('event_attendee').delete().eq('id', a.id);
      if (error) throw new Error(error.message);
    },
    onSuccess: () => { qc.invalidateQueries({ queryKey: attendeesKey(event.id) }); setRemoving(null); },
  });

  const list = attendees.data ?? [];
  const accepted = list.filter((a) => a.rsvp === 'accepted').length;
  const rsvpOf = (code: Rsvp) => rsvps?.find((r) => r.code === code);
  const pill = (row: { label: string; tone: string } | undefined) => row && <span className={`pill pill-${row.tone}`}>{row.label}</span>;

  return (
    <section className="card ov-card" aria-labelledby="attendees-title">
      <div className="ov-head">
        <div className="ov-title-row">
          <h2 id="attendees-title" className="ov-title">Attendees</h2>
          <span className="card-sub">{list.length === 0 ? 'No one invited yet' : `${list.length} invited · ${accepted} accepted`}</span>
        </div>
        <div className="ov-actions">
          {canAdd && <button className="btn btn-outline btn-sm" onClick={() => setAdding(true)}><Plus size={14} strokeWidth={2.6} />Add attendees</button>}
        </div>
      </div>

      {(attendees.error || setRsvp.error) && <div className="form-error" role="alert">{(attendees.error ?? setRsvp.error)!.message}</div>}

      {attendees.isLoading ? <div className="ov-empty text-muted">Loading…</div> : list.length === 0 ? (
        <div className="ov-empty">
          <span><strong>No attendees yet.</strong> Add HCPs from Event Center or search your CRMs for them.</span>
          {canAdd && <button className="btn btn-primary btn-sm" onClick={() => setAdding(true)}><Plus size={14} strokeWidth={2.6} />Add attendees</button>}
        </div>
      ) : (
        <div className="table-scroll">
          <table className="agenda-table attendees-table">
            <thead>
              <tr><th>Name</th><th>Role</th><th>Organisation</th><th>RSVP</th><th>CRM</th><th aria-label="Actions" /></tr>
            </thead>
            <tbody>
              {list.map((a) => {
                const name = attendeeName(a);
                const sub = a.hcp ? [a.hcp.specialty?.name, a.hcp.city].filter(Boolean).join(' · ') : a.user ? 'Colleague' : 'Guest';
                const menu = [
                  ...(a.hcp_id ? [{ key: 'profile', label: 'View expert profile', icon: <UserRound size={14} />, onSelect: () => navigate(`/experts/${a.hcp_id}`) }] : []),
                  ...(canDelete ? [{ key: 'remove', label: 'Remove attendee', icon: <Trash2 size={14} />, danger: true, onSelect: () => setRemoving(a) }] : []),
                ];
                return (
                  <tr key={a.id}>
                    <td>
                      <span className="dt-person">
                        <Avatar size={30} initials={a.user?.initials ?? initialsOf(name)} color={a.user?.avatar_color ?? avatarColorFor(name)} />
                        <span>
                          {a.hcp_id ? <Link to={`/experts/${a.hcp_id}`} className="agenda-title expert-link">{name}</Link> : <span className="agenda-title">{name}</span>}
                          <div className="dt-sub">{sub}</div>
                        </span>
                      </span>
                    </td>
                    <td>{a.role_label ?? <span className="text-muted">—</span>}</td>
                    <td className="att-org">{a.organisation ?? <span className="text-muted">—</span>}</td>
                    <td>
                      {canEdit ? (
                        <Menu label={`RSVP for ${name}`} width={160}
                          items={(rsvps ?? []).map((r) => ({ key: r.code, label: pill(r), text: r.label, onSelect: () => r.code !== a.rsvp && setRsvp.mutate({ id: a.id, rsvp: r.code }) }))}
                          trigger={(t) => (
                            <button type="button" className={`pill pill-${rsvpOf(a.rsvp)?.tone ?? 'grey'} att-rsvp`} aria-label={`RSVP for ${name}: ${rsvpOf(a.rsvp)?.label ?? a.rsvp}. Change`} {...t}>
                              {rsvpOf(a.rsvp)?.label ?? a.rsvp}<ChevronDown size={12} strokeWidth={2.6} aria-hidden />
                            </button>
                          )} />
                      ) : pill(rsvpOf(a.rsvp))}
                    </td>
                    <td>{a.crm_status === 'not_applicable' ? <span className="text-muted">—</span> : pill(crmStatuses?.find((c) => c.code === a.crm_status))}</td>
                    <td className="agenda-menu">
                      {menu.length > 0 && (
                        <Menu label={`Actions for ${name}`} items={menu} width={200}
                          trigger={(t) => <button type="button" className="icon-btn" aria-label={`Actions for ${name}`} {...t}><MoreVertical size={16} /></button>} />
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {adding && <AddAttendeesModal event={event} attending={list} onClose={() => setAdding(false)} />}
      {removing && (
        <ConfirmDialog title="Remove attendee" confirmLabel="Remove" pending={remove.isPending} error={remove.error?.message}
          onConfirm={() => remove.mutate(removing)} onCancel={() => { setRemoving(null); remove.reset(); }}>
          Remove {attendeeName(removing)} from this event's attendees? Their expert record and any engagement on this event stay as they are.
        </ConfirmDialog>
      )}
    </section>
  );
}
