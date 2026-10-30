import { useQuery } from '@tanstack/react-query';
import { supabase } from '../../lib/supabase';
import type { EventStatus, Tone } from '../../lib/types';
import type { Rsvp } from '../event/attendees/attendeesData';

export type Eligibility = 'eligible' | 'pending' | 'ineligible';

export interface FmvRate {
  id: string; effective_date: string; expiration_date: string | null;
  rate: number; min_rate: number; max_rate: number; currency: string;
}

/** An expert is an HCP in EC's own table. */
export interface ExpertRow {
  id: string; display_name: string; salutation: string | null; first_name: string; last_name: string;
  specialty_id: string | null; primary_hco_id: string | null; country_code: string | null; city: string | null; email: string | null; tier: string | null; status: string;
  eligibility: Eligibility; eligibility_note: string | null;
  source: string; crm_external_id: string | null; onekey_id: string | null;
  specialty: { name: string } | null;
  country: { name: string } | null;
  primary_hco: { name: string; city: string | null; address: string | null } | null;
  crm_connection: { name: string } | null;
  fmv_rate: FmvRate[];
  /** On events I can see */
  event_expert: { event_id: string }[];
  event_attendee: { event_id: string }[];
}

const EXPERT_SELECT = 'id,display_name,salutation,first_name,last_name,specialty_id,primary_hco_id,country_code,city,email,tier,status,eligibility,eligibility_note,source,crm_external_id,onekey_id,' +
  'specialty(name),country(name),primary_hco:hco(name,city,address),crm_connection(name),' +
  'fmv_rate(id,effective_date,expiration_date,rate,min_rate,max_rate,currency),event_expert(event_id),event_attendee(event_id)';

/** numeric columns arrive as strings; normalise once */
const normalise = (x: ExpertRow): ExpertRow => ({
  ...x, fmv_rate: x.fmv_rate.map((f) => ({ ...f, rate: Number(f.rate), min_rate: Number(f.min_rate), max_rate: Number(f.max_rate) }))
    .sort((a, b) => b.effective_date.localeCompare(a.effective_date)),
});

/** Expert eligibility labels and tones (expert_eligibility). */
export function useEligibilities() {
  return useQuery({
    queryKey: ['expert_eligibility'], staleTime: Infinity,
    queryFn: async () => {
      const { data, error } = await supabase.from('expert_eligibility').select('code,label,tone,sort').order('sort');
      if (error) throw error;
      return data as { code: Eligibility; label: string; tone: Tone; sort: number }[];
    },
  });
}

/** Every active expert. Small enough to load whole; filtering happens in the browser. */
export function useExpertDirectory() {
  return useQuery({
    queryKey: ['experts'],
    queryFn: async () => {
      const { data, error } = await supabase.from('hcp').select(EXPERT_SELECT).eq('status', 'active').order('last_name').order('first_name');
      if (error) throw error;
      return (data as unknown as ExpertRow[]).map(normalise);
    },
  });
}

export function useExpert(id: string | undefined) {
  return useQuery({
    queryKey: ['expert', id],
    enabled: Boolean(id),
    queryFn: async () => {
      const { data, error } = await supabase.from('hcp').select(EXPERT_SELECT).eq('id', id!).maybeSingle();
      if (error) throw error;
      return data ? normalise(data as unknown as ExpertRow) : null;
    },
  });
}

/** Choices for the Edit expert form: specialties and organisations (HCOs). */
export function useExpertFormOptions() {
  return useQuery({
    queryKey: ['expert-form-options'], staleTime: 5 * 60_000,
    queryFn: async () => {
      const [sp, hco] = await Promise.all([
        supabase.from('specialty').select('id,name').order('name'),
        supabase.from('hco').select('id,name,city').order('name'),
      ]);
      if (sp.error) throw sp.error;
      if (hco.error) throw hco.error;
      return { specialties: sp.data as { id: string; name: string }[], hcos: hco.data as { id: string; name: string; city: string | null }[] };
    },
  });
}

/** One event the expert is part of: as an expert (speaker, chair, …) or simply attending. */
export interface Engagement {
  id: string; type: 'expert' | 'attendee'; role: string | null; eligibility: Eligibility | null;
  hourly_rate: number | null; currency: string | null; total_payable: number | null; rsvp: Rsvp | null; attended: boolean;
  event: { id: string; name: string; status: EventStatus; starts_at: string | null; timezone: string; city: string | null;
           event_type: { name: string } | null; country: { name: string } | null } | null;
}

/** How many events the expert is part of, in either way. */
export const engagementCount = (x: ExpertRow) => new Set([...x.event_expert, ...x.event_attendee].map((e) => e.event_id)).size;

const ENGAGEMENT_EVENT = 'event(id,name,status,starts_at,timezone,city,event_type(name),country(name))';

/**
 * The events the expert was or will be part of (only events I can see), newest first. One row per
 * event: someone on the event's Experts list counts as an expert, even if they're also an attendee.
 */
export function useEngagements(hcpId: string | undefined) {
  return useQuery({
    queryKey: ['expert', hcpId, 'engagements'],
    enabled: Boolean(hcpId),
    queryFn: async () => {
      const [experts, attendees] = await Promise.all([
        supabase.from('event_expert').select(`id,role,eligibility,hourly_rate,currency,total_payable,${ENGAGEMENT_EVENT}`).eq('hcp_id', hcpId!),
        supabase.from('event_attendee').select(`id,rsvp,attended,${ENGAGEMENT_EVENT}`).eq('hcp_id', hcpId!),
      ]);
      if (experts.error) throw experts.error;
      if (attendees.error) throw attendees.error;
      type AttendeeRow = Pick<Engagement, 'id' | 'attended' | 'event'> & { rsvp: Rsvp };
      type ExpertEngagement = Pick<Engagement, 'id' | 'role' | 'eligibility' | 'hourly_rate' | 'currency' | 'total_payable' | 'event'>;
      const attending = new Map((attendees.data as unknown as AttendeeRow[]).map((a) => [a.event?.id, a]));
      const asExpert: Engagement[] = (experts.data as unknown as ExpertEngagement[]).map((x) => {
        const a = attending.get(x.event?.id);
        attending.delete(x.event?.id);
        return { ...x, type: 'expert', total_payable: Number(x.total_payable), hourly_rate: x.hourly_rate == null ? null : Number(x.hourly_rate), rsvp: a?.rsvp ?? null, attended: a?.attended ?? false };
      });
      const asAttendee: Engagement[] = [...attending.values()].map((a) => ({
        ...a, type: 'attendee', role: null, eligibility: null, hourly_rate: null, currency: null, total_payable: null }));
      return [...asExpert, ...asAttendee].sort((a, b) => (b.event?.starts_at ?? '').localeCompare(a.event?.starts_at ?? ''));
    },
  });
}

const today = () => new Date().toLocaleDateString('en-CA');

/** The FMV record that applies on a date (records are newest first and don't overlap). */
export const fmvOn = (rates: FmvRate[], on = today()) =>
  rates.find((f) => f.effective_date <= on && (!f.expiration_date || f.expiration_date >= on)) ?? null;

export const fmvState = (f: FmvRate, on = today()): 'current' | 'expired' | 'upcoming' =>
  f.effective_date > on ? 'upcoming' : f.expiration_date && f.expiration_date < on ? 'expired' : 'current';

export const initialsOf = (x: { first_name: string; last_name: string }) => `${x.first_name[0] ?? ''}${x.last_name[0] ?? ''}`.toUpperCase();
