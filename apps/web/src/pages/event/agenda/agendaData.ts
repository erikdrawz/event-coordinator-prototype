import { useQuery } from '@tanstack/react-query';
import { supabase } from '../../../lib/supabase';
import { toLocalInput } from '../eventForm';

interface Person { display_name: string; initials: string | null; avatar_color: string | null }

export interface SessionSpeaker {
  id: string; minutes: number | null; sort: number; event_expert_id: string | null; user_id: string | null;
  expert: { hcp: { display_name: string } | null } | null;
  user: Person | null;
}
export interface Session {
  id: string; title: string; session_kind: string | null; location: string | null; starts_at: string; ends_at: string;
  event_session_speaker: SessionSpeaker[];
}

/** Someone who can speak at a session: one of the event's experts, or a member of its team. */
export interface SpeakerOption { key: string; event_expert_id?: string; user_id?: string; name: string; sub: string; initials: string | null; color: string | null }

export const sessionsKey = (eventId: string) => ['event', eventId, 'sessions'];

export function useSessions(eventId: string) {
  return useQuery({
    queryKey: sessionsKey(eventId),
    queryFn: async () => {
      const { data, error } = await supabase.from('event_session')
        .select('id,title,session_kind,location,starts_at,ends_at,event_session_speaker(id,minutes,sort,event_expert_id,user_id,' +
                'expert:event_expert(hcp(display_name)),user:app_user!event_session_speaker_user_id_fkey(display_name,initials,avatar_color))')
        .eq('event_id', eventId)
        .order('starts_at').order('sort');
      if (error) throw error;
      const rows = data as unknown as Session[];
      rows.forEach((s) => s.event_session_speaker.sort((a, b) => a.sort - b.sort));
      return rows;
    },
  });
}

export function useSpeakerOptions(eventId: string) {
  return useQuery({
    queryKey: ['event', eventId, 'speaker-options'],
    queryFn: async () => {
      const [experts, team] = await Promise.all([
        supabase.from('event_expert').select('id,role,hcp(display_name,city)').eq('event_id', eventId),
        supabase.from('event_team_member').select('user_id,role_label,user:app_user!event_team_member_user_id_fkey(display_name,initials,avatar_color)').eq('event_id', eventId),
      ]);
      if (experts.error) throw experts.error;
      if (team.error) throw team.error;
      const initials = (n: string) => n.replace(/^(Dr|Prof)\.?\s+/i, '').split(/\s+/).map((w) => w[0]).slice(0, 2).join('').toUpperCase();
      const ex = (experts.data as unknown as { id: string; role: string; hcp: { display_name: string; city: string | null } | null }[])
        .map((e): SpeakerOption => ({ key: `x:${e.id}`, event_expert_id: e.id, name: e.hcp?.display_name ?? 'Unknown HCP',
          sub: [e.role[0].toUpperCase() + e.role.slice(1), e.hcp?.city].filter(Boolean).join(' · '), initials: initials(e.hcp?.display_name ?? '?'), color: null }));
      const tm = (team.data as unknown as { user_id: string; role_label: string | null; user: Person | null }[])
        .map((t): SpeakerOption => ({ key: `u:${t.user_id}`, user_id: t.user_id, name: t.user?.display_name ?? 'Unknown user',
          sub: t.role_label ?? 'Team', initials: t.user?.initials ?? null, color: t.user?.avatar_color ?? null }));
      return [...ex.sort((a, b) => a.name.localeCompare(b.name)), ...tm.sort((a, b) => a.name.localeCompare(b.name))];
    },
  });
}

export function useSessionKinds() {
  return useQuery({
    queryKey: ['session-kinds'], staleTime: 5 * 60_000,
    queryFn: async () => {
      const { data, error } = await supabase.from('session_kind').select('name').eq('is_active', true).order('sort');
      if (error) throw error;
      return (data as { name: string }[]).map((k) => k.name);
    },
  });
}

export const speakerKey = (s: { event_expert_id: string | null; user_id: string | null }) =>
  s.event_expert_id ? `x:${s.event_expert_id}` : `u:${s.user_id}`;
export const speakerName = (s: SessionSpeaker) => s.expert?.hcp?.display_name ?? s.user?.display_name ?? 'Unknown';

/** Session times as the event's wall clock. */
export function localParts(iso: string, tz: string) {
  const l = toLocalInput(iso, tz);
  return { date: l.slice(0, 10), time: l.slice(11) };
}
export const minutesBetween = (a: string, b: string) => Math.round((new Date(b).getTime() - new Date(a).getTime()) / 60000);

/** "HH:mm" + minutes → "HH:mm" (wraps past midnight). */
export function addMinutes(time: string, mins: number) {
  const [h, m] = time.split(':').map(Number);
  const t = (((h * 60 + m + mins) % 1440) + 1440) % 1440;
  return `${String(Math.floor(t / 60)).padStart(2, '0')}:${String(t % 60).padStart(2, '0')}`;
}
