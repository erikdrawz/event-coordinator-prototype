import { useQuery } from '@tanstack/react-query';
import { supabase } from '../../../lib/supabase';
import type { Tone } from '../../../lib/types';

export type Rsvp = 'invited' | 'accepted' | 'tentative' | 'declined';
export type AttendeeCrmStatus = 'pending' | 'reconciled' | 'not_found' | 'not_applicable';
export interface Lookup<C extends string> { code: C; label: string; tone: Tone; sort: number }

/** user: a colleague; expert: an HCP on the event's Experts list; attendee: anyone else */
export type AttendeeType = 'user' | 'expert' | 'attendee';
export const ATTENDEE_TYPE_LABEL: Record<AttendeeType, string> = { expert: 'Expert', attendee: 'Attendee', user: 'User' };

export interface Attendee {
  id: string; attendee_kind: 'hcp' | 'user' | 'other'; hcp_id: string | null; user_id: string | null;
  display_name: string | null; organisation: string | null; role_label: string | null;
  rsvp: Rsvp; attended: boolean; crm_status: AttendeeCrmStatus;
  /** Who is responsible for the attendee: whoever added them, unless handed on */
  owner_id: string | null; owner: { id: string; display_name: string; initials: string | null; avatar_color: string | null } | null;
  hcp: { display_name: string; last_name: string; city: string | null; specialty: { name: string } | null } | null;
  user: { display_name: string; last_name: string; initials: string | null; avatar_color: string | null } | null;
  /** Worked out on load: it follows the event's Experts list */
  type: AttendeeType;
  crm_external_id: string | null; crm_connection: { name: string } | null;
  created_at: string; updated_at: string; creator: { display_name: string } | null;
}

/** One person to add: an HCP in EC, or a CRM record that is copied into EC on the way. */
export type AttendeePick = { hcp_id: string } | { crm_connection_id: string; external_id: string };

export const attendeesKey = (eventId: string) => ['event', eventId, 'attendees'];

export const attendeeName = (a: Attendee) => a.hcp?.display_name ?? a.user?.display_name ?? a.display_name ?? 'Unknown';
const sortName = (a: Attendee) => a.hcp?.last_name ?? a.user?.last_name ?? a.display_name ?? '';

/** The event's attendees with their type: experts first, then other attendees, then users, each by last name. */
export function useAttendees(eventId: string) {
  return useQuery({
    queryKey: attendeesKey(eventId),
    queryFn: async () => {
      const experts = await supabase.from('event_expert').select('hcp_id').eq('event_id', eventId);
      if (experts.error) throw experts.error;
      const onExperts = new Set((experts.data ?? []).map((x) => x.hcp_id as string));
      const { data, error } = await supabase.from('event_attendee')
        .select('id,attendee_kind,hcp_id,user_id,display_name,organisation,role_label,rsvp,attended,crm_status,owner_id,' +
                'owner:app_user!event_attendee_owner_id_fkey(id,display_name,initials,avatar_color),' +
                'crm_external_id,crm_connection(name),created_at,updated_at,creator:app_user!event_attendee_created_by_fkey(display_name),' +
                'hcp(display_name,last_name,city,specialty(name)),user:app_user!event_attendee_user_id_fkey(display_name,last_name,initials,avatar_color)')
        .eq('event_id', eventId);
      if (error) throw error;
      const order: Record<AttendeeType, number> = { expert: 0, attendee: 1, user: 2 };
      return (data as unknown as Omit<Attendee, 'type'>[])
        .map((a): Attendee => ({ ...a, type: a.attendee_kind === 'user' ? 'user' : a.hcp_id && onExperts.has(a.hcp_id) ? 'expert' : 'attendee' }))
        .sort((a, b) => order[a.type] - order[b.type] || sortName(a).localeCompare(sortName(b)));
    },
  });
}

function useLookup<C extends string>(table: string) {
  return useQuery({
    queryKey: [table], staleTime: Infinity,
    queryFn: async () => {
      const { data, error } = await supabase.from(table).select('code,label,tone,sort').order('sort');
      if (error) throw error;
      return data as Lookup<C>[];
    },
  });
}
export const useRsvps = () => useLookup<Rsvp>('attendee_rsvp');
export const useAttendeeCrmStatuses = () => useLookup<AttendeeCrmStatus>('attendee_crm_status');

export type AttendeePatch = { rsvp?: Rsvp; attended?: boolean; owner_id?: string; organisation?: string | null; role_label?: string | null };

/** Changes one or many attendees in one call; returns how many the database let through (the rest weren't editable). */
export async function updateAttendees(ids: string[], patch: AttendeePatch) {
  const { data, error } = await supabase.from('event_attendee').update(patch).in('id', ids).select('id');
  if (error) throw new Error(error.message);
  return data.length;
}
/** Removes one or many attendees; returns how many were removed. */
export async function removeAttendees(ids: string[]) {
  const { data, error } = await supabase.from('event_attendee').delete().in('id', ids).select('id');
  if (error) throw new Error(error.message);
  return data.length;
}

/** Adds HCPs from EC or the CRMs in one call (add_event_attendees); people already attending are skipped. */
export async function addAttendees(eventId: string, people: AttendeePick[]) {
  const { data, error } = await supabase.rpc('add_event_attendees', { p_event_id: eventId, p_people: people });
  if (error) throw new Error(error.message);
  return data as { added: number; skipped: number; attendees: string[] };
}
