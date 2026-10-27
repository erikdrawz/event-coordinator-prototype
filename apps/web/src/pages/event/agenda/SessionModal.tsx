import { useMemo, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Plus, X } from 'lucide-react';
import { supabase } from '../../../lib/supabase';
import { avatarColorFor } from '../../../lib/avatar';
import { Avatar } from '../../../components/Avatar';
import { Modal } from '../../../ui/Modal';
import { Field, FormSection } from '../../../ui/Form';
import { Select } from '../../../ui/Select';
import { DateInput, TimeInput } from '../../../ui/DateInput';
import { Menu } from '../../../ui/Menu';
import {
  addMinutes, localParts, sessionsKey, speakerKey, useSessionKinds, useSpeakerOptions, type Session, type SpeakerOption,
} from './agendaData';

interface Draft { key: string; event_expert_id?: string; user_id?: string; minutes: string }

interface Props {
  eventId: string;
  timezone: string;
  session: Session;
  onClose: () => void;
}

const toMin = (t: string) => { const [h, m] = t.split(':').map(Number); return h * 60 + m; };

/**
 * Edit an agenda session and who speaks in it, including location and per-speaker minutes.
 * New sessions are added inline in the agenda (InlineSessionRow). Saves through save_event_session().
 */
export function SessionModal({ eventId, timezone, session, onClose }: Props) {
  const qc = useQueryClient();
  const kinds = useSessionKinds();
  const options = useSpeakerOptions(eventId);
  const start = localParts(session.starts_at, timezone);
  const end = localParts(session.ends_at, timezone);

  const [title, setTitle] = useState(session.title);
  const [kind, setKind] = useState(session.session_kind ?? '');
  const [location, setLocation] = useState(session.location ?? '');
  const [date, setDate] = useState(start.date);
  const [from, setFrom] = useState(start.time);
  const [to, setTo] = useState(end.time);
  const [speakers, setSpeakers] = useState<Draft[]>(session.event_session_speaker.map((s) => ({
    key: speakerKey(s), event_expert_id: s.event_expert_id ?? undefined, user_id: s.user_id ?? undefined, minutes: s.minutes?.toString() ?? '',
  })));
  const [errors, setErrors] = useState<Record<string, string>>({});

  const length = from && to ? toMin(to) - toMin(from) : null;
  const byKey = useMemo(() => new Map((options.data ?? []).map((o) => [o.key, o])), [options.data]);
  const available = (options.data ?? []).filter((o) => !speakers.some((s) => s.key === o.key));

  // Keep the session's length when the start moves
  const moveStart = (t: string) => {
    if (t && from && to) setTo(addMinutes(t, toMin(to) - toMin(from)));
    setFrom(t);
  };
  const addSpeaker = (o: SpeakerOption) => setSpeakers((list) => [...list, {
    key: o.key, event_expert_id: o.event_expert_id, user_id: o.user_id,
    minutes: list.length === 0 && length && length > 0 ? String(length) : '',
  }]);

  const save = useMutation({
    mutationFn: async () => {
      // A session that runs past midnight ends on the next day
      const endDate = toMin(to) < toMin(from) ? new Date(Date.parse(`${date}T00:00:00Z`) + 86400000).toISOString().slice(0, 10) : date;
      const p = {
        id: session.id,
        title: title.trim(), session_kind: kind || null, location: location.trim() || null,
        starts_local: `${date}T${from}`, ends_local: `${endDate}T${to}`,
        speakers: speakers.map((s) => ({ event_expert_id: s.event_expert_id ?? null, user_id: s.user_id ?? null, minutes: s.minutes ? Number(s.minutes) : null })),
      };
      const { error } = await supabase.rpc('save_event_session', { p });
      if (error) throw new Error(error.message);
    },
    onSuccess: () => { qc.invalidateQueries({ queryKey: sessionsKey(eventId) }); onClose(); },
  });

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    const errs: Record<string, string> = {};
    if (!title.trim()) errs.title = 'Give the session a title';
    if (!date) errs.date = 'Choose a day';
    if (!from) errs.from = 'Add a start time';
    if (!to) errs.to = 'Add an end time';
    setErrors(errs);
    if (!Object.keys(errs).length) save.mutate();
  };

  return (
    <Modal open size="lg" title="Edit session" onClose={onClose}
      footerNote={<><span className="field-required">*</span> Required · times are local to the event ({timezone.replace(/_/g, ' ')})</>}
      footer={<>
        <button type="button" className="btn" onClick={onClose}>Cancel</button>
        <button type="submit" form="session-form" className="btn btn-primary" disabled={save.isPending}>{save.isPending ? 'Saving…' : 'Save session'}</button>
      </>}>
      <form id="session-form" className="form" onSubmit={submit} noValidate>
        {save.error && <div className="form-error" role="alert" style={{ marginBottom: 16 }}>{save.error.message}</div>}
        <FormSection title="Session">
          <Field label="Title" required error={errors.title} wide>
            {(id, d) => <input id={id} aria-describedby={d} aria-invalid={Boolean(errors.title) || undefined} className="input" value={title}
              onChange={(e) => setTitle(e.target.value)} placeholder="e.g. Real-world outcomes: regional registry data" />}
          </Field>
          <Field label="Kind">
            {(id) => <Select id={id} value={kind} onChange={setKind} emptyLabel="None"
              options={[...(kinds.data ?? []), ...(kind && !kinds.data?.includes(kind) ? [kind] : [])].map((k) => ({ value: k, label: k }))} />}
          </Field>
          <Field label="Location" hint="Room or stage, if the event has several.">
            {(id, d) => <input id={id} aria-describedby={d} className="input" value={location} onChange={(e) => setLocation(e.target.value)} />}
          </Field>
        </FormSection>

        <FormSection title="Time">
          <Field label="Day" required error={errors.date}>
            {(id, d) => <DateInput id={id} aria-describedby={d} aria-invalid={Boolean(errors.date) || undefined} value={date} onChange={setDate} />}
          </Field>
          <div className="session-times">
            <Field label="Starts" required error={errors.from}>
              {(id, d) => <TimeInput id={id} aria-describedby={d} aria-invalid={Boolean(errors.from) || undefined} value={from} onChange={moveStart} />}
            </Field>
            <Field label="Ends" required error={errors.to}>
              {(id, d) => <TimeInput id={id} aria-describedby={d} aria-invalid={Boolean(errors.to) || undefined} value={to} onChange={setTo} />}
            </Field>
            <div className="session-length" aria-live="polite">
              {length != null && <>{length < 0 ? `${length + 1440} min (ends next day)` : `${length} min`}</>}
            </div>
          </div>
        </FormSection>

        <FormSection title="Speakers">
          <div className="field field-wide">
            {speakers.length === 0 && <p className="field-hint">No speakers yet. Breaks and meals usually don't need one.</p>}
            {speakers.length > 0 && (
              <ul className="session-speakers">
                {speakers.map((s, i) => {
                  const o = byKey.get(s.key);
                  return (
                    <li key={s.key}>
                      <Avatar size={26} initials={o?.initials} color={o?.color ?? avatarColorFor(o?.name ?? s.key)} />
                      <span className="session-speaker-name">{o?.name ?? 'Unknown'}<span className="dt-sub">{o?.sub}</span></span>
                      <label className="session-speaker-min">
                        <input className="input" type="number" min={0} step={5} value={s.minutes} aria-label={`Minutes for ${o?.name}`}
                          onChange={(e) => setSpeakers((list) => list.map((x, j) => (j === i ? { ...x, minutes: e.target.value } : x)))} />
                        <span>min</span>
                      </label>
                      <button type="button" className="icon-btn" aria-label={`Remove ${o?.name}`}
                        onClick={() => setSpeakers((list) => list.filter((_, j) => j !== i))}><X size={15} /></button>
                    </li>
                  );
                })}
              </ul>
            )}
            <Menu label="Add speaker" empty={options.data?.length ? 'Everyone is already on this session' : 'Add speakers or team members to the event first'}
              items={available.map((o) => ({ key: o.key, text: o.name, label: <>{o.name}<span className="dt-sub"> · {o.sub}</span></>,
                icon: <Avatar size={20} initials={o.initials} color={o.color ?? avatarColorFor(o.name)} />, onSelect: () => addSpeaker(o) }))}
              trigger={(t) => <button type="button" className="btn btn-sm session-add-speaker" {...t}><Plus size={14} />Add speaker</button>} />
          </div>
        </FormSection>
      </form>
    </Modal>
  );
}
