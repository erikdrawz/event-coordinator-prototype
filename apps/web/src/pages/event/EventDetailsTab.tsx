import type { ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import { ExternalLink, Pencil } from 'lucide-react';
import { supabase } from '../../lib/supabase';
import { useAuth } from '../../lib/auth';
import { can } from '../../lib/permissions';
import { eventDateTime } from '../../lib/format';
import { Avatar } from '../../components/Avatar';
import { formatDate } from '../../ui/DateInput';
import { useEventForm } from './EventFormProvider';
import { fieldsForType, useEventFormOptions, type CustomFieldDef, type UserOpt } from './eventForm';

interface Details {
  id: string; event_number: string; event_type_id: string; timezone: string; starts_at: string | null; ends_at: string | null;
  city: string | null; venue_name: string | null; venue_address: string | null; expected_attendees: number | null;
  estimated_spend: number | null; currency: string | null; description: string | null; custom_fields: Record<string, unknown>;
  event_type: { name: string } | null; country: { name: string } | null; therapeutic_area: { name: string } | null;
  owner: { display_name: string; initials: string | null; avatar_color: string | null; user_type: 'human' | 'agent' } | null;
  event_product: { product: { name: string } | null }[];
}

const SELECT = 'id,event_number,event_type_id,timezone,starts_at,ends_at,city,venue_name,venue_address,expected_attendees,estimated_spend,currency,description,custom_fields,' +
  'event_type(name),country(name),therapeutic_area(name),owner:app_user!event_owner_id_fkey(display_name,initials,avatar_color,user_type),event_product(product(name))';

const empty = <span className="text-muted">—</span>;

/** A custom field value for reading: labels for options, formatted numbers and dates, links for URLs. */
export function customValue(def: CustomFieldDef, v: unknown, users: UserOpt[]): ReactNode {
  if (v == null || v === '' || (Array.isArray(v) && !v.length)) return empty;
  const optLabel = (x: string) => def.options.find((o) => o.value === x)?.label ?? x;
  switch (def.field_type) {
    case 'picklist': return optLabel(String(v));
    case 'multi_picklist': return (v as string[]).map(optLabel).join(', ');
    case 'checkbox': return v ? 'Yes' : 'No';
    case 'date': return formatDate(String(v));
    case 'lookup_user': return users.find((u) => u.id === v)?.display_name ?? 'Unknown user';
    case 'number': case 'currency':
      return new Intl.NumberFormat('en-GB', def.decimals != null ? { minimumFractionDigits: def.decimals, maximumFractionDigits: def.decimals } : {}).format(Number(v));
    case 'url':
      return <a href={String(v)} target="_blank" rel="noopener noreferrer" className="details-link">{String(v).replace(/^https?:\/\//, '')}<ExternalLink size={13} aria-hidden /></a>;
    default: return <span className="details-text">{String(v)}</span>;
  }
}

function Row({ label, children, hint, wide }: { label: string; children: ReactNode; hint?: string | null; wide?: boolean }) {
  return (
    <div className={`details-row${wide ? ' wide' : ''}`}>
      <dt title={hint ?? undefined}>{label}</dt>
      <dd>{children}</dd>
    </div>
  );
}

/** Everything captured on the event: base fields, then the custom fields its type shows. */
export function EventDetailsTab({ eventId }: { eventId: string }) {
  const { me } = useAuth();
  const { openEditEvent } = useEventForm();
  const options = useEventFormOptions();
  const { data: e, isLoading, error } = useQuery({
    queryKey: ['event', eventId, 'details'],
    queryFn: async () => {
      const { data, error } = await supabase.from('event').select(SELECT).eq('id', eventId).single();
      if (error) throw error;
      return data as unknown as Details;
    },
  });

  if (isLoading || options.isLoading) return <section className="card details-card"><div className="text-muted">Loading…</div></section>;
  if (error || !e) return <section className="card details-card"><div className="form-error">Couldn't load the details: {error?.message}</div></section>;

  const custom = [...fieldsForType(options.data?.fields ?? [], e.event_type_id).values()].flat();
  const money = e.estimated_spend != null
    ? new Intl.NumberFormat('en-GB', { style: 'currency', currency: e.currency ?? 'EUR', maximumFractionDigits: 0 }).format(e.estimated_spend) : null;

  return (
    <section className="card details-card" aria-labelledby="details-title">
      <div className="details-head">
        <h2 id="details-title" className="card-title">Event details</h2>
        {can(me, 'event', 'edit') && <button className="btn" onClick={() => openEditEvent(e.id)}><Pencil size={14} />Edit</button>}
      </div>

      <h3 className="details-section">Event</h3>
      <dl className="details-grid">
        <Row label="Event number">{e.event_number}</Row>
        <Row label="Event type">{e.event_type?.name ?? empty}</Row>
        <Row label="Owner">{e.owner ? <span className="dt-person"><Avatar size={22} initials={e.owner.initials} color={e.owner.avatar_color} isAgent={e.owner.user_type === 'agent'} />{e.owner.display_name}</span> : empty}</Row>
        <Row label="Therapeutic area">{e.therapeutic_area?.name ?? empty}</Row>
        <Row label="Products" wide>{e.event_product.length ? e.event_product.map((p) => p.product?.name).filter(Boolean).join(', ') : empty}</Row>
        <Row label="Description" wide>{e.description ? <span className="details-text">{e.description}</span> : empty}</Row>
      </dl>

      <h3 className="details-section">When and where</h3>
      <dl className="details-grid">
        <Row label="Starts">{e.starts_at ? eventDateTime(e.starts_at, e.timezone) : empty}</Row>
        <Row label="Ends">{e.ends_at ? eventDateTime(e.ends_at, e.timezone) : empty}</Row>
        <Row label="Country">{e.country?.name ?? empty}</Row>
        <Row label="City">{e.city ?? empty}</Row>
        <Row label="Venue">{e.venue_name ?? empty}</Row>
        <Row label="Venue address">{e.venue_address ?? empty}</Row>
        <Row label="Time zone">{e.timezone.replace(/_/g, ' ')}</Row>
      </dl>

      <h3 className="details-section">Planning</h3>
      <dl className="details-grid">
        <Row label="Expected attendees">{e.expected_attendees ?? empty}</Row>
        <Row label="Estimated spend">{money ?? empty}</Row>
      </dl>

      {custom.length > 0 && <>
        <h3 className="details-section">Additional details</h3>
        <dl className="details-grid">
          {custom.map((d) => (
            <Row key={d.id} label={d.label} hint={d.help_text} wide={d.field_type === 'long_text'}>
              {customValue(d, e.custom_fields[d.api_name], options.data?.users ?? [])}
            </Row>
          ))}
        </dl>
      </>}
    </section>
  );
}
