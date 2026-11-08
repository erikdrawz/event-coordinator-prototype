import { useState } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { supabase } from '../lib/supabase';
import { CustomFieldInput } from '../pages/event/CustomFieldInput';
import { customValue } from '../pages/event/EventDetailsTab';
import type { CustomFieldDef } from '../pages/event/eventForm';
import { usePeople } from '../pages/event/team/teamData';
import { PanelField } from '../ui/SidePanel';
import './custom-fields.css';

/** The objects custom fields extend (custom_field_object). Events use their own form; these helpers serve the rest. */
export type CustomObject = 'event' | 'event_request' | 'hcp' | 'hco' | 'event_attendee' | 'event_expert';
export type CustomValues = Record<string, unknown>;

/** Active custom field definitions for an object, in creation order (the order they're shown in). */
export function useCustomFieldDefs(object: CustomObject) {
  return useQuery({
    queryKey: ['custom-fields', object], staleTime: 5 * 60_000,
    queryFn: async () => {
      const { data, error } = await supabase.from('custom_field')
        .select('id,api_name,label,field_type,options,is_required,help_text,decimals,created_at,custom_field_layout(event_type_id)')
        .eq('object_name', object).eq('is_active', true).order('created_at');
      if (error) throw new Error(error.message);
      return data as CustomFieldDef[];
    },
  });
}

/** An event's type, for records that hang off an event (attendees, experts on it). */
export function useEventTypeOf(eventId: string) {
  return useQuery({
    queryKey: ['event', eventId, 'type'], staleTime: 5 * 60_000,
    queryFn: async () => {
      const { data, error } = await supabase.from('event').select('event_type_id').eq('id', eventId).single();
      if (error) throw new Error(error.message);
      return (data as { event_type_id: string | null }).event_type_id;
    },
  });
}

/** The fields shown for a record: those on every event type, plus its own type's (none for experts and HCOs). */
export const fieldsFor = (defs: CustomFieldDef[] | undefined, typeId: string | null) =>
  (defs ?? []).filter((d) => d.custom_field_layout.some((l) => l.event_type_id === null || (typeId != null && l.event_type_id === typeId)));

const isEmpty = (v: unknown) => v == null || v === '' || (Array.isArray(v) && v.length === 0);

/** Values to save: the shown fields, empty ones as null (the database drops them). Other fields keep theirs. */
export const customPayload = (shown: CustomFieldDef[], values: CustomValues): CustomValues =>
  ({ ...values, ...Object.fromEntries(shown.map((d) => [d.api_name, isEmpty(values[d.api_name]) ? null : values[d.api_name]])) });

/** The inputs for a form (modals): one per shown field. */
export function CustomFieldInputs({ shown, values, onChange }: { shown: CustomFieldDef[]; values: CustomValues; onChange: (v: CustomValues) => void }) {
  const people = usePeople(shown.some((d) => d.field_type === 'lookup_user'));
  return <>{shown.map((d) => (
    <CustomFieldInput key={d.id} def={d} value={values[d.api_name]} users={people.data ?? []}
      onChange={(v) => onChange({ ...values, [d.api_name]: v })} />
  ))}</>;
}

/** Read-only rows, e.g. on a record's details card. */
export function useCustomRows(object: CustomObject, typeId: string | null, values: CustomValues | undefined) {
  const defs = useCustomFieldDefs(object);
  const shown = fieldsFor(defs.data, typeId);
  const people = usePeople(shown.some((d) => d.field_type === 'lookup_user'));
  return shown.map((d) => ({ def: d, value: customValue(d, values?.[d.api_name], people.data ?? []) }));
}

/**
 * The custom fields of a record in a SidePanel (an attendee, an expert on an event): their values,
 * and for people who can edit, an Edit that turns them into inputs saved together.
 */
export function CustomFieldsPanel({ object, typeId, values, canEdit, onSave }: {
  object: CustomObject; typeId: string | null; values: CustomValues; canEdit: boolean; onSave: (v: CustomValues) => Promise<unknown>;
}) {
  const defs = useCustomFieldDefs(object);
  const shown = fieldsFor(defs.data, typeId);
  const rows = useCustomRows(object, typeId, values);
  const [draft, setDraft] = useState<CustomValues | null>(null);
  const save = useMutation({ mutationFn: (v: CustomValues) => onSave(customPayload(shown, v)), onSuccess: () => setDraft(null) });
  if (!shown.length) return null;
  return (
    <section className="sp-section">
      <div className="cf-panel-head">
        <h3 className="sp-section-title">Additional details</h3>
        {canEdit && !draft && <button type="button" className="link" onClick={() => { save.reset(); setDraft({ ...values }); }}>Edit</button>}
      </div>
      {draft ? (
        <div className="form cf-panel-form">
          <CustomFieldInputs shown={shown} values={draft} onChange={setDraft} />
          {save.error && <div className="form-error" role="alert">{save.error.message}</div>}
          <div className="cf-panel-actions">
            <button type="button" className="btn btn-sm" onClick={() => setDraft(null)}>Cancel</button>
            <button type="button" className="btn btn-primary btn-sm" disabled={save.isPending} onClick={() => save.mutate(draft)}>{save.isPending ? 'Saving…' : 'Save'}</button>
          </div>
        </div>
      ) : (
        <dl className="sp-fields">{rows.map((r) => <PanelField key={r.def.id} label={r.def.label}>{r.value}</PanelField>)}</dl>
      )}
    </section>
  );
}
