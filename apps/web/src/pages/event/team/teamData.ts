import { useQuery } from '@tanstack/react-query';
import { supabase } from '../../../lib/supabase';

export interface Person { id: string; display_name: string; initials: string | null; avatar_color: string | null; job_title: string | null; user_type: 'human' | 'agent' }

export interface TeamRole { code: string; label: string; description: string; can_edit: boolean; sort: number }
export interface TeamMember { id: string; user_id: string; team_role: string; role_label: string | null; created_at: string; user: Person | null }

export interface Reaction { emoji: string; user_id: string }
export interface Post {
  id: string; parent_id: string | null; body: string; created_at: string; author_id: string;
  author: Person | null; reactions: Reaction[];
}
export interface Thread extends Post { replies: Post[] }

/**
 * A record with a team and a board: an event or a request. Their tables follow one naming
 * pattern (<kind>_team_member, <kind>_post, <kind>_post_reaction, keyed by <kind>_id).
 */
export interface Board { kind: 'event' | 'request'; id: string }
export const boardTables = ({ kind }: Board) => ({
  team: `${kind}_team_member`, post: `${kind}_post`, reaction: `${kind}_post_reaction`, key: `${kind}_id`,
});
/** Everything cached for the record (access, team, posts) sits under this key. */
export const boardKey = (b: Board) => [b.kind, b.id];
export const teamKey = (b: Board) => [b.kind, b.id, 'team'];
export const postsKey = (b: Board) => [b.kind, b.id, 'posts'];
const PERSON = 'id,display_name,initials,avatar_color,job_title,user_type';

/** Access roles, from the team_role table. */
export function useTeamRoles() {
  return useQuery({
    queryKey: ['team-roles'], staleTime: Infinity,
    queryFn: async () => {
      const { data, error } = await supabase.from('team_role').select('code,label,description,can_edit,sort').order('sort');
      if (error) throw error;
      return data as TeamRole[];
    },
  });
}

export function useTeam(board: Board) {
  const t = boardTables(board);
  return useQuery({
    queryKey: teamKey(board),
    queryFn: async () => {
      const { data, error } = await supabase.from(t.team)
        .select(`id,user_id,team_role,role_label,created_at,user:app_user!${t.team}_user_id_fkey(${PERSON})`)
        .eq(t.key, board.id);
      if (error) throw error;
      return data as unknown as TeamMember[];
    },
  });
}

/** People in the organisation who could join a team. */
export function usePeople(enabled: boolean) {
  return useQuery({
    queryKey: ['people'], enabled, staleTime: 5 * 60_000,
    queryFn: async () => {
      const { data, error } = await supabase.from('app_user').select(PERSON).eq('status', 'active').eq('user_type', 'human').order('display_name');
      if (error) throw error;
      return data as Person[];
    },
  });
}

/** The board: top-level posts newest first, each with its replies oldest first. */
export function usePosts(board: Board) {
  const t = boardTables(board);
  return useQuery({
    queryKey: postsKey(board),
    queryFn: async () => {
      const { data, error } = await supabase.from(t.post)
        .select(`id,parent_id,body,created_at,author_id,author:app_user!${t.post}_author_id_fkey(${PERSON}),reactions:${t.reaction}(emoji,user_id)`)
        .eq(t.key, board.id)
        .order('created_at', { ascending: false });
      if (error) throw error;
      const posts = data as unknown as Post[];
      const replies = new Map<string, Post[]>();
      for (const p of posts) if (p.parent_id) replies.set(p.parent_id, [p, ...(replies.get(p.parent_id) ?? [])]);
      return posts.filter((p) => !p.parent_id).map((p): Thread => ({ ...p, replies: replies.get(p.id) ?? [] }));
    },
  });
}

/** "Today, 16:10", "Yesterday, 09:30", "Fri 25 Oct, 16:10". */
export function postTime(iso: string, now = new Date()) {
  const d = new Date(iso);
  const time = d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
  const day = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const diff = Math.round((day(now) - day(d)) / 86400000);
  if (diff === 0) return `Today, ${time}`;
  if (diff === 1) return `Yesterday, ${time}`;
  return `${d.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' }).replace('Sept', 'Sep')}, ${time}`;
}
