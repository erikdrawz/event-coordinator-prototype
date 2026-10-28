import { useMemo, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Download, Lock, Pencil, Plus, Settings2, Trash2, Upload } from 'lucide-react';
import { supabase } from '../../lib/supabase';
import { useAuth } from '../../lib/auth';
import { can } from '../../lib/permissions';
import { DataTable, useTableSort, type Column } from '../../ui/DataTable';
import { SearchInput, Toolbar } from '../../ui/Toolbar';
import { Modal } from '../../ui/Modal';
import { ConfirmDialog } from '../../ui/ConfirmDialog';
import { CheckboxField, Field, FormSection } from '../../ui/Form';
import { MultiSelect } from '../../ui/MultiSelect';
import { Select } from '../../ui/Select';
import { DateInput, formatDate } from '../../ui/DateInput';
import { ContractDocument } from '../contracts/ContractDocument';
import { useContractTypes, useTypeLabel } from '../contracts/contractsData';
import { saveBlob } from '../contracts/contractPdf';
import '../contracts/contracts.css';
import { AdminPage } from './AdminLayout';
import {
  ADMIN_KEY, must, syncLinks, useContractTemplates, useCountries, useEventTypes, useMergeFields, versionStates,
  type ContractTemplateRow, type TemplateVersion, type VersionState,
} from './adminData';

const EXPERT_TYPES = ['msa', 'work_order', 'event_contract', 'addendum'];
const forEvents = (type: string) => type !== 'msa';
const isoDay = (d: Date) => d.toLocaleDateString('en-CA');
const nextNewYear = () => `${new Date().getFullYear() + 1}-01-01`;
const STATE: Record<VersionState, { label: string; tone: string }> = {
  current: { label: 'In effect', tone: 'green' }, scheduled: { label: 'Scheduled', tone: 'blue' }, retired: { label: 'Retired', tone: 'grey' },
};

/** Contract templates: what each is for, and which version is in effect now or scheduled. */
export function ContractTemplatesAdmin() {
  const { me } = useAuth();
  const navigate = useNavigate();
  const templates = useContractTemplates();
  const types = useEventTypes();
  const typeLabel = useTypeLabel();
  const [q, setQ] = useState('');
  const [adding, setAdding] = useState(false);

  const columns = useMemo<Column<ContractTemplateRow>[]>(() => [
    { id: 'name', header: 'Template', width: '24%', sortValue: (t) => t.name,
      cell: (t) => <><Link to={t.id} className="dt-primary">{t.name}</Link><div className="dt-sub">{typeLabel(t.contract_type)}</div></> },
    { id: 'version', header: 'Version', width: '22%',
      cell: (t) => {
        const states = versionStates(t.contract_template_version);
        const current = t.contract_template_version.find((v) => states.get(v.id)?.state === 'current');
        const next = [...t.contract_template_version].reverse().find((v) => states.get(v.id)?.state === 'scheduled');
        return <>
          {current ? <>v{current.version} <span className="dt-sub">since {formatDate(current.effective_from)}</span></> : <span className="admin-all">None in effect yet</span>}
          {next && <div className="dt-sub version-next"><span className="pill pill-blue pill-sm">Scheduled</span> v{next.version} from {formatDate(next.effective_from)}</div>}
        </>;
      } },
    { id: 'types', header: 'Event types', width: '26%',
      cell: (t) => {
        if (!forEvents(t.contract_type)) return <span className="admin-all">Expert level, no event</span>;
        const names = (types.data ?? []).filter((e) => t.event_type_contract_template.some((l) => l.event_type_id === e.id)).map((e) => e.name);
        return <span className={names.length ? 'dt-sub' : 'admin-all'}>{names.length ? names.join(', ') : 'Not used by any event type yet'}</span>;
      } },
    { id: 'countries', header: 'Countries', width: '16%', cell: (t) => <Countries t={t} /> },
    { id: 'active', header: 'Status', width: '12%', sortValue: (t) => (t.is_active ? 0 : 1),
      cell: (t) => <span className={`pill ${t.is_active ? 'pill-green' : 'pill-grey'}`}>{t.is_active ? 'Active' : 'Inactive'}</span> },
  ], [types.data, typeLabel]);

  const filtered = useMemo(() => templates.data?.filter((t) => !q || t.name.toLowerCase().includes(q.toLowerCase())), [templates.data, q]);
  const { rows, sort, setSort } = useTableSort(filtered, columns, { columnId: 'name', dir: 'asc' });

  return (
    <AdminPage title="Contract templates" sub="The documents contracts are drafted from. Each template has versions; a contract gets the one in effect on its event's date."
      action={can(me, 'contract_template', 'create') && <button className="btn btn-primary" onClick={() => setAdding(true)}><Upload size={15} strokeWidth={2.4} />Upload template</button>}
      readOnlyNote={!can(me, 'contract_template', 'edit') && 'Contract templates are managed by System Admins, like event types.'}>
      <Toolbar label="Filter contract templates"><SearchInput value={q} onChange={setQ} placeholder="Search templates" /></Toolbar>
      <DataTable label="Contract templates" columns={columns} rows={rows} rowKey={(t) => t.id} sort={sort} onSortChange={setSort}
        loading={templates.isLoading} error={templates.error} empty="No contract templates yet." />
      {adding && <SettingsModal template={null} onClose={(id) => { setAdding(false); if (id) navigate(id); }} />}
    </AdminPage>
  );
}

