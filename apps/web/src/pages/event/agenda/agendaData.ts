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

/**
 * Someone who can speak at a session: one of the event's speakers, any other HCP (who becomes a speaker
 * when saved), or a member of the event team (internal, no honorarium).
 */
export interface SpeakerOption {
  key: string; event_expert_id?: string; hcp_id?: string; user_id?: string;
  name: string; sub: string; initials: string | null; color: string | null; group: 'speaker' | 'hcp' | 'team';
}

export const sessionsKey = (eventId: string) => ['event', eventId, 'sessions'];
/** Agenda changes can add speakers and change their hours, so they refresh everything under the event. */
export const eventKey = (eventId: string) => ['event', eventId];

export async function fetchSessions(eventId: string) {
  const { data, error } = await supabase.from('event_session')
    .select('id,title,session_kind,location,starts_at,ends_at,event_session_speaker(id,minutes,sort,event_expert_id,user_id,' +
            'expert:event_expert(hcp(display_name)),user:app_user!event_session_speaker_user_id_fkey(display_name,initials,avatar_color))')
    .eq('event_id', eventId)
    .order('starts_at').order('sort');
  if (error) throw error;
  const rows = data as unknown as Session[];
  rows.forEach((s) => s.event_session_speaker.sort((a, b) => a.sort - b.sort));
  return rows;
}

export function useSessions(eventId: string) {
  return useQuery({ queryKey: sessionsKey(eventId), queryFn: () => fetchSessions(eventId) });
}

export function useSpeakerOptions(eventId: string) {
  return useQuery({
    queryKey: ['event', eventId, 'speaker-options'],
    queryFn: async () => {
      const [experts, team, hcps] = await Promise.all([
        supabase.from('event_expert').select('id,hcp_id,role,hcp(display_name,city)').eq('event_id', eventId),
        supabase.from('event_team_member').select('user_id,role_label,user:app_user!event_team_member_user_id_fkey(display_name,initials,avatar_color)').eq('event_id', eventId),
        supabase.from('hcp').select('id,display_name,city,specialty(name)').eq('status', 'active').order('last_name'),
      ]);
      for (const r of [experts, team, hcps]) if (r.error) throw r.error;
      const ex = (experts.data as unknown as { id: string; hcp_id: string; role: string; hcp: { display_name: string; city: string | null } | null }[])
        .map((e): SpeakerOption => ({ key: `x:${e.id}`, event_expert_id: e.id, hcp_id: e.hcp_id, name: e.hcp?.display_name ?? 'Unknown HCP', group: 'speaker',
          sub: [e.role[0].toUpperCase() + e.role.slice(1), e.hcp?.city].filter(Boolean).join(' · '), initials: initials(e.hcp?.display_name ?? '?'), color: null }));
      const onEvent = new Set(ex.map((e) => e.hcp_id));
      const others = (hcps.data as unknown as { id: string; display_name: string; city: string | null; specialty: { name: string } | null }[])
        .filter((h) => !onEvent.has(h.id))
        .map((h): SpeakerOption => ({ key: `h:${h.id}`, hcp_id: h.id, name: h.display_name, group: 'hcp',
          sub: ['New speaker', h.specialty?.name, h.city].filter(Boolean).join(' · '), initials: initials(h.display_name), color: null }));
      const tm = (team.data as unknown as { user_id: string; role_label: string | null; user: Person | null }[])
        .map((t): SpeakerOption => ({ key: `u:${t.user_id}`, user_id: t.user_id, name: t.user?.display_name ?? 'Unknown user', group: 'team',
          sub: `${t.role_label ?? 'Team'} · internal`, initials: t.user?.initials ?? null, color: t.user?.avatar_color ?? null }));
      const byName = (a: SpeakerOption, b: SpeakerOption) => a.name.localeCompare(b.name);
      return [...ex.sort(byName), ...tm.sort(byName), ...others];
    },
  });
}

/** What to send to save_event_session for a picked option. */
export const speakerPayload = (o: { event_expert_id?: string | null; hcp_id?: string | null; user_id?: string | null }, minutes: number | null) =>
  o.event_expert_id ? { event_expert_id: o.event_expert_id, minutes }
    : o.hcp_id ? { hcp_id: o.hcp_id, minutes } : { user_id: o.user_id, minutes };

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
/** "Dr Richard Griffiths" → "RG" */
export const initials = (n: string) => n.replace(/^(Dr|Prof)\.?\s+/i, '').split(/\s+/).map((w) => w[0]).slice(0, 2).join('').toUpperCase();

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

const toMin = (t: string) => { const [h, m] = t.split(':').map(Number); return h * 60 + m; };
/** Minutes from "HH:mm" to "HH:mm"; an end before the start runs past midnight. */
export const sessionLength = (from: string, to: string) => (from && to ? (toMin(to) - toMin(from) + 1440) % 1440 : null);

/** A session being edited in the agenda editor. Times are the event's wall clock. */
export interface DraftSpeaker {
  key: string; event_expert_id?: string; hcp_id?: string; user_id?: string;
  name: string; initials: string | null; color: string | null;
  /** '' = the whole session */
  minutes: string;
}
export interface DraftSession {
  key: string; id?: string; date: string; from: string; to: string;
  title: string; kind: string; location: string; speakers: DraftSpeaker[];
}

export function toDraft(s: Session, tz: string): DraftSession {
  const start = localParts(s.starts_at, tz);
  return {
    key: s.id, id: s.id, date: start.date, from: start.time, to: localParts(s.ends_at, tz).time,
    title: s.title, kind: s.session_kind ?? '', location: s.location ?? '',
    speakers: s.event_session_speaker.map((sp) => ({
      key: speakerKey(sp), event_expert_id: sp.event_expert_id ?? undefined, user_id: sp.user_id ?? undefined,
      name: speakerName(sp), initials: sp.user?.initials ?? initials(speakerName(sp)), color: sp.user?.avatar_color ?? null,
      minutes: sp.minutes?.toString() ?? '',
    })),
  };
}

export const draftSpeaker = (o: SpeakerOption): DraftSpeaker => ({
  key: o.key, event_expert_id: o.event_expert_id, hcp_id: o.event_expert_id ? undefined : o.hcp_id, user_id: o.user_id,
  name: o.name, initials: o.initials, color: o.color, minutes: '',
});

/** One session as save_agenda expects it. */
export function draftPayload(d: DraftSession) {
  const endDate = d.to < d.from ? new Date(Date.parse(`${d.date}T00:00:00Z`) + 86400000).toISOString().slice(0, 10) : d.date;
  return {
    ...(d.id ? { id: d.id } : {}),
    title: d.title.trim(), session_kind: d.kind || null, location: d.location.trim() || null,
    starts_local: `${d.date}T${d.from}`, ends_local: `${endDate}T${d.to}`,
    speakers: d.speakers.map((sp) => speakerPayload(sp, sp.minutes ? Number(sp.minutes) : null)),
  };
}
