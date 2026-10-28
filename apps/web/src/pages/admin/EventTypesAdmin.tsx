import { useMemo, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Plus } from 'lucide-react';
import { supabase } from '../../lib/supabase';
import { useAuth } from '../../lib/auth';
import { can } from '../../lib/permissions';
import { DataTable, useTableSort, type Column } from '../../ui/DataTable';
import { SearchInput, Toolbar } from '../../ui/Toolbar';
import { Modal } from '../../ui/Modal';
import { CheckboxField, Field, FormSection } from '../../ui/Form';
import { MultiSelect } from '../../ui/MultiSelect';
import { AdminPage } from './AdminLayout';
import { ADMIN_KEY, must, syncLinks, useContractTemplates, useCountries, useCustomFields, useEventTypes, type EventTypeRow } from './adminData';

function Codes({ values, all, allLabel }: { values: string[]; all?: boolean; allLabel: string }) {
  if (!values.length) return <span className="admin-all">{all ? allLabel : 'None'}</span>;
  return <span className="admin-codes">{values.slice(0, 8).map((v) => <span key={v} className="admin-code">{v}</span>)}
    {values.length > 8 && <span className="admin-all">+{values.length - 8}</span>}</span>;
}

export function EventTypesAdmin() {
  const { me } = useAuth();
  const types = useEventTypes();
  const fields = useCustomFields();
  const templates = useContractTemplates();
  const [q, setQ] = useState('');
  const [editing, setEditing] = useState<EventTypeRow | 'new' | null>(null);

  const columns = useMemo<Column<EventTypeRow>[]>(() => [
    { id: 'name', header: 'Event type', width: '22%', sortValue: (t) => t.name,
      cell: (t) => <><button className="dt-primary as-button" onClick={() => setEditing(t)}>{t.name}</button>
        {t.description && <div className="dt-sub">{t.description}</div>}</> },
    { id: 'countries', header: 'Countries', width: '26%', sortValue: (t) => t.event_type_country.length,
      cell: (t) => <Codes values={t.event_type_country.map((c) => c.country_code).sort()} allLabel="" /> },
    { id: 'fields', header: 'Event details fields', width: '19%',
      cell: (t) => {
        const names = (fields.data ?? []).filter((f) => f.is_active && f.custom_field_layout.some((l) => l.event_type_id === t.id || l.event_type_id === null)).map((f) => f.label);
        return <span className="dt-sub">{names.length ? names.join(', ') : 'None'}</span>;
      } },
    { id: 'templates', header: 'Contract templates', width: '21%',
      cell: (t) => {
        const names = (templates.data ?? []).filter((c) => t.event_type_contract_template.some((l) => l.contract_template_id === c.id)).map((c) => c.name);
        return <span className="dt-sub">{names.length ? names.join(', ') : 'None'}</span>;
      } },
    { id: 'active', header: 'Status', width: '12%', sortValue: (t) => (t.is_active ? 0 : 1),
      cell: (t) => <span className={`pill ${t.is_active ? 'pill-green' : 'pill-grey'}`}>{t.is_active ? 'Active' : 'Inactive'}</span> },
  ], [fields.data, templates.data]);

  const filtered = useMemo(() => types.data?.filter((t) => !q || t.name.toLowerCase().includes(q.toLowerCase())), [types.data, q]);
  const { rows, sort, setSort } = useTableSort(filtered, columns, { columnId: 'name', dir: 'asc' });
  const canEditType = can(me, 'event_type', 'edit');

  return (
    <AdminPage title="Event types" sub="What kinds of events people can create, and in which countries."
      action={can(me, 'event_type', 'create') && <button className="btn btn-primary" onClick={() => setEditing('new')}><Plus size={15} strokeWidth={2.6} />New event type</button>}
      readOnlyNote={!canEditType && 'Event types and their countries are managed by System Admins.'}>
      <Toolbar label="Filter event types"><SearchInput value={q} onChange={setQ} placeholder="Search event types" /></Toolbar>
      <DataTable label="Event types" columns={columns} rows={rows} rowKey={(t) => t.id} sort={sort} onSortChange={setSort}
        loading={types.isLoading} error={types.error} empty="No event types yet." />
      {editing && <EventTypeEditor type={editing === 'new' ? null : editing} onClose={() => setEditing(null)} />}
    </AdminPage>
  );
}

