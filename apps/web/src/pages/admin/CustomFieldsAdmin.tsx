import { useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Plus, Trash2 } from 'lucide-react';
import { supabase } from '../../lib/supabase';
import { useAuth } from '../../lib/auth';
import { can } from '../../lib/permissions';
import { DataTable, useTableSort, type Column } from '../../ui/DataTable';
import { FilterSelect, SearchInput, Segmented, Toolbar } from '../../ui/Toolbar';
import { Modal } from '../../ui/Modal';
import { CheckboxField, Field, FormSection } from '../../ui/Form';
import { Select } from '../../ui/Select';
import { MultiSelect } from '../../ui/MultiSelect';
import { AdminPage } from './AdminLayout';
import { ADMIN_KEY, must, useCustomFieldObjects, useCustomFields, useEventTypes, type CustomFieldRow, type CustomFieldType } from './adminData';

/** Types offered when creating a field. Seeded fields may use others; those still display and edit. */
const NEW_TYPES: { value: CustomFieldType; label: string }[] = [
  { value: 'picklist', label: 'Single-select dropdown' },
  { value: 'text', label: 'Text' },
  { value: 'number', label: 'Number' },
  { value: 'url', label: 'URL' },
];
const TYPE_LABEL: Record<CustomFieldType, string> = {
  picklist: 'Single-select dropdown', text: 'Text', number: 'Number', url: 'URL', long_text: 'Long text',
  currency: 'Currency', date: 'Date', checkbox: 'Checkbox', multi_picklist: 'Multi-select', lookup_user: 'User',
};

/** "Cost centre" → "cost_centre__c": the stable name values are stored under. */
export function apiNameFrom(label: string) {
  const base = label.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()
    .replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').replace(/^(\d)/, 'f_$1').slice(0, 40);
  return base ? `${base}__c` : '';
}
const optionValue = (label: string) => apiNameFrom(label).replace(/__c$/, '');

function typeSummary(f: CustomFieldRow) {
  if (f.field_type === 'picklist') return `${TYPE_LABEL.picklist} · ${f.options.length} option${f.options.length === 1 ? '' : 's'}`;
  if (f.field_type === 'number' && f.decimals != null) return `Number · ${f.decimals === 0 ? 'whole numbers' : `${f.decimals} decimal${f.decimals === 1 ? '' : 's'}`}`;
  return TYPE_LABEL[f.field_type];
}

