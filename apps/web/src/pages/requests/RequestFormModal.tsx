import { useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { supabase } from '../../lib/supabase';
import { ymdInZone } from '../../lib/format';
import { Modal } from '../../ui/Modal';
import { Field, FormSection } from '../../ui/Form';
import { Select } from '../../ui/Select';
import { DateInput, formatDate } from '../../ui/DateInput';
import { useEligibilities, useExpertDirectory } from '../experts/expertsData';
import { useRequestDurations, useRequestEvents, useRequestKinds, useRequestTypes, type RequestKind, type RequestRow } from './requestData';
import '../contracts/contracts.css';

interface FormState {
  request_type: RequestKind; title: string; event_type_id: string; event_date: string; duration: string; rationale: string;
  hcp_id: string; related_event_id: string;
}

/** A tiering request logged from an event: the expert and the event are given. */
export interface TieringPreset { hcp: { id: string; name: string }; event: { id: string; name: string } }

/**
 * New request (event or tiering; `tiering` fixes the kind, expert and event when logged from an
 * event's Experts) or Edit request (drafts only).
 */
export function RequestFormModal({ request, tiering, onClose }: { request?: RequestRow; tiering?: TieringPreset; onClose: () => void }) {
  const navigate = useNavigate();
  const qc = useQueryClient();
  const kinds = useRequestKinds();
  const initial = useMemo<FormState>(() => ({
    request_type: request?.request_type ?? (tiering ? 'tiering' : 'event'),
    title: request?.title ?? '', event_type_id: request?.event_type_id ?? '', event_date: request?.event_date ?? '',
    duration: request?.duration ?? '', rationale: request?.rationale ?? '',
    hcp_id: request?.hcp_id ?? tiering?.hcp.id ?? '', related_event_id: request?.related_event_id ?? tiering?.event.id ?? '',
  }), [request, tiering]);
  const [f, setF] = useState(initial);
  const isTiering = f.request_type === 'tiering';
  const types = useRequestTypes();
  const durations = useRequestDurations();
  const experts = useExpertDirectory();
  const eligibilities = useEligibilities();
  const events = useRequestEvents(isTiering && !tiering);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const formRef = useRef<HTMLFormElement>(null);
  const dirty = JSON.stringify(f) !== JSON.stringify(initial);

  const set = <K extends keyof FormState>(k: K, v: FormState[K]) => {
    setF((prev) => ({ ...prev, [k]: v }));
    if (errors[k]) setErrors(({ [k]: _, ...rest }) => rest);
  };

  const save = useMutation({
    mutationFn: async () => {
      const fields = isTiering
        ? { hcp_id: f.hcp_id, related_event_id: f.related_event_id, rationale: f.rationale.trim() }
        : { title: f.title.trim(), event_type_id: f.event_type_id, event_date: f.event_date, duration: f.duration, rationale: f.rationale.trim() };
      const { data, error } = await supabase.rpc('save_request', {
        p: { ...(request ? { id: request.id } : { request_type: f.request_type }), ...fields },
      });
      if (error) throw new Error(error.message);
      return data as { id: string };
    },
    onSuccess: (r) => {
      qc.invalidateQueries({ queryKey: ['requests'] });
      qc.invalidateQueries({ queryKey: ['request', r.id] });
      qc.invalidateQueries({ queryKey: ['home'] });
      qc.invalidateQueries({ queryKey: ['tiering-requests'] });
      onClose();
      if (!request) navigate(`/requests/${r.id}`);
    },
  });

  const submit = (ev: React.FormEvent) => {
    ev.preventDefault();
    const errs: Record<string, string> = {};
    if (isTiering) {
      if (!f.hcp_id) errs.hcp_id = 'Choose the expert';
    } else {
      if (!f.title.trim()) errs.title = 'Give the request a name';
      if (!f.event_type_id) errs.event_type_id = 'Choose an event type';
    }
    setErrors(errs);
    if (Object.keys(errs).length) {
      setTimeout(() => formRef.current?.querySelector<HTMLElement>('[aria-invalid="true"]')?.focus(), 0);
      return;
    }
    save.mutate();
  };
  const inv = (k: string) => (errors[k] ? true : undefined);
  const loadError = (isTiering ? experts.error ?? events.error : types.error ?? durations.error) ?? kinds.error;
  const eligibilityLabel = (code: string) => eligibilities.data?.find((e) => e.code === code)?.label ?? code;
  const chosenExpert = experts.data?.find((x) => x.id === f.hcp_id);
  // Experts who aren't eligible first: they're the usual reason for a tiering request
  const expertOptions = useMemo(() => [...(experts.data ?? [])]
    .sort((a, b) => Number(a.eligibility === 'eligible') - Number(b.eligibility === 'eligible') || a.last_name.localeCompare(b.last_name))
    .map((x) => ({ value: x.id, label: `${x.display_name} · ${eligibilityLabel(x.eligibility)}` })), [experts.data, eligibilities.data]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <Modal open title={request ? 'Edit request' : tiering ? 'New tiering request' : 'New request'} onClose={onClose}
      confirmClose={dirty && !save.isPending ? 'Discard your changes to this request?' : false}
      footerNote={<><span className="field-required">*</span> Required to save. {isTiering ? 'The business justification is needed to submit.' : 'Date, duration and justification are needed to submit.'}</>}
      footer={<>
        <button type="button" className="btn" onClick={onClose} disabled={save.isPending}>Cancel</button>
        <button type="submit" form="request-form" className="btn btn-primary" disabled={save.isPending || (isTiering ? !experts.data : !types.data)}>
          {save.isPending ? 'Saving…' : request ? 'Save changes' : 'Save draft'}
        </button>
      </>}>
      <form id="request-form" ref={formRef} className="form" onSubmit={submit} noValidate>
        {(save.error || loadError) && <div className="form-error" role="alert" style={{ marginBottom: 16 }}>{(save.error ?? loadError)!.message}</div>}
        <FormSection>
          {!request && !tiering && (
            <div className="field field-wide" role="radiogroup" aria-label="Kind of request">
              <span className="field-label">Kind of request</span>
              <div className="type-choices type-choices-row">
                {(kinds.data ?? []).map((k) => (
                  <label key={k.code} className={`type-choice${f.request_type === k.code ? ' selected' : ''}`}>
                    <input type="radio" name="request-kind" value={k.code} checked={f.request_type === k.code} onChange={() => { set('request_type', k.code); setErrors({}); }} />
                    <span><strong>{k.label}</strong><span className="dt-sub">{k.description}</span></span>
                  </label>
                ))}
              </div>
            </div>
          )}

          {isTiering ? <>
            <Field label="Expert" required error={errors.hcp_id} wide
              hint={chosenExpert ? [eligibilityLabel(chosenExpert.eligibility), chosenExpert.tier, chosenExpert.eligibility_note].filter(Boolean).join(' · ') : undefined}>
              {(id, d) => tiering
                ? <div id={id} className="input input-static">{tiering.hcp.name}</div>
                : <Select id={id} aria-describedby={d} aria-invalid={inv('hcp_id')} value={f.hcp_id} searchable placeholder="Choose an expert"
                    onChange={(v) => set('hcp_id', v)} options={expertOptions} />}
            </Field>
            <Field label="Event" wide hint={tiering ? 'The event the expert is needed for' : 'Optional: the event the expert is needed for'}>
              {(id, d) => tiering
                ? <div id={id} className="input input-static">{tiering.event.name}</div>
                : <Select id={id} aria-describedby={d} value={f.related_event_id} searchable emptyLabel="No event" placeholder="No event"
                    onChange={(v) => set('related_event_id', v)}
                    options={(events.data ?? []).map((e) => ({ value: e.id, label: e.starts_at ? `${e.name} · ${formatDate(ymdInZone(e.starts_at, e.timezone))}` : e.name }))} />}
            </Field>
          </> : <>
            <Field label="Name" required error={errors.title} wide>
              {(id, d) => <input id={id} aria-describedby={d} aria-invalid={inv('title')} className="input" value={f.title}
                onChange={(e) => set('title', e.target.value)} placeholder="e.g. Nordic SMA Advisory Board" autoFocus={Boolean(request)} />}
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
          </>}

          <Field label="Business justification" wide hint={isTiering
            ? "Why this expert is needed, and what should be reviewed: their tier, an annual cap, an open check."
            : 'Why this event is needed: the medical or business need, the audience and the expected outcome.'}>
            {(id, d) => <textarea id={id} aria-describedby={d} className="input" rows={5} value={f.rationale} autoFocus={Boolean(tiering)}
              onChange={(e) => set('rationale', e.target.value)} />}
          </Field>
        </FormSection>
      </form>
    </Modal>
  );
}
