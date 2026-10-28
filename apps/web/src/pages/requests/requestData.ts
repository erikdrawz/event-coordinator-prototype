import { useQuery } from '@tanstack/react-query';
import { supabase } from '../../lib/supabase';
import type { Tone } from '../../lib/types';
import type { Person } from '../event/team/teamData';

export type RequestStatus = 'draft' | 'review' | 'approved' | 'rejected';
interface StatusRow { code: RequestStatus; label: string; tone: Tone; sort: number }

const PERSON = 'id,display_name,initials,avatar_color,job_title,user_type';

export interface RequestRow {
  id: string; request_number: string; title: string; status: RequestStatus; event_type_id: string;
  timezone: string; starts_at: string | null; ends_at: string | null; rationale: string | null;
  submitted_at: string | null; created_at: string; requested_by: string; event_id: string | null;
  event_type: { name: string } | null;
  requester: Person | null;
  coordinator: Person | null;
}
export const REQUEST_SELECT = 'id,request_number,title,status,event_type_id,timezone,starts_at,ends_at,rationale,submitted_at,created_at,requested_by,event_id,' +
  `event_type(name),requester:app_user!event_request_requested_by_fkey(${PERSON}),coordinator:app_user!event_request_coordinator_id_fkey(${PERSON})`;

/** Request statuses (labels, tones) from request_status, like event statuses. */
export function useRequestStatuses() {
  return useQuery({
    queryKey: ['request_status'], staleTime: Infinity,
    queryFn: async () => {
      const { data, error } = await supabase.from('request_status').select('code,label,tone,sort').order('sort');
      if (error) throw error;
      return data as StatusRow[];
    },
  });
}

export interface RequestListRow extends RequestRow { /** Only my team row, if any. */ my_team: { team_role: string }[] }

/** Every request I can see (RLS decides: my teams' requests, plus submitted ones for home office). */
export function useRequests(meId: string | undefined) {
  return useQuery({
    queryKey: ['requests', meId],
    enabled: Boolean(meId),
    queryFn: async () => {
      const { data, error } = await supabase.from('event_request').select(`${REQUEST_SELECT},my_team:request_team_member(team_role)`)
        .eq('my_team.user_id', meId!)
        .order('created_at', { ascending: false });
      if (error) throw error;
      return data as unknown as RequestListRow[];
    },
  });
}

export function useRequest(id: string | undefined) {
  return useQuery({
    queryKey: ['request', id],
    enabled: Boolean(id),
    queryFn: async () => {
      const { data, error } = await supabase.from('event_request').select(REQUEST_SELECT).eq('id', id!).maybeSingle();
      if (error) throw error;
      return data as unknown as RequestRow | null;
    },
  });
}

/** My access to a request (my_request_access): its Team decides, the database enforces. */
export function useMyRequestAccess(id: string | undefined) {
  return useQuery({
    queryKey: ['request', id, 'access'],
    enabled: Boolean(id),
    queryFn: async () => {
      const { data, error } = await supabase.rpc('my_request_access', { p_request_id: id });
      if (error) throw error;
      return data as { access: 'edit' | 'view' | null; team_role: string | null };
    },
  });
}

/** Active event types, for the request form. */
export function useRequestTypes() {
  return useQuery({
    queryKey: ['request-types'], staleTime: 5 * 60_000,
    queryFn: async () => {
      const { data, error } = await supabase.from('event_type').select('id,name,default_duration_minutes').eq('is_active', true).order('name');
      if (error) throw error;
      return data as { id: string; name: string; default_duration_minutes: number | null }[];
    },
  });
}

/** What still has to be filled in before a draft can be submitted (the database checks the same). */
export function missingForSubmit(r: Pick<RequestRow, 'starts_at' | 'ends_at' | 'rationale'>) {
  return [!r.starts_at && 'start', !r.ends_at && 'end', !r.rationale?.trim() && 'business justification'].filter(Boolean) as string[];
}
