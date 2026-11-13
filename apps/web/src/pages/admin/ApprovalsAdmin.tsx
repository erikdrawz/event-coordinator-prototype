import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Plus, Trash2 } from 'lucide-react';
import { supabase } from '../../lib/supabase';
import { useAuth } from '../../lib/auth';
import { can } from '../../lib/permissions';
import { DataTable, useTableSort, type Column } from '../../ui/DataTable';
import { FilterSelect, SearchInput, Segmented, Toolbar } from '../../ui/Toolbar';
import { Modal } from '../../ui/Modal';
import { ConfirmDialog } from '../../ui/ConfirmDialog';
import { CheckboxField, Field, FormSection } from '../../ui/Form';
import { Select } from '../../ui/Select';
import { MultiSelect } from '../../ui/MultiSelect';
import { useRequestKinds } from '../requests/requestData';
import { AdminPage } from './AdminLayout';
import { ADMIN_KEY, must, useAreas, useCountries, useCustomFields, useEventTypes, useGroups, useUsers } from './adminData';

type Op = 'in' | 'not_in' | 'gt' | 'gte' | 'lt' | 'lte' | 'is_true' | 'is_false';
interface Criterion { field: string; op: Op; values?: string[]; value?: number }
type ApproverType = 'manager' | 'group' | 'user';
interface StepRow {
  id: string; step_number: number; name: string; approver_type: ApproverType;
  approver_user_id: string | null; approver_group_id: string | null; fallback_group_id: string | null;
}
interface ProcessRow {
  id: string; name: string; description: string | null; record_type: RecordType; priority: number; criteria: Criterion[]; is_active: boolean;
  email_approvers: boolean; approve_by_email: boolean; email_submitter: boolean;
  approval_process_step: StepRow[];
}
type Kind = 'choice' | 'number' | 'boolean';
type RecordType = 'request' | 'event';
const RECORD_TYPES: { value: RecordType; label: string; plural: string }[] = [
  { value: 'request', label: 'Requests', plural: 'requests' }, { value: 'event', label: 'Events', plural: 'events' },
];
interface FieldDef { code: string; label: string; kind: Kind; options: { value: string; label: string }[] }

const OPS: Record<Kind, { value: Op; label: string }[]> = {
  choice: [{ value: 'in', label: 'is one of' }, { value: 'not_in', label: 'is not one of' }],
  number: [{ value: 'gt', label: 'more than' }, { value: 'gte', label: 'at least' }, { value: 'lt', label: 'less than' }, { value: 'lte', label: 'at most' }],
  boolean: [{ value: 'is_true', label: 'is ticked' }, { value: 'is_false', label: 'is not ticked' }],
};
const APPROVER_TYPES: { value: ApproverType; label: string }[] = [
  { value: 'manager', label: "Submitter's manager" }, { value: 'group', label: 'Group' }, { value: 'user', label: 'Person' },
];
const KEY = [ADMIN_KEY, 'approval-processes'];
const NUMBER_ERROR = 'Give the step a number from 1 to 20';

function useProcesses() {
  return useQuery({
    queryKey: KEY,
    queryFn: async () => (await must(supabase.from('approval_process')
      .select('id,name,description,record_type,priority,criteria,is_active,email_approvers,approve_by_email,email_submitter,approval_process_step(id,step_number,name,approver_type,approver_user_id,approver_group_id,fallback_group_id)')
      .order('priority').order('name'))) as unknown as ProcessRow[],
  });
}

