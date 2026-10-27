import { useRef, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Check, Plus, X } from 'lucide-react';
import { supabase } from '../../../lib/supabase';
import { avatarColorFor } from '../../../lib/avatar';
import { Avatar } from '../../../components/Avatar';
import { Select } from '../../../ui/Select';
import { TimeInput } from '../../../ui/DateInput';
import { Menu } from '../../../ui/Menu';
import { addMinutes, eventKey, speakerPayload, type SpeakerOption } from './agendaData';

interface Props {
  eventId: string;
  /** The day being added to, 'YYYY-MM-DD' in the event's zone. */
  date: string;
  start: string;
  kinds: string[];
  speakers: SpeakerOption[];
  /** After a save: where the next new row should start. */
  onSaved: (nextStart: string) => void;
  onCancel: () => void;
}

const toMin = (t: string) => { const [h, m] = t.split(':').map(Number); return h * 60 + m; };

/**
 * A new agenda session typed straight into the table. Enter saves and the parent opens the next row;
 * Esc cancels. Details like location and per-speaker minutes are in the edit modal afterwards.
 */
export function InlineSessionRow({ eventId, date, start, kinds, speakers, onSaved, onCancel }: Props) {
  const qc = useQueryClient();
  const [from, setFrom] = useState(start);
  const [to, setTo] = useState(addMinutes(start, 30));
  const [title, setTitle] = useState('');
  const [kind, setKind] = useState('');
  const [picked, setPicked] = useState<SpeakerOption[]>([]);
  const [error, setError] = useState<string | null>(null);
  const titleRef = useRef<HTMLInputElement>(null);

  const length = from && to ? (toMin(to) - toMin(from) + 1440) % 1440 : null;
  const free = speakers.filter((o) => !picked.some((p) => p.key === o.key));

  const moveStart = (t: string) => {
    if (t && from && to) setTo(addMinutes(t, toMin(to) - toMin(from)));
    setFrom(t);
  };

  const save = useMutation({
    mutationFn: async () => {
      const endDate = toMin(to) < toMin(from) ? new Date(Date.parse(`${date}T00:00:00Z`) + 86400000).toISOString().slice(0, 10) : date;
      const { error } = await supabase.rpc('save_event_session', { p: {
        event_id: eventId, title: title.trim(), session_kind: kind || null,
        starts_local: `${date}T${from}`, ends_local: `${endDate}T${to}`,
        // One speaker gets the whole slot; with several, minutes are set in the edit form
        speakers: picked.map((o) => speakerPayload(o, picked.length === 1 ? length : null)),
      } });
      if (error) throw new Error(error.message);
    },
    onSuccess: () => { qc.invalidateQueries({ queryKey: eventKey(eventId) }); onSaved(to); },
    onError: (e) => setError(e.message),
  });

  const submit = () => {
    if (!title.trim()) { setError('Give the session a title'); titleRef.current?.focus(); return; }
    if (!from || !to) { setError('Add a start and an end time'); return; }
    setError(null);
    save.mutate();
  };
  // Enter saves from any field in the row; Esc cancels (open popups handle their own Esc first)
  const onKey = (e: React.KeyboardEvent) => {
    if (e.defaultPrevented) return;
    if (e.key === 'Enter' && (e.target as HTMLElement).tagName === 'INPUT' && (e.target as HTMLElement).getAttribute('aria-haspopup') !== 'listbox') { e.preventDefault(); submit(); }
    else if (e.key === 'Escape') { e.preventDefault(); onCancel(); }
  };

  return (
    <>
      <tr className="agenda-inline" onKeyDown={onKey}>
        <td className="agenda-start"><TimeInput aria-label="Starts" value={from} onChange={moveStart} /></td>
        <td className="agenda-end"><TimeInput aria-label="Ends" value={to} onChange={setTo} /></td>
        <td className="num">{length ?? ''}</td>
        <td>
          <div className="agenda-inline-main">
            <input ref={titleRef} className="input" autoFocus placeholder="Session title" aria-label="Session title"
              aria-invalid={error === 'Give the session a title' || undefined} value={title}
              onChange={(e) => { setTitle(e.target.value); if (error) setError(null); }} />
            <Select aria-label="Kind" value={kind} onChange={setKind} emptyLabel="No kind" placeholder="Kind"
              options={kinds.map((k) => ({ value: k, label: k }))} />
          </div>
        </td>
        <td>
          <span className="agenda-speakers">
            {picked.map((o) => (
              <span key={o.key} className="speaker-chip">
                <Avatar size={20} initials={o.initials} color={o.color ?? avatarColorFor(o.name)} />{o.name}
                <button type="button" className="ms-chip-x" aria-label={`Remove ${o.name}`} onClick={() => setPicked((p) => p.filter((x) => x.key !== o.key))}><X size={12} /></button>
              </span>
            ))}
            <Menu label="Add a speaker" width={280} empty={speakers.length ? 'Everyone is already on this session' : 'Add speakers or team members to the event first'}
              items={free.map((o) => ({ key: o.key, text: o.name, label: <>{o.name}<span className="dt-sub"> · {o.sub}</span></>,
                icon: <Avatar size={20} initials={o.initials} color={o.color ?? avatarColorFor(o.name)} />, onSelect: () => setPicked((p) => [...p, o]) }))}
              trigger={(t) => <button type="button" className="speaker-add" {...t}><Plus size={12} strokeWidth={2.6} />Speaker</button>} />
          </span>
        </td>
        <td className="agenda-menu agenda-inline-actions">
          <button type="button" className="icon-btn ok" aria-label="Save session" title="Save (Enter)" disabled={save.isPending} onClick={submit}><Check size={16} /></button>
          <button type="button" className="icon-btn" aria-label="Cancel" title="Cancel (Esc)" onClick={onCancel}><X size={16} /></button>
        </td>
      </tr>
      <tr className="agenda-inline-note">
        <td colSpan={6}>
          {error ? <span className="field-error" role="alert">{error}</span>
            : <span className="field-hint">Enter saves and starts the next session · Esc cancels</span>}
        </td>
      </tr>
    </>
  );
}
