import { useMemo, useRef, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { supabase } from '../../lib/supabase';
import { Modal } from '../../ui/Modal';
import { Field, FormSection } from '../../ui/Form';
import { Select } from '../../ui/Select';
import { useCountries } from '../admin/adminData';
import { useEligibilities, useExpertFormOptions, type ExpertRow } from './expertsData';

interface FormState {
  salutation: string; first_name: string; last_name: string; email: string;
  specialty_id: string; tier: string; primary_hco_id: string; city: string; country_code: string;
  eligibility: string; eligibility_note: string; onekey_id: string;
}

const TIERS = ['Tier 1', 'Tier 2', 'Tier 3', 'Tier 4'].map((t) => ({ value: t, label: t }));
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Edit expert: the HCP record as Event Center holds it. FMV rates and contracts are kept apart. */
export function ExpertFormModal({ expert: x, onClose }: { expert: ExpertRow; onClose: () => void }) {
  const qc = useQueryClient();
  const options = useExpertFormOptions();
  const countries = useCountries();
  const eligibilities = useEligibilities();
  const initial = useMemo<FormState>(() => ({
    salutation: x.salutation ?? '', first_name: x.first_name, last_name: x.last_name, email: x.email ?? '',
    specialty_id: x.specialty_id ?? '', tier: x.tier ?? '', primary_hco_id: x.primary_hco_id ?? '', city: x.city ?? '',
    country_code: x.country_code ?? '', eligibility: x.eligibility, eligibility_note: x.eligibility_note ?? '', onekey_id: x.onekey_id ?? '',
  }), [x]);
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
      const blank = (v: string) => v.trim() || null;
      const { error } = await supabase.from('hcp').update({
        salutation: blank(f.salutation), first_name: f.first_name.trim(), last_name: f.last_name.trim(), email: blank(f.email),
        specialty_id: f.specialty_id || null, tier: f.tier || null, primary_hco_id: f.primary_hco_id || null, city: blank(f.city),
        country_code: f.country_code || null, eligibility: f.eligibility, eligibility_note: blank(f.eligibility_note), onekey_id: blank(f.onekey_id),
      }).eq('id', x.id).select('id').single();
      if (error) throw new Error(error.code === 'PGRST116' ? "You don't have permission to edit this expert." : error.message);
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['expert', x.id] });
      qc.invalidateQueries({ queryKey: ['experts'] });
      onClose();
    },
  });

  const submit = (ev: React.FormEvent) => {
    ev.preventDefault();
    const errs: Record<string, string> = {};
    if (!f.first_name.trim()) errs.first_name = 'Enter a first name';
    if (!f.last_name.trim()) errs.last_name = 'Enter a last name';
    if (f.email.trim() && !EMAIL.test(f.email.trim())) errs.email = 'Enter an email address like name@hospital.org';
    setErrors(errs);
    if (Object.keys(errs).length) {
      setTimeout(() => formRef.current?.querySelector<HTMLElement>('[aria-invalid="true"]')?.focus(), 0);
      return;
    }
    save.mutate();
  };
  const inv = (k: string) => (errors[k] ? true : undefined);
  const loadError = options.error ?? countries.error ?? eligibilities.error;
  const ready = Boolean(options.data && countries.data && eligibilities.data);

  return (
    <Modal open title="Edit expert" onClose={onClose}
      confirmClose={dirty && !save.isPending ? 'Discard your changes to this expert?' : false}
      footerNote={x.crm_connection
        ? <>Changes stay in Event Center; the record in {x.crm_connection.name} isn't updated.</>
        : <><span className="field-required">*</span> Required</>}
      footer={<>
        <button type="button" className="btn" onClick={onClose} disabled={save.isPending}>Cancel</button>
        <button type="submit" form="expert-form" className="btn btn-primary" disabled={save.isPending || !ready || !dirty}>
          {save.isPending ? 'Saving…' : 'Save changes'}
        </button>
      </>}>
      <form id="expert-form" ref={formRef} className="form" onSubmit={submit} noValidate>
        {(save.error || loadError) && <div className="form-error" role="alert" style={{ marginBottom: 16 }}>{(save.error ?? loadError)!.message}</div>}
        <FormSection title="Expert">
          <Field label="First name" required error={errors.first_name}>
            {(id, d) => <input id={id} aria-describedby={d} aria-invalid={inv('first_name')} className="input" value={f.first_name}
              onChange={(e) => set('first_name', e.target.value)} autoFocus />}
          </Field>
          <Field label="Last name" required error={errors.last_name}>
            {(id, d) => <input id={id} aria-describedby={d} aria-invalid={inv('last_name')} className="input" value={f.last_name}
              onChange={(e) => set('last_name', e.target.value)} />}
          </Field>
          <Field label="Title" hint="Shown before the name, e.g. Dr or Prof">
            {(id, d) => <input id={id} aria-describedby={d} className="input" value={f.salutation} onChange={(e) => set('salutation', e.target.value)} />}
          </Field>
          <Field label="Email" error={errors.email}>
            {(id, d) => <input id={id} type="email" aria-describedby={d} aria-invalid={inv('email')} className="input" value={f.email}
              onChange={(e) => set('email', e.target.value)} />}
          </Field>
          <Field label="Specialty">
            {(id) => <Select id={id} value={f.specialty_id} onChange={(v) => set('specialty_id', v)} emptyLabel="None"
              options={(options.data?.specialties ?? []).map((s) => ({ value: s.id, label: s.name }))} />}
          </Field>
          <Field label="Tier">
            {(id) => <Select id={id} value={f.tier} onChange={(v) => set('tier', v)} emptyLabel="None" options={TIERS} />}
          </Field>
          <Field label="Organisation" wide>
            {(id) => <Select id={id} value={f.primary_hco_id} onChange={(v) => set('primary_hco_id', v)} emptyLabel="None" searchable
              options={(options.data?.hcos ?? []).map((h) => ({ value: h.id, label: h.city ? `${h.name}, ${h.city}` : h.name }))} />}
          </Field>
          <Field label="City">
            {(id) => <input id={id} className="input" value={f.city} onChange={(e) => set('city', e.target.value)} />}
          </Field>
          <Field label="Country">
            {(id) => <Select id={id} value={f.country_code} onChange={(v) => set('country_code', v)} emptyLabel="None"
              options={(countries.data ?? []).map((c) => ({ value: c.code, label: c.name }))} />}
          </Field>
          <Field label="OneKey ID">
            {(id) => <input id={id} className="input" value={f.onekey_id} onChange={(e) => set('onekey_id', e.target.value)} />}
          </Field>
        </FormSection>
        <FormSection title="Eligibility">
          <Field label="Eligibility" hint="Events the expert joins from now on start with it; each event can still differ">
            {(id, d) => <Select id={id} aria-describedby={d} value={f.eligibility} onChange={(v) => set('eligibility', v)}
              options={(eligibilities.data ?? []).map((e) => ({ value: e.code, label: e.label }))} />}
          </Field>
          <Field label="Reason" wide hint="Why, when not simply eligible, e.g. annual cap reached or debarment check open. Shown on the expert page.">
            {(id, d) => <textarea id={id} aria-describedby={d} className="input" rows={3} value={f.eligibility_note}
              onChange={(e) => set('eligibility_note', e.target.value)} />}
          </Field>
        </FormSection>
      </form>
    </Modal>
  );
}
