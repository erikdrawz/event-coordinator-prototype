import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Plus, Trash2 } from 'lucide-react';
import { supabase } from '../../lib/supabase';
import { useAuth } from '../../lib/auth';
import { can } from '../../lib/permissions';
import { Avatar } from '../../components/Avatar';
import { DataTable, useTableSort, type Column } from '../../ui/DataTable';
import { SearchInput, Segmented, Toolbar } from '../../ui/Toolbar';
import { Modal } from '../../ui/Modal';
import { ConfirmDialog } from '../../ui/ConfirmDialog';
import { Field, FormSection } from '../../ui/Form';
import { MultiSelect } from '../../ui/MultiSelect';
import { AdminPage } from './AdminLayout';
import { ACCESS, ruleSummary } from './AccessRulesAdmin';
import { ADMIN_KEY, must, syncLinks, useAccessRules, useEventTypes, useGroups, useUsers, type AccessRuleRow, type GroupRow, type UserRow } from './adminData';

/** The rules that put the group on teams, as access levels: "Viewer · 1 rule". */
function RulesCell({ rules }: { rules: AccessRuleRow[] }) {
  const live = rules.filter((r) => r.is_active);
  if (!live.length) return <span className="admin-all">{rules.length ? 'Rules inactive' : 'No rules'}</span>;
  const roles = [...new Set(live.map((r) => ACCESS.find((a) => a.value === r.team_role)?.label))].join(', ');
  return <>{roles}<div className="dt-sub">{live.length} rule{live.length === 1 ? '' : 's'}</div></>;
}

/** Up to five faces, then a count. */
function Members({ ids, people }: { ids: string[]; people: Map<string, UserRow> }) {
  if (!ids.length) return <span className="admin-all">No members</span>;
  const shown = ids.map((id) => people.get(id)).filter(Boolean) as UserRow[];
  const names = shown.map((u) => u.display_name).sort().join(', ');
  return (
    <span className="group-faces" data-tip={names} tabIndex={0} aria-label={names}>
      {shown.slice(0, 5).map((u) => <Avatar key={u.id} size={24} initials={u.initials} color={u.avatar_color} />)}
      {ids.length > 5 && <span className="group-faces-more">+{ids.length - 5}</span>}
    </span>
  );
}

export function GroupsAdmin() {
  const { me } = useAuth();
  const groups = useGroups();
  const rules = useAccessRules();
  const users = useUsers();
  const [q, setQ] = useState('');
  const [editing, setEditing] = useState<GroupRow | 'new' | null>(null);
  const people = useMemo(() => new Map((users.data ?? []).map((u) => [u.id, u])), [users.data]);
  const rulesOf = useMemo(() => {
    const m = new Map<string, AccessRuleRow[]>();
    for (const r of rules.data ?? []) m.set(r.group_id, [...(m.get(r.group_id) ?? []), r]);
    return (id: string) => m.get(id) ?? [];
  }, [rules.data]);

  const columns = useMemo<Column<GroupRow>[]>(() => [
    { id: 'name', header: 'Group', width: '38%', sortValue: (g) => g.name,
      cell: (g) => <><button className="dt-primary as-button" onClick={() => setEditing(g)}>{g.name}</button>
        {g.description && <div className="dt-sub">{g.description}</div>}</> },
    { id: 'members', header: 'Members', width: '22%', sortValue: (g) => g.user_group_member.length,
      cell: (g) => <Members ids={g.user_group_member.map((m) => m.user_id)} people={people} /> },
    { id: 'rules', header: 'Access on teams', width: '22%', sortValue: (g) => rulesOf(g.id).filter((r) => r.is_active).length,
      cell: (g) => <RulesCell rules={rulesOf(g.id)} /> },
    { id: 'status', header: 'Status', width: '12%', sortValue: (g) => (g.is_active ? 0 : 1),
      cell: (g) => <span className={`pill ${g.is_active ? 'pill-green' : 'pill-grey'}`}>{g.is_active ? 'Active' : 'Inactive'}</span> },
  ], [people, rulesOf]);

  const filtered = useMemo(() => groups.data?.filter((g) => !q || [g.name, g.description].some((v) => v?.toLowerCase().includes(q.toLowerCase()))),
    [groups.data, q]);
  const { rows, sort, setSort } = useTableSort(filtered, columns, { columnId: 'name', dir: 'asc' });

  return (
    <AdminPage title="Groups" sub="Named sets of people. Access rules put groups on teams; teams can add them by hand, and approval processes will use them to approve."
      action={can(me, 'user_group', 'create') && <button className="btn btn-primary" onClick={() => setEditing('new')}><Plus size={15} strokeWidth={2.6} />New group</button>}
      readOnlyNote={!can(me, 'user_group', 'edit') && 'Groups are managed by System and Business Admins.'}>
      <Toolbar label="Filter groups">
        <SearchInput value={q} onChange={setQ} placeholder="Search groups" />
      </Toolbar>
      <DataTable label="Groups" columns={columns} rows={rows} rowKey={(g) => g.id} sort={sort} onSortChange={setSort}
        loading={groups.isLoading} error={groups.error} empty="No groups yet." />
      {editing && <GroupEditor group={editing === 'new' ? null : editing} rules={editing === 'new' ? [] : rulesOf(editing.id)} onClose={() => setEditing(null)} />}
    </AdminPage>
  );
}

