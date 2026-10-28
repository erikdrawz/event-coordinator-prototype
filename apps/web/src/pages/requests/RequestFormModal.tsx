import { useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { supabase } from '../../lib/supabase';
import { Modal } from '../../ui/Modal';
import { Field, FormSection } from '../../ui/Form';
import { Select } from '../../ui/Select';
import { DateInput } from '../../ui/DateInput';
import { useRequestDurations, useRequestTypes, type RequestRow } from './requestData';

interface FormState { title: string; event_type_id: string; event_date: string; duration: string; rationale: string }

/** New request (no request given) or Edit request (drafts only). */
export function RequestFormModal({ request, onClose }: { request?: RequestRow; onClose: () => void }) {
  const navigate = useNavigate();
  const qc = useQueryClient();
  const types = useRequestTypes();
  const durations = useRequestDurations();
  const initial = useMemo<FormState>(() => ({
    title: request?.title ?? '', event_type_id: request?.event_type_id ?? '', event_date: request?.event_date ?? '',
    duration: request?.duration ?? '', rationale: request?.rationale ?? '',
  }), [request]);
  const [f, setF] = useState(initial);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const formRef = useRef<HTMLFormElement>(null);
  const dirty = JSON.stringify(f) !== JSON.stringify(initial);

  const set = <K extends keyof FormState>(k: K, v: FormState[K]) => {
    setF((prev) => ({ ...prev, [k]: v }));
    if (errors[k]) setErrors(({ [k]: _, ...rest }) => rest);
  };

  const save = useMutation({
    mutationFn: async () => {
      const { data, error } = await supabase.rpc('save_request', {
        p: { ...(request ? { id: request.id } : {}), ...f, title: f.title.trim(), rationale: f.rationale.trim() },
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
    setErrors(errs);
    if (Object.keys(errs).length) {
      setTimeout(() => formRef.current?.querySelector<HTMLElement>('[aria-invalid="true"]')?.focus(), 0);
      return;
    }
    save.mutate();
  };
  const inv = (k: string) => (errors[k] ? true : undefined);
  const loadError = types.error ?? durations.error;

  return (
    <Modal open title={request ? 'Edit request' : 'New request'} onClose={onClose}
      confirmClose={dirty && !save.isPending ? 'Discard your changes to this request?' : false}
      footerNote={<><span className="field-required">*</span> Required to save. Date, duration and justification are needed to submit.</>}
      footer={<>
        <button type="button" className="btn" onClick={onClose} disabled={save.isPending}>Cancel</button>
        <button type="submit" form="request-form" className="btn btn-primary" disabled={save.isPending || !types.data}>
          {save.isPending ? 'Saving…' : request ? 'Save changes' : 'Save draft'}
        </button>
      </>}>
      <form id="request-form" ref={formRef} className="form" onSubmit={submit} noValidate>
        {(save.error || loadError) && <div className="form-error" role="alert" style={{ marginBottom: 16 }}>{(save.error ?? loadError)!.message}</div>}
        <FormSection>
          <Field label="Name" required error={errors.title} wide>
            {(id, d) => <input id={id} aria-describedby={d} aria-invalid={inv('title')} className="input" value={f.title}
              onChange={(e) => set('title', e.target.value)} placeholder="e.g. Nordic SMA Advisory Board" autoFocus />}
          </Field>
          <Field label="Event type" required error={errors.event_type_id} wide>
            {(id, d) => <Select id={id} aria-describedby={d} aria-invalid={inv('event_type_id')} value={f.event_type_id}
              onChange={(v) => set('event_type_id', v)} options={(types.data ?? []).map((t) => ({ value: t.id, label: t.name }))} />}
          </Field>
          <Field label="Date" hint="The first day, if it runs longer">
            {(id, d) => <DateInput id={id} aria-describedby={d} value={f.event_date} onChange={(v) => set('event_date', v)} />}
          </Field>
          <Field label="Duration">
            {(id) => <Select id={id} value={f.duration} onChange={(v) => set('duration', v)}
              options={(durations.data ?? []).map((x) => ({ value: x.code, label: x.label }))} />}
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
