import { useEffect, useMemo, useRef, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useBlocker } from 'react-router-dom';
import { ChevronDown, Plus, Trash2, X } from 'lucide-react';
import { supabase } from '../../../lib/supabase';
import { avatarColorFor } from '../../../lib/avatar';
import { Avatar } from '../../../components/Avatar';
import { DateInput, TimeInput } from '../../../ui/DateInput';
import { useAuth } from '../../../lib/auth';
import { can } from '../../../lib/permissions';
import { ConfirmDialog } from '../../../ui/ConfirmDialog';
import { keepsWithoutSessions, useExperts } from '../speakers/speakersData';
import { PersonPicker } from '../people/PersonPicker';
import { AgendaDays, agendaDays, nextDay } from './AgendaDays';
import {
  addMinutes, draftPayload, draftSpeaker, eventKey, localParts, sessionLength, useSpeakerOptions,
  type DraftSession, type SpeakerOption,
} from './agendaData';

interface EventLite { id: string; timezone: string; starts_at: string | null; ends_at: string | null }

interface Props {
  event: EventLite;
  /** The saved agenda, as drafts, and the agenda_version() it was read at. */
  initial: DraftSession[];
  version: string;
  /** Start with an empty session row (building an agenda from scratch). */
  addFirst?: boolean;
  day: string | null;
  onDay: (d: string) => void;
  canAdd: boolean;
  canDelete: boolean;
  onClose: () => void;
}

const fingerprint = (rows: DraftSession[]) => JSON.stringify(rows.map((r) =>
  [r.id, r.date, r.from, r.to, r.title.trim(), r.kind, r.location.trim(), r.speakers.map((s) => [s.key, s.minutes])]));
const SPEAKER_GROUPS = [
  { group: 'speaker' as const, label: 'Experts on this event' },
  { group: 'team' as const, label: 'Event team (internal)' },
  { group: 'hcp' as const, label: 'In Event Coordinator' },
];
const names = (list: string[]) => list.length <= 2 ? list.join(' and ') : `${list.slice(0, -1).join(', ')} and ${list[list.length - 1]}`;

/**
 * The whole agenda in edit mode. Nothing is saved until "Save agenda", which sends every session to
 * save_agenda() in one transaction, so speakers can be moved between sessions without losing their record.
 */
