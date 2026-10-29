import { useQuery } from '@tanstack/react-query';
import { supabase } from '../../../lib/supabase';
import type { Tone } from '../../../lib/types';

export type Rsvp = 'invited' | 'accepted' | 'tentative' | 'declined';
export type AttendeeCrmStatus = 'pending' | 'reconciled' | 'not_found' | 'not_applicable';
export interface Lookup<C extends string> { code: C; label: string; tone: Tone; sort: number }

export interface Attendee {
  id: string; attendee_kind: 'hcp' | 'user' | 'other'; hcp_id: string | null; user_id: string | null;
  display_name: string | null; organisation: string | null; role_label: string | null;
  rsvp: Rsvp; attended: boolean | null; crm_status: AttendeeCrmStatus;
  hcp: { display_name: string; last_name: string; city: string | null; specialty: { name: string } | null } | null;
  user: { display_name: string; last_name: string; initials: string | null; avatar_color: string | null } | null;
}

/** One person to add: an HCP in EC, or a CRM record that is copied into EC on the way. */
export type AttendeePick = { hcp_id: string } | { crm_connection_id: string; external_id: string };

export const attendeesKey = (eventId: string) => ['event', eventId, 'attendees'];

export const attendeeName = (a: Attendee) => a.hcp?.display_name ?? a.user?.display_name ?? a.display_name ?? 'Unknown';
const sortName = (a: Attendee) => a.hcp?.last_name ?? a.user?.last_name ?? a.display_name ?? '';

/** The event's attendees: HCPs first, then colleagues and guests, each by last name. */
export function useAttendees(eventId: string) {
  return useQuery({
    queryKey: attendeesKey(eventId),
    queryFn: async () => {
      const { data, error } = await supabase.from('event_attendee')
        .select('id,attendee_kind,hcp_id,user_id,display_name,organisation,role_label,rsvp,attended,crm_status,' +
                'hcp(display_name,last_name,city,specialty(name)),user:app_user!event_attendee_user_id_fkey(display_name,last_name,initials,avatar_color)')
        .eq('event_id', eventId);
      if (error) throw error;
      const kind = { hcp: 0, user: 1, other: 2 };
      return (data as unknown as Attendee[]).sort((a, b) => kind[a.attendee_kind] - kind[b.attendee_kind] || sortName(a).localeCompare(sortName(b)));
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

/** Adds HCPs from EC or the CRMs in one call (add_event_attendees); people already attending are skipped. */
export async function addAttendees(eventId: string, people: AttendeePick[]) {
  const { data, error } = await supabase.rpc('add_event_attendees', { p_event_id: eventId, p_people: people });
  if (error) throw new Error(error.message);
  return data as { added: number; skipped: number; attendees: string[] };
}