function Countries({ t }: { t: ContractTemplateRow }) {
  return t.country_codes?.length
    ? <span className="admin-codes">{t.country_codes.map((c) => <span key={c} className="admin-code">{c}</span>)}</span>
    : <span className="admin-all">{forEvents(t.contract_type) ? "All of the event type's" : 'All'}</span>;
}

/** One template: its versions over time (in effect, scheduled, retired) and where it's used. */
export function ContractTemplatePage() {
  const { id } = useParams();
  const { me } = useAuth();
  const qc = useQueryClient();
  const templates = useContractTemplates();
  const eventTypes = useEventTypes();
  const fields = useMergeFields();
  const typeLabel = useTypeLabel();
  const t = templates.data?.find((x) => x.id === id);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [settings, setSettings] = useState(false);
  const [versionEdit, setVersionEdit] = useState<TemplateVersion | 'new' | null>(null);
  const [deleting, setDeleting] = useState<TemplateVersion | null>(null);
  const canEdit = can(me, 'contract_template_version', 'edit');

  const remove = useMutation({
    mutationFn: (v: TemplateVersion) => must(supabase.from('contract_template_version').delete().eq('id', v.id)),
    onSuccess: () => { qc.invalidateQueries({ queryKey: [ADMIN_KEY] }); setDeleting(null); setSelectedId(null); },
  });

  if (templates.isLoading) return <div className="empty-state">Loading…</div>;
  if (!t) return <div className="card empty-state"><div className="empty-state-title">Template not found</div><Link to="/admin/contract-templates">Back to contract templates</Link></div>;

  const versions = t.contract_template_version;
  const states = versionStates(versions);
  const current = versions.find((v) => states.get(v.id)?.state === 'current');
  const selected = versions.find((v) => v.id === selectedId) ?? current ?? versions[0];
  const sel = selected && states.get(selected.id);
  const names = (eventTypes.data ?? []).filter((e) => t.event_type_contract_template.some((l) => l.event_type_id === e.id)).map((e) => e.name);

  return (
    <>
      <nav className="crumbs"><Link to="/admin/contract-templates">Contract templates</Link><span>/</span><span>{t.name}</span></nav>
      <AdminPage title={t.name} sub={`${versions.length} version${versions.length === 1 ? '' : 's'}`}
        action={<div className="event-actions">
          <button className="btn" onClick={() => setSettings(true)}><Settings2 size={15} />Settings</button>
          {can(me, 'contract_template_version', 'create') && <button className="btn btn-primary" onClick={() => setVersionEdit('new')}><Plus size={15} strokeWidth={2.6} />New version</button>}
        </div>}>
        <dl className="template-meta" aria-label="Where it's used">
          <div><dt>Status</dt><dd><span className={`pill ${t.is_active ? 'pill-green' : 'pill-grey'}`}>{t.is_active ? 'Active' : 'Inactive'}</span></dd></div>
          <div><dt>Contract type</dt><dd>{typeLabel(t.contract_type)}</dd></div>
          <div className="template-meta-wide"><dt>Event types</dt><dd>{forEvents(t.contract_type)
            ? (names.length ? names.join(', ') : <span className="text-muted">None yet</span>) : <span className="text-muted">Expert level, no event</span>}</dd></div>
          <div><dt>Countries</dt><dd><Countries t={t} /></dd></div>
        </dl>
        <div className="template-main">
          <section className="card ov-card" aria-labelledby="versions-title">
            <div className="ov-head"><div className="ov-title-row"><h2 id="versions-title" className="ov-title">Versions</h2>
              <span className="card-sub">A contract gets the version in effect on its event's date (an MSA: its start date)</span></div></div>
            <div className="table-scroll">
              <table className="agenda-table expert-table version-table">
                <thead><tr><th>Version</th><th>In effect</th><th>Status</th><th>What changed</th><th className="num">Contracts</th></tr></thead>
                <tbody>
                  {versions.map((v) => {
                    const st = states.get(v.id)!;
                    return (
                      <tr key={v.id} className={`${v.id === selected?.id ? 'is-selected' : ''}${st.state === 'retired' ? ' is-past' : ''}`} onClick={() => setSelectedId(v.id)}>
                        <td className="dt-nowrap"><button type="button" className="agenda-title as-button" onClick={() => setSelectedId(v.id)}>v{v.version}</button>
                          {v.is_locked && <span className="version-lock" tabIndex={0} aria-label="Used for sent contracts" data-tip="Used for contracts sent for signature, so it can't change"><Lock size={12} aria-hidden /></span>}</td>
                        <td className="dt-nowrap">{formatDate(v.effective_from)}{st.until ? <> – {formatDate(st.until)}</> : <span className="dt-sub"> onwards</span>}</td>
                        <td><span className={`pill pill-${STATE[st.state].tone}`}>{STATE[st.state].label}</span></td>
                        <td>{v.notes ?? <span className="text-muted">—</span>}</td>
                        <td className="num">{v.contracts_using || <span className="text-muted">0</span>}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            {!current && <p className="admin-section-note version-note">No version is in effect yet, so contracts can't use this template until {versions.length ? formatDate(versions[versions.length - 1].effective_from) : 'a version is added'}.</p>}
          </section>

          {selected && sel && (
            <section className="card ov-card" aria-labelledby="version-title">
              <div className="ov-head">
                <div className="ov-title-row">
                  <h2 id="version-title" className="ov-title">Version {selected.version}</h2>
                  <span className={`pill pill-${STATE[sel.state].tone}`}>{STATE[sel.state].label}</span>
                  <span className="card-sub">{selected.file_name ?? ''}</span>
                </div>
                <div className="ov-actions">
                  <button className="btn btn-sm" onClick={() => saveBlob(new Blob([selected.body], { type: 'text/markdown' }), selected.file_name ?? `${t.name} v${selected.version}.md`)}><Download size={14} />.md</button>
                  {canEdit && !selected.is_locked && <button className="btn btn-sm" onClick={() => setVersionEdit(selected)}><Pencil size={14} />Edit</button>}
                  {can(me, 'contract_template_version', 'delete') && selected.contracts_using === 0 && <button className="btn btn-sm btn-ghost" onClick={() => setDeleting(selected)}><Trash2 size={14} />Delete</button>}
                </div>
              </div>
              {selected.is_locked && <p className="admin-section-note version-note">Used for contracts sent for signature, so it can't change. Add a new version for changes.</p>}
              <div className="template-preview template-preview-page"><ContractDocument body={selected.body} fields={(fields.data ?? []).map((f) => f.field)} /></div>
            </section>
          )}
        </div>
      </AdminPage>

      {settings && <SettingsModal template={t} onClose={() => setSettings(false)} />}
      {versionEdit && <VersionModal template={t} version={versionEdit === 'new' ? null : versionEdit} onClose={(vid) => { setVersionEdit(null); if (vid) setSelectedId(vid); }} />}
      {deleting && (
        <ConfirmDialog title={`Delete version ${deleting.version}?`} confirmLabel="Delete version" pending={remove.isPending} error={remove.error?.message}
          onConfirm={() => remove.mutate(deleting)} onCancel={() => { remove.reset(); setDeleting(null); }}>
          No contracts were drafted from it. {states.get(deleting.id)?.state === 'scheduled' ? 'The version before it stays in effect.' : 'The version before it takes over from its date.'}
        </ConfirmDialog>
      )}
    </>
  );
}

/** The template's text: upload a Markdown file or write it, preview with the merge fields marked. */
function BodyEditor({ body, setBody, fileName, setFileName, error, disabled, onName }: {
  body: string; setBody: (v: string) => void; fileName: string | null; setFileName: (v: string | null) => void;
  error?: string; disabled?: boolean; onName?: (n: string) => void;
}) {
  const fields = useMergeFields();
  const fileRef = useRef<HTMLInputElement>(null);
  const [view, setView] = useState<'text' | 'preview'>(body ? 'preview' : 'text');
  const [fileError, setFileError] = useState<string | null>(null);
  const readFile = async (f: File | undefined) => {
    if (!f) return;
    if (!/\.(md|markdown|txt)$/i.test(f.name)) { setFileError('Upload a Markdown file (.md)'); return; }
    setFileError(null); setBody(await f.text()); setFileName(f.name); setView('preview');
    onName?.(f.name.replace(/\.(md|markdown|txt)$/i, '').replace(/[-_]+/g, ' ').replace(/^\w/, (c) => c.toUpperCase()));
  };
  return (
    <div className="field field-wide">
      <div className="template-file">
        <input ref={fileRef} type="file" accept=".md,.markdown,.txt,text/markdown,text/plain" hidden onChange={(e) => { readFile(e.target.files?.[0]); e.target.value = ''; }} />
        {!disabled && <button type="button" className="btn btn-sm" onClick={() => fileRef.current?.click()}><Upload size={14} />{body ? 'Replace file' : 'Choose Markdown file'}</button>}
        <span className="dt-sub">{fileName ?? (body ? 'Written here' : 'No file yet')}</span>
        {body && (
          <div className="segmented template-view" role="group" aria-label="Show">
            <button type="button" aria-pressed={view === 'preview'} onClick={() => setView('preview')}>Preview</button>
            <button type="button" aria-pressed={view === 'text'} onClick={() => setView('text')}>{disabled ? 'Text' : 'Edit text'}</button>
          </div>
        )}
      </div>
      {view === 'preview' && body
        ? <div className="template-preview"><ContractDocument body={body} fields={(fields.data ?? []).map((f) => f.field)} /></div>
        : <textarea aria-label="Template text" aria-invalid={Boolean(error) || undefined} className="input template-text" rows={14} value={body} disabled={disabled}
            onChange={(e) => setBody(e.target.value)}
            placeholder={'# Work Order {{contract.number}}\n\nBetween {{company.name}} and {{expert.name}} for {{event.name}} ({{event.dates}}).\n\n{{honorarium.table}}'} />}
      {(error || fileError) && <div className="field-error">{error ?? fileError}</div>}
      <details className="merge-fields">
        <summary>Merge fields you can use</summary>
        <dl>{(fields.data ?? []).map((f) => <div key={f.field}><dt><code>{`{{${f.field}}}`}</code></dt><dd>{f.description}</dd></div>)}</dl>
      </details>
    </div>
  );
}

const scrollToError = (form: string) => setTimeout(() => document.querySelector(`#${form} .form-error`)?.scrollIntoView({ block: 'nearest', behavior: 'smooth' }), 0);

/** A template's settings; a new template also gets its first version here. */
function SettingsModal({ template: t, onClose }: { template: ContractTemplateRow | null; onClose: (newId?: string) => void }) {
  const { me } = useAuth();
  const qc = useQueryClient();
  const contractTypes = useContractTypes();
  const eventTypes = useEventTypes();
  const countries = useCountries();
  const beforeTypes = t?.event_type_contract_template.map((l) => l.event_type_id) ?? [];
  const [name, setName] = useState(t?.name ?? '');
  const [type, setType] = useState(t?.contract_type ?? 'work_order');
  const [etypes, setEtypes] = useState(beforeTypes);
  const [ctry, setCtry] = useState<string[]>(t?.country_codes ?? []);
  const [active, setActive] = useState(t?.is_active ?? true);
  const [body, setBody] = useState('');
  const [fileName, setFileName] = useState<string | null>(null);
  const [from, setFrom] = useState(isoDay(new Date()));
  const [errors, setErrors] = useState<Record<string, string>>({});
  const canSave = can(me, 'contract_template', t ? 'edit' : 'create');
  const canLink = can(me, 'event_type_contract_template', 'create');

  const save = useMutation({
    mutationFn: async () => {
      const row = { name: name.trim(), contract_type: type, country_codes: ctry.length ? ctry : null, is_active: active };
      let id = t?.id;
      if (id) await must(supabase.from('contract_template').update(row).eq('id', id));
      else {
        id = (await must(supabase.from('contract_template').insert(row).select('id').single()))!.id;
        const v = await supabase.from('contract_template_version').insert({ contract_template_id: id, body, file_name: fileName, effective_from: from, notes: 'First version' });
        if (v.error) { await supabase.from('contract_template').delete().eq('id', id); throw new Error(v.error.message); }
      }
      if (canLink) await syncLinks('event_type_contract_template', 'contract_template_id', id!, 'event_type_id', beforeTypes, forEvents(type) ? etypes : []);
      return id;
    },
    onSuccess: (id) => { qc.invalidateQueries({ queryKey: [ADMIN_KEY] }); qc.invalidateQueries({ queryKey: ['contract-options'] }); onClose(t ? undefined : id); },
    onError: () => scrollToError('template-form'),
  });

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    const errs: Record<string, string> = {};
    if (!name.trim()) errs.name = 'Give the template a name';
    if (!t && !body.trim()) errs.body = 'Upload a Markdown file or write the template';
    if (!t && !from) errs.from = 'Choose the date it takes effect';
    setErrors(errs);
    if (!Object.keys(errs).length) save.mutate();
  };

  return (
    <Modal open size="lg" title={t ? `${t.name}: settings` : 'Upload contract template'} onClose={() => onClose()}
      confirmClose={canSave && !t && Boolean(body || name) && !save.isPending ? 'Discard this template?' : false}
      footer={canSave ? <>
        <button type="button" className="btn" onClick={() => onClose()}>Cancel</button>
        <button type="submit" form="template-form" className="btn btn-primary" disabled={save.isPending}>{save.isPending ? 'Saving…' : 'Save'}</button>
      </> : <button type="button" className="btn" onClick={() => onClose()}>Close</button>}>
      <form id="template-form" className="form" onSubmit={submit} noValidate>
        {save.error && <div className="form-error" role="alert" style={{ marginBottom: 16 }}>{save.error.message}</div>}
        <FormSection title="Template">
          <Field label="Name" required error={errors.name}>
            {(id, d) => <input id={id} aria-describedby={d} aria-invalid={Boolean(errors.name) || undefined} className="input" value={name}
              disabled={!canSave} onChange={(e) => { setName(e.target.value); setErrors(({ name: _, ...r }) => r); }} autoFocus={!t} />}
          </Field>
          <Field label="Contract type" hint={t ? "Can't change once the template exists" : undefined}>
            {(id, d) => <Select id={id} aria-describedby={d} value={type} onChange={setType} disabled={!canSave || Boolean(t)}
              options={(contractTypes.data ?? []).filter((c) => EXPERT_TYPES.includes(c.code)).map((c) => ({ value: c.code, label: c.label }))} />}
          </Field>
          <CheckboxField label="Active" checked={active} onChange={setActive} disabled={!canSave} hint="Inactive templates aren't offered for new contracts." />
        </FormSection>
        {!t && (
          <FormSection title="First version">
            <Field label="In effect from" required error={errors.from} hint="Contracts for events from this date use it. Later versions are added on the template's page.">
              {(id, d) => <DateInput id={id} aria-describedby={d} value={from} onChange={setFrom} />}
            </Field>
            <BodyEditor body={body} setBody={(v) => { setBody(v); setErrors(({ body: _, ...r }) => r); }} fileName={fileName} setFileName={setFileName}
              error={errors.body} onName={(n) => { if (!name.trim()) setName(n); }} />
          </FormSection>
        )}
        <FormSection title="Where it's used">
          {forEvents(type) ? (
            <Field label="Event types" wide hint="Contracts for experts on events of these types can use this template.">
              {(id, d) => <MultiSelect id={id} aria-describedby={d} aria-label="Event types" value={etypes} onChange={setEtypes} disabled={!canLink}
                placeholder="No event types yet" options={(eventTypes.data ?? []).filter((e) => e.is_active || etypes.includes(e.id)).map((e) => ({ value: e.id, label: e.name }))} />}
            </Field>
          ) : <p className="admin-section-note field-wide">Master Service Agreements belong to the expert, so they don't depend on an event type.</p>}
          <Field label="Countries" wide hint={forEvents(type)
            ? "Leave empty to use it in every country the event types are available in. Pick countries to limit it, e.g. a German version."
            : 'Leave empty for experts from every country.'}>
            {(id, d) => <MultiSelect id={id} aria-describedby={d} aria-label="Countries" value={ctry} onChange={setCtry} disabled={!canSave}
              placeholder="All countries" options={(countries.data ?? []).map((c) => ({ value: c.code, label: `${c.name} (${c.code})` }))} />}
          </Field>
        </FormSection>
      </form>
    </Modal>
  );
}

/** Add a version (starting from the latest text) or change one that no sent contract uses yet. */
function VersionModal({ template: t, version: v, onClose }: { template: ContractTemplateRow; version: TemplateVersion | null; onClose: (id?: string) => void }) {
  const qc = useQueryClient();
  const latest = t.contract_template_version[0];
  const [from, setFrom] = useState(v?.effective_from ?? (latest && latest.effective_from >= nextNewYear() ? '' : nextNewYear()));
  const [notes, setNotes] = useState(v?.notes ?? '');
  const [body, setBody] = useState(v?.body ?? latest?.body ?? '');
  const [fileName, setFileName] = useState(v?.file_name ?? latest?.file_name ?? null);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const dirty = v ? body !== v.body || from !== v.effective_from || notes !== (v.notes ?? '') : body !== (latest?.body ?? '') || Boolean(notes);

  const save = useMutation({
    mutationFn: async () => {
      const row = { effective_from: from, notes: notes.trim() || null, body, file_name: fileName };
      if (v) { await must(supabase.from('contract_template_version').update(row).eq('id', v.id)); return v.id; }
      return (await must(supabase.from('contract_template_version').insert({ ...row, contract_template_id: t.id }).select('id').single()))!.id as string;
    },
    onSuccess: (id) => { qc.invalidateQueries({ queryKey: [ADMIN_KEY] }); qc.invalidateQueries({ queryKey: ['contract-options'] }); onClose(id); },
    onError: () => scrollToError('version-form'),
  });
  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    const errs: Record<string, string> = {};
    if (!from) errs.from = 'Choose the date it takes effect';
    if (!body.trim()) errs.body = 'Upload a Markdown file or write the template';
    setErrors(errs);
    if (!Object.keys(errs).length) save.mutate();
  };

  return (
    <Modal open size="lg" title={v ? `${t.name}: version ${v.version}` : `${t.name}: new version`} onClose={() => onClose()}
      confirmClose={dirty && !save.isPending ? 'Discard this version?' : false}
      footerNote={v ? (v.contracts_using ? `${v.contracts_using} draft contract${v.contracts_using === 1 ? '' : 's'} use this version; they pick up changes when drafted again.` : undefined)
        : latest ? `Starts from version ${latest.version}'s text.` : undefined}
      footer={<>
        <button type="button" className="btn" onClick={() => onClose()}>Cancel</button>
        <button type="submit" form="version-form" className="btn btn-primary" disabled={save.isPending}>{save.isPending ? 'Saving…' : v ? 'Save version' : 'Add version'}</button>
      </>}>
      <form id="version-form" className="form" onSubmit={submit} noValidate>
        {save.error && <div className="form-error" role="alert" style={{ marginBottom: 16 }}>{save.error.message}</div>}
        <FormSection>
          <Field label="In effect from" required error={errors.from} hint="Contracts for events from this date get this version, until the next version starts.">
            {(id, d) => <DateInput id={id} aria-describedby={d} value={from} onChange={(x) => { setFrom(x); setErrors(({ from: _, ...r }) => r); }} />}
          </Field>
          <Field label="What changed" hint="Shown in the list of versions">
            {(id, d) => <input id={id} aria-describedby={d} className="input" value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="e.g. New payment terms" />}
          </Field>
          <BodyEditor body={body} setBody={(x) => { setBody(x); setErrors(({ body: _, ...r }) => r); }} fileName={fileName} setFileName={setFileName} error={errors.body} />
        </FormSection>
      </form>
    </Modal>
  );
}
