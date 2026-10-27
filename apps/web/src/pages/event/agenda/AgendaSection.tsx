import { useState } from 'react';
import { useEventAccess } from '../eventAccess';
import { useQueryClient } from '@tanstack/react-query';
import { Pencil, Plus } from 'lucide-react';
import { supabase } from '../../../lib/supabase';
import { useAuth } from '../../../lib/auth';
import { can } from '../../../lib/permissions';
import { avatarColorFor } from '../../../lib/avatar';
import { Avatar } from '../../../components/Avatar';
import { AgendaEditor } from './AgendaEditor';
import { AgendaDays, agendaDays, dayLabel } from './AgendaDays';
import {
  fetchSessions, initials, localParts, minutesBetween, sessionsKey, speakerName, toDraft, useSessions, type DraftSession,
} from './agendaData';

interface EventLite { id: string; timezone: string; starts_at: string | null; ends_at: string | null }

/**
 * The agenda: read-only by default, one tab per day (in the event's time zone), sessions in time order.
 * "Edit agenda" opens the whole agenda for editing; it is saved in one go (AgendaEditor).
 */
export function AgendaSection({ event }: { event: EventLite }) {
  const { me } = useAuth();
  const { canEdit: canEditEvent } = useEventAccess();
  const qc = useQueryClient();
  const sessions = useSessions(event.id);
  const [day, setDay] = useState<string | null>(null);
  const [editing, setEditing] = useState<{ rows: DraftSession[]; version: string; addFirst: boolean } | null>(null);
  const [opening, setOpening] = useState(false);
  const [openError, setOpenError] = useState<string | null>(null);
  const tz = event.timezone;
  const canEdit = can(me, 'event_session', 'edit') && canEditEvent;
  const canAdd = can(me, 'event_session', 'create') && canEditEvent;
  const canDelete = can(me, 'event_session', 'delete') && canEditEvent;

  // Edit from the agenda as it is now: read the version first, then the sessions, so a change
  // in between makes the save refuse rather than overwrite it
  const startEditing = async (addFirst: boolean) => {
    setOpening(true); setOpenError(null);
    try {
      const { data: version, error } = await supabase.rpc('agenda_version', { p_event_id: event.id });
      if (error) throw error;
      const fresh = await qc.fetchQuery({ queryKey: sessionsKey(event.id), queryFn: () => fetchSessions(event.id), staleTime: 0 });
      setEditing({ rows: fresh.map((s) => toDraft(s, tz)), version: version as string, addFirst });
    } catch (e) {
      setOpenError((e as Error).message);
    } finally {
      setOpening(false);
    }
  };

  if (editing) {
    return <AgendaEditor event={event} initial={editing.rows} version={editing.version} addFirst={editing.addFirst}
      day={day} onDay={setDay} canAdd={canAdd} canDelete={canDelete} onClose={() => setEditing(null)} />;
  }

  const days = agendaDays(event.starts_at ? localParts(event.starts_at, tz).date : null, event.ends_at ? localParts(event.ends_at, tz).date : null,
    (sessions.data ?? []).map((s) => localParts(s.starts_at, tz).date));
  const current = day && days.includes(day) ? day : days[0] ?? null;
  const todays = (sessions.data ?? []).filter((s) => localParts(s.starts_at, tz).date === current);

  const span = todays.length ? `${localParts(todays[0].starts_at, tz).time}–${localParts(todays[todays.length - 1].ends_at, tz).time}` : null;
  const total = sessions.data?.length ?? 0;
  const sub = total === 0 ? 'No sessions yet'
    : `${total} session${total === 1 ? '' : 's'}${days.length > 1 ? ` over ${days.length} days` : ''}${span ? ` · ${span}` : ''}`;

  return (
    <section className="card ov-card" aria-labelledby="agenda-title">
      <div className="ov-head">
        <div className="ov-title-row">
          <h2 id="agenda-title" className="ov-title">Agenda</h2>
          <span className="card-sub">{sub}</span>
        </div>
        <div className="ov-actions">
          <AgendaDays days={days} current={current} onPick={setDay} />
          {canEdit && total > 0 && (
            <button type="button" className="btn btn-outline btn-sm" onClick={() => startEditing(false)} disabled={opening}>
              <Pencil size={14} />Edit agenda
            </button>
          )}
        </div>
      </div>

      {(openError || sessions.error) && <div className="form-error" role="alert">{openError ?? sessions.error!.message}</div>}

      {sessions.isLoading ? <div className="ov-empty text-muted">Loading…</div> : total === 0 ? (
        <div className="ov-empty">
          <span><strong>No sessions yet.</strong> Build the timeline session by session; speakers you add join the Speakers list when you save.</span>
          {canEdit && canAdd && <button type="button" className="btn btn-primary btn-sm" onClick={() => startEditing(true)} disabled={opening}><Plus size={14} strokeWidth={2.6} />Add sessions</button>}
        </div>
      ) : todays.length === 0 ? (
        <div className="ov-empty"><span><strong>Nothing scheduled{current ? ` on ${dayLabel(current)}` : ''}.</strong></span></div>
      ) : (
        <div className="table-scroll">
          <table className="agenda-table">
            <thead>
              <tr><th>Start</th><th>End</th><th className="num">Min</th><th>Session</th><th>Speakers</th></tr>
            </thead>
            <tbody>
              {todays.map((s) => (
                <tr key={s.id}>
                  <td className="agenda-start">{localParts(s.starts_at, tz).time}</td>
                  <td className="agenda-end">{localParts(s.ends_at, tz).time}</td>
                  <td className="num">{minutesBetween(s.starts_at, s.ends_at)}</td>
                  <td>
                    <span className="agenda-title">{s.title}</span>
                    {s.location && <div className="dt-sub">{s.location}</div>}
                  </td>
                  <td>
                    <span className="agenda-speakers">
                      {s.event_session_speaker.map((sp) => (
                        <span key={sp.id} className="speaker-chip" title={sp.minutes ? `${sp.minutes} min` : undefined}>
                          <Avatar size={20} initials={sp.user?.initials ?? initials(speakerName(sp))} color={sp.user?.avatar_color ?? avatarColorFor(speakerName(sp))} />
                          {speakerName(sp)}
                        </span>
                      ))}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
