import { useQuery } from '@tanstack/react-query';
import { supabase } from '../../lib/supabase';

// ---------- Reference data for the form ----------

export interface EventTypeOpt { id: string; name: string; default_duration_minutes: number | null }
export interface CountryOpt { code: string; name: string; default_timezone: string | null }
export interface CustomFieldDef {
  id: string; api_name: string; label: string; is_required: boolean; help_text: string | null;
  field_type: 'text' | 'long_text' | 'number' | 'currency' | 'date' | 'checkbox' | 'picklist' | 'multi_picklist' | 'lookup_user';
  options: { value: string; label: string }[];
  custom_field_layout: { event_type_id: string | null; section: string; sort: number }[];
}
export interface UserOpt { id: string; display_name: string }

async function rows<T>(q: PromiseLike<{ data: unknown; error: { message: string } | null }>) {
  const { data, error } = await q;
  if (error) throw new Error(error.message);
  return data as T[];
}

/** Everything the event form needs to render, loaded once and cached. */
export function useEventFormOptions() {
  return useQuery({
    queryKey: ['event-form-options'],
    staleTime: 5 * 60_000,
    queryFn: async () => {
      const [types, countries, areas, products, users, fields] = await Promise.all([
        rows<EventTypeOpt>(supabase.from('event_type').select('id,name,default_duration_minutes').eq('is_active', true).order('name')),
        rows<CountryOpt>(supabase.from('country').select('code,name,default_timezone').order('name')),
        rows<{ id: string; name: string }>(supabase.from('therapeutic_area').select('id,name').order('name')),
        rows<{ id: string; name: string; therapeutic_area_id: string | null }>(supabase.from('product').select('id,name,therapeutic_area_id').order('name')),
        rows<UserOpt>(supabase.from('app_user').select('id,display_name').eq('user_type', 'human').eq('status', 'active').order('display_name')),
        rows<CustomFieldDef>(supabase.from('custom_field')
          .select('id,api_name,label,field_type,options,is_required,help_text,custom_field_layout(event_type_id,section,sort)')
          .eq('object_name', 'event').eq('is_active', true)),
      ]);
      return { types, countries, areas, products, users, fields };
    },
  });
}

/** Custom fields shown for an event type, grouped by layout section in display order. */
export function fieldsForType(defs: CustomFieldDef[], typeId: string) {
  const placed = defs.flatMap((d) => {
    // A type-specific layout wins over the "all types" one
    const l = d.custom_field_layout.find((x) => x.event_type_id === typeId) ?? d.custom_field_layout.find((x) => x.event_type_id === null);
    return l ? [{ def: d, section: l.section, sort: l.sort }] : [];
  }).sort((a, b) => a.sort - b.sort || a.def.label.localeCompare(b.def.label));
  const sections = new Map<string, CustomFieldDef[]>();
  const rank = (s: string) => { const i = SECTION_ORDER.indexOf(s); return i < 0 ? SECTION_ORDER.length : i; };
  [...new Set(placed.map((p) => p.section))].sort((a, b) => rank(a) - rank(b) || a.localeCompare(b))
    .forEach((s) => sections.set(s, placed.filter((p) => p.section === s).map((p) => p.def)));
  return sections;
}

/** Known layout sections in display order; admin-made sections follow alphabetically. */
const SECTION_ORDER = ['details', 'finance', 'compliance'];
export const SECTION_TITLES: Record<string, string> = { details: 'Additional details', finance: 'Finance', compliance: 'Compliance' };
export const sectionTitle = (s: string) => SECTION_TITLES[s] ?? s.replace(/_/g, ' ').replace(/^./, (c) => c.toUpperCase());

// ---------- Form state ----------

export interface EventFormState {
  name: string; event_type_id: string; therapeutic_area_id: string; product_ids: string[]; owner_id: string;
  country_code: string; city: string; venue_name: string; venue_address: string; timezone: string;
  starts_local: string; ends_local: string;
  expected_attendees: string; estimated_spend: string; currency: string; description: string;
  custom: Record<string, unknown>;
}

export interface EventRecord {
  id: string; name: string; event_type_id: string; therapeutic_area_id: string | null; owner_id: string | null;
  country_code: string | null; city: string | null; venue_name: string | null; venue_address: string | null; timezone: string;
  starts_at: string | null; ends_at: string | null; expected_attendees: number | null; estimated_spend: number | null;
  currency: string | null; description: string | null; custom_fields: Record<string, unknown>;
  event_product: { product_id: string }[];
}

