import { useMemo, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { MoreVertical, Pencil, Plus, Trash2 } from 'lucide-react';
import { supabase } from '../../../lib/supabase';
import { useAuth } from '../../../lib/auth';
import { can } from '../../../lib/permissions';
import { avatarColorFor } from '../../../lib/avatar';
import { Avatar } from '../../../components/Avatar';
import { Menu } from '../../../ui/Menu';
import { ConfirmDialog } from '../../../ui/ConfirmDialog';
import { SessionModal } from './SessionModal';
import { InlineSessionRow } from './InlineSessionRow';
import {
  localParts, minutesBetween, sessionsKey, speakerKey, speakerName, useSessionKinds, useSessions, useSpeakerOptions, type Session,
} from './agendaData';

interface EventLite { id: string; timezone: string; starts_at: string | null; ends_at: string | null }

const dayLabel = (d: string) => new Date(`${d}T00:00:00Z`).toLocaleDateString('en-GB', { timeZone: 'UTC', weekday: 'short', day: 'numeric', month: 'short' }).replace('Sept', 'Sep');
const nextDay = (d: string) => new Date(Date.parse(`${d}T00:00:00Z`) + 86400000).toISOString().slice(0, 10);

/** The agenda grid: one tab per day (in the event's time zone), sessions in time order. */
export function AgendaSection({ event }: { event: EventLite }) {
  const { me } = useAuth();
  const qc = useQueryClient();
  const sessions = useSessions(event.id);
  const options = useSpeakerOptions(event.id);
  const kinds = useSessionKinds();
  const [extraDays, setExtraDays] = useState<string[]>([]);
  const [day, setDay] = useState<string | null>(null);
  const [editing, setEditing] = useState<Session | null>(null);
  // The inline new-session row: its day, suggested start, and a counter so each new row starts fresh
  const [adding, setAdding] = useState<{ date: string; start: string; n: number } | null>(null);
  const [deleting, setDeleting] = useState<Session | null>(null);
  const tz = event.timezone;
  const canAdd = can(me, 'event_session', 'create');
  const canEdit = can(me, 'event_session', 'edit');
  const canDelete = can(me, 'event_session', 'delete');

  // Days: the event's own dates, any day with sessions, and days added here
  const days = useMemo(() => {
    const set = new Set<string>(extraDays);
    if (event.starts_at) {
      let d = localParts(event.starts_at, tz).date;
      const last = event.ends_at ? localParts(event.ends_at, tz).date : d;
      for (let i = 0; d <= last && i < 14; i++, d = nextDay(d)) set.add(d);
    }
    sessions.data?.forEach((s) => set.add(localParts(s.starts_at, tz).date));
    return [...set].sort();
  }, [event.starts_at, event.ends_at, tz, sessions.data, extraDays]);
  const current = day && days.includes(day) ? day : days[0] ?? (adding?.date ?? null);
  const todays = (sessions.data ?? []).filter((s) => localParts(s.starts_at, tz).date === current);

  const span = todays.length ? `${localParts(todays[0].starts_at, tz).time}–${localParts(todays[todays.length - 1].ends_at, tz).time}` : null;
  const total = sessions.data?.length ?? 0;
  const sub = total === 0 ? 'No sessions yet'
    : `${total} session${total === 1 ? '' : 's'}${days.length > 1 ? ` over ${days.length} days` : ''}${span ? ` · ${span}` : ''}`;

  // New sessions start where the day's last one ends, or at the event's start time
  const startAdding = () => {
    const last = todays[todays.length - 1];
    const date = current ?? (event.starts_at ? localParts(event.starts_at, tz).date : new Date().toISOString().slice(0, 10));
    const start = last ? localParts(last.ends_at, tz).time : event.starts_at && date === localParts(event.starts_at, tz).date ? localParts(event.starts_at, tz).time : '09:00';
    setAdding((a) => ({ date, start, n: (a?.n ?? 0) + 1 }));
  };
  const showAdding = adding && adding.date === current;

  const addSpeaker = useMutation({
    mutationFn: async ({ s, key }: { s: Session; key: string }) => {
      const o = options.data?.find((x) => x.key === key);
      const speakers = [...s.event_session_speaker.map((x) => ({ event_expert_id: x.event_expert_id, user_id: x.user_id, minutes: x.minutes })),
        { event_expert_id: o?.event_expert_id ?? null, user_id: o?.user_id ?? null, minutes: s.event_session_speaker.length ? null : minutesBetween(s.starts_at, s.ends_at) }];
      const { error } = await supabase.rpc('save_event_session', { p: { id: s.id, speakers } });
      if (error) throw new Error(error.message);
    },
    onSettled: () => qc.invalidateQueries({ queryKey: sessionsKey(event.id) }),
  });
  const remove = useMutation({
    mutationFn: async (s: Session) => {
      const { error } = await supabase.from('event_session').delete().eq('id', s.id);
      if (error) throw new Error(error.message);
    },
    onSuccess: () => { qc.invalidateQueries({ queryKey: sessionsKey(event.id) }); setDeleting(null); },
  });

  const addDay = () => {
    const d = nextDay(days[days.length - 1] ?? (event.starts_at ? localParts(event.starts_at, tz).date : new Date().toISOString().slice(0, 10)));
    setExtraDays((x) => [...x, d]);
    setDay(d);
  };

  return (
    <section className="card ov-card" aria-labelledby="agenda-title">
      <div className="ov-head">
        <div className="ov-title-row">
          <h2 id="agenda-title" className="ov-title">Agenda</h2>
          <span className="card-sub">{sub}</span>
        </div>
        <div className="ov-actions">
          {(days.length > 1 || canAdd) && days.length > 0 && (
            <div className="segmented agenda-days" role="tablist" aria-label="Agenda day">
              {days.map((d, i) => (
                <button key={d} role="tab" aria-selected={d === current} aria-pressed={d === current} onClick={() => { setDay(d); setAdding(null); }}>
                  Day {i + 1}<span className="agenda-day-date">{dayLabel(d)}</span>
                </button>
              ))}
              {canAdd && <button className="agenda-add-day" aria-label="Add a day" title="Add a day" onClick={addDay}><Plus size={13} strokeWidth={2.6} /></button>}
            </div>
          )}
          {canAdd && <button className="btn btn-outline btn-sm" onClick={startAdding} disabled={Boolean(showAdding)}><Plus size={14} strokeWidth={2.6} />Add session</button>}
        </div>
      </div>

      {(addSpeaker.error || sessions.error) && <div className="form-error" role="alert">{(addSpeaker.error ?? sessions.error)!.message}</div>}

      {sessions.isLoading ? <div className="ov-empty text-muted">Loading…</div> : todays.length === 0 && !showAdding ? (
        <div className="ov-empty">
          <span><strong>Nothing scheduled{days.length > 1 && current ? ` on ${dayLabel(current)}` : ''}.</strong> Add the first session to build the day's timeline.</span>
          {canAdd && <button className="btn btn-primary btn-sm" onClick={startAdding}><Plus size={14} strokeWidth={2.6} />Add session</button>}
        </div>
      ) : (
        <div className="table-scroll">
          <table className="agenda-table">
            <thead>
              <tr><th>Start</th><th>End</th><th className="num">Min</th><th>Session</th><th>Speakers</th><th aria-label="Actions" /></tr>
            </thead>
            <tbody>
              {todays.map((s) => {
                const taken = new Set(s.event_session_speaker.map(speakerKey));
                const free = (options.data ?? []).filter((o) => !taken.has(o.key));
                return (
                  <tr key={s.id}>
                    <td className="agenda-start">{localParts(s.starts_at, tz).time}</td>
                    <td className="agenda-end">{localParts(s.ends_at, tz).time}</td>
                    <td className="num">{minutesBetween(s.starts_at, s.ends_at)}</td>
                    <td>
                      {canEdit ? <button className="agenda-title as-link" onClick={() => setEditing(s)}>{s.title}</button>
                        : <span className="agenda-title">{s.title}</span>}
                      <div className="dt-sub">{[s.session_kind, s.location].filter(Boolean).join(' · ')}</div>
                    </td>
                    <td>
                      <span className="agenda-speakers">
                        {s.event_session_speaker.map((sp) => (
                          <span key={sp.id} className="speaker-chip" title={sp.minutes ? `${sp.minutes} min` : undefined}>
                            <Avatar size={20} initials={sp.user?.initials ?? speakerName(sp).replace(/^(Dr|Prof)\.?\s+/i, '').split(' ').map((w) => w[0]).slice(0, 2).join('')}
                              color={sp.user?.avatar_color ?? avatarColorFor(speakerName(sp))} />
                            {speakerName(sp)}
                          </span>
                        ))}
                        {canEdit && (
                          <Menu label={`Add a speaker to ${s.title}`} empty={options.data?.length ? 'Everyone is already on this session' : 'Add speakers or team members to the event first'}
                            items={free.map((o) => ({ key: o.key, text: o.name, label: <>{o.name}<span className="dt-sub"> · {o.sub}</span></>,
                              icon: <Avatar size={20} initials={o.initials} color={o.color ?? avatarColorFor(o.name)} />,
                              onSelect: () => addSpeaker.mutate({ s, key: o.key }) }))}
                            width={280}
                            trigger={(t) => <button className="speaker-add" aria-label={`Add a speaker to ${s.title}`} {...t}><Plus size={12} strokeWidth={2.6} />Speaker</button>} />
                        )}
                      </span>
                    </td>
                    <td className="agenda-menu">
                      {(canEdit || canDelete) && (
                        <Menu label={`Actions for ${s.title}`} width={170}
                          items={[
                            ...(canEdit ? [{ key: 'edit', label: 'Edit session', icon: <Pencil size={14} />, onSelect: () => setEditing(s) }] : []),
                            ...(canDelete ? [{ key: 'delete', label: 'Delete', icon: <Trash2 size={14} />, danger: true, onSelect: () => setDeleting(s) }] : []),
                          ]}
                          trigger={(t) => <button className="icon-btn" aria-label={`Actions for ${s.title}`} {...t}><MoreVertical size={16} /></button>} />
                      )}
                    </td>
                  </tr>
                );
              })}
              {showAdding && (
                <InlineSessionRow key={adding.n} eventId={event.id} date={adding.date} start={adding.start}
                  kinds={kinds.data ?? []} speakers={options.data ?? []}
                  onSaved={(next) => setAdding((a) => a && { ...a, start: next, n: a.n + 1 })}
                  onCancel={() => setAdding(null)} />
              )}
            </tbody>
          </table>
        </div>
      )}

      {editing && <SessionModal eventId={event.id} timezone={tz} session={editing} onClose={() => setEditing(null)} />}
      {deleting && (
        <ConfirmDialog title="Delete session?" confirmLabel="Delete session" pending={remove.isPending} error={remove.error?.message}
          onConfirm={() => remove.mutate(deleting)} onCancel={() => { remove.reset(); setDeleting(null); }}>
          “{deleting.title}” and its speaker assignments will be removed from the agenda. Speakers stay on the event.
        </ConfirmDialog>
      )}
    </section>
  );
}
