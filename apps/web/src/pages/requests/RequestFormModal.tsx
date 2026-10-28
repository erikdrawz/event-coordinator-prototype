import { useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { supabase } from '../../lib/supabase';
import { Modal } from '../../ui/Modal';
import { Field, FormSection } from '../../ui/Form';
import { Select } from '../../ui/Select';
import { DateTimeInput } from '../../ui/DateInput';
import { addMinutesLocal, toLocalInput } from '../event/eventForm';
import { useRequestTypes, type RequestRow } from './requestData';

interface FormState { title: string; event_type_id: string; starts_local: string; ends_local: string; rationale: string }

/**
 * New request (no request given) or Edit request (drafts only). Start and end are entered in the
 * request's time zone; a new request takes the requester's own zone.
 */
export function RequestFormModal({ request, onClose }: { request?: RequestRow; onClose: () => void }) {
  const navigate = useNavigate();
  const qc = useQueryClient();
  const types = useRequestTypes();
  const timezone = request?.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
  const initial = useMemo<FormState>(() => ({
    title: request?.title ?? '', event_type_id: request?.event_type_id ?? '',
    starts_local: request?.starts_at ? toLocalInput(request.starts_at, timezone) : '',
    ends_local: request?.ends_at ? toLocalInput(request.ends_at, timezone) : '',
    rationale: request?.rationale ?? '',
  }), [request, timezone]);
  const [f, setF] = useState(initial);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const formRef = useRef<HTMLFormElement>(null);
  const dirty = JSON.stringify(f) !== JSON.stringify(initial);

  const set = <K extends keyof FormState>(k: K, v: FormState[K]) => {
    setF((prev) => ({ ...prev, [k]: v }));
    if (errors[k]) setErrors(({ [k]: _, ...rest }) => rest);
  };
  // A new start fills in the end from the event type's usual length
  const pickStart = (v: string) => setF((prev) => {
    const mins = types.data?.find((t) => t.id === prev.event_type_id)?.default_duration_minutes ?? 120;
    const endStale = !prev.ends_local || prev.ends_local <= v;
    return { ...prev, starts_local: v, ends_local: v && endStale ? addMinutesLocal(v, mins) : prev.ends_local };
  });

  const save = useMutation({
    mutationFn: async () => {
      const { data, error } = await supabase.rpc('save_request', {
        p: { ...(request ? { id: request.id } : {}), ...f, timezone, title: f.title.trim(), rationale: f.rationale.trim() },
      });
      if (error) throw new Error(error.message);
      return data as { id: string };
    },
    onSuccess: (r) => {
      qc.invalidateQueries({ queryKey: ['requests'] });
      qc.invalidateQueries({ queryKey: ['request', r.id] });
      qc.invalidateQueries({ queryKey: ['home'] });
      onClose();
      if (!request) navigate(`/requests/${r.id}`);
    },
  });

  const submit = (ev: React.FormEvent) => {
    ev.preventDefault();
    const errs: Record<string, string> = {};
    if (!f.title.trim()) errs.title = 'Give the request a name';
    if (!f.event_type_id) errs.event_type_id = 'Choose an event type';
    if (f.starts_local && f.ends_local && f.ends_local < f.starts_local) errs.ends_local = 'Ends before it starts';
    setErrors(errs);
    if (Object.keys(errs).length) {
      setTimeout(() => formRef.current?.querySelector<HTMLElement>('[aria-invalid="true"]')?.focus(), 0);
      return;
    }
    save.mutate();
  };
  const inv = (k: string) => (errors[k] ? true : undefined);
  const zone = timezone.replace(/_/g, ' ');

  return (
    <Modal open title={request ? 'Edit request' : 'New request'} onClose={onClose}
      confirmClose={dirty && !save.isPending ? 'Discard your changes to this request?' : false}
      footerNote={<><span className="field-required">*</span> Required to save. Start, end and justification are needed to submit.</>}
      footer={<>
        <button type="button" className="btn" onClick={onClose} disabled={save.isPending}>Cancel</button>
        <button type="submit" form="request-form" className="btn btn-primary" disabled={save.isPending || !types.data}>
          {save.isPending ? 'Saving…' : request ? 'Save changes' : 'Save draft'}
        </button>
      </>}>
      <form id="request-form" ref={formRef} className="form" onSubmit={submit} noValidate>
        {(save.error || types.error) && <div className="form-error" role="alert" style={{ marginBottom: 16 }}>{(save.error ?? types.error)!.message}</div>}
        <FormSection>
          <Field label="Name" required error={errors.title} wide>
            {(id, d) => <input id={id} aria-describedby={d} aria-invalid={inv('title')} className="input" value={f.title}
              onChange={(e) => set('title', e.target.value)} placeholder="e.g. Nordic SMA Advisory Board" autoFocus />}
          </Field>
          <Field label="Event type" required error={errors.event_type_id} wide>
            {(id, d) => <Select id={id} aria-describedby={d} aria-invalid={inv('event_type_id')} value={f.event_type_id}
              onChange={(v) => set('event_type_id', v)} options={(types.data ?? []).map((t) => ({ value: t.id, label: t.name }))} />}
          </Field>
          <Field label="Start" hint={`Time zone: ${zone}`}>
            {(id, d) => <DateTimeInput id={id} aria-describedby={d} value={f.starts_local} onChange={pickStart} />}
          </Field>
          <Field label="End" error={errors.ends_local}>
            {(id, d) => <DateTimeInput id={id} aria-describedby={d} aria-invalid={inv('ends_local')} value={f.ends_local}
              min={f.starts_local || undefined} defaultTime={f.starts_local.slice(11) || '09:00'} onChange={(v) => set('ends_local', v)} />}
          </Field>
          <Field label="Business justification" wide hint="Why this event is needed: the medical or business need, the audience and the expected outcome.">
            {(id, d) => <textarea id={id} aria-describedby={d} className="input" rows={5} value={f.rationale}
              onChange={(e) => set('rationale', e.target.value)} />}
          </Field>
        </FormSection>
      </form>
    </Modal>
  );
}
