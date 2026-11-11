import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { MoreVertical, Pencil, SmilePlus, Trash2 } from 'lucide-react';
import { supabase } from '../../../lib/supabase';
import { useAuth } from '../../../lib/auth';
import { avatarColorFor } from '../../../lib/avatar';
import { Avatar } from '../../../components/Avatar';
import { Menu } from '../../../ui/Menu';
import { ConfirmDialog } from '../../../ui/ConfirmDialog';
import { ViaEmail } from '../../../ui/ViaEmail';
import { boardTables, mentionsIn, postTime, postsKey, usePosts, useTeam, useTeamRoles, type Board, type Person, type Post, type Thread } from './teamData';

const EMOJI = ['👍', '🎉', '👀', '❤️', '✅', '⚠️'];
const SHOWN_REPLIES = 2;

/** Someone who can be mentioned, with what they do on the team. */
type Mentionable = Person & { note: string | null };

const PersonAvatar = ({ p, size }: { p: Person | null; size: number }) => (
  <Avatar size={size} initials={p?.initials} color={p?.avatar_color ?? avatarColorFor(p?.display_name ?? '?')} isAgent={p?.user_type === 'agent'} title={p?.display_name} />
);

/** The "@name" being typed just before the caret, if any: where its @ is and what follows it. */
function mentionAt(text: string, caret: number) {
  const m = /(?:^|\s)@([\p{L}'.-]*(?: [\p{L}'.-]*)?)$/u.exec(text.slice(0, caret));
  return m ? { start: caret - m[1].length - 1, query: m[1].toLowerCase() } : null;
}

/**
 * Grows with its text; Cmd/Ctrl+Enter sends. Typing @ lists the people who can be mentioned;
 * picking one writes "@Their Name", and the post mentions everyone named that way.
 */
function Composer({ placeholder, note, submitLabel, autoFocus, onSubmit, onCancel, pending, people, initial }: {
  placeholder: string; note?: string; submitLabel: string; autoFocus?: boolean; pending?: boolean; people: Mentionable[];
  onSubmit: (body: string, mentions: string[]) => Promise<unknown>; onCancel?: () => void;
  /** Text to start from (editing a post); the caret starts at its end. */
  initial?: string;
}) {
  const [body, setBody] = useState(initial ?? '');
  const [typing, setTyping] = useState<{ start: number; query: string } | null>(null);
  const [active, setActive] = useState(0);
  const ref = useRef<HTMLTextAreaElement>(null);
  const listId = useId();
  // Where the caret goes once a picked name is in the text
  const caret = useRef<number | null>(null);
  useLayoutEffect(() => {
    const el = ref.current;
    if (el && caret.current !== null) { el.setSelectionRange(caret.current, caret.current); fit(el); caret.current = null; }
  }, [body]);
  useLayoutEffect(() => {
    const el = ref.current;
    if (el && initial) { fit(el); el.setSelectionRange(initial.length, initial.length); }
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  const matches = typing ? people.filter((p) => {
    const name = p.display_name.toLowerCase();
    return name.startsWith(typing.query) || name.split(/\s+/).some((w) => w.startsWith(typing.query));
  }).slice(0, 6) : [];
  const open = matches.length > 0;

  const fit = (el: HTMLTextAreaElement) => { el.style.height = ''; el.style.height = `${el.scrollHeight}px`; };
  const track = (el: HTMLTextAreaElement) => {
    const next = el.selectionStart === el.selectionEnd ? mentionAt(el.value, el.selectionStart) : null;
    if (next?.start !== typing?.start || next?.query !== typing?.query) setActive(0);
    setTyping(next);
  };
  const pick = (p: Person) => {
    const el = ref.current;
    if (!el || !typing) return;
    const before = `${body.slice(0, typing.start)}@${p.display_name} `;
    caret.current = before.length;
    setBody(before + body.slice(el.selectionStart).replace(/^ /, ''));
    setTyping(null);
  };
  const send = async () => {
    if (!body.trim() || pending) return;
    await onSubmit(body.trim(), mentionsIn(body, people));
    setBody(''); setTyping(null);
    if (ref.current) ref.current.style.height = '';
  };
  return (
    <div className="composer">
      <textarea ref={ref} className="composer-input" rows={1} value={body} placeholder={placeholder} aria-label={placeholder} autoFocus={autoFocus}
        role="combobox" aria-autocomplete="list" aria-expanded={open} aria-controls={open ? listId : undefined}
        aria-activedescendant={open ? `${listId}-${active}` : undefined}
        onChange={(e) => { setBody(e.target.value); fit(e.target); track(e.target); }}
        onSelect={(e) => track(e.currentTarget)} onBlur={() => setTyping(null)}
        onKeyDown={(e) => {
          if (open && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) {
            e.preventDefault(); setActive((i) => (i + (e.key === 'ArrowDown' ? 1 : matches.length - 1)) % matches.length); return;
          }
          if (open && (e.key === 'Enter' || e.key === 'Tab') && !e.metaKey && !e.ctrlKey) { e.preventDefault(); pick(matches[active] ?? matches[0]); return; }
          if (open && e.key === 'Escape') { e.preventDefault(); setTyping(null); return; }
          if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); void send(); }
          if (e.key === 'Escape' && onCancel) { e.preventDefault(); onCancel(); }
        }} />
      {open && (
        <ul id={listId} className="mention-list" role="listbox" aria-label="People to mention">
          {matches.map((p, i) => (
            <li key={p.id} id={`${listId}-${i}`} role="option" aria-selected={i === active} className={`mention-option${i === active ? ' active' : ''}`}
              onMouseDown={(e) => { e.preventDefault(); pick(p); }} onMouseEnter={() => setActive(i)}>
              <PersonAvatar p={p} size={22} />
              <span className="mention-name">{p.display_name}</span>
              {p.note && <span className="mention-meta">{p.note}</span>}
            </li>
          ))}
        </ul>
      )}
      <div className="composer-foot">
        <span className="composer-note">{note}</span>
        {onCancel && <button type="button" className="btn btn-ghost btn-sm" onClick={onCancel}>Cancel</button>}
        <button type="button" className="btn btn-primary btn-sm" disabled={!body.trim() || body === initial || pending} onClick={() => void send()}>{submitLabel}</button>
      </div>
    </div>
  );
}

