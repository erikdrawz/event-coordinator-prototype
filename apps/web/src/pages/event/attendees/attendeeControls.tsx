import { useEffect, useState, type ReactNode } from 'react';
import { ChevronDown } from 'lucide-react';
import { Avatar } from '../../../components/Avatar';
import { Menu } from '../../../ui/Menu';
import type { Person } from '../team/teamData';
import type { Attendee, AttendeeCrmStatus, Lookup, Rsvp } from './attendeesData';

/** The same controls in the list, the side panel and the bulk bar. */

export const ATTENDED = [{ value: true, label: 'Yes', tone: 'green' }, { value: false, label: 'No', tone: 'grey' }] as const;
export const attendedOf = (v: boolean) => ATTENDED.find((o) => o.value === v)!;

export const pill = (row: { label: string; tone: string } | undefined) => row && <span className={`pill pill-${row.tone}`}>{row.label}</span>;

function PillMenu<V>({ label, current, options, onChange, width = 160 }: {
  label: string; current: { label: string; tone: string }; options: { value: V; label: string; tone: string }[]; onChange: (v: V) => void; width?: number;
}) {
  return (
    <Menu label={label} width={width}
      items={options.map((o) => ({ key: String(o.value), label: pill(o), text: o.label, onSelect: () => onChange(o.value) }))}
      trigger={(t) => (
        <button type="button" className={`pill pill-${current.tone} att-rsvp`} aria-label={`${label}: ${current.label}. Change`} {...t}>
          {current.label}<ChevronDown size={12} strokeWidth={2.6} aria-hidden />
        </button>
      )} />
  );
}

export function RsvpControl({ name, value, rsvps, canEdit, onChange }: {
  name: string; value: Rsvp; rsvps: Lookup<Rsvp>[] | undefined; canEdit: boolean; onChange: (v: Rsvp) => void;
}) {
  const current = rsvps?.find((r) => r.code === value) ?? { label: value, tone: 'grey' };
  if (!canEdit) return pill(current);
  return <PillMenu label={`RSVP for ${name}`} current={current} options={(rsvps ?? []).map((r) => ({ value: r.code, label: r.label, tone: r.tone }))}
    onChange={(v) => v !== value && onChange(v)} />;
}

export function AttendedControl({ name, value, canEdit, onChange }: { name: string; value: boolean; canEdit: boolean; onChange: (v: boolean) => void }) {
  if (!canEdit) return pill(attendedOf(value));
  return <PillMenu label={`Attended for ${name}`} current={attendedOf(value)} options={[...ATTENDED]} width={120}
    onChange={(v) => v !== value && onChange(v)} />;
}

export function OwnerValue({ owner }: { owner: Attendee['owner'] }) {
  return owner
    ? <span className="dt-person"><Avatar size={22} initials={owner.initials} color={owner.avatar_color} />{owner.display_name}</span>
    : <span className="text-muted">—</span>;
}

/** A searchable list of active people; `trigger` renders the button. */
export function PeopleMenu({ label, people, onPick, trigger }: {
  label: string; people: Person[] | undefined; onPick: (p: Person) => void; trigger: Parameters<typeof Menu>[0]['trigger'];
}) {
  return (
    <Menu label={label} width={240} searchable
      items={(people ?? []).map((p) => ({ key: p.id, label: <span className="dt-person"><Avatar size={22} initials={p.initials} color={p.avatar_color} />{p.display_name}</span>, text: p.display_name, onSelect: () => onPick(p) }))}
      trigger={trigger} />
  );
}

export function OwnerControl({ name, owner, people, canEdit, onChange }: {
  name: string; owner: Attendee['owner']; people: Person[] | undefined; canEdit: boolean; onChange: (id: string) => void;
}) {
  if (!canEdit) return <OwnerValue owner={owner} />;
  return (
    <PeopleMenu label={`Owner of ${name}`} people={people} onPick={(p) => p.id !== owner?.id && onChange(p.id)}
      trigger={(t) => (
        <button type="button" className="att-owner" aria-label={`Owner of ${name}: ${owner?.display_name ?? 'nobody'}. Change`} {...t}>
          <OwnerValue owner={owner} /><ChevronDown size={12} strokeWidth={2.6} aria-hidden />
        </button>
      )} />
  );
}

export function CrmPill({ status, statuses }: { status: AttendeeCrmStatus; statuses: Lookup<AttendeeCrmStatus>[] | undefined }) {
  return status === 'not_applicable' ? <span className="text-muted">—</span> : <>{pill(statuses?.find((c) => c.code === status))}</>;
}

/** A short text field that saves when you leave it (or press Enter); Esc puts it back. */
export function TextFieldControl({ label, value, canEdit, onSave, placeholder }: {
  label: string; value: string | null; canEdit: boolean; onSave: (v: string | null) => void; placeholder?: string;
}): ReactNode {
  const [text, setText] = useState(value ?? '');
  useEffect(() => setText(value ?? ''), [value]);
  if (!canEdit) return value ?? <span className="text-muted">—</span>;
  const commit = () => { const v = text.trim() || null; if (v !== (value ?? null)) onSave(v); };
  return (
    <input className="input" aria-label={label} value={text} placeholder={placeholder} onChange={(e) => setText(e.target.value)} onBlur={commit}
      onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); if (e.key === 'Escape') { e.preventDefault(); setText(value ?? ''); } }} />
  );
}
