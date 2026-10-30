import { Link } from 'react-router-dom';
import { Trash2, UserRound } from 'lucide-react';
import { avatarColorFor } from '../../../lib/avatar';
import { Avatar } from '../../../components/Avatar';
import { PanelField, PanelSection, SidePanel } from '../../../ui/SidePanel';
import { formatDate } from '../../../ui/DateInput';
import type { Person } from '../team/teamData';
import { AttendedControl, CrmPill, OwnerControl, RsvpControl, TextFieldControl } from './attendeeControls';
import { ATTENDEE_TYPE_LABEL, attendeeName, type Attendee, type AttendeeCrmStatus, type AttendeePatch, type Lookup, type Rsvp } from './attendeesData';

export const initialsOf = (n: string) => n.replace(/^(Dr|Prof)\.?\s+/i, '').split(/\s+/).map((w) => w[0]).slice(0, 2).join('').toUpperCase();
export const attendeeSub = (a: Attendee) => (a.hcp ? [a.hcp.specialty?.name, a.hcp.city].filter(Boolean).join(' · ') : a.user ? 'Colleague' : 'Guest');

/** Everything about one attendee, editable in place for people who can edit the event. */
export function AttendeePanel({ a, rsvps, crmStatuses, people, canEdit, canDelete, onChange, onRemove, onClose }: {
  a: Attendee; rsvps: Lookup<Rsvp>[] | undefined; crmStatuses: Lookup<AttendeeCrmStatus>[] | undefined; people: Person[] | undefined;
  canEdit: boolean; canDelete: boolean; onChange: (patch: AttendeePatch) => void; onRemove: () => void; onClose: () => void;
}) {
  const name = attendeeName(a);
  const when = (iso: string) => formatDate(iso.slice(0, 10));
  return (
    <SidePanel recordKey={a.id} onClose={onClose}
      leading={<Avatar size={40} initials={a.user?.initials ?? initialsOf(name)} color={a.user?.avatar_color ?? avatarColorFor(name)} />}
      title={name} subtitle={<>{ATTENDEE_TYPE_LABEL[a.type]}{attendeeSub(a) && <> · {attendeeSub(a)}</>}</>}
      footer={<>
        {a.hcp_id ? <Link to={`/experts/${a.hcp_id}`} className="btn btn-sm"><UserRound size={14} />View expert profile</Link> : <span />}
        {canDelete && <button type="button" className="btn btn-sm btn-danger-outline" disabled={a.type === 'expert'} title={a.type === 'expert' ? 'Remove them from the event\'s experts first' : undefined} onClick={onRemove}><Trash2 size={14} />Remove attendee</button>}
      </>}>
      <PanelSection title="Attendance">
        <PanelField label="RSVP"><RsvpControl name={name} value={a.rsvp} rsvps={rsvps} canEdit={canEdit} onChange={(rsvp) => onChange({ rsvp })} /></PanelField>
        <PanelField label="Attended"><AttendedControl name={name} value={a.attended} canEdit={canEdit} onChange={(attended) => onChange({ attended })} /></PanelField>
        <PanelField label="Owner"><OwnerControl name={name} owner={a.owner} people={people} canEdit={canEdit} onChange={(owner_id) => onChange({ owner_id })} /></PanelField>
      </PanelSection>
      <PanelSection title="Details">
        <PanelField label="Type">{ATTENDEE_TYPE_LABEL[a.type]}</PanelField>
        <PanelField label="Organisation">
          <TextFieldControl label="Organisation" value={a.organisation} canEdit={canEdit} onSave={(organisation) => onChange({ organisation })} />
        </PanelField>
        <PanelField label="Role">
          <TextFieldControl label="Role" value={a.role_label} canEdit={canEdit} placeholder="e.g. Advisor, Organiser" onSave={(role_label) => onChange({ role_label })} />
        </PanelField>
      </PanelSection>
      {a.attendee_kind === 'hcp' && (
        <PanelSection title="CRM">
          <PanelField label="Status"><CrmPill status={a.crm_status} statuses={crmStatuses} /></PanelField>
          <PanelField label="CRM">{a.crm_connection?.name ?? <span className="text-muted">Not linked</span>}</PanelField>
          <PanelField label="CRM ID">{a.crm_external_id ?? <span className="text-muted">—</span>}</PanelField>
        </PanelSection>
      )}
      <PanelSection title="Record">
        <PanelField label="Added">{when(a.created_at)}{a.creator && <> by {a.creator.display_name}</>}</PanelField>
        <PanelField label="Last changed">{when(a.updated_at)}</PanelField>
      </PanelSection>
    </SidePanel>
  );
}
