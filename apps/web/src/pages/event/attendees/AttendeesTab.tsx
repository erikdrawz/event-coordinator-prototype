import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { ChevronDown, MoreVertical, PanelRight, Plus, Trash2, UserRound } from 'lucide-react';
import { useAuth } from '../../../lib/auth';
import { can } from '../../../lib/permissions';
import { avatarColorFor } from '../../../lib/avatar';
import { Avatar } from '../../../components/Avatar';
import { Menu } from '../../../ui/Menu';
import { ConfirmDialog } from '../../../ui/ConfirmDialog';
import { BulkBar, SelectAllCell, SelectRowCell, isRowClick, useRowSelection } from '../../../ui/BulkSelect';
import { useEventAccess } from '../eventAccess';
import { usePeople } from '../team/teamData';
import { AddAttendeesModal } from './AddAttendeesModal';
import { AttendeePanel, attendeeSub, initialsOf } from './AttendeePanel';
import { ATTENDED, AttendedControl, CrmPill, OwnerControl, PeopleMenu, RsvpControl, pill } from './attendeeControls';
import {
  ATTENDEE_TYPE_LABEL, attendeeName, attendeesKey, removeAttendees, updateAttendees, useAttendeeCrmStatuses, useAttendees, useRsvps,
  type Attendee, type AttendeePatch,
} from './attendeesData';
import './attendees.css';

const plural = (n: number) => `${n} attendee${n === 1 ? '' : 's'}`;

/**
 * Who's invited to the event, how they answered, whether they came and who looks after them. HCPs are
 * added in bulk from EC or the CRMs. Clicking a row opens the attendee in a side panel with every field;
 * ticking rows offers bulk changes.
 */
const EXPERT_STAYS = 'Experts stay on the attendee list. Remove them from the event\'s experts first.';