/** Post text with its mentions highlighted (yours more strongly). */
function PostBody({ p, names, meId }: { p: Post; names: Map<string, string>; meId?: string }) {
  const tags = p.mentions.map((id) => ({ id, tag: `@${names.get(id) ?? ''}` })).filter((t) => t.tag.length > 1)
    .sort((a, b) => b.tag.length - a.tag.length);
  if (!tags.length) return <p className="post-body">{p.body}</p>;
  const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const parts = p.body.split(new RegExp(`(${tags.map((t) => esc(t.tag)).join('|')})(?![\\p{L}\\p{N}])`, 'giu'));
  return (
    <p className="post-body">
      {parts.map((part, i) => {
        const t = i % 2 ? tags.find((x) => x.tag.toLowerCase() === part.toLowerCase()) : undefined;
        return t ? <span key={i} className={`mention${t.id === meId ? ' mention-me' : ''}`}>{part}</span> : part;
      })}
    </p>
  );
}

/**
 * The team's message board for an event or a request: posts, threaded replies and reactions.
 * Anyone on the team can post. canModerate: may delete other people's posts.
 */
export function Discussion({ board, name, canModerate }: { board: Board; name: string; canModerate: boolean }) {
  const { me } = useAuth();
  const qc = useQueryClient();
  const t = boardTables(board);
  const posts = usePosts(board);
  const team = useTeam(board);
  const roles = useTeamRoles();
  // Anyone on the team can be mentioned (they can read the board); mentions of people who left still show by name
  const members = useMemo(() => (team.data ?? []).map((m) => m.user).filter((u): u is Person => Boolean(u)), [team.data]);
  const mentionable = useMemo(() => (team.data ?? []).flatMap((m): Mentionable[] => m.user && m.user.id !== me?.id && m.user.user_type === 'human'
    ? [{ ...m.user, note: m.role_label ?? roles.data?.find((r) => r.code === m.team_role)?.label ?? null }] : [])
    .sort((a, b) => a.display_name.localeCompare(b.display_name)), [team.data, roles.data, me?.id]);
  const names = useMemo(() => new Map(members.map((u) => [u.id, u.display_name])), [members]);
  const [replyTo, setReplyTo] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [deleting, setDeleting] = useState<Post | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const refresh = () => qc.invalidateQueries({ queryKey: postsKey(board) });

  // ?post=<id> (links in emails): open its thread, scroll to it and highlight it for a moment
  const [params] = useSearchParams();
  const linked = params.get('post');
  const [focus, setFocus] = useState<string | null>(null);
  useEffect(() => {
    if (!linked || !posts.data) return;
    const thread = posts.data.find((t) => t.id === linked || t.replies.some((r) => r.id === linked));
    if (!thread) return;
    if (thread.id !== linked) setExpanded((s) => new Set(s).add(thread.id));
    setFocus(linked);
    const t1 = setTimeout(() => document.getElementById(`post-${linked}`)?.scrollIntoView({ behavior: 'smooth', block: 'center' }), 50);
    const t2 = setTimeout(() => setFocus(null), 3500);
    return () => { clearTimeout(t1); clearTimeout(t2); };
  }, [linked, posts.data != null]); // eslint-disable-line react-hooks/exhaustive-deps

  const post = useMutation({
    mutationFn: async ({ body, mentions, parent_id }: { body: string; mentions: string[]; parent_id?: string }) => {
      const { error } = await supabase.from(t.post).insert({ [t.key]: board.id, body, mentions, parent_id: parent_id ?? null });
      if (error) throw new Error(error.message);
    },
    onSuccess: (_, v) => { refresh(); if (v.parent_id) { setReplyTo(null); setExpanded((s) => new Set(s).add(v.parent_id!)); } },
  });
  const react = useMutation({
    mutationFn: async ({ p, emoji, on }: { p: Post; emoji: string; on: boolean }) => {
      const { error } = on
        ? await supabase.from(t.reaction).delete().match({ post_id: p.id, emoji, user_id: me!.id })
        : await supabase.from(t.reaction).insert({ post_id: p.id, emoji, [t.key]: board.id });
      if (error) throw new Error(error.message);
    },
    onSettled: refresh,
  });
  // Authors edit their own posts; only people newly mentioned are told (the database decides)
  const edit = useMutation({
    mutationFn: async ({ id, body, mentions }: { id: string; body: string; mentions: string[] }) => {
      const { error } = await supabase.from(t.post).update({ body, mentions }).eq('id', id);
      if (error) throw new Error(error.message);
    },
    onSuccess: () => { refresh(); setEditing(null); },
  });
  const remove = useMutation({
    mutationFn: async (p: Post) => {
      const { error } = await supabase.from(t.post).delete().eq('id', p.id);
      if (error) throw new Error(error.message);
    },
    onSuccess: () => { refresh(); setDeleting(null); },
  });

  const threads = posts.data ?? [];
  const error = post.error ?? edit.error ?? react.error ?? posts.error;

  const reactions = (p: Post, small?: boolean) => {
    const counts = new Map<string, { n: number; mine: boolean }>();
    for (const r of p.reactions) {
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

  const postActions = (p: Post) => (p.author_id === me?.id || canModerate) && editing !== p.id && (
    <Menu label="Post actions" width={170}
      items={[
        ...(p.author_id === me?.id ? [{ key: 'edit', label: 'Edit', icon: <Pencil size={14} />, onSelect: () => { edit.reset(); setEditing(p.id); } }] : []),
        { key: 'delete', label: 'Delete', icon: <Trash2 size={14} />, danger: true, onSelect: () => setDeleting(p) },
      ]}
      trigger={(t) => <button type="button" className="icon-btn post-menu" aria-label="Post actions" {...t}><MoreVertical size={15} /></button>} />
  );

  const edited = (p: Post) => p.edited_at && <span className="post-edited" data-tip={`Edited ${postTime(p.edited_at)}`}>Edited</span>;
  const bodyOrEditor = (p: Post) => editing === p.id
    ? <Composer placeholder="Edit your post…" submitLabel="Save" autoFocus initial={p.body} pending={edit.isPending} people={mentionable}
        note="Only people you newly mention are notified."
        onSubmit={(body, mentions) => edit.mutateAsync({ id: p.id, body, mentions })} onCancel={() => setEditing(null)} />
    : <PostBody p={p} names={names} meId={me?.id} />;

  const renderThread = (t: Thread) => {
    const open = expanded.has(t.id);
    const shown = open ? t.replies : t.replies.slice(-SHOWN_REPLIES);
    const hidden = t.replies.length - shown.length;
    return (
      <article key={t.id} id={`post-${t.id}`} className={`post${focus === t.id ? ' post-focus' : ''}`}>
        <PersonAvatar p={t.author} size={34} />
        <div className="post-main">
          <div className="post-head">
            <span className="post-who">{t.author?.display_name ?? 'Former user'}</span>
            <span className="post-when">{postTime(t.created_at)}</span>
            {edited(t)}
            {t.channel === 'email' && <ViaEmail tip="Posted by replying to an Event Center email" />}
            {postActions(t)}
          </div>
          {bodyOrEditor(t)}
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
                <div key={r.id} id={`post-${r.id}`} className={`post reply${focus === r.id ? ' post-focus' : ''}`}>
                  <PersonAvatar p={r.author} size={26} />
                  <div className="post-main">
                    <div className="post-head">
                      <span className="post-who">{r.author?.display_name ?? 'Former user'}</span>
                      <span className="post-when">{postTime(r.created_at)}</span>
                      {edited(r)}
                      {r.channel === 'email' && <ViaEmail tip="Posted by replying to an Event Center email" />}
                      {postActions(r)}
                    </div>
                    {bodyOrEditor(r)}
                    {r.reactions.length > 0 && reactions(r, true)}
                  </div>
                </div>
              ))}
              {replyTo === t.id && (
                <Composer placeholder={`Reply to ${t.author?.display_name?.split(' ')[0] ?? 'the post'}…`} submitLabel="Reply" autoFocus pending={post.isPending}
                  people={mentionable} onSubmit={(body, mentions) => post.mutateAsync({ body, mentions, parent_id: t.id })} onCancel={() => setReplyTo(null)} />
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
        <Composer placeholder="Post an update or ask the team…" note={`Everyone on the ${name} team can read this. Type @ to mention someone.`} submitLabel="Post"
          pending={post.isPending} people={mentionable} onSubmit={(body, mentions) => post.mutateAsync({ body, mentions })} />
      </div>
      {error && <div className="form-error" role="alert">{error.message}</div>}
      {posts.isLoading ? <div className="ov-empty text-muted">Loading…</div>
        : threads.length === 0 ? <div className="ov-empty"><span><strong>No posts yet.</strong> {board.kind === 'request' ? 'Questions and answers between the requester, the approvers and the team.' : 'Start the conversation: updates, questions and decisions for the team.'}</span></div>
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
