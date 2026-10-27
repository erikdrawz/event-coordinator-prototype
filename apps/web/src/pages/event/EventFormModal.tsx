import { useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { supabase } from '../../lib/supabase';
import { useAuth } from '../../lib/auth';
import { Modal } from '../../ui/Modal';
import { ChipPicker, Field, FormSection } from '../../ui/Form';
import { CustomFieldInput } from './CustomFieldInput';
import {
  addMinutesLocal, emptyForm, EVENT_RECORD_SELECT, fieldsForType, formFromRecord, sectionTitle, TIME_ZONES,
  toPayload, useEventFormOptions, validate, type CustomFieldDef, type EventFormState, type EventRecord,
} from './eventForm';

const CURRENCIES = ['EUR', 'GBP', 'USD', 'CHF', 'DKK', 'NOK', 'SEK', 'PLN'];

/** New event (eventId undefined) or Edit event. Loads what it needs, then shows the form. */
export function EventFormModal({ eventId, onClose }: { eventId?: string; onClose: () => void }) {
  const options = useEventFormOptions();
  const record = useQuery({
    queryKey: ['event-record', eventId],
    enabled: Boolean(eventId),
    queryFn: async () => {
      const { data, error } = await supabase.from('event').select(EVENT_RECORD_SELECT).eq('id', eventId!).single();
      if (error) throw error;
      return data as unknown as EventRecord;
    },
  });

  const title = eventId ? 'Edit event' : 'New event';
  const loadError = options.error ?? record.error;
  if (loadError || !options.data || (eventId && !record.data)) {
    return (
      <Modal open title={title} onClose={onClose}>
        {loadError ? <div className="form-error">Couldn't load the form: {loadError.message}</div> : <div className="text-muted">Loading…</div>}
      </Modal>
    );
  }
  return <EventForm eventId={eventId} record={record.data} options={options.data} onClose={onClose} title={title} />;
}

type Options = NonNullable<ReturnType<typeof useEventFormOptions>['data']>;

function EventForm({ eventId, record, options, onClose, title }:
  { eventId?: string; record?: EventRecord; options: Options; onClose: () => void; title: string }) {
  const { me } = useAuth();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const initial = useMemo(() => (record ? formFromRecord(record) : emptyForm(me!.id)), [record, me]);
  const [f, setF] = useState<EventFormState>(initial);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [tzTouched, setTzTouched] = useState(Boolean(record));
  const bodyRef = useRef<HTMLFormElement>(null);

  const sections = useMemo(() => (f.event_type_id ? fieldsForType(options.fields, f.event_type_id) : new Map<string, CustomFieldDef[]>()), [options.fields, f.event_type_id]);
  const shown = useMemo(() => [...sections.values()].flat(), [sections]);
  const dirty = JSON.stringify(f) !== JSON.stringify(initial);

  const set = <K extends keyof EventFormState>(k: K, v: EventFormState[K]) => {
    setF((prev) => ({ ...prev, [k]: v }));
    if (errors[k as string]) setErrors(({ [k as string]: _, ...rest }) => rest);
  };
  const setCustom = (api: string, v: unknown) => {
    setF((prev) => ({ ...prev, custom: { ...prev.custom, [api]: v } }));
    if (errors[api]) setErrors(({ [api]: _, ...rest }) => rest);
  };

  const pickCountry = (code: string) => {
    setF((prev) => {
      const tz = options.countries.find((c) => c.code === code)?.default_timezone;
      return { ...prev, country_code: code, timezone: !tzTouched && tz ? tz : prev.timezone };
    });
  };
  // A new start fills in the end from the event type's usual length
  const pickStart = (v: string) => {
    setF((prev) => {
      const mins = options.types.find((t) => t.id === prev.event_type_id)?.default_duration_minutes;
      const endStale = !prev.ends_local || prev.ends_local <= v;
      return { ...prev, starts_local: v, ends_local: v && mins && endStale ? addMinutesLocal(v, mins) : prev.ends_local };
    });
  };

  const save = useMutation({
    mutationFn: async () => {
      const p = toPayload(f, shown);
      const res = eventId
        ? await supabase.rpc('update_event', { p_event_id: eventId, p })
        : await supabase.rpc('create_event', { p });
      if (res.error) throw new Error(res.error.message);
      return res.data as { id: string };
    },
    onSuccess: (e) => {
      qc.invalidateQueries({ queryKey: ['events'] });
      qc.invalidateQueries({ queryKey: ['home'] });
      qc.invalidateQueries({ queryKey: ['event', e.id] });
      qc.invalidateQueries({ queryKey: ['event-record', e.id] });
      onClose();
      if (!eventId) navigate(`/events/${e.id}`);
    },
    onError: () => bodyRef.current?.closest('.modal-body')?.scrollTo({ top: 0, behavior: 'smooth' }),
  });

  const submit = (ev: React.FormEvent) => {
    ev.preventDefault();
    const errs = validate(f, shown);
    setErrors(errs);
    if (Object.keys(errs).length) {
      // Focus the first field with a problem
      setTimeout(() => bodyRef.current?.querySelector<HTMLElement>('[aria-invalid="true"]')?.focus(), 0);
      return;
    }
    save.mutate();
  };

  const err = (k: string) => errors[k];
  const inv = (k: string) => (errors[k] ? true : undefined);
  const areaProducts = options.products.filter((p) => !f.therapeutic_area_id || p.therapeutic_area_id === f.therapeutic_area_id
    || f.product_ids.includes(p.id));

  return (
    <Modal open size="lg" title={title} onClose={onClose}
      confirmClose={dirty && !save.isPending ? 'Discard your changes to this event?' : false}
      footerNote={<><span className="field-required">*</span> Required</>}
      footer={<>
        <button type="button" className="btn" onClick={onClose} disabled={save.isPending}>Cancel</button>
        <button type="submit" form="event-form" className="btn btn-primary" disabled={save.isPending}>
          {save.isPending ? 'Saving…' : eventId ? 'Save changes' : 'Create event'}
        </button>
      </>}>
      <form id="event-form" ref={bodyRef} className="form" onSubmit={submit} noValidate>
        {save.error && <div className="form-error" role="alert" style={{ marginBottom: 16 }}>{save.error.message}</div>}

        <FormSection title="Event">
          <Field label="Event name" required error={err('name')} wide>
            {(id, d) => <input id={id} aria-describedby={d} aria-invalid={inv('name')} className="input" value={f.name}
              onChange={(e) => set('name', e.target.value)} placeholder="e.g. Nordic SMA Advisory Board" autoFocus={!eventId} />}
          </Field>
          <Field label="Event type" required error={err('event_type_id')}>
            {(id, d) => (
              <select id={id} aria-describedby={d} aria-invalid={inv('event_type_id')} className="input" value={f.event_type_id}
                onChange={(e) => set('event_type_id', e.target.value)}>
                <option value="">Choose…</option>
                {options.types.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
              </select>
            )}
          </Field>
          <Field label="Owner">
            {(id) => (
              <select id={id} className="input" value={f.owner_id} onChange={(e) => set('owner_id', e.target.value)}>
                {options.users.map((u) => <option key={u.id} value={u.id}>{u.display_name}</option>)}
              </select>
            )}
          </Field>
          <Field label="Therapeutic area">
            {(id) => (
              <select id={id} className="input" value={f.therapeutic_area_id} onChange={(e) => set('therapeutic_area_id', e.target.value)}>
                <option value="">None</option>
                {options.areas.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
              </select>
            )}
          </Field>
          <Field label="Products" wide hint={areaProducts.length ? null : 'No products in this therapeutic area.'}>
            {() => <ChipPicker label="Products" value={f.product_ids} onChange={(v) => set('product_ids', v)}
              options={areaProducts.map((p) => ({ value: p.id, label: p.name }))} />}
          </Field>
        </FormSection>

        <FormSection title="When and where">
          <Field label="Country">
            {(id) => (
              <select id={id} className="input" value={f.country_code} onChange={(e) => pickCountry(e.target.value)}>
                <option value="">Choose…</option>
                {options.countries.map((c) => <option key={c.code} value={c.code}>{c.name}</option>)}
              </select>
            )}
          </Field>
          <Field label="City">
            {(id) => <input id={id} className="input" value={f.city} onChange={(e) => set('city', e.target.value)} />}
          </Field>
          <Field label="Venue">
            {(id) => <input id={id} className="input" value={f.venue_name} onChange={(e) => set('venue_name', e.target.value)} placeholder="e.g. Copenhagen Marriott Hotel" />}
          </Field>
          <Field label="Venue address">
            {(id) => <input id={id} className="input" value={f.venue_address} onChange={(e) => set('venue_address', e.target.value)} />}
          </Field>
          <Field label="Starts" hint="Local time at the event">
            {(id, d) => <input id={id} aria-describedby={d} type="datetime-local" className="input" value={f.starts_local} onChange={(e) => pickStart(e.target.value)} />}
          </Field>
          <Field label="Ends" error={err('ends_local')}>
            {(id, d) => <input id={id} aria-describedby={d} aria-invalid={inv('ends_local')} type="datetime-local" className="input"
              value={f.ends_local} min={f.starts_local || undefined} onChange={(e) => set('ends_local', e.target.value)} />}
          </Field>
          <Field label="Time zone" wide hint={tzTouched ? null : 'Follows the country until you change it.'}>
            {(id, d) => (
              <select id={id} aria-describedby={d} className="input" value={f.timezone}
                onChange={(e) => { setTzTouched(true); set('timezone', e.target.value); }}>
                {(TIME_ZONES.includes(f.timezone) ? TIME_ZONES : [f.timezone, ...TIME_ZONES]).map((z) => <option key={z} value={z}>{z.replace(/_/g, ' ')}</option>)}
              </select>
            )}
          </Field>
        </FormSection>

        <FormSection title="Planning">
          <Field label="Expected attendees">
            {(id) => <input id={id} type="number" min={0} className="input" value={f.expected_attendees} onChange={(e) => set('expected_attendees', e.target.value)} />}
          </Field>
          <Field label="Estimated spend">
            {(id) => (
              <div className="input-group">
                <input id={id} type="number" min={0} step="any" className="input" value={f.estimated_spend} onChange={(e) => set('estimated_spend', e.target.value)} />
                <select aria-label="Currency" className="input" value={f.currency} onChange={(e) => set('currency', e.target.value)}>
                  {CURRENCIES.map((c) => <option key={c}>{c}</option>)}
                </select>
              </div>
            )}
          </Field>
          <Field label="Description" wide>
            {(id) => <textarea id={id} className="input" rows={3} value={f.description} onChange={(e) => set('description', e.target.value)}
              placeholder="Purpose, audience and anything the team should know" />}
          </Field>
        </FormSection>

        {[...sections].map(([section, defs]) => (
          <FormSection key={section} title={sectionTitle(section)}>
            {defs.map((d) => <CustomFieldInput key={d.id} def={d} value={f.custom[d.api_name]} error={err(d.api_name)}
              users={options.users} onChange={(v) => setCustom(d.api_name, v)} />)}
          </FormSection>
        ))}
        {!f.event_type_id && options.fields.length > 0 && (
          <p className="field-hint">Choose an event type to see the fields that apply to it.</p>
        )}
      </form>
    </Modal>
  );
}