export function AttendeesTab({ event }: { event: { id: string; name: string } }) {
  const { me } = useAuth();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const { canEdit: canEditEvent } = useEventAccess();
  const attendees = useAttendees(event.id);
  const rsvps = useRsvps().data;
  const crmStatuses = useAttendeeCrmStatuses().data;
  const [adding, setAdding] = useState(false);
  const [removing, setRemoving] = useState<Attendee[] | null>(null);
  const [openId, setOpenId] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const canAdd = canEditEvent && can(me, 'event_attendee', 'create');
  const canEdit = canEditEvent && can(me, 'event_attendee', 'edit');
  const canDelete = canEditEvent && can(me, 'event_attendee', 'delete');
  const people = usePeople(canEdit).data;
  useEffect(() => { if (!notice) return; const t = setTimeout(() => setNotice(null), 6000); return () => clearTimeout(t); }, [notice]);

  const list = attendees.data ?? [];
  const selection = useRowSelection(list.map((a) => a.id));
  const canSelect = canEdit || canDelete;
  const open = list.find((a) => a.id === openId) ?? null;

  const refresh = () => qc.invalidateQueries({ queryKey: attendeesKey(event.id) });
  /** One attendee (from the list or the panel) or the ticked ones (from the bulk bar). */
  const change = useMutation({
    mutationFn: ({ ids, patch }: { ids: string[]; patch: AttendeePatch }) => updateAttendees(ids, patch),
    onSuccess: (n, { ids }) => {
      if (ids.length > 1 || selection.some) setNotice(n === ids.length ? `${plural(n)} updated` : `${plural(n)} updated; ${ids.length - n} you can't edit were left as they were`);
    },
    onSettled: refresh,
  });
  const remove = useMutation({
    mutationFn: (rows: Attendee[]) => removeAttendees(rows.map((a) => a.id)),
    onSuccess: (n, rows) => {
      if (rows.some((a) => a.id === openId)) setOpenId(null);
      if (rows.length > 1) setNotice(`${plural(n)} removed`);
      setRemoving(null); refresh();
    },
  });
  const setOne = (id: string) => (patch: AttendeePatch) => change.mutate({ ids: [id], patch });
  const setMany = (patch: AttendeePatch) => change.mutate({ ids: [...selection.selected], patch });

  const accepted = list.filter((a) => a.rsvp === 'accepted').length;
  const ticked = list.filter((a) => selection.has(a.id));
  const tickedOff = ticked.filter((a) => a.type !== 'expert');
  const bulkButton = (label: string) => (t: object) => <button type="button" className="btn btn-sm" {...t}>{label}<ChevronDown size={14} aria-hidden /></button>;

  return (
    <section className="card ov-card" aria-labelledby="attendees-title">
      {selection.some ? (
        <BulkBar selection={selection} noun={['attendee', 'attendees']} notice={notice}>
          {canEdit && <>
            <Menu label="Set RSVP for the selected attendees" width={160}
              items={(rsvps ?? []).map((r) => ({ key: r.code, label: pill(r), text: r.label, onSelect: () => setMany({ rsvp: r.code }) }))} trigger={bulkButton('RSVP')} />
            <Menu label="Set Attended for the selected attendees" width={120}
              items={ATTENDED.map((o) => ({ key: o.label, label: pill(o), text: o.label, onSelect: () => setMany({ attended: o.value }) }))} trigger={bulkButton('Attended')} />
            <PeopleMenu label="Set the owner of the selected attendees" people={people} onPick={(p) => setMany({ owner_id: p.id })} trigger={bulkButton('Owner')} />
          </>}
          {canDelete && <button type="button" className="btn btn-sm btn-danger-outline" disabled={!tickedOff.length} title={tickedOff.length ? undefined : EXPERT_STAYS} onClick={() => setRemoving(tickedOff)}><Trash2 size={14} />Remove</button>}
        </BulkBar>
      ) : (
        <div className="ov-head">
          <div className="ov-title-row">
            <h2 id="attendees-title" className="ov-title">Attendees</h2>
            <span className="card-sub">{list.length === 0 ? 'No one invited yet' : `${list.length} invited · ${accepted} accepted`}</span>
          </div>
          <div className="ov-actions">
            {notice && <span className="bs-notice" role="status">{notice}</span>}
            {canAdd && <button className="btn btn-outline btn-sm" onClick={() => setAdding(true)}><Plus size={14} strokeWidth={2.6} />Add attendees</button>}
          </div>
        </div>
      )}

      {(attendees.error || change.error) && <div className="form-error" role="alert">{(attendees.error ?? change.error)!.message}</div>}

      {attendees.isLoading ? <div className="ov-empty text-muted">Loading…</div> : list.length === 0 ? (
        <div className="ov-empty">
          <span><strong>No attendees yet.</strong> Add HCPs from Event Center or search your CRMs for them.</span>
          {canAdd && <button className="btn btn-primary btn-sm" onClick={() => setAdding(true)}><Plus size={14} strokeWidth={2.6} />Add attendees</button>}
        </div>
      ) : (
        <div className="table-scroll">
          <table className="agenda-table attendees-table">
            <thead>
              <tr>
                {canSelect && <SelectAllCell selection={selection} label="Select all attendees" />}
                <th>Name</th><th>Type</th><th>RSVP</th><th>Attended</th><th>Owner</th><th>CRM</th><th aria-label="Actions" />
              </tr>
            </thead>
            <tbody>
              {list.map((a) => {
                const name = attendeeName(a);
                const menu = [
                  { key: 'details', label: 'Show details', icon: <PanelRight size={14} />, onSelect: () => setOpenId(a.id) },
                  ...(a.hcp_id ? [{ key: 'profile', label: 'View expert profile', icon: <UserRound size={14} />, onSelect: () => navigate(`/experts/${a.hcp_id}`) }] : []),
                  ...(canDelete ? [{ key: 'remove', label: 'Remove attendee', icon: <Trash2 size={14} />, danger: true, disabled: a.type === 'expert', onSelect: () => setRemoving([a]) }] : []),
                ];
                const cls = ['row-openable', a.id === openId && 'is-open', selection.has(a.id) && 'is-selected'].filter(Boolean).join(' ');
                return (
                  <tr key={a.id} className={cls} tabIndex={0}
                    onClick={(e) => { if (isRowClick(e)) setOpenId(a.id); }}
                    onKeyDown={(e) => { if (e.key === 'Enter' && e.target === e.currentTarget) setOpenId(a.id); }}>
                    {canSelect && <SelectRowCell selection={selection} id={a.id} label={`Select ${name}`} />}
                    <td>
                      <span className="dt-person">
                        <Avatar size={30} initials={a.user?.initials ?? initialsOf(name)} color={a.user?.avatar_color ?? avatarColorFor(name)} />
                        <span>
                          {a.hcp_id ? <Link to={`/experts/${a.hcp_id}`} className="agenda-title expert-link">{name}</Link> : <span className="agenda-title">{name}</span>}
                          <div className="dt-sub">{attendeeSub(a)}</div>
                        </span>
                      </span>
                    </td>
                    <td className="att-type">{ATTENDEE_TYPE_LABEL[a.type]}</td>
                    <td><RsvpControl name={name} value={a.rsvp} rsvps={rsvps} canEdit={canEdit} onChange={(rsvp) => setOne(a.id)({ rsvp })} /></td>
                    <td><AttendedControl name={name} value={a.attended} canEdit={canEdit} onChange={(attended) => setOne(a.id)({ attended })} /></td>
                    <td><OwnerControl name={name} owner={a.owner} people={people} canEdit={canEdit} onChange={(owner_id) => setOne(a.id)({ owner_id })} /></td>
                    <td><CrmPill status={a.crm_status} statuses={crmStatuses} /></td>
                    <td className="agenda-menu">
                      <Menu label={`Actions for ${name}`} items={menu} width={200}
                        trigger={(t) => <button type="button" className="icon-btn" aria-label={`Actions for ${name}`} {...t}><MoreVertical size={16} /></button>} />
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      {list.length > 0 && <p className="field-hint att-hint">Click a row for every detail{canSelect ? '; tick rows to change several at once' : ''}.</p>}

      {open && (
        <AttendeePanel a={open} rsvps={rsvps} crmStatuses={crmStatuses} people={people} canEdit={canEdit} canDelete={canDelete}
          onChange={setOne(open.id)} onRemove={() => setRemoving([open])} onClose={() => setOpenId(null)} />
      )}
      {adding && <AddAttendeesModal event={event} attending={list} onClose={() => setAdding(false)} />}
      {removing && (
        <ConfirmDialog title={removing.length === 1 ? 'Remove attendee' : `Remove ${plural(removing.length)}`} confirmLabel="Remove"
          pending={remove.isPending} error={remove.error?.message}
          onConfirm={() => remove.mutate(removing)} onCancel={() => { setRemoving(null); remove.reset(); }}>
          {removing.length === 1
            ? <>Remove {attendeeName(removing[0])} from this event's attendees?</>
            : <>Remove {plural(removing.length)} from this event's attendees?</>}
          {ticked.length > removing.length && removing.every((a) => selection.has(a.id)) && ` ${ticked.length - removing.length} who ${ticked.length - removing.length === 1 ? 'is an expert stays' : 'are experts stay'} on the list.`}
        </ConfirmDialog>
      )}
    </section>
  );
}