export const EVENT_RECORD_SELECT =
  'id,name,event_type_id,therapeutic_area_id,owner_id,country_code,city,venue_name,venue_address,timezone,starts_at,ends_at,' +
  'expected_attendees,estimated_spend,currency,description,custom_fields,event_product(product_id)';

export function emptyForm(meId: string): EventFormState {
  return {
    name: '', event_type_id: '', therapeutic_area_id: '', product_ids: [], owner_id: meId,
    country_code: '', city: '', venue_name: '', venue_address: '', timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    starts_local: '', ends_local: '', expected_attendees: '', estimated_spend: '', currency: 'EUR', description: '', custom: {},
  };
}

export function formFromRecord(e: EventRecord): EventFormState {
  const s = (v: string | number | null) => (v == null ? '' : String(v));
  return {
    name: e.name, event_type_id: e.event_type_id, therapeutic_area_id: s(e.therapeutic_area_id),
    product_ids: e.event_product.map((p) => p.product_id), owner_id: s(e.owner_id),
    country_code: s(e.country_code), city: s(e.city), venue_name: s(e.venue_name), venue_address: s(e.venue_address),
    timezone: e.timezone,
    starts_local: e.starts_at ? toLocalInput(e.starts_at, e.timezone) : '',
    ends_local: e.ends_at ? toLocalInput(e.ends_at, e.timezone) : '',
    expected_attendees: s(e.expected_attendees), estimated_spend: s(e.estimated_spend), currency: e.currency ?? 'EUR',
    description: s(e.description), custom: { ...e.custom_fields },
  };
}

const isEmpty = (v: unknown) => v == null || v === '' || (Array.isArray(v) && v.length === 0);

/**
 * The create_event / update_event payload. Times go as wall-clock times in the event's zone,
 * which the database converts. Custom fields: the ones shown for this type; empty ones are sent
 * as null so an edit clears them.
 */
export function toPayload(f: EventFormState, shown: CustomFieldDef[]) {
  const t = (v: string) => (v.trim() === '' ? null : v.trim());
  const n = (v: string) => (v.trim() === '' ? null : Number(v));
  const custom: Record<string, unknown> = {};
  shown.forEach((d) => {
    const v = f.custom[d.api_name];
    custom[d.api_name] = isEmpty(v) ? null : v;
  });
  return {
    name: f.name.trim(), event_type_id: f.event_type_id, therapeutic_area_id: t(f.therapeutic_area_id),
    product_ids: f.product_ids, owner_id: t(f.owner_id),
    country_code: t(f.country_code), city: t(f.city), venue_name: t(f.venue_name), venue_address: t(f.venue_address),
    timezone: f.timezone, starts_local: t(f.starts_local), ends_local: t(f.ends_local),
    expected_attendees: n(f.expected_attendees), estimated_spend: n(f.estimated_spend), currency: t(f.currency),
    description: t(f.description), custom_fields: custom,
  };
}

/** Client-side required checks, so people see problems before saving. The database checks again. */
export function validate(f: EventFormState, shown: CustomFieldDef[]) {
  const errors: Record<string, string> = {};
  if (!f.name.trim()) errors.name = 'Give the event a name';
  if (!f.event_type_id) errors.event_type_id = 'Choose an event type';
  if (f.starts_local && f.ends_local && f.ends_local < f.starts_local) errors.ends_local = 'Ends before it starts';
  shown.forEach((d) => { if (d.is_required && isEmpty(f.custom[d.api_name])) errors[d.api_name] = `${d.label} is required`; });
  return errors;
}

// ---------- Times ----------

/** An instant as 'YYYY-MM-DDTHH:mm' wall-clock time in a zone, for <input type="datetime-local">. */
export function toLocalInput(iso: string, timeZone: string) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-CA', {
    timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(new Date(iso)).map((x) => [x.type, x.value]));
  return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}`;
}

/** Adds minutes to a wall-clock 'YYYY-MM-DDTHH:mm' string (no zone involved). */
export function addMinutesLocal(local: string, minutes: number) {
  const d = new Date(`${local}:00Z`);
  d.setUTCMinutes(d.getUTCMinutes() + minutes);
  return d.toISOString().slice(0, 16);
}

export const TIME_ZONES = Intl.supportedValuesOf('timeZone');
