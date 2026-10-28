import { useMemo, useRef, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Upload } from 'lucide-react';
import { supabase } from '../../lib/supabase';
import { useAuth } from '../../lib/auth';
import { can } from '../../lib/permissions';
import { DataTable, useTableSort, type Column } from '../../ui/DataTable';
import { SearchInput, Toolbar } from '../../ui/Toolbar';
import { Modal } from '../../ui/Modal';
import { CheckboxField, Field, FormSection } from '../../ui/Form';
import { MultiSelect } from '../../ui/MultiSelect';
import { Select } from '../../ui/Select';
import { ContractDocument } from '../contracts/ContractDocument';
import { useContractTypes, useTypeLabel } from '../contracts/contractsData';
import '../contracts/contracts.css';
import { AdminPage } from './AdminLayout';
import { ADMIN_KEY, must, syncLinks, useContractTemplates, useCountries, useEventTypes, useMergeFields, type ContractTemplateRow } from './adminData';

const EXPERT_TYPES = ['msa', 'work_order', 'event_contract', 'addendum'];
const forEvents = (type: string) => type !== 'msa';

export function ContractTemplatesAdmin() {
  const { me } = useAuth();
  const templates = useContractTemplates();
  const types = useEventTypes();
  const typeLabel = useTypeLabel();
  const [q, setQ] = useState('');
  const [editing, setEditing] = useState<ContractTemplateRow | 'new' | null>(null);

  const columns = useMemo<Column<ContractTemplateRow>[]>(() => [
    { id: 'name', header: 'Template', width: '28%', sortValue: (t) => t.name,
      cell: (t) => <><button className="dt-primary as-button" onClick={() => setEditing(t)}>{t.name}</button>
        {t.file_name && <div className="dt-sub">{t.file_name}</div>}</> },
    { id: 'type', header: 'Contract type', width: '18%', sortValue: (t) => typeLabel(t.contract_type), cell: (t) => typeLabel(t.contract_type) },
    { id: 'types', header: 'Event types', width: '26%',
      cell: (t) => {
        if (!forEvents(t.contract_type)) return <span className="admin-all">Expert level, no event</span>;
        const names = (types.data ?? []).filter((e) => t.event_type_contract_template.some((l) => l.event_type_id === e.id)).map((e) => e.name);
        return <span className={names.length ? 'dt-sub' : 'admin-all'}>{names.length ? names.join(', ') : 'Not used by any event type yet'}</span>;
      } },
    { id: 'countries', header: 'Countries', width: '16%',
      cell: (t) => t.country_codes?.length
        ? <span className="admin-codes">{t.country_codes.map((c) => <span key={c} className="admin-code">{c}</span>)}</span>
        : <span className="admin-all">{forEvents(t.contract_type) ? "All of the event type's" : 'All'}</span> },
    { id: 'active', header: 'Status', width: '12%', sortValue: (t) => (t.is_active ? 0 : 1),
      cell: (t) => <span className={`pill ${t.is_active ? 'pill-green' : 'pill-grey'}`}>{t.is_active ? 'Active' : 'Inactive'}</span> },
  ], [types.data, typeLabel]);

  const filtered = useMemo(() => templates.data?.filter((t) => !q || t.name.toLowerCase().includes(q.toLowerCase())), [templates.data, q]);
  const { rows, sort, setSort } = useTableSort(filtered, columns, { columnId: 'name', dir: 'asc' });
  const canEdit = can(me, 'contract_template', 'edit');

  return (
    <AdminPage title="Contract templates" sub="The documents contracts are drafted from: Markdown with merge fields, used by the event types you choose."
      action={can(me, 'contract_template', 'create') && <button className="btn btn-primary" onClick={() => setEditing('new')}><Upload size={15} strokeWidth={2.4} />Upload template</button>}
      readOnlyNote={!canEdit && 'Contract templates are managed by System Admins, like event types.'}>
      <Toolbar label="Filter contract templates"><SearchInput value={q} onChange={setQ} placeholder="Search templates" /></Toolbar>
      <DataTable label="Contract templates" columns={columns} rows={rows} rowKey={(t) => t.id} sort={sort} onSortChange={setSort}
        loading={templates.isLoading} error={templates.error} empty="No contract templates yet." />
      {editing && <TemplateEditor template={editing === 'new' ? null : editing} onClose={() => setEditing(null)} />}
    </AdminPage>
  );
}

