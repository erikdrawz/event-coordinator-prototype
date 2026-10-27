import { useRef, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { MoreVertical, SmilePlus, Trash2 } from 'lucide-react';
import { supabase } from '../../../lib/supabase';
import { useAuth } from '../../../lib/auth';
import { avatarColorFor } from '../../../lib/avatar';
import { Avatar } from '../../../components/Avatar';
import { Menu } from '../../../ui/Menu';
import { ConfirmDialog } from '../../../ui/ConfirmDialog';
import { postTime, postsKey, usePosts, type Person, type Post, type Thread } from './teamData';

const EMOJI = ['👍', '🎉', '👀', '❤️', '✅', '⚠️'];
const SHOWN_REPLIES = 2;

const PersonAvatar = ({ p, size }: { p: Person | null; size: number }) => (
  <Avatar size={size} initials={p?.initials} color={p?.avatar_color ?? avatarColorFor(p?.display_name ?? '?')} isAgent={p?.user_type === 'agent'} title={p?.display_name} />
);

/** Grows with its text; Cmd/Ctrl+Enter sends. */
function Composer({ placeholder, note, submitLabel, autoFocus, onSubmit, onCancel, pending }: {
  placeholder: string; note?: string; submitLabel: string; autoFocus?: boolean; pending?: boolean;
  onSubmit: (body: string) => Promise<unknown>; onCancel?: () => void;
}) {
  const [body, setBody] = useState('');
  const ref = useRef<HTMLTextAreaElement>(null);
  const send = async () => {
    if (!body.trim() || pending) return;
    await onSubmit(body.trim());
    setBody('');
    if (ref.current) ref.current.style.height = '';
  };
  return (
    <div className="composer">
      <textarea ref={ref} className="composer-input" rows={1} value={body} placeholder={placeholder} aria-label={placeholder} autoFocus={autoFocus}
        onChange={(e) => { setBody(e.target.value); e.target.style.height = ''; e.target.style.height = `${e.target.scrollHeight}px`; }}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); void send(); }
          if (e.key === 'Escape' && onCancel) { e.preventDefault(); onCancel(); }
        }} />
      <div className="composer-foot">
        <span className="composer-note">{note}</span>
        {onCancel && <button type="button" className="btn btn-ghost btn-sm" onClick={onCancel}>Cancel</button>}
        <button type="button" className="btn btn-primary btn-sm" disabled={!body.trim() || pending} onClick={() => void send()}>{submitLabel}</button>
      </div>
    </div>
  );
}