/** The fields criteria can test, per record type, with their choices: built-in ones and the object's custom fields. */
function useCriteriaFields(): Record<RecordType, FieldDef[]> {
  const base = useQuery({
    queryKey: ['approval-criteria-fields'], staleTime: Infinity,
    queryFn: async () => (await must(supabase.from('approval_criteria_field').select('record_type,code,label,kind').order('sort'))) as { record_type: RecordType; code: string; label: string; kind: Kind }[],
  });
  const kinds = useRequestKinds();
  const types = useEventTypes();
  const countries = useCountries();
  const areas = useAreas();
  const custom = useCustomFields();
  return useMemo(() => {
    const choices: Record<string, { value: string; label: string }[]> = {
      request_type: (kinds.data ?? []).map((k) => ({ value: k.code, label: k.label })),
      event_type_id: (types.data ?? []).map((t) => ({ value: t.id, label: t.name })),
      country_code: (countries.data ?? []).map((c) => ({ value: c.code, label: `${c.name} (${c.code})` })),
      therapeutic_area_id: (areas.data ?? []).map((a) => ({ value: a.id, label: a.name })),
    };
    const forType = (rt: RecordType): FieldDef[] => {
      const builtIn = (base.data ?? []).filter((f) => f.record_type === rt).map((f): FieldDef => ({ code: f.code, label: f.label, kind: f.kind, options: choices[f.code] ?? [] }));
      const object = rt === 'event' ? 'event' : 'event_request';
      const extra = (custom.data ?? []).filter((f) => f.is_active && f.object_name === object).flatMap((f): FieldDef[] => {
        const kind: Kind | null = f.field_type === 'picklist' ? 'choice' : f.field_type === 'number' || f.field_type === 'currency' ? 'number'
          : f.field_type === 'checkbox' ? 'boolean' : null;
        return kind ? [{ code: `custom.${f.api_name}`, label: f.label, kind, options: f.options }] : [];
      });
      return [...builtIn, ...extra];
    };
    return { request: forType('request'), event: forType('event') };
  }, [base.data, kinds.data, types.data, countries.data, areas.data, custom.data]);
}

/** "Request type is Tiering · Country is GB, IE", or "Every request" / "Every event". */
function criteriaText(criteria: Criterion[], fields: FieldDef[], rt: RecordType) {
  if (!criteria.length) return rt === 'event' ? 'Every event' : 'Every request';
  return criteria.map((c) => {
    const f = fields.find((x) => x.code === c.field);
    const op = f ? OPS[f.kind].find((o) => o.value === c.op)?.label : c.op;
    const val = c.values ? c.values.map((v) => f?.options.find((o) => o.value === v)?.label.replace(/ \([A-Z]{2}\)$/, '') ?? v).join(', ')
      : c.value != null ? c.value.toLocaleString('en-GB') : '';
    return [f?.label ?? c.field, op, val].filter(Boolean).join(' ');
  }).join(' · ');
}

/** "1. Manager, UKI Marketing → 2. UKI Medical" */
function stepsText(steps: StepRow[], who: (s: StepRow) => string) {
  const nums = [...new Set(steps.map((s) => s.step_number))].sort((a, b) => a - b);
  return nums.map((n, i) => `${i + 1}. ${steps.filter((s) => s.step_number === n).map(who).join(' + ')}`).join(' → ');
}

