import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { supabase } from '../../lib/supabase';
import type { EventStatus } from '../../lib/types';

export type Scope = 'mine' | 'all';
export type When = 'upcoming' | 'past';

interface Person { id: string; display_name: string; initials: string | null; avatar_color: string | null; user_type: 'human' | 'agent' }
const PERSON = 'id,display_name,initials,avatar_color,user_type';

export interface AgendaEvent {
  id: string; name: string; status: EventStatus; starts_at: string; ends_at: string | null; timezone: string;
  city: string | null; country_code: string | null; venue_name: string | null;
  event_type: { name: string } | null;
  owner: Pick<Person, 'display_name'> | null;
  /** Only the current user's team row, if any. */
  event_team_member: { team_role: string }[];
}

const DAY = 86400000;
const startOfToday = () => { const d = new Date(); d.setHours(0, 0, 0, 0); return d; };

/**
 * Events in a time window, either all visible ones or only those the user is on the team of.
 * RLS decides what "all" means for this user.
 */
async function fetchEvents(meId: string, scope: Scope, from: Date, to: Date, ascending: boolean, withCancelled = true) {
  const team = scope === 'mine' ? 'event_team_member!inner(team_role)' : 'event_team_member(team_role)';
  let q = supabase.from('event')
    .select(`id,name,status,starts_at,ends_at,timezone,city,country_code,venue_name,event_type(name),owner:app_user!event_owner_id_fkey(display_name),${team}`)
    .eq('event_team_member.user_id', meId)
    .gte('starts_at', from.toISOString())
    .lt('starts_at', to.toISOString())
    .order('starts_at', { ascending });
  if (!withCancelled) q = q.neq('status', 'cancelled');
  const { data, error } = await q;
  if (error) throw error;
  return data as unknown as AgendaEvent[];
}

/** The agenda: next 90 days, or the last 90 days newest first. Cancelled events are left out (the calendar keeps them). */
export function useAgenda(meId: string | undefined, scope: Scope, when: When) {
  return useQuery({
    queryKey: ['home', 'agenda', meId, scope, when],
    enabled: Boolean(meId),
    queryFn: () => {
      const today = startOfToday();
      return when === 'upcoming'
        ? fetchEvents(meId!, scope, today, new Date(today.getTime() + 90 * DAY), true, false)
        : fetchEvents(meId!, scope, new Date(today.getTime() - 90 * DAY), today, false, false);
    },
  });
}

/** The days a month view shows: from the Sunday on or before the 1st, whole weeks. */
export function monthGrid(month: Date) {
  const start = new Date(month.getFullYear(), month.getMonth(), 1 - month.getDay());
  const weeks = Math.ceil((month.getDay() + new Date(month.getFullYear(), month.getMonth() + 1, 0).getDate()) / 7);
  return { start, weeks, end: new Date(start.getFullYear(), start.getMonth(), start.getDate() + weeks * 7) };
}

/**
 * Events in a month's grid. Starts a week early so events that began before the grid but run into
 * it show, and pads a day after so events near midnight in other zones land.
 */
export const calendarQuery = (meId: string, scope: Scope, month: Date) => ({
  queryKey: ['home', 'calendar', meId, scope, month.getFullYear(), month.getMonth()],
  queryFn: () => {
    const { start, end } = monthGrid(month);
    return fetchEvents(meId, scope, new Date(start.getTime() - 7 * DAY), new Date(end.getTime() + DAY), true);
  },
  staleTime: 60_000,
});

/** Events in the visible month. While another month loads, the previous one stays on screen. */
export function useCalendarEvents(meId: string | undefined, scope: Scope, month: Date) {
  return useQuery({ ...calendarQuery(meId ?? '', scope, month), enabled: Boolean(meId), placeholderData: keepPreviousData });
}

export interface PendingApproval {
  id: string; submitted_at: string;
  submitter: Person | null;
  request: { id: string; title: string; event_date: string | null } | null;
}

/** Approvals with a step waiting on the current user (as a person, or a member of the approving group). */
export function useMyApprovals(meId: string | undefined) {
  return useQuery({
    queryKey: ['home', 'approvals', meId],
    enabled: Boolean(meId),
    queryFn: async () => {
      const { data, error } = await supabase.rpc('my_pending_approvals');
      if (error) throw error;
      return (data as { approval_id: string; record_id: string; title: string; event_date: string | null; submitted_at: string; submitter: Person | null }[])
        .map((a): PendingApproval => ({ id: a.approval_id, submitted_at: a.submitted_at, submitter: a.submitter,
          request: { id: a.record_id, title: a.title, event_date: a.event_date } }))
        .sort((a, b) => b.submitted_at.localeCompare(a.submitted_at));
    },
  });
}

export interface MyTask {
  id: string; title: string; due_date: string | null;
  event: { id: string; name: string } | null;
  creator: Person | null;
}

/** Open tasks assigned to the current user, soonest due first. */
export function useMyTasks(meId: string | undefined) {
  return useQuery({
    queryKey: ['home', 'tasks', meId],
    enabled: Boolean(meId),
    queryFn: async () => {
      const { data, error } = await supabase.from('event_task')
        .select(`id,title,due_date,event(id,name),creator:app_user!event_task_created_by_fkey(${PERSON})`)
        .eq('assignee_id', meId!)
        .is('done_at', null)
        .order('due_date', { ascending: true, nullsFirst: false });
      if (error) throw error;
      return data as unknown as MyTask[];
    },
  });
}

export interface UnassignedRequest {
  id: string; title: string; submitted_at: string | null; request_type: 'event' | 'tiering';
  event_type: { name: string } | null;
  related_event: { name: string } | null;
  requester: Person | null;
}

/** Submitted requests (events and tiering) with no coordinator yet. */
export function useUnassignedRequests() {
  return useQuery({
    queryKey: ['home', 'unassigned'],
    queryFn: async () => {
      const { data, error, count } = await supabase.from('event_request')
        .select(`id,title,submitted_at,request_type,event_type(name),related_event:event!event_request_related_event_id_fkey(name),requester:app_user!event_request_requested_by_fkey(${PERSON})`, { count: 'exact' })
        .is('coordinator_id', null)
        .eq('status', 'review')
        .order('submitted_at', { ascending: false })
        .limit(3);
      if (error) throw error;
      return { rows: data as unknown as UnassignedRequest[], total: count ?? 0 };
    },
  });
}

export interface RecentEvent {
  id: string; name: string; status: EventStatus; starts_at: string | null; timezone: string;
  city: string | null; country_code: string | null;
}

/**
 * Events the user (or an agent acting for them) changed most recently, from the audit trail.
 * Views aren't tracked yet, so "opened" doesn't count until there is a table for it.
 */
export function useRecentlyWorkedOn(meId: string | undefined) {
  return useQuery({
    queryKey: ['home', 'recent', meId],
    enabled: Boolean(meId),
    queryFn: async () => {
      const { data, error } = await supabase.from('event_history')
        .select('event_id,at')
        .or(`actor_user_id.eq.${meId},on_behalf_of_user_id.eq.${meId}`)
        .order('at', { ascending: false })
        .limit(100);
      if (error) throw error;
      const ids = [...new Set((data as { event_id: string }[]).map((r) => r.event_id))].slice(0, 3);
      if (!ids.length) return [];
      const { data: events, error: eErr } = await supabase.from('event')
        .select('id,name,status,starts_at,timezone,city,country_code').in('id', ids);
      if (eErr) throw eErr;
      return ids.map((id) => (events as RecentEvent[]).find((e) => e.id === id)).filter((e): e is RecentEvent => Boolean(e));
    },
  });
}