function GroupEditor({ group, rules, onClose }: { group: GroupRow | null; rules: AccessRuleRow[]; onClose: () => void }) {
  const { me } = useAuth();
  const qc = useQueryClient();
  const users = useUsers();
  const types = useEventTypes();
  const typeName = (id: string) => types.data?.find((t) => t.id === id)?.name ?? 'Unknown type';
  const editable = group ? can(me, 'user_group', 'edit') : can(me, 'user_group', 'create');
  const beforeMembers = group?.user_group_member.map((m) => m.user_id) ?? [];

  const [name, setName] = useState(group?.name ?? '');
  const [description, setDescription] = useState(group?.description ?? '');
  const [members, setMembers] = useState(beforeMembers);
  const [active, setActive] = useState(group?.is_active ?? true);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [deleting, setDeleting] = useState(false);

  // Members are active people; someone already in the group stays listed if they've left
  const memberOptions = (users.data ?? [])
    .filter((u) => u.user_type === 'human' && (u.status === 'active' || beforeMembers.includes(u.id)))
    .map((u) => ({ value: u.id, label: u.status === 'active' ? u.display_name : `${u.display_name} (inactive)` }));
  const refresh = () => qc.invalidateQueries({ queryKey: [ADMIN_KEY] });

  const save = useMutation({
    mutationFn: async () => {
      const row = { name: name.trim(), description: description.trim() || null, is_active: active };
      let id = group?.id;
      if (id) await must(supabase.from('user_group').update(row).eq('id', id));
      else id = (await must(supabase.from('user_group').insert(row).select('id').single()))!.id;
      await syncLinks('user_group_member', 'group_id', id!, 'user_id', beforeMembers, members);
    },
    onSuccess: () => { refresh(); onClose(); },
  });
  const remove = useMutation({
    mutationFn: async () => { await must(supabase.from('user_group').delete().eq('id', group!.id)); },
    onSuccess: () => { refresh(); onClose(); },
  });

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    const errs: Record<string, string> = {};
    if (!name.trim()) errs.name = 'Give the group a name';
    setErrors(errs);
    if (!Object.keys(errs).length) save.mutate();
  };

  if (deleting && group) {
    return (
      <ConfirmDialog title={`Delete ${group.name}?`} confirmLabel="Delete group" pending={remove.isPending} error={remove.error?.message}
        onConfirm={() => remove.mutate()} onCancel={() => { remove.reset(); setDeleting(false); }}>
        It leaves the team of every event and request it's on, its access rules are deleted, and its members lose the access it gave them.
        To keep it for later, make it inactive instead.
      </ConfirmDialog>
    );
  }

  return (
    <Modal open size="lg" title={group ? group.name : 'New group'} onClose={onClose}
      footerNote={group && editable && can(me, 'user_group', 'delete') && (
        <button type="button" className="btn btn-danger-outline" onClick={() => setDeleting(true)}><Trash2 size={14} />Delete group</button>
      )}
      footer={<>
        <button type="button" className="btn" onClick={onClose}>{editable ? 'Cancel' : 'Close'}</button>
        {editable && <button type="submit" form="group-form" className="btn btn-primary" disabled={save.isPending}>{save.isPending ? 'Saving…' : group ? 'Save changes' : 'Create group'}</button>}
      </>}>
      <form id="group-form" className="form" onSubmit={submit} noValidate>
        {save.error && <div className="form-error" role="alert" style={{ marginBottom: 16 }}>{save.error.message}</div>}

        <FormSection title="Group">
          <Field label="Name" required error={errors.name}>
            {(id, d) => <input id={id} aria-describedby={d} aria-invalid={Boolean(errors.name) || undefined} className="input" value={name}
              disabled={!editable} autoFocus={!group} placeholder="e.g. UKI Medical" onChange={(e) => setName(e.target.value)} />}
          </Field>
          <Field label="Status" hint="An inactive group gives no access, and its rules don't apply.">
            {() => <Segmented label="Status" value={active ? 'active' : 'inactive'} onChange={editable ? (v) => setActive(v === 'active') : () => {}}
              options={[{ value: 'active', label: 'Active' }, { value: 'inactive', label: 'Inactive' }]} />}
          </Field>
          <Field label="Description" wide>
            {(id) => <input id={id} className="input" value={description} disabled={!editable} onChange={(e) => setDescription(e.target.value)} />}
          </Field>
        </FormSection>

        <FormSection title="Members">
          <Field label="People" wide hint="Someone can be in several groups.">
            {(id, d) => <MultiSelect id={id} aria-describedby={d} aria-label="Members" value={members} onChange={setMembers} maxChips={12}
              disabled={!editable} placeholder="No members yet" options={memberOptions} />}
          </Field>
        </FormSection>

        <FormSection title="Access on teams">
          {rules.length ? (
            <ul className="group-rules field-wide">
              {rules.map((r) => <li key={r.id} className={r.is_active ? undefined : 'inactive'}>
                <span>{ruleSummary(r, typeName)}</span>{!r.is_active && <span className="pill pill-grey">Inactive</span>}</li>)}
            </ul>
          ) : (
            <div className="group-rule-count field-wide">
              {group ? 'No access rules use this group: it joins teams only when someone adds it.' : 'Once the group exists, access rules can put it on teams by country and event type.'}
            </div>
          )}
          {group && (
            <div className="group-rules-foot field-wide">
              <Link to={`/admin/access-rules?group=${group.id}`} className="btn btn-sm">{can(me, 'access_rule', 'create') ? 'Manage access rules' : 'See access rules'}</Link>
            </div>
          )}
        </FormSection>
      </form>
    </Modal>
  );
}