export function AgendaEditor({ event, initial, version, addFirst, day, onDay, canAdd, canDelete, onClose }: Props) {
  const qc = useQueryClient();
  const options = useSpeakerOptions(event.id);
  const experts = useExperts(event.id);
  const { me } = useAuth();
  const canSearchCrm = can(me, 'hcp', 'create');
  const tz = event.timezone;
  const seq = useRef(0);
  const eventStart = event.starts_at ? localParts(event.starts_at, tz) : null;

  const newRow = (date: string, from: string): DraftSession =>
    ({ key: `new-${++seq.current}`, date, from, to: addMinutes(from, 30), title: '', kind: '', location: '', speakers: [] });
  const [rows, setRows] = useState<DraftSession[]>(() =>
    addFirst ? [...initial, newRow(day ?? eventStart?.date ?? new Date().toISOString().slice(0, 10), eventStart?.time ?? '09:00')] : initial);
  const [extraDays, setExtraDays] = useState<string[]>([]);
  const [open, setOpen] = useState<Set<string>>(new Set());
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [focusKey, setFocusKey] = useState<string | null>(addFirst ? rows[rows.length - 1]?.key ?? null : null);
  const [discarding, setDiscarding] = useState(false);

  const saved = useMemo(() => fingerprint(initial), [initial]);
  const dirty = fingerprint(rows) !== saved;

  const days = agendaDays(eventStart?.date ?? null, event.ends_at ? localParts(event.ends_at, tz).date : null, [...rows.map((r) => r.date), ...extraDays]);
  const current = day && days.includes(day) ? day : days[0] ?? null;
  const todays = rows.filter((r) => r.date === current);

  // What saving does to the event's Experts, from the saved speakers and the draft
  const effects = useMemo(() => {
    const kept = new Set(rows.flatMap((r) => r.speakers.map((s) => s.event_expert_id)).filter(Boolean));
    const joining = [...new Map(rows.flatMap((r) => r.speakers).filter((s) => s.hcp_id).map((s) => [s.hcp_id, s.name])).values()];
    const leaving = (experts.data ?? []).filter((x) => x.event_session_speaker.length > 0 && !kept.has(x.id) && !keepsWithoutSessions(x))
      .map((x) => x.hcp?.display_name ?? 'Unknown HCP');
    return { joining, leaving };
  }, [rows, experts.data]);

  useEffect(() => {
    if (!focusKey) return;
    document.querySelector<HTMLInputElement>(`[data-session-title="${focusKey}"]`)?.focus();
    setFocusKey(null);
  }, [focusKey, current]);

  // Unsaved changes: ask before leaving the page or switching tabs
  const blocker = useBlocker(({ currentLocation, nextLocation }) =>
    dirty && (currentLocation.pathname !== nextLocation.pathname || currentLocation.search !== nextLocation.search));
  useEffect(() => {
    if (!dirty) return;
    const warn = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [dirty]);

  const update = (key: string, patch: Partial<DraftSession>) => {
    setRows((list) => list.map((r) => (r.key === key ? { ...r, ...patch } : r)));
    if (errors[key]) setErrors(({ [key]: _, ...rest }) => rest);
  };
  const addRow = () => {
    const date = current ?? eventStart?.date ?? new Date().toISOString().slice(0, 10);
    const last = todays[todays.length - 1];
    const r = newRow(date, last?.to || (date === eventStart?.date ? eventStart.time : '09:00'));
    setRows((list) => [...list, r]);
    onDay(date);
    setFocusKey(r.key);
  };
  const addDay = () => {
    const d = nextDay(days[days.length - 1] ?? eventStart?.date ?? new Date().toISOString().slice(0, 10));
    setExtraDays((x) => [...x, d]);
    onDay(d);
  };

  const save = useMutation({
    mutationFn: async () => {
      const { error } = await supabase.rpc('save_agenda', { p: { event_id: event.id, version, sessions: rows.map(draftPayload) } });
      if (error) throw Object.assign(new Error(error.message), { code: error.code });
    },
    onSuccess: async () => { await qc.invalidateQueries({ queryKey: eventKey(event.id) }); onClose(); },
  });
  const conflict = (save.error as { code?: string } | null)?.code === 'PT409';

  const submit = () => {
    const errs: Record<string, string> = {};
    for (const r of rows) {
      if (!r.title.trim()) errs[r.key] = 'Give the session a title';
      else if (!r.from || !r.to) errs[r.key] = 'Add a start and an end time';
    }
    setErrors(errs);
    const first = rows.find((r) => errs[r.key]);
    if (first) { onDay(first.date); setFocusKey(first.key); return; }
    save.mutate();
  };
  const cancel = () => (dirty ? setDiscarding(true) : onClose());
  const reload = async () => { await qc.invalidateQueries({ queryKey: eventKey(event.id) }); onClose(); };

  return (
    <section className="card ov-card agenda-editing" aria-labelledby="agenda-title">
      <div className="ov-head">
        <div className="ov-title-row">
          <h2 id="agenda-title" className="ov-title">Agenda</h2>
          <span className="card-sub">Editing · times are local to the event ({tz.replace(/_/g, ' ')})</span>
        </div>
        <div className="ov-actions">
          <AgendaDays days={days} current={current} onPick={onDay} onAddDay={canAdd ? addDay : undefined} />
          {canAdd && <button type="button" className="btn btn-outline btn-sm" onClick={addRow}><Plus size={14} strokeWidth={2.6} />Add session</button>}
        </div>
      </div>

      <div className="table-scroll">
        <table className="agenda-table">
          <thead>
            <tr><th>Start</th><th>End</th><th className="num">Min</th><th>Session</th><th>Speakers</th><th aria-label="Actions" /></tr>
          </thead>
          <tbody>
            {todays.map((r) => (
              <EditRow key={r.key} row={r} error={errors[r.key]} open={open.has(r.key)} options={options.data ?? []}
                canDelete={canDelete} canSearchCrm={canSearchCrm}
                onChange={(patch) => { update(r.key, patch); if (patch.date) onDay(patch.date); }}
                onToggle={() => setOpen((s) => { const n = new Set(s); if (n.has(r.key)) n.delete(r.key); else n.add(r.key); return n; })}
                onRemove={() => setRows((list) => list.filter((x) => x.key !== r.key))}
                onEnter={canAdd ? addRow : undefined} />
            ))}
            {todays.length === 0 && (
              <tr className="agenda-edit-empty">
                <td colSpan={6}>
                  Nothing on this day yet.{' '}
                  {canAdd && <button type="button" className="link" onClick={addRow}>Add a session</button>}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      <div className="agenda-savebar" role="region" aria-label="Save agenda">
        <div className="agenda-savebar-msg" aria-live="polite">
          {save.error ? (
            <span className="field-error" role="alert">
              {save.error.message}
              {conflict && <> <button type="button" className="link" onClick={reload}>Discard my changes and reload</button></>}
            </span>
          ) : (
            <>
              <strong>{dirty ? 'Unsaved changes' : 'No changes yet'}</strong>
              {effects.joining.length > 0 && <span>{names(effects.joining)} will be added to Experts.</span>}
              {effects.leaving.length > 0 && <span>{names(effects.leaving)} will be removed from Experts (no sessions left).</span>}
              {!effects.joining.length && !effects.leaving.length && <span className="text-muted">Experts update when you save.</span>}
            </>
          )}
        </div>
        <div className="agenda-savebar-actions">
          <button type="button" className="btn" onClick={cancel}>Cancel</button>
          <button type="button" className="btn btn-primary" onClick={submit} disabled={!dirty || save.isPending}>{save.isPending ? 'Saving…' : 'Save agenda'}</button>
        </div>
      </div>

      {(discarding || blocker.state === 'blocked') && (
        <ConfirmDialog title="Discard agenda changes?" confirmLabel="Discard changes"
          onConfirm={() => { if (blocker.state === 'blocked') blocker.proceed(); else onClose(); }}
          onCancel={() => { setDiscarding(false); blocker.reset?.(); }}>
          Your changes to the agenda haven't been saved.
        </ConfirmDialog>
      )}
    </section>
  );
}

interface RowProps {
  row: DraftSession;
  error?: string;
  open: boolean;
  options: SpeakerOption[];
  canDelete: boolean;
  canSearchCrm: boolean;
  onChange: (patch: Partial<DraftSession>) => void;
  onToggle: () => void;
  onRemove: () => void;
  onEnter?: () => void;
}

function EditRow({ row: r, error, open, options, canDelete, canSearchCrm, onChange, onToggle, onRemove, onEnter }: RowProps) {
  const length = sessionLength(r.from, r.to);
  const free = options.filter((o) => !r.speakers.some((s) => s.key === o.key));
  const label = r.title.trim() || 'new session';
  // Keep the session's length when its start moves
  const moveStart = (t: string) => onChange(t && r.from && r.to ? { from: t, to: addMinutes(t, length ?? 0) } : { from: t });
  // A speaking time typed as the whole session keeps following it when the end moves
  const moveEnd = (to: string) => onChange({ to, speakers: r.speakers.map((s) => (length != null && s.minutes === String(length) ? { ...s, minutes: '' } : s)) });
  const setMinutes = (key: string, minutes: string) => onChange({ speakers: r.speakers.map((s) => (s.key === key ? { ...s, minutes } : s)) });

  return (
    <>
      <tr className={`agenda-edit${open ? ' is-open' : ''}${error ? ' has-error' : ''}`}>
        <td className="agenda-start"><TimeInput aria-label={`Start of ${label}`} value={r.from} onChange={moveStart} /></td>
        <td className="agenda-end"><TimeInput aria-label={`End of ${label}`} value={r.to} onChange={moveEnd} /></td>
        <td className="num">{length ?? ''}</td>
        <td>
          <div className="agenda-edit-main">
            <input className="input" data-session-title={r.key} placeholder="Session title" aria-label="Session title" value={r.title}
              aria-invalid={error === 'Give the session a title' || undefined}
              onChange={(e) => onChange({ title: e.target.value })}
              onKeyDown={(e) => { if (e.key === 'Enter' && onEnter) { e.preventDefault(); onEnter(); } }} />
          </div>
        </td>
        <td>
          <span className="agenda-speakers">
            {r.speakers.map((s) => (
              <span key={s.key} className="speaker-chip" title={s.minutes ? `${s.minutes} min` : undefined}>
                <Avatar size={20} initials={s.initials} color={s.color ?? avatarColorFor(s.name)} />{s.name}
                <button type="button" className="ms-chip-x" aria-label={`Remove ${s.name} from ${label}`}
                  onClick={() => onChange({ speakers: r.speakers.filter((x) => x.key !== s.key) })}><X size={12} /></button>
              </span>
            ))}
            <PersonPicker label={`Add a speaker to ${label}`} options={free} groups={SPEAKER_GROUPS} canSearchCrm={canSearchCrm}
              onPick={(o) => onChange({ speakers: [...r.speakers, draftSpeaker(o)] })}
              trigger={(t) => <button type="button" className="speaker-add" aria-label={`Add a speaker to ${label}`} {...t}><Plus size={12} strokeWidth={2.6} />Speaker</button>} />
          </span>
        </td>
        <td className="agenda-edit-actions">
          <button type="button" className={`icon-btn agenda-more${open ? ' is-open' : ''}`} aria-expanded={open} aria-label={`More details for ${label}`}
            title="Day, location and speaker minutes" onClick={onToggle}><ChevronDown size={16} /></button>
          {canDelete && <button type="button" className="icon-btn icon-btn-danger" aria-label={`Delete ${label}`} title="Delete session" onClick={onRemove}><Trash2 size={15} /></button>}
        </td>
      </tr>
      {error && (
        <tr className="agenda-edit-note"><td colSpan={6}><span className="field-error" role="alert">{error}</span></td></tr>
      )}
      {open && (
        <tr className="agenda-edit-details">
          <td colSpan={3} />
          <td colSpan={3}>
            <div className="agenda-details">
              <div className="agenda-detail">
                <span className="agenda-detail-label">Day</span>
                <DateInput aria-label={`Day of ${label}`} value={r.date} onChange={(date) => date && onChange({ date })} />
              </div>
              <div className="agenda-detail">
                <span className="agenda-detail-label">Location</span>
                <input className="input" aria-label={`Location of ${label}`} placeholder="Room or stage" value={r.location}
                  onChange={(e) => onChange({ location: e.target.value })} />
              </div>
              {r.speakers.length > 0 && (
                <div className="agenda-detail agenda-detail-wide">
                  <span className="agenda-detail-label">Speaking time</span>
                  <div className="agenda-minutes">
                    {r.speakers.map((s) => (
                      <label key={s.key} className="agenda-minute">
                        <span>{s.name}</span>
                        <input className="input" type="number" min={0} step={5} inputMode="numeric" value={s.minutes}
                          placeholder={length != null ? String(length) : ''} aria-label={`Minutes for ${s.name}`}
                          onChange={(e) => setMinutes(s.key, e.target.value)} />
                        <span className="text-muted">min</span>
                      </label>
                    ))}
                  </div>
                  <span className="field-hint">Leave empty for the whole session. Speaking time sets service hours.</span>
                </div>
              )}
            </div>
          </td>
        </tr>
      )}
    </>
  );
}
