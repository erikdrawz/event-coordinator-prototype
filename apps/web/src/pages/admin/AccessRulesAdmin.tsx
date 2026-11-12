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
import { ConfirmDialog } from '../../ui/ConfirmDialog';
import { Field, FormSection } from '../../ui/Form';
import { Select } from '../../ui/Select';
import { MultiSelect } from '../../ui/MultiSelect';
import { AdminPage } from './AdminLayout';
import { ADMIN_KEY, must, useAccessRules, useCountries, useEventTypes, useGroups, type AccessRuleRow, type RuleAppliesTo } from './adminData';

export const ACCESS = [
  { value: 'viewer', label: 'Viewer', hint: 'Members see the events and requests and post on their boards.' },
  { value: 'organizer', label: 'Organizer', hint: 'Members edit the events and requests and manage their teams.' },
];
export const APPLIES_TO: { value: RuleAppliesTo; label: string }[] = [
  { value: 'all', label: 'Events and requests' },
  { value: 'events', label: 'Events' },
  { value: 'requests', label: 'Requests' },
];

/** Country codes, or All. */
export function RuleCountries({ codes }: { codes: string[] | null }) {
  if (!codes?.length) return <span className="admin-all">All countries</span>;
  return <span className="admin-codes">{codes.slice(0, 8).map((c) => <span key={c} className="admin-code">{c}</span>)}
    {codes.length > 8 && <span className="admin-all">+{codes.length - 8}</span>}</span>;
}

/** One line saying what a rule does, e.g. "Viewer on events in GB, IE · Advisory board, Conference". */
export function ruleSummary(r: AccessRuleRow, typeName: (id: string) => string) {
  const what = APPLIES_TO.find((a) => a.value === r.applies_to)!.label.toLowerCase();
  const where = r.country_codes?.length ? `in ${r.country_codes.join(', ')}` : 'in every country';
  const types = r.event_type_ids?.length ? r.event_type_ids.map(typeName).join(', ') : 'all event types';
  return `${ACCESS.find((a) => a.value === r.team_role)?.label} on ${what} ${where} · ${types}`;
}

export function AccessRulesAdmin() {
  const { me } = useAuth();
  const rules = useAccessRules();
  const groups = useGroups();
  const types = useEventTypes();
  const [params, setParams] = useSearchParams();
  const [q, setQ] = useState('');
  const [applies, setApplies] = useState('');
  const [editing, setEditing] = useState<AccessRuleRow | 'new' | null>(null);
  const group = params.get('group') ?? '';
  const setGroup = (v: string) => setParams(v ? { group: v } : {}, { replace: true });

  const groupName = useMemo(() => {
    const m = new Map((groups.data ?? []).map((g) => [g.id, g]));
    return (id: string) => m.get(id)?.name ?? '—';
  }, [groups.data]);
  const groupActive = (id: string) => groups.data?.find((g) => g.id === id)?.is_active ?? true;
  const typeName = useMemo(() => {
    const m = new Map((types.data ?? []).map((t) => [t.id, t.name]));
    return (id: string) => m.get(id) ?? 'Unknown type';
  }, [types.data]);

  const columns = useMemo<Column<AccessRuleRow>[]>(() => [
    { id: 'group', header: 'Group', width: '24%', sortValue: (r) => groupName(r.group_id),
      cell: (r) => <><button className="dt-primary as-button" onClick={() => setEditing(r)}>{groupName(r.group_id)}</button>
        {r.note && <div className="dt-sub">{r.note}</div>}</> },
    { id: 'applies', header: 'Applies to', width: '14%', sortValue: (r) => r.applies_to,
      cell: (r) => APPLIES_TO.find((a) => a.value === r.applies_to)?.label },
    { id: 'countries', header: 'Countries', width: '18%', sortValue: (r) => r.country_codes?.length ?? 999,
      cell: (r) => <RuleCountries codes={r.country_codes} /> },
    { id: 'types', header: 'Event types', width: '20%', sortValue: (r) => r.event_type_ids?.length ?? 999,
      cell: (r) => r.event_type_ids?.length ? r.event_type_ids.map(typeName).sort().join(', ') : <span className="admin-all">All event types</span> },
    { id: 'access', header: 'Access', width: '10%', sortValue: (r) => r.team_role,
      cell: (r) => ACCESS.find((a) => a.value === r.team_role)?.label },
    { id: 'status', header: 'Status', width: '12%', sortValue: (r) => (r.is_active && groupActive(r.group_id) ? 0 : 1),
      cell: (r) => !r.is_active ? <span className="pill pill-grey">Inactive</span>
        : !groupActive(r.group_id) ? <span className="pill pill-grey" data-tip="The group is inactive, so the rule doesn't apply">Group inactive</span>
        : <span className="pill pill-green">Active</span> },
  ], [groupName, typeName, groups.data]); // eslint-disable-line react-hooks/exhaustive-deps

  const filtered = useMemo(() => rules.data?.filter((r) => (!group || r.group_id === group) && (!applies || r.applies_to === applies)
    && (!q || [groupName(r.group_id), r.note].some((v) => v?.toLowerCase().includes(q.toLowerCase())))), [rules.data, group, applies, q, groupName]);
  const { rows, sort, setSort } = useTableSort(filtered, columns, { columnId: 'group', dir: 'asc' });

  return (
    <AdminPage title="Access rules"
      sub="Put groups on the team of events and requests automatically, by country and event type. Members get the rule's access for as long as they're in the group."
      action={can(me, 'access_rule', 'create') && <button className="btn btn-primary" onClick={() => setEditing('new')}><Plus size={15} strokeWidth={2.6} />New rule</button>}
      readOnlyNote={!can(me, 'access_rule', 'edit') && 'Access rules are managed by System and Business Admins.'}>
      <Toolbar label="Filter access rules">
        <SearchInput value={q} onChange={setQ} placeholder="Search rules" />
        <FilterSelect label="Group" value={group} onChange={setGroup} options={(groups.data ?? []).map((g) => ({ value: g.id, label: g.name }))} />
        <FilterSelect label="Applies to" value={applies} onChange={setApplies} options={APPLIES_TO} />
      </Toolbar>
      <DataTable label="Access rules" columns={columns} rows={rows} rowKey={(r) => r.id} sort={sort} onSortChange={setSort}
        loading={rules.isLoading} error={rules.error} empty={group ? 'No rules for this group yet.' : 'No access rules yet.'} />
      {editing && <RuleEditor rule={editing === 'new' ? null : editing} defaultGroup={group} onClose={() => setEditing(null)} />}
    </AdminPage>
  );
}

