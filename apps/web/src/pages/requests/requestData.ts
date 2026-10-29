import { useQuery } from '@tanstack/react-query';
import { supabase } from '../../lib/supabase';
import type { Tone } from '../../lib/types';
import type { Person } from '../event/team/teamData';

export type RequestStatus = 'draft' | 'review' | 'approved' | 'rejected';
/** Event request or tiering request (request_type) */
export type RequestKind = 'event' | 'tiering';
interface StatusRow { code: RequestStatus; label: string; tone: Tone; sort: number }

const PERSON = 'id,display_name,initials,avatar_color,job_title,user_type';

export interface RequestRow {
  id: string; request_number: string; title: string; status: RequestStatus; request_type: RequestKind; event_type_id: string | null;
  /** 'YYYY-MM-DD' */ event_date: string | null; duration: string | null; rationale: string | null;
  submitted_at: string | null; created_at: string; requested_by: string; event_id: string | null;
  event_type: { name: string } | null;
  /** Tiering request: the expert, and the event they're needed for */
  hcp_id: string | null; related_event_id: string | null;
  hcp: { id: string; display_name: string; eligibility: 'eligible' | 'pending' | 'ineligible'; eligibility_note: string | null; tier: string | null; specialty: { name: string } | null } | null;
  related_event: { id: string; name: string; starts_at: string | null; timezone: string } | null;
  requester: Person | null;
  coordinator: Person | null;
  /** Approved or rejected: by whom, when, and why */
  decided_at: string | null; decision_note: string | null; decider: Person | null;
}
export const REQUEST_SELECT = 'id,request_number,title,status,request_type,event_type_id,event_date,duration,rationale,submitted_at,created_at,requested_by,event_id,' +
  'hcp_id,related_event_id,hcp(id,display_name,eligibility,eligibility_note,tier,specialty(name)),' +
  'related_event:event!event_request_related_event_id_fkey(id,name,starts_at,timezone),' +
  `event_type(name),requester:app_user!event_request_requested_by_fkey(${PERSON}),coordinator:app_user!event_request_coordinator_id_fkey(${PERSON}),` +
  `decided_at,decision_note,decider:app_user!event_request_decided_by_fkey(${PERSON})`;

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
      return data as { access: 'edit' | 'view' | null; team_role: string | null; /** May approve or reject it now */ can_decide: boolean };
    },
  });
}

/** Kinds of request (request_type): event request, tiering request. */
export function useRequestKinds() {
  return useQuery({
    queryKey: ['request_type'], staleTime: Infinity,
    queryFn: async () => {
      const { data, error } = await supabase.from('request_type').select('code,label,description').order('sort');
      if (error) throw error;
      return data as { code: RequestKind; label: string; description: string | null }[];
    },
  });
}

/** Events a tiering request can name: those I can see that haven't ended or been cancelled. */
export function useRequestEvents(enabled = true) {
  return useQuery({
    queryKey: ['request-events'], enabled, staleTime: 60_000,
    queryFn: async () => {
      const { data, error } = await supabase.from('event').select('id,name,starts_at,timezone,status')
        .not('status', 'in', '(cancelled,closed)').order('starts_at', { nullsFirst: false });
      if (error) throw error;
      return data as { id: string; name: string; starts_at: string | null; timezone: string }[];
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

/** Duration choices (request_duration): 1–3 hours, half day, full day, 2 days, more. */
export function useRequestDurations() {
  return useQuery({
    queryKey: ['request_duration'], staleTime: Infinity,
    queryFn: async () => {
      const { data, error } = await supabase.from('request_duration').select('code,label').order('sort');
      if (error) throw error;
      return data as { code: string; label: string }[];
    },
  });
}

/** What still has to be filled in before a draft can be submitted (the database checks the same). */
export function missingForSubmit(r: Pick<RequestRow, 'request_type' | 'event_date' | 'duration' | 'rationale' | 'hcp_id'>) {
  return (r.request_type === 'tiering'
    ? [!r.hcp_id && 'expert', !r.rationale?.trim() && 'business justification']
    : [!r.event_date && 'date', !r.duration && 'duration', !r.rationale?.trim() && 'business justification']).filter(Boolean) as string[];
}