export function ApprovalsAdmin() {
  const { me } = useAuth();
  const processes = useProcesses();
  const fields = useCriteriaFields();
  const groups = useGroups();
  const users = useUsers();
  const [q, setQ] = useState('');
  const [rt, setRt] = useState('');
  const [editing, setEditing] = useState<ProcessRow | 'new' | null>(null);
  const who = useMemo(() => {
    const g = new Map((groups.data ?? []).map((x) => [x.id, x.name]));
    const u = new Map((users.data ?? []).map((x) => [x.id, x.display_name]));
    return (s: StepRow) => s.approver_type === 'manager' ? 'Manager' : s.approver_type === 'group' ? g.get(s.approver_group_id!) ?? 'Group' : u.get(s.approver_user_id!) ?? 'Person';
  }, [groups.data, users.data]);

  const columns = useMemo<Column<ProcessRow>[]>(() => [
    { id: 'name', header: 'Process', width: '24%', sortValue: (p) => p.name,
      cell: (p) => <><button className="dt-primary as-button" onClick={() => setEditing(p)}>{p.name}</button>
        {p.description && <div className="dt-sub">{p.description}</div>}</> },
    { id: 'type', header: 'For', width: '9%', sortValue: (p) => p.record_type, cell: (p) => RECORD_TYPES.find((r) => r.value === p.record_type)?.label },
    { id: 'criteria', header: 'Applies when', width: '24%', cell: (p) => <span className={p.criteria.length ? undefined : 'admin-all'}>{criteriaText(p.criteria, fields[p.record_type], p.record_type)}</span> },
    { id: 'steps', header: 'Approvers', width: '24%', cell: (p) => p.approval_process_step.length
      ? stepsText(p.approval_process_step, who) : <span className="admin-all">No steps: never applies</span> },
    { id: 'priority', header: 'Priority', width: '9%', sortValue: (p) => p.priority, cell: (p) => p.priority },
    { id: 'status', header: 'Status', width: '10%', sortValue: (p) => (p.is_active ? 0 : 1),
      cell: (p) => <span className={`pill ${p.is_active ? 'pill-green' : 'pill-grey'}`}>{p.is_active ? 'Active' : 'Inactive'}</span> },
  ], [fields, who]);

  const filtered = useMemo(() => processes.data?.filter((p) => (!rt || p.record_type === rt)
    && (!q || [p.name, p.description].some((v) => v?.toLowerCase().includes(q.toLowerCase())))), [processes.data, q, rt]);
  const { rows, sort, setSort } = useTableSort(filtered, columns, { columnId: 'priority', dir: 'asc' });

  return (
    <AdminPage title="Approvals"
      sub="Who approves which requests and events. On submit, the active process with the lowest priority number whose conditions all match applies."
      action={can(me, 'approval_process', 'create') && <button className="btn btn-primary" onClick={() => setEditing('new')}><Plus size={15} strokeWidth={2.6} />New process</button>}
      readOnlyNote={!can(me, 'approval_process', 'edit') && 'Approval processes are managed by System and Business Admins.'}>
      <Toolbar label="Filter approval processes">
        <SearchInput value={q} onChange={setQ} placeholder="Search processes" />
        <FilterSelect label="For" value={rt} onChange={setRt} options={RECORD_TYPES.map((r) => ({ value: r.value, label: r.label }))} />
      </Toolbar>
      <DataTable label="Approval processes" columns={columns} rows={rows} rowKey={(p) => p.id} sort={sort} onSortChange={setSort}
        loading={processes.isLoading} error={processes.error} empty="No approval processes yet: submitting is refused until one applies." />
      {editing && <ProcessEditor process={editing === 'new' ? null : editing} fields={fields} onClose={() => setEditing(null)} />}
    </AdminPage>
  );
}

type DraftStep = Omit<StepRow, 'id'> & { id?: string; key: string };
let keySeq = 0;
const newKey = () => `n${++keySeq}`;