function EventTypeEditor({ type, onClose }: { type: EventTypeRow | null; onClose: () => void }) {
  const { me } = useAuth();
  const qc = useQueryClient();
  const countries = useCountries();
  const fields = useCustomFields();
  const templates = useContractTemplates();
  const beforeTemplates = type?.event_type_contract_template.map((l) => l.contract_template_id) ?? [];
  const [tplIds, setTplIds] = useState(beforeTemplates);
  // Fields shown on this type, oldest first. "All types" assignments (API-made) show as locked.
  const allTypes = (fields.data ?? []).filter((f) => f.custom_field_layout.some((l) => l.event_type_id === null));
  const beforeFields = (fields.data ?? []).filter((f) => type && f.custom_field_layout.some((l) => l.event_type_id === type.id)).map((f) => f.id);
  const [fieldIds, setFieldIds] = useState<string[] | null>(null);
  const chosenFields = fieldIds ?? beforeFields;
  const beforeCountries = type?.event_type_country.map((c) => c.country_code) ?? [];
  const [name, setName] = useState(type?.name ?? '');
  const [description, setDescription] = useState(type?.description ?? '');
  const [duration, setDuration] = useState(type?.default_duration_minutes?.toString() ?? '');
  const [active, setActive] = useState(type?.is_active ?? true);
  const [ctry, setCtry] = useState(beforeCountries);
  const [nameError, setNameError] = useState<string | null>(null);

  const canType = can(me, 'event_type', type ? 'edit' : 'create');
  const canCountries = can(me, 'event_type_country', 'create');
  const canFields = can(me, 'custom_field_layout', 'create');
  const canTemplates = can(me, 'event_type_contract_template', 'create');

  const save = useMutation({
    mutationFn: async () => {
      let id = type?.id;
      const row = { name: name.trim(), description: description.trim() || null,
        default_duration_minutes: duration ? Number(duration) : null, is_active: active };
      if (canType) {
        if (id) await must(supabase.from('event_type').update(row).eq('id', id));
        else id = (await must(supabase.from('event_type').insert(row).select('id').single()))!.id;
      }
      if (!id) return;
      if (canCountries) await syncLinks('event_type_country', 'event_type_id', id, 'country_code', beforeCountries, ctry);
      if (canFields && fieldIds) await syncLinks('custom_field_layout', 'event_type_id', id, 'custom_field_id', beforeFields, fieldIds);
      if (canTemplates) await syncLinks('event_type_contract_template', 'event_type_id', id, 'contract_template_id', beforeTemplates, tplIds);
    },
    onSuccess: () => { qc.invalidateQueries({ queryKey: [ADMIN_KEY] }); qc.invalidateQueries({ queryKey: ['event-form-options'] }); onClose(); },
  });

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    if (canType && !name.trim()) { setNameError('Give the event type a name'); return; }
    save.mutate();
  };

  return (
    <Modal open size="lg" title={type ? type.name : 'New event type'} onClose={onClose}
      footer={canType || canCountries || canFields || canTemplates ? <>
        <button type="button" className="btn" onClick={onClose}>Cancel</button>
        <button type="submit" form="event-type-form" className="btn btn-primary" disabled={save.isPending}>{save.isPending ? 'Saving…' : 'Save'}</button>
      </> : <button type="button" className="btn" onClick={onClose}>Close</button>}>
      <form id="event-type-form" className="form" onSubmit={submit} noValidate>
        {save.error && <div className="form-error" role="alert" style={{ marginBottom: 16 }}>{save.error.message}</div>}
        <FormSection title="Event type">
          <Field label="Name" required error={nameError} wide>
            {(id, d) => <input id={id} aria-describedby={d} aria-invalid={Boolean(nameError) || undefined} className="input" value={name}
              disabled={!canType} onChange={(e) => { setName(e.target.value); setNameError(null); }} autoFocus={!type} />}
          </Field>
          <Field label="Description" wide>
            {(id) => <input id={id} className="input" value={description} disabled={!canType} onChange={(e) => setDescription(e.target.value)} />}
          </Field>
          <Field label="Usual length (minutes)" hint="New events of this type get this end time by default.">
            {(id, d) => <input id={id} aria-describedby={d} type="number" min={0} step={15} className="input" value={duration}
              disabled={!canType} onChange={(e) => setDuration(e.target.value)} />}
          </Field>
          <CheckboxField label="Active" checked={active} onChange={setActive} disabled={!canType}
            hint="Inactive types can't be chosen for new events. Existing events keep them." />
        </FormSection>
        <FormSection title="Where it's available">
          <Field label="Countries" wide hint="People can create this type only in these countries, and only where they manage events.">
            {(id, d) => <MultiSelect id={id} aria-describedby={d} aria-label="Countries" value={ctry} onChange={setCtry} disabled={!canCountries}
              placeholder="No countries yet" options={(countries.data ?? []).map((c) => ({ value: c.code, label: `${c.name} (${c.code})` }))} />}
          </Field>
        </FormSection>
        <FormSection title="Event details">
          <Field label="Custom fields" wide hint="Shown on the Event details tab and in the event form, in the order the fields were created.">
            {(id, d) => <MultiSelect id={id} aria-describedby={d} aria-label="Custom fields" value={chosenFields} onChange={setFieldIds}
              disabled={!canFields || fields.isLoading} placeholder="No custom fields" maxChips={10}
              options={(fields.data ?? []).filter((f) => (f.is_active || chosenFields.includes(f.id)) && !allTypes.includes(f)).map((f) => ({ value: f.id, label: f.label }))} />}
          </Field>
          {allTypes.length > 0 && <p className="admin-section-note">Also shown on every event type: {allTypes.map((f) => f.label).join(', ')}.</p>}
        </FormSection>
        <FormSection title="Contracts">
          <Field label="Contract templates" wide hint="Work Orders, Single-event Contracts and Addenda for experts on these events are drafted from these. Each is available in all of this type's countries unless the template is limited to some.">
            {(id, d) => <MultiSelect id={id} aria-describedby={d} aria-label="Contract templates" value={tplIds} onChange={setTplIds}
              disabled={!canTemplates || templates.isLoading} placeholder="No contract templates" maxChips={10}
              options={(templates.data ?? []).filter((c) => c.contract_type !== 'msa' && (c.is_active || tplIds.includes(c.id)))
                .map((c) => ({ value: c.id, label: c.country_codes?.length ? `${c.name} (${c.country_codes.join(', ')})` : c.name }))} />}
          </Field>
        </FormSection>
      </form>
    </Modal>
  );
}