export function CustomFieldsAdmin() {
  const { me } = useAuth();
  const fields = useCustomFields();
  const types = useEventTypes();
  const objects = useCustomFieldObjects();
  const [params, setParams] = useSearchParams();
  const q = params.get('q') ?? '';
  const object = params.get('object') ?? '';
  const show = (params.get('show') ?? 'active') as 'active' | 'all';
  const setParam = (k: string, v: string, empty = '') => setParams((p) => { const n = new URLSearchParams(p); if (v && v !== empty) n.set(k, v); else n.delete(k); return n; }, { replace: true });
  const setQ = (v: string) => setParam('q', v);
  const setShow = (v: 'active' | 'all') => setParam('show', v, 'active');
  const objectOf = (code: string) => objects.data?.find((o) => o.code === code);
  const [editing, setEditing] = useState<CustomFieldRow | 'new' | null>(null);
  const typeName = useMemo(() => new Map(types.data?.map((t) => [t.id, t.name])), [types.data]);

  const columns = useMemo<Column<CustomFieldRow>[]>(() => [
    { id: 'label', header: 'Field', width: '24%', sortValue: (f) => f.label,
      cell: (f) => <><button className="dt-primary as-button" onClick={() => setEditing(f)}>{f.label}</button>
        {f.help_text && <div className="dt-sub">{f.help_text}</div>}</> },
    { id: 'object', header: 'Object', width: '13%', sortValue: (f) => objects.data?.findIndex((o) => o.code === f.object_name) ?? 0,
      cell: (f) => objectOf(f.object_name)?.label ?? f.object_name },
    { id: 'name', header: 'Name', width: '16%', sortValue: (f) => f.api_name, cell: (f) => <code className="admin-api">{f.api_name}</code> },
    { id: 'type', header: 'Type', width: '15%', sortValue: (f) => TYPE_LABEL[f.field_type],
      cell: (f) => <>{typeSummary(f)}{f.is_required && <div className="dt-sub">Required</div>}</> },
    { id: 'types', header: 'Shown on', width: '20%',
      cell: (f) => {
        if (objectOf(f.object_name) && !objectOf(f.object_name)!.by_event_type) return <span className="dt-sub">Every {objectOf(f.object_name)!.label.replace(/ \(.*\)$/, '').toLowerCase()}</span>;
        if (f.custom_field_layout.some((l) => l.event_type_id === null)) return <span className="dt-sub">All event types</span>;
        const names = f.custom_field_layout.map((l) => typeName.get(l.event_type_id!)).filter(Boolean);
        if (names.length && names.length === typeName.size) return <span className="dt-sub">All event types</span>;
        return <span className="dt-sub">{names.length ? names.join(', ') : 'Not on any event type yet'}</span>;
      } },
    { id: 'active', header: 'Status', width: '12%', sortValue: (f) => (f.is_active ? 0 : 1),
      cell: (f) => <span className={`pill ${f.is_active ? 'pill-green' : 'pill-grey'}`}>{f.is_active ? 'Active' : 'Inactive'}</span> },
  ], [typeName, objects.data]);

  const filtered = useMemo(() => fields.data?.filter((f) => (show === 'all' || f.is_active) && (!object || f.object_name === object)
    && (!q || [f.label, f.api_name].some((v) => v.toLowerCase().includes(q.toLowerCase())))), [fields.data, q, show, object]);
  // Default order is creation order, which is also the order on the Event details tab
  const { rows, sort, setSort } = useTableSort(filtered, columns, null);

  return (
    <AdminPage title="Custom fields" sub="Extra fields on events, requests, experts, HCOs, event attendees and event experts. Fields are shown in the order they were created; those on events, requests and event attendees or experts follow event types."
      action={can(me, 'custom_field', 'create') && <button className="btn btn-primary" onClick={() => setEditing('new')}><Plus size={15} strokeWidth={2.6} />New custom field</button>}
      readOnlyNote={!can(me, 'custom_field', 'edit') && 'Custom fields are managed by System Admins.'}>
      <Toolbar label="Filter custom fields">
        <SearchInput value={q} onChange={setQ} placeholder="Search fields" />
        <FilterSelect label="Object" value={object} onChange={(v) => setParam('object', v)} options={(objects.data ?? []).map((o) => ({ value: o.code, label: o.label }))} />
        <Segmented label="Show" value={show} onChange={setShow} options={[{ value: 'active', label: 'Active' }, { value: 'all', label: 'All' }]} />
      </Toolbar>
      <DataTable label="Custom fields" columns={columns} rows={rows} rowKey={(f) => f.id} sort={sort} onSortChange={setSort}
        loading={fields.isLoading} error={fields.error} empty="No custom fields yet." />
      {editing && <CustomFieldEditor field={editing === 'new' ? null : editing} defaultObject={object || 'event'} onClose={() => setEditing(null)} />}
    </AdminPage>
  );
}

interface OptionDraft { value: string; label: string; isNew: boolean }