function RuleEditor({ rule, defaultGroup, onClose }: { rule: AccessRuleRow | null; defaultGroup: string; onClose: () => void }) {
  const { me } = useAuth();
  const qc = useQueryClient();
  const groups = useGroups();
  const countries = useCountries();
  const types = useEventTypes();
  const editable = rule ? can(me, 'access_rule', 'edit') : can(me, 'access_rule', 'create');

  const [groupId, setGroupId] = useState(rule?.group_id ?? defaultGroup);
  const [applies, setApplies] = useState<RuleAppliesTo>(rule?.applies_to ?? 'all');
  const [ctry, setCtry] = useState<string[]>(rule?.country_codes ?? []);
  const [typeIds, setTypeIds] = useState<string[]>(rule?.event_type_ids ?? []);
  const [role, setRole] = useState<string>(rule?.team_role ?? 'viewer');
  const [note, setNote] = useState(rule?.note ?? '');
  const [active, setActive] = useState(rule?.is_active ?? true);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [deleting, setDeleting] = useState(false);
  const refresh = () => qc.invalidateQueries({ queryKey: [ADMIN_KEY] });

  // Inactive groups and event types stay choosable when the rule already names them
  const groupOptions = (groups.data ?? []).filter((g) => g.is_active || g.id === rule?.group_id)
    .map((g) => ({ value: g.id, label: g.is_active ? g.name : `${g.name} (inactive)` }));
  const typeOptions = (types.data ?? []).filter((t) => t.is_active || rule?.event_type_ids?.includes(t.id))
    .map((t) => ({ value: t.id, label: t.is_active ? t.name : `${t.name} (inactive)` }));

  const save = useMutation({
    mutationFn: async () => {
      const row = { group_id: groupId, applies_to: applies, country_codes: ctry.length ? ctry : null,
                    event_type_ids: typeIds.length ? typeIds : null, team_role: role, note: note.trim() || null, is_active: active };
      if (rule) await must(supabase.from('access_rule').update(row).eq('id', rule.id));
      else await must(supabase.from('access_rule').insert(row));
    },
    onSuccess: () => { refresh(); onClose(); },
  });
  const remove = useMutation({
    mutationFn: async () => { await must(supabase.from('access_rule').delete().eq('id', rule!.id)); },
    onSuccess: () => { refresh(); onClose(); },
  });

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    const errs: Record<string, string> = {};
    if (!groupId) errs.group = 'Choose the group';
    setErrors(errs);
    if (!Object.keys(errs).length) save.mutate();
  };

  if (deleting && rule) {
    return (
      <ConfirmDialog title="Delete this rule?" confirmLabel="Delete rule" pending={remove.isPending} error={remove.error?.message}
        onConfirm={() => remove.mutate()} onCancel={() => { remove.reset(); setDeleting(false); }}>
        The group leaves the team of open events and requests in review that only this rule put it on.
        Closed events and decided requests keep it.
      </ConfirmDialog>
    );
  }

  return (
    <Modal open size="lg" title={rule ? 'Access rule' : 'New access rule'} onClose={onClose}
      footerNote={rule && editable && can(me, 'access_rule', 'delete') && (
        <button type="button" className="btn btn-danger-outline" onClick={() => setDeleting(true)}><Trash2 size={14} />Delete rule</button>
      )}
      footer={<>
        <button type="button" className="btn" onClick={onClose}>{editable ? 'Cancel' : 'Close'}</button>
        {editable && <button type="submit" form="rule-form" className="btn btn-primary" disabled={save.isPending}>{save.isPending ? 'Saving…' : rule ? 'Save changes' : 'Create rule'}</button>}
      </>}>
      <form id="rule-form" className="form" onSubmit={submit} noValidate>
        {save.error && <div className="form-error" role="alert" style={{ marginBottom: 16 }}>{save.error.message}</div>}
        <div className="admin-note">Changes apply right away to open events and requests in review. Closed events and decided requests keep the access they had.</div>

        <FormSection title="Who gets access">
          <Field label="Group" required error={errors.group}>
            {(id, d) => <Select id={id} aria-describedby={d} value={groupId} searchable placeholder="Choose a group" disabled={!editable}
              onChange={(v) => { setGroupId(v); setErrors({}); }} options={groupOptions} />}
          </Field>
          <Field label="Access" hint={ACCESS.find((a) => a.value === role)?.hint}>
            {(id, d) => <Select id={id} aria-describedby={d} value={role} onChange={setRole} disabled={!editable}
              options={ACCESS.map((a) => ({ value: a.value, label: a.label }))} />}
          </Field>
        </FormSection>

        <FormSection title="Where it applies">
          <Field label="Applies to" wide hint={applies !== 'events' ? 'Requests get the group once submitted; drafts stay private.' : undefined}>
            {() => <Segmented label="Applies to" value={applies} onChange={editable ? setApplies : () => {}} options={APPLIES_TO} />}
          </Field>
          <Field label="Countries" wide hint="Leave empty for every country.">
            {(id, d) => <MultiSelect id={id} aria-describedby={d} aria-label="Countries" value={ctry} onChange={setCtry} disabled={!editable}
              placeholder="All countries" options={(countries.data ?? []).map((c) => ({ value: c.code, label: `${c.name} (${c.code})` }))} />}
          </Field>
          <Field label="Event types" wide hint={applies !== 'events'
            ? 'Leave empty for every event type. Tiering requests have no event type, so only rules for every event type apply to them.'
            : 'Leave empty for every event type.'}>
            {(id, d) => <MultiSelect id={id} aria-describedby={d} aria-label="Event types" value={typeIds} onChange={setTypeIds} disabled={!editable}
              placeholder="All event types" options={typeOptions} />}
          </Field>
        </FormSection>

        <FormSection title="Details">
          <Field label="Note" wide hint="Why the rule exists, for whoever reads it next.">
            {(id, d) => <input id={id} aria-describedby={d} className="input" value={note} disabled={!editable}
              placeholder="e.g. Medical follows advisory boards in the UK and Ireland" onChange={(e) => setNote(e.target.value)} />}
          </Field>
          <Field label="Status" hint="An inactive rule adds nobody; groups it added leave open events and requests in review.">
            {() => <Segmented label="Status" value={active ? 'active' : 'inactive'} onChange={editable ? (v) => setActive(v === 'active') : () => {}}
              options={[{ value: 'active', label: 'Active' }, { value: 'inactive', label: 'Inactive' }]} />}
          </Field>
        </FormSection>
      </form>
    </Modal>
  );
}