/** The team's message board: posts, threaded replies and reactions. Anyone on the team can post. */
export function Discussion({ eventId, eventName, canEditEvent }: { eventId: string; eventName: string; canEditEvent: boolean }) {
  const { me } = useAuth();
  const qc = useQueryClient();
  const posts = usePosts(eventId);
  const [replyTo, setReplyTo] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [deleting, setDeleting] = useState<Post | null>(null);
  const refresh = () => qc.invalidateQueries({ queryKey: postsKey(eventId) });

  const post = useMutation({
    mutationFn: async ({ body, parent_id }: { body: string; parent_id?: string }) => {
      const { error } = await supabase.from('event_post').insert({ event_id: eventId, body, parent_id: parent_id ?? null });
      if (error) throw new Error(error.message);
    },
    onSuccess: (_, v) => { refresh(); if (v.parent_id) { setReplyTo(null); setExpanded((s) => new Set(s).add(v.parent_id!)); } },
  });
  const react = useMutation({
    mutationFn: async ({ p, emoji, on }: { p: Post; emoji: string; on: boolean }) => {
      const { error } = on
        ? await supabase.from('event_post_reaction').delete().match({ post_id: p.id, emoji, user_id: me!.id })
        : await supabase.from('event_post_reaction').insert({ post_id: p.id, emoji, event_id: eventId });
      if (error) throw new Error(error.message);
    },
    onSettled: refresh,
  });
  const remove = useMutation({
    mutationFn: async (p: Post) => {
      const { error } = await supabase.from('event_post').delete().eq('id', p.id);
      if (error) throw new Error(error.message);
    },
    onSuccess: () => { refresh(); setDeleting(null); },
  });

  const threads = posts.data ?? [];
  const error = post.error ?? react.error ?? posts.error;

  const reactions = (p: Post, small?: boolean) => {
    const counts = new Map<string, { n: number; mine: boolean }>();
    for (const r of p.event_post_reaction) {
      const c = counts.get(r.emoji) ?? { n: 0, mine: false };
      counts.set(r.emoji, { n: c.n + 1, mine: c.mine || r.user_id === me?.id });
    }
    return (
      <div className={`post-reactions${small ? ' small' : ''}`}>
        {[...counts].map(([emoji, c]) => (
          <button key={emoji} type="button" className={`reaction${c.mine ? ' mine' : ''}`} aria-pressed={c.mine}
            aria-label={`${emoji} ${c.n}${c.mine ? ', including you' : ''}`} onClick={() => react.mutate({ p, emoji, on: c.mine })}>
            <span aria-hidden>{emoji}</span> {c.n}
          </button>
        ))}
        <Menu label="Add a reaction" width={232} className="menu-row"
          items={EMOJI.map((emoji) => ({ key: emoji, text: emoji, label: <span className="reaction-option">{emoji}</span>,
            onSelect: () => { if (!counts.get(emoji)?.mine) react.mutate({ p, emoji, on: false }); } }))}
          trigger={(t) => <button type="button" className="reaction-add" aria-label="Add a reaction" {...t}><SmilePlus size={14} /></button>} />
      </div>
    );
  };

  const postActions = (p: Post) => (p.author_id === me?.id || canEditEvent) && (
    <Menu label="Post actions" width={170}
      items={[{ key: 'delete', label: 'Delete', icon: <Trash2 size={14} />, danger: true, onSelect: () => setDeleting(p) }]}
      trigger={(t) => <button type="button" className="icon-btn post-menu" aria-label="Post actions" {...t}><MoreVertical size={15} /></button>} />
  );

  const renderThread = (t: Thread) => {
    const open = expanded.has(t.id);
    const shown = open ? t.replies : t.replies.slice(-SHOWN_REPLIES);
    const hidden = t.replies.length - shown.length;
    return (
      <article key={t.id} className="post">
        <PersonAvatar p={t.author} size={34} />
        <div className="post-main">
          <div className="post-head">
            <span className="post-who">{t.author?.display_name ?? 'Former user'}</span>
            <span className="post-when">{postTime(t.created_at)}</span>
            {postActions(t)}
          </div>
          <p className="post-body">{t.body}</p>
          <div className="post-foot">
            {reactions(t)}
            <button type="button" className="link post-reply" onClick={() => setReplyTo(replyTo === t.id ? null : t.id)}>Reply</button>
          </div>
          {(t.replies.length > 0 || replyTo === t.id) && (
            <div className="post-thread">
              {hidden > 0 && (
                <button type="button" className="link post-more" onClick={() => setExpanded((s) => new Set(s).add(t.id))}>
                  Show {hidden} earlier repl{hidden === 1 ? 'y' : 'ies'}
                </button>
              )}
              {shown.map((r) => (
                <div key={r.id} className="post reply">
                  <PersonAvatar p={r.author} size={26} />
                  <div className="post-main">
                    <div className="post-head">
                      <span className="post-who">{r.author?.display_name ?? 'Former user'}</span>
                      <span className="post-when">{postTime(r.created_at)}</span>
                      {postActions(r)}
                    </div>
                    <p className="post-body">{r.body}</p>
                    {r.event_post_reaction.length > 0 && reactions(r, true)}
                  </div>
                </div>
              ))}
              {replyTo === t.id && (
                <Composer placeholder={`Reply to ${t.author?.display_name?.split(' ')[0] ?? 'the post'}…`} submitLabel="Reply" autoFocus pending={post.isPending}
                  onSubmit={(body) => post.mutateAsync({ body, parent_id: t.id })} onCancel={() => setReplyTo(null)} />
              )}
            </div>
          )}
        </div>
      </article>
    );
  };

  return (
    <section className="card team-card discussion" aria-labelledby="discussion-title">
      <div className="ov-title-row">
        <h2 id="discussion-title" className="ov-title">Discussion</h2>
        <span className="card-sub">{threads.length} thread{threads.length === 1 ? '' : 's'}</span>
      </div>
      <div className="post post-new">
        <Avatar size={34} initials={me?.initials} color={me?.avatar_color ?? avatarColorFor(me?.display_name ?? '?')} />
        <Composer placeholder="Post an update or ask the team…" note={`Everyone on the ${eventName} team can read this`} submitLabel="Post"
          pending={post.isPending} onSubmit={(body) => post.mutateAsync({ body })} />
      </div>
      {error && <div className="form-error" role="alert">{error.message}</div>}
      {posts.isLoading ? <div className="ov-empty text-muted">Loading…</div>
        : threads.length === 0 ? <div className="ov-empty"><span><strong>No posts yet.</strong> Start the conversation: updates, questions and decisions for the team.</span></div>
        : <div className="posts">{threads.map(renderThread)}</div>}

      {deleting && (
        <ConfirmDialog title="Delete post?" confirmLabel="Delete post" pending={remove.isPending} error={remove.error?.message}
          onConfirm={() => remove.mutate(deleting)} onCancel={() => { remove.reset(); setDeleting(null); }}>
          {deleting.parent_id ? 'This reply will be removed from the thread.' : 'This post and its replies will be removed from the board.'}
        </ConfirmDialog>
      )}
    </section>
  );
}