function CustomFieldEditor({ field, defaultObject, onClose }: { field: CustomFieldRow | null; defaultObject: string; onClose: () => void }) {
  const { me } = useAuth();
  const qc = useQueryClient();
  const objects = useCustomFieldObjects();
  const types = useEventTypes();
  const [object, setObject] = useState(field?.object_name ?? defaultObject);
  const byType = objects.data?.find((o) => o.code === object)?.by_event_type ?? true;
  const onForms = object === 'event' || object === 'event_request';
  // Where it shows: every event type (a null layout row), or the types chosen
  const beforeTypes = field?.custom_field_layout.map((l) => l.event_type_id) ?? [];
  const [everyType, setEveryType] = useState(field ? beforeTypes.includes(null) : true);
  const [typeIds, setTypeIds] = useState<string[]>(beforeTypes.filter((t): t is string => t !== null));
  const editable = can(me, 'custom_field', field ? 'edit' : 'create');
  const [label, setLabel] = useState(field?.label ?? '');
  const [apiName, setApiName] = useState(field?.api_name ?? '');
  const [nameTouched, setNameTouched] = useState(Boolean(field));
  const [description, setDescription] = useState(field?.help_text ?? '');
  const [type, setType] = useState<CustomFieldType>(field?.field_type ?? 'picklist');
  const [decimals, setDecimals] = useState(field?.decimals?.toString() ?? '0');
  const [options, setOptions] = useState<OptionDraft[]>(field?.options.map((o) => ({ ...o, isNew: false })) ?? [{ value: '', label: '', isNew: true }]);
  const [required, setRequired] = useState(field?.is_required ?? false);
  const [active, setActive] = useState(field?.is_active ?? true);
  const [errors, setErrors] = useState<Record<string, string>>({});

  const typeOptions = field && !NEW_TYPES.some((t) => t.value === field.field_type)
    ? [...NEW_TYPES, { value: field.field_type, label: TYPE_LABEL[field.field_type] }] : NEW_TYPES;

  const save = useMutation({
    mutationFn: async () => {
      const opts = type === 'picklist' || type === 'multi_picklist'
        ? options.filter((o) => o.label.trim()).map((o) => ({ value: o.isNew ? optionValue(o.label) : o.value, label: o.label.trim() }))
        : [];
      const row = {
        label: label.trim(), help_text: description.trim() || null, options: opts, is_required: onForms && required, is_active: active,
        decimals: type === 'number' ? Number(decimals) : null,
      };
      const id = field ? (await must(supabase.from('custom_field').update(row).eq('id', field.id).select('id').single()) as { id: string }).id
        : (await must(supabase.from('custom_field').insert({ ...row, object_name: object, api_name: apiName, field_type: type }).select('id').single()) as { id: string }).id;
      // Expert and HCO fields show everywhere (the database adds that); the rest follow the chosen event types
      if (byType) {
        const want: (string | null)[] = everyType ? [null] : typeIds;
        const gone = beforeTypes.filter((t) => !want.includes(t));
        const added = want.filter((t) => !beforeTypes.includes(t));
        if (gone.includes(null)) await must(supabase.from('custom_field_layout').delete().eq('custom_field_id', id).is('event_type_id', null));
        const goneIds = gone.filter((t): t is string => t !== null);
        if (goneIds.length) await must(supabase.from('custom_field_layout').delete().eq('custom_field_id', id).in('event_type_id', goneIds));
        if (added.length) await must(supabase.from('custom_field_layout').insert(added.map((t) => ({ custom_field_id: id, event_type_id: t }))));
      }
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: [ADMIN_KEY] });
      qc.invalidateQueries({ queryKey: ['event-form-options'] });
      qc.invalidateQueries({ queryKey: ['custom-fields'] });
      onClose();
    },
  });

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    const errs: Record<string, string> = {};
    if (!label.trim()) errs.label = 'Give the field a label';
    if (!/^[a-z][a-z0-9_]{0,40}__c$/.test(apiName)) errs.apiName = 'Lowercase letters, digits and underscores, ending in __c';
    if (type === 'picklist') {
      const filled = options.filter((o) => o.label.trim());
      if (!filled.length) errs.options = 'Add at least one option';
      const values = filled.map((o) => (o.isNew ? optionValue(o.label) : o.value));
      if (new Set(values).size !== values.length) errs.options = 'Two options have the same name';
    }
    setErrors(errs);
    if (!Object.keys(errs).length) save.mutate();
  };

  return (
    <Modal open size="lg" title={field ? field.label : 'New custom field'} onClose={onClose}
      footer={editable ? <>
        <button type="button" className="btn" onClick={onClose}>Cancel</button>
        <button type="submit" form="cf-form" className="btn btn-primary" disabled={save.isPending}>{save.isPending ? 'Saving…' : field ? 'Save changes' : 'Create field'}</button>
      </> : <button type="button" className="btn" onClick={onClose}>Close</button>}>
      <form id="cf-form" className="form" onSubmit={submit} noValidate>
        {save.error && <div className="form-error" role="alert" style={{ marginBottom: 16 }}>{save.error.message}</div>}
        <FormSection title="Field">
          <Field label="Object" required wide hint={field ? 'Fixed once created. Create a new field to put it on another object.' : 'The record the field belongs to.'}>
            {(id, d) => <Select id={id} aria-describedby={d} value={object} onChange={setObject} disabled={Boolean(field) || !editable}
              options={(objects.data ?? []).map((o) => ({ value: o.code, label: o.label }))} />}
          </Field>
          <Field label="Label" required error={errors.label} hint="What people see.">
            {(id, d) => <input id={id} aria-describedby={d} aria-invalid={Boolean(errors.label) || undefined} className="input" value={label} disabled={!editable}
              onChange={(e) => { setLabel(e.target.value); if (!nameTouched) setApiName(apiNameFrom(e.target.value)); }} />}
          </Field>
          <Field label="Name" required error={errors.apiName}
            hint={field ? "Fixed once created: values are stored under it, and the API and reports use it." : 'Used by the API and reports. Fixed once created.'}>
            {(id, d) => <input id={id} aria-describedby={d} aria-invalid={Boolean(errors.apiName) || undefined} className="input admin-api-input"
              value={apiName} disabled={Boolean(field) || !editable} spellCheck={false}
              onChange={(e) => { setNameTouched(true); setApiName(e.target.value.trim()); }} />}
          </Field>
          <Field label="Description" wide hint="Shown under the field to help people fill it in.">
            {(id, d) => <textarea id={id} aria-describedby={d} className="input" rows={2} value={description} disabled={!editable} onChange={(e) => setDescription(e.target.value)} />}
          </Field>
        </FormSection>

        <FormSection title="Type">
          <Field label="Type" required hint={field ? 'Fixed once created. Create a new field to change it.' : null}>
            {(id, d) => <Select id={id} aria-describedby={d} value={type} onChange={(v) => setType(v as CustomFieldType)}
              options={typeOptions} disabled={Boolean(field) || !editable} />}
          </Field>
          {type === 'number' && (
            <Field label="Decimals" hint="How many decimal places a value may have.">
              {(id, d) => <Select id={id} aria-describedby={d} value={decimals} onChange={setDecimals} disabled={!editable}
                options={['0', '1', '2', '3', '4', '5', '6'].map((n) => ({ value: n, label: n === '0' ? 'None (whole numbers)' : `${n} (e.g. ${(0).toFixed(Number(n)).replace(/0$/, '5')})` }))} />}
            </Field>
          )}
          {(type === 'picklist' || type === 'multi_picklist') && (
            <Field label="Options" wide required error={errors.options} hint="Renaming an option keeps existing values; removed options stay on events that already use them.">
              {() => (
                <div className="cf-options">
                  {options.map((o, i) => (
                    <div key={i} className="cf-option">
                      <input className="input" aria-label={`Option ${i + 1}`} value={o.label} disabled={!editable} placeholder={`Option ${i + 1}`}
                        onChange={(e) => setOptions(options.map((x, j) => (j === i ? { ...x, label: e.target.value } : x)))} />
                      {editable && <button type="button" className="btn btn-ghost" aria-label={`Remove option ${i + 1}`}
                        onClick={() => setOptions(options.filter((_, j) => j !== i))}><Trash2 size={15} /></button>}
                    </div>
                  ))}
                  {editable && <span><button type="button" className="btn" onClick={(e) => {
                    setOptions([...options, { value: '', label: '', isNew: true }]);
                    // Put the cursor in the new row once it renders
                    const list = (e.currentTarget as HTMLElement).closest('.cf-options');
                    setTimeout(() => list?.querySelector<HTMLInputElement>('.cf-option:last-of-type input')?.focus(), 0);
                  }}>
                    <Plus size={14} />Add option</button></span>}
                </div>
              )}
            </Field>
          )}
        </FormSection>

        {byType && (
          <FormSection title="Where it shows">
            <CheckboxField label="Every event type" checked={everyType} onChange={setEveryType} disabled={!editable}
              hint={object === 'event' ? 'Or choose the types below; Admin → Event types can change this too.' : object === 'event_request' ? 'A tiering request has no event type, so it shows fields on every type only.' : "By the type of the record's event."} />
            {!everyType && (
              <Field label="Event types" wide hint="None chosen: the field isn't shown yet.">
                {(id, d) => <MultiSelect id={id} aria-describedby={d} aria-label="Event types" value={typeIds} onChange={setTypeIds} disabled={!editable}
                  placeholder="Choose event types" options={(types.data ?? []).map((t) => ({ value: t.id, label: t.name }))} />}
              </Field>
            )}
          </FormSection>
        )}

        <FormSection title="Rules">
          {onForms && <CheckboxField label="Required" checked={required} onChange={setRequired} disabled={!editable}
            hint={`Must be filled in where it shows, from the next time ${object === 'event' ? 'an event' : 'a request'} is saved.`} />}
          <CheckboxField label="Active" checked={active} onChange={setActive} disabled={!editable}
            hint="Inactive fields disappear; stored values are kept." />
        </FormSection>
      </form>
    </Modal>
  );
}