function TemplateEditor({ template: t, onClose }: { template: ContractTemplateRow | null; onClose: () => void }) {
  const { me } = useAuth();
  const qc = useQueryClient();
  const contractTypes = useContractTypes();
  const eventTypes = useEventTypes();
  const countries = useCountries();
  const fields = useMergeFields();
  const fileRef = useRef<HTMLInputElement>(null);
  const beforeTypes = t?.event_type_contract_template.map((l) => l.event_type_id) ?? [];
  const [name, setName] = useState(t?.name ?? '');
  const [type, setType] = useState(t?.contract_type ?? 'work_order');
  const [body, setBody] = useState(t?.body ?? '');
  const [fileName, setFileName] = useState(t?.file_name ?? null);
  const [etypes, setEtypes] = useState(beforeTypes);
  const [ctry, setCtry] = useState<string[]>(t?.country_codes ?? []);
  const [active, setActive] = useState(t?.is_active ?? true);
  const [view, setView] = useState<'text' | 'preview'>(t ? 'preview' : 'text');
  const [errors, setErrors] = useState<Record<string, string>>({});
  const canSave = can(me, 'contract_template', t ? 'edit' : 'create');
  const canLink = can(me, 'event_type_contract_template', 'create');

  const readFile = async (f: File | undefined) => {
    if (!f) return;
    if (!/\.(md|markdown|txt)$/i.test(f.name)) { setErrors((e) => ({ ...e, body: 'Upload a Markdown file (.md)' })); return; }
    setBody(await f.text()); setFileName(f.name); setView('preview');
    if (!name.trim()) setName(f.name.replace(/\.(md|markdown|txt)$/i, '').replace(/[-_]+/g, ' ').replace(/^\w/, (c) => c.toUpperCase()));
    setErrors(({ body: _, ...rest }) => rest);
  };

  const save = useMutation({
    mutationFn: async () => {
      const row = { name: name.trim(), contract_type: type, body, file_name: fileName, country_codes: ctry.length ? ctry : null, is_active: active };
      let id = t?.id;
      if (id) await must(supabase.from('contract_template').update(row).eq('id', id));
      else id = (await must(supabase.from('contract_template').insert(row).select('id').single()))!.id;
      if (canLink) await syncLinks('event_type_contract_template', 'contract_template_id', id!, 'event_type_id', beforeTypes, forEvents(type) ? etypes : []);
    },
    onSuccess: () => { qc.invalidateQueries({ queryKey: [ADMIN_KEY] }); qc.invalidateQueries({ queryKey: ['contract-options'] }); onClose(); },
    onError: () => setTimeout(() => document.querySelector('#template-form .form-error')?.scrollIntoView({ block: 'nearest', behavior: 'smooth' }), 0),
  });

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    const errs: Record<string, string> = {};
    if (!name.trim()) errs.name = 'Give the template a name';
    if (!body.trim()) errs.body = 'Upload a Markdown file or write the template';
    setErrors(errs);
    if (!Object.keys(errs).length) save.mutate();
  };

  return (
    <Modal open size="lg" title={t ? t.name : 'Upload contract template'} onClose={onClose}
      confirmClose={canSave && (body !== (t?.body ?? '') || name !== (t?.name ?? '')) && !save.isPending ? 'Discard your changes to this template?' : false}
      footer={canSave ? <>
        <button type="button" className="btn" onClick={onClose}>Cancel</button>
        <button type="submit" form="template-form" className="btn btn-primary" disabled={save.isPending}>{save.isPending ? 'Saving…' : 'Save'}</button>
      </> : <button type="button" className="btn" onClick={onClose}>Close</button>}>
      <form id="template-form" className="form" onSubmit={submit} noValidate>
        {save.error && <div className="form-error" role="alert" style={{ marginBottom: 16 }}>{save.error.message}</div>}
        <FormSection title="Template">
          <Field label="Name" required error={errors.name}>
            {(id, d) => <input id={id} aria-describedby={d} aria-invalid={Boolean(errors.name) || undefined} className="input" value={name}
              disabled={!canSave} onChange={(e) => { setName(e.target.value); setErrors(({ name: _, ...r }) => r); }} />}
          </Field>
          <Field label="Contract type" hint={t ? "Can't change once the template exists" : undefined}>
            {(id, d) => <Select id={id} aria-describedby={d} value={type} onChange={setType} disabled={!canSave || Boolean(t)}
              options={(contractTypes.data ?? []).filter((c) => EXPERT_TYPES.includes(c.code)).map((c) => ({ value: c.code, label: c.label }))} />}
          </Field>
          <CheckboxField label="Active" checked={active} onChange={setActive} disabled={!canSave} hint="Inactive templates aren't offered for new contracts." />
        </FormSection>

        <FormSection title="Document">
          <div className="field field-wide">
            <div className="template-file">
              <input ref={fileRef} type="file" accept=".md,.markdown,.txt,text/markdown,text/plain" hidden onChange={(e) => { readFile(e.target.files?.[0]); e.target.value = ''; }} />
              {canSave && <button type="button" className="btn btn-sm" onClick={() => fileRef.current?.click()}><Upload size={14} />{body ? 'Replace file' : 'Choose Markdown file'}</button>}
              <span className="dt-sub">{fileName ?? (body ? 'Written here' : 'No file yet')}</span>
              {body && (
                <div className="segmented template-view" role="group" aria-label="Show">
                  <button type="button" aria-pressed={view === 'preview'} onClick={() => setView('preview')}>Preview</button>
                  <button type="button" aria-pressed={view === 'text'} onClick={() => setView('text')}>{canSave ? 'Edit text' : 'Text'}</button>
                </div>
              )}
            </div>
            {view === 'preview' && body
              ? <div className="template-preview"><ContractDocument body={body} fields={(fields.data ?? []).map((f) => f.field)} /></div>
              : <textarea aria-label="Template text" aria-invalid={Boolean(errors.body) || undefined} className="input template-text" rows={14} value={body}
                  disabled={!canSave} onChange={(e) => { setBody(e.target.value); setErrors(({ body: _, ...r }) => r); }}
                  placeholder={'# Work Order {{contract.number}}\n\nBetween {{company.name}} and {{expert.name}} for {{event.name}} ({{event.dates}}).\n\n{{honorarium.table}}'} />}
            {errors.body && <div className="field-error">{errors.body}</div>}
            <details className="merge-fields">
              <summary>Merge fields you can use</summary>
              <dl>{(fields.data ?? []).map((f) => <div key={f.field}><dt><code>{`{{${f.field}}}`}</code></dt><dd>{f.description}</dd></div>)}</dl>
            </details>
          </div>
        </FormSection>

        <FormSection title="Where it's used">
          {forEvents(type) ? (
            <Field label="Event types" wide hint="Contracts for experts on events of these types can use this template.">
              {(id, d) => <MultiSelect id={id} aria-describedby={d} aria-label="Event types" value={etypes} onChange={setEtypes} disabled={!canLink}
                placeholder="No event types yet" options={(eventTypes.data ?? []).filter((e) => e.is_active || etypes.includes(e.id)).map((e) => ({ value: e.id, label: e.name }))} />}
            </Field>
          ) : <p className="admin-section-note field-wide">Master Service Agreements belong to the expert, so they don't depend on an event type.</p>}
          <Field label="Countries" wide hint={forEvents(type)
            ? "Leave empty to use it in every country the event types are available in. Pick countries to limit it, e.g. a German version."
            : "Leave empty for experts from every country."}>
            {(id, d) => <MultiSelect id={id} aria-describedby={d} aria-label="Countries" value={ctry} onChange={setCtry} disabled={!canSave}
              placeholder="All countries" options={(countries.data ?? []).map((c) => ({ value: c.code, label: `${c.name} (${c.code})` }))} />}
          </Field>
        </FormSection>
      </form>
    </Modal>
  );
}