function ProcessEditor({ process, fields: allFields, onClose }: { process: ProcessRow | null; fields: Record<RecordType, FieldDef[]>; onClose: () => void }) {
  const { me } = useAuth();
  const qc = useQueryClient();
  const groups = useGroups();
  const users = useUsers();
  const editable = process ? can(me, 'approval_process', 'edit') : can(me, 'approval_process', 'create');

  const [name, setName] = useState(process?.name ?? '');
  const [description, setDescription] = useState(process?.description ?? '');
  const [priority, setPriority] = useState(String(process?.priority ?? 50));
  const [active, setActive] = useState(process?.is_active ?? true);
  const [recordType, setRecordType] = useState<RecordType>(process?.record_type ?? 'request');
  const [emailApprovers, setEmailApprovers] = useState(process?.email_approvers ?? true);
  const [approveByEmail, setApproveByEmail] = useState(process?.approve_by_email ?? true);
  const [emailSubmitter, setEmailSubmitter] = useState(process?.email_submitter ?? true);
  const repliesOn = Boolean(me?.tenant.email_replies);
  const fields = allFields[recordType];
  const [criteria, setCriteria] = useState<Criterion[]>(process?.criteria ?? []);
  const [steps, setSteps] = useState<DraftStep[]>(() => process
    ? process.approval_process_step.slice().sort((a, b) => a.step_number - b.step_number || a.name.localeCompare(b.name)).map((s) => ({ ...s, key: s.id }))
    : [{ key: newKey(), step_number: 1, name: 'Manager approval', approver_type: 'manager', approver_user_id: null, approver_group_id: null, fallback_group_id: null }]);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [deleting, setDeleting] = useState(false);

  const groupOptions = (groups.data ?? []).filter((g) => g.is_active || steps.some((s) => s.approver_group_id === g.id || s.fallback_group_id === g.id))
    .map((g) => ({ value: g.id, label: g.is_active ? g.name : `${g.name} (inactive)` }));
  const personOptions = (users.data ?? []).filter((u) => u.user_type === 'human' && (u.status === 'active' || steps.some((s) => s.approver_user_id === u.id)))
    .map((u) => ({ value: u.id, label: u.status === 'active' ? u.display_name : `${u.display_name} (inactive)` }));
  const setStep = (key: string, patch: Partial<DraftStep>) => setSteps((all) => all.map((s) => (s.key === key ? { ...s, ...patch } : s)));
  const setCrit = (i: number, c: Criterion) => setCriteria((all) => all.map((x, j) => (j === i ? c : x)));

  const save = useMutation({
    mutationFn: async () => {
      const row = { name: name.trim(), description: description.trim() || null, priority: Number(priority), is_active: active, criteria,
                    email_approvers: emailApprovers, approve_by_email: approveByEmail, email_submitter: emailSubmitter,
                    ...(process ? {} : { record_type: recordType }) };
      let id = process?.id;
      if (id) await must(supabase.from('approval_process').update(row).eq('id', id));
      else id = (await must(supabase.from('approval_process').insert(row).select('id').single()))!.id;
      const keep = steps.filter((s) => s.id).map((s) => s.id!);
      const removed = (process?.approval_process_step ?? []).filter((s) => !keep.includes(s.id)).map((s) => s.id);
      if (removed.length) await must(supabase.from('approval_process_step').delete().in('id', removed));
      for (const s of steps) {
        const r = { step_number: s.step_number, name: s.name.trim(), approver_type: s.approver_type,
          approver_user_id: s.approver_type === 'user' ? s.approver_user_id : null,
          approver_group_id: s.approver_type === 'group' ? s.approver_group_id : null,
          fallback_group_id: s.approver_type === 'manager' ? s.fallback_group_id : null };
        if (s.id) await must(supabase.from('approval_process_step').update(r).eq('id', s.id));
        else await must(supabase.from('approval_process_step').insert({ ...r, process_id: id }));
      }
    },
    onSuccess: () => { qc.invalidateQueries({ queryKey: [ADMIN_KEY] }); onClose(); },
    onError: () => qc.invalidateQueries({ queryKey: KEY }),
  });
  const remove = useMutation({
    mutationFn: async () => { await must(supabase.from('approval_process').delete().eq('id', process!.id)); },
    onSuccess: () => { qc.invalidateQueries({ queryKey: [ADMIN_KEY] }); onClose(); },
  });

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    const errs: Record<string, string> = {};
    if (!name.trim()) errs.name = 'Give the process a name';
    if (!/^-?\d+$/.test(priority.trim())) errs.priority = 'A whole number, e.g. 10';
    criteria.forEach((c, i) => {
      if (!c.field) errs[`c${i}`] = 'Choose a field';
      else if ((c.op === 'in' || c.op === 'not_in') && !c.values?.length) errs[`c${i}`] = 'Choose at least one value';
      else if (['gt', 'gte', 'lt', 'lte'].includes(c.op) && (c.value == null || Number.isNaN(c.value))) errs[`c${i}`] = 'Enter a number';
    });
    if (!steps.length) errs.steps = 'Add at least one step';
    steps.forEach((s) => {
      if (!(s.step_number >= 1 && s.step_number <= 20)) errs[s.key] = NUMBER_ERROR;
      else if (!s.name.trim()) errs[s.key] = 'Name the step';
      else if (s.approver_type === 'group' && !s.approver_group_id) errs[s.key] = 'Choose the group';
      else if (s.approver_type === 'user' && !s.approver_user_id) errs[s.key] = 'Choose the person';
    });
    setErrors(errs);
    if (!Object.keys(errs).length) save.mutate();
  };

  if (deleting && process) {
    return (
      <ConfirmDialog title={`Delete ${process.name}?`} confirmLabel="Delete process" pending={remove.isPending} error={remove.error?.message}
        onConfirm={() => remove.mutate()} onCancel={() => { remove.reset(); setDeleting(false); }}>
        {process.record_type === 'event' ? 'Events' : 'Requests'} submitted from now on go through another process, or can't be submitted if none applies.
        Approvals already running carry on as they were. To pause it instead, make it inactive.
      </ConfirmDialog>
    );
  }

  return (
    <Modal open size="lg" title={process ? process.name : 'New approval process'} onClose={onClose}
      footerNote={process && editable && can(me, 'approval_process', 'delete') && (
        <button type="button" className="btn btn-danger-outline" onClick={() => setDeleting(true)}><Trash2 size={14} />Delete process</button>
      )}
      footer={<>
        <button type="button" className="btn" onClick={onClose}>{editable ? 'Cancel' : 'Close'}</button>
        {editable && <button type="submit" form="process-form" className="btn btn-primary" disabled={save.isPending}>{save.isPending ? 'Saving…' : process ? 'Save changes' : 'Create process'}</button>}
      </>}>
      <form id="process-form" className="form" onSubmit={submit} noValidate>
        {save.error && <div className="form-error" role="alert" style={{ marginBottom: 16 }}>{save.error.message}</div>}
        <div className="admin-note">Changes apply to {recordType === 'event' ? 'events' : 'requests'} submitted from now on. Approvals already running keep the approvers they started with.</div>

        <FormSection title="Process">
          <Field label="Name" required error={errors.name}>
            {(id, d) => <input id={id} aria-describedby={d} aria-invalid={Boolean(errors.name) || undefined} className="input" value={name}
              disabled={!editable} autoFocus={!process} placeholder="e.g. UK & Ireland advisory boards" onChange={(e) => setName(e.target.value)} />}
          </Field>
          <Field label="Status">
            {() => <Segmented label="Status" value={active ? 'active' : 'inactive'} onChange={editable ? (v) => setActive(v === 'active') : () => {}}
              options={[{ value: 'active', label: 'Active' }, { value: 'inactive', label: 'Inactive' }]} />}
          </Field>
          <Field label="Description" wide>
            {(id) => <input id={id} className="input" value={description} disabled={!editable} onChange={(e) => setDescription(e.target.value)} />}
          </Field>
          <Field label="Applies to" hint={process ? 'Fixed once created.' : 'Content approvals come next.'}>
            {() => <Segmented label="Applies to" value={recordType} options={RECORD_TYPES.map((r) => ({ value: r.value, label: r.label }))}
              onChange={process || !editable ? () => {} : (v) => { setRecordType(v); setCriteria([]); }} />}
          </Field>
          <Field label="Priority" required error={errors.priority} hint="Lower numbers are checked first; give catch-all processes a high one.">
            {(id, d) => <input id={id} aria-describedby={d} className="input" inputMode="numeric" value={priority} disabled={!editable}
              onChange={(e) => setPriority(e.target.value)} />}
          </Field>
        </FormSection>

        <FormSection title="Applies when">
          <div className="field-wide proc-rows">
            {criteria.length === 0 && <div className="admin-all">Every {recordType}. Add conditions to narrow it; all of them must match.</div>}
            {criteria.map((c, i) => {
              const f = fields.find((x) => x.code === c.field);
              return (
                <div key={i} className="proc-row">
                  <div className="proc-cells proc-crit">
                    <Select aria-label={`Condition ${i + 1} field`} value={c.field} placeholder="Field" disabled={!editable}
                      options={fields.map((x) => ({ value: x.code, label: x.label }))}
                      onChange={(v) => { const k = fields.find((x) => x.code === v)!.kind; setCrit(i, { field: v, op: OPS[k][0].value, ...(k === 'choice' ? { values: [] } : {}) }); }} />
                    {f && <Select aria-label={`Condition ${i + 1} test`} value={c.op} disabled={!editable} options={OPS[f.kind]}
                      onChange={(v) => setCrit(i, { ...c, op: v as Op })} />}
                    {f?.kind === 'choice' && <MultiSelect aria-label={`Condition ${i + 1} values`} value={c.values ?? []} disabled={!editable}
                      placeholder="Choose values" options={f.options} onChange={(v) => setCrit(i, { ...c, values: v })} />}
                    {f?.kind === 'number' && <input className="input" aria-label={`Condition ${i + 1} number`} inputMode="decimal" disabled={!editable}
                      value={c.value ?? ''} onChange={(e) => setCrit(i, { ...c, value: e.target.value === '' ? undefined : Number(e.target.value) })} />}
                  </div>
                  {editable && <button type="button" className="btn btn-ghost" aria-label={`Remove condition ${i + 1}`}
                    onClick={() => setCriteria((all) => all.filter((_, j) => j !== i))}><Trash2 size={15} /></button>}
                  {errors[`c${i}`] && <span className="field-error proc-error">{errors[`c${i}`]}</span>}
                </div>
              );
            })}
            {editable && <span><button type="button" className="btn" onClick={() => setCriteria((all) => [...all, { field: '', op: 'in', values: [] }])}>
              <Plus size={14} />Add condition</button></span>}
          </div>
        </FormSection>

        <FormSection title="Steps">
          <div className="field-wide proc-rows">
            <div className="field-hint">Steps run in order of their number; steps with the same number run in parallel. A group step needs one member's decision. Nobody approves what they submitted.</div>
            {errors.steps && <span className="field-error">{errors.steps}</span>}
            {steps.map((s) => (
              <div key={s.key} className="proc-row">
                <div className="proc-cells proc-step">
                  {/* Digits only; empty (0) while typing, checked on save */}
                  <input className="input proc-num" aria-label="Step number" inputMode="numeric" value={s.step_number || ''} disabled={!editable}
                    aria-invalid={errors[s.key] === NUMBER_ERROR || undefined}
                    onChange={(e) => { const t = e.target.value.replace(/\D/g, '').slice(0, 2); setStep(s.key, { step_number: t ? Number(t) : 0 }); }} />
                  <input className="input" aria-label="Step name" value={s.name} placeholder="e.g. Medical review" disabled={!editable}
                    onChange={(e) => setStep(s.key, { name: e.target.value })} />
                  <Select aria-label="Approver" value={s.approver_type} disabled={!editable} options={APPROVER_TYPES}
                    onChange={(v) => setStep(s.key, { approver_type: v as ApproverType })} />
                  {s.approver_type === 'group' && <Select aria-label="Group" value={s.approver_group_id ?? ''} searchable placeholder="Choose a group" disabled={!editable}
                    options={groupOptions} onChange={(v) => setStep(s.key, { approver_group_id: v })} />}
                  {s.approver_type === 'user' && <Select aria-label="Person" value={s.approver_user_id ?? ''} searchable placeholder="Choose a person" disabled={!editable}
                    options={personOptions} onChange={(v) => setStep(s.key, { approver_user_id: v })} />}
                  {s.approver_type === 'manager' && <Select aria-label="Fallback group" value={s.fallback_group_id ?? ''} searchable disabled={!editable}
                    placeholder="No fallback" emptyLabel="No fallback" options={groupOptions.map((o) => ({ ...o, label: `Fallback: ${o.label}` }))}
                    onChange={(v) => setStep(s.key, { fallback_group_id: v || null })} />}
                </div>
                {editable && <button type="button" className="btn btn-ghost" aria-label={`Remove step ${s.name || s.step_number}`}
                  onClick={() => setSteps((all) => all.filter((x) => x.key !== s.key))}><Trash2 size={15} /></button>}
                {errors[s.key] && <span className="field-error proc-error">{errors[s.key]}</span>}
              </div>
            ))}
            {steps.some((s) => s.approver_type === 'manager') && (
              <div className="field-hint">Manager steps: when the submitter has no manager, the fallback group approves; with no fallback, submitting is refused.</div>
            )}
            {editable && <span><button type="button" className="btn" onClick={() => setSteps((all) => [...all, {
              key: newKey(), step_number: (Math.max(0, ...all.map((s) => s.step_number)) + 1), name: '', approver_type: 'group',
              approver_user_id: null, approver_group_id: null, fallback_group_id: null }])}>
              <Plus size={14} />Add step</button></span>}
          </div>
        </FormSection>

        <FormSection title="Email">
          <CheckboxField label="Email approvers when their step starts" checked={emailApprovers} onChange={setEmailApprovers} disabled={!editable}
            hint="They're always notified in Event Center; this adds an email with the details." />
          <CheckboxField label="Approvers can approve or reject by replying" checked={approveByEmail && repliesOn} onChange={setApproveByEmail}
            disabled={!editable || !repliesOn || !emailApprovers}
            hint={!repliesOn ? 'Replying by email is turned off for the organisation (Admin → Settings).'
              : 'Off: the email only links to Event Center, where they sign in to decide. Choose off where a sign-off must be given in the app.'} />
          <CheckboxField label={recordType === 'event' ? "Email the outcome to the event's owner and submitter" : 'Email the outcome to the requester'}
            checked={emailSubmitter} onChange={setEmailSubmitter} disabled={!editable}
            hint="Approved, or rejected with the reason. They're always notified in Event Center." />
        </FormSection>
      </form>
    </Modal>
  );
}
