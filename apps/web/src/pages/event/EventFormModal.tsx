import { useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { supabase } from '../../lib/supabase';
import { useAuth } from '../../lib/auth';
import { Modal } from '../../ui/Modal';
import { ChipPicker, Field, FormSection } from '../../ui/Form';
import { Select } from '../../ui/Select';
import { DateTimeInput } from '../../ui/DateInput';
import { CustomFieldInput } from './CustomFieldInput';
import {
  addMinutesLocal, allowedFor, creationScope, emptyForm, EVENT_RECORD_SELECT, fieldsForType, formFromRecord, sectionTitle, TIME_ZONES,
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
  const scope = useMemo(() => creationScope(me!, options), [me, options]);
  const initial = useMemo(() => (record ? formFromRecord(record)
    : emptyForm(me!.id, scope.home, options.countries.find((c) => c.code === scope.home)?.default_timezone ?? null)), [record, me, scope, options.countries]);
  const [f, setF] = useState<EventFormState>(initial);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [tzTouched, setTzTouched] = useState(Boolean(record));
  const bodyRef = useRef<HTMLFormElement>(null);

  const sections = useMemo(() => (f.event_type_id ? fieldsForType(options.fields, f.event_type_id) : new Map<string, CustomFieldDef[]>()), [options.fields, f.event_type_id]);
  const shown = useMemo(() => [...sections.values()].flat(), [sections]);
  const dirty = JSON.stringify(f) !== JSON.stringify(initial);
  const zoneOptions = useMemo(() => (TIME_ZONES.includes(f.timezone) ? TIME_ZONES : [f.timezone, ...TIME_ZONES])
    .map((z) => ({ value: z, label: z.replace(/_/g, ' ') })), [f.timezone]);

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
  const type = options.types.find((t) => t.id === f.event_type_id);
  const typeAreas = type?.event_type_therapeutic_area.map((a) => a.therapeutic_area_id) ?? [];
  const typeProducts = type?.event_type_product.map((p) => p.product_id) ?? [];

  // A new type keeps only the country, area and products it allows
  const pickType = (typeId: string) => {
    setF((prev) => {
      const t = options.types.find((x) => x.id === typeId);
      const areas = t?.event_type_therapeutic_area.map((a) => a.therapeutic_area_id) ?? [];
      const prods = t?.event_type_product.map((p) => p.product_id) ?? [];
      const countryOk = scope.countriesFor(typeId).some((c) => c.code === prev.country_code);
      return {
        ...prev, event_type_id: typeId,
        country_code: countryOk || eventId ? prev.country_code : '',
        therapeutic_area_id: !areas.length || areas.includes(prev.therapeutic_area_id) ? prev.therapeutic_area_id : '',
        product_ids: prods.length ? prev.product_ids.filter((p) => prods.includes(p)) : prev.product_ids,
      };
    });
    setErrors(({ event_type_id: _, ...rest }) => rest);
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
  const typeOptions = scope.types.some((t) => t.id === f.event_type_id) || !type ? scope.types : [type, ...scope.types];
  const countryOptions = scope.countriesFor(f.event_type_id);
  const currentCountry = options.countries.find((c) => c.code === f.country_code);
  if (currentCountry && !countryOptions.includes(currentCountry)) countryOptions.unshift(currentCountry);  // an existing event elsewhere
  const areaOptions = allowedFor(options.areas, typeAreas, [f.therapeutic_area_id]);
  const areaProducts = allowedFor(options.products, typeProducts, f.product_ids)
    .filter((p) => !f.therapeutic_area_id || p.therapeutic_area_id === f.therapeutic_area_id || f.product_ids.includes(p.id));

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
              <Select id={id} aria-describedby={d} aria-invalid={inv('event_type_id')} value={f.event_type_id}
                onChange={pickType} options={typeOptions.map((t) => ({ value: t.id, label: t.name }))} />
            )}
          </Field>
          <Field label="Owner">
            {(id) => (
              <Select id={id} value={f.owner_id} onChange={(v) => set('owner_id', v)} searchable
                options={options.users.map((u) => ({ value: u.id, label: u.display_name }))} />
            )}
          </Field>
          <Field label="Therapeutic area">
            {(id) => (
              <Select id={id} value={f.therapeutic_area_id} onChange={(v) => set('therapeutic_area_id', v)} emptyLabel="None"
                options={areaOptions.map((a) => ({ value: a.id, label: a.name }))} />
            )}
          </Field>
          <Field label="Products" wide hint={areaProducts.length ? null : 'No products available for this event type and area.'}>
            {() => <ChipPicker label="Products" value={f.product_ids} onChange={(v) => set('product_ids', v)}
              options={areaProducts.map((p) => ({ value: p.id, label: p.name }))} />}
          </Field>
        </FormSection>

        <FormSection title="When and where">
          <Field label="Country" required error={err('country_code')}
            hint={f.event_type_id && countryOptions.length === 0 ? `${type?.name} events aren't available in any of your countries.`
              : !f.event_type_id ? 'Countries you can create events in.' : null}>
            {(id, d) => (
              <Select id={id} aria-describedby={d} aria-invalid={inv('country_code')} value={f.country_code}
                onChange={(v) => { pickCountry(v); setErrors(({ country_code: _, ...rest }) => rest); }}
                options={countryOptions.map((c) => ({ value: c.code, label: c.name }))} />
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
            {(id, d) => <DateTimeInput id={id} aria-describedby={d} value={f.starts_local} onChange={pickStart} />}
          </Field>
          <Field label="Ends" error={err('ends_local')}>
            {(id, d) => <DateTimeInput id={id} aria-describedby={d} aria-invalid={inv('ends_local')} value={f.ends_local}
              min={f.starts_local || undefined} defaultTime={f.starts_local.slice(11) || '09:00'} onChange={(v) => set('ends_local', v)} />}
          </Field>
          <Field label="Time zone" wide hint={tzTouched ? null : 'Follows the country until you change it.'}>
            {(id, d) => (
              <Select id={id} aria-describedby={d} value={f.timezone} options={zoneOptions}
                onChange={(v) => { setTzTouched(true); set('timezone', v); }} />
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
                <Select aria-label="Currency" value={f.currency} onChange={(v) => set('currency', v)}
                  options={CURRENCIES.map((c) => ({ value: c, label: c }))} />
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
