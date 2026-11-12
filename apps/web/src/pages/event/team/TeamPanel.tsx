import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { ChevronDown, Plus, UserRound, UsersRound, X } from 'lucide-react';
import { supabase } from '../../../lib/supabase';
import { useAuth } from '../../../lib/auth';
import { can } from '../../../lib/permissions';
import { avatarColorFor } from '../../../lib/avatar';
import { Avatar } from '../../../components/Avatar';
import { Select } from '../../../ui/Select';
import { Menu } from '../../../ui/Menu';
import { ConfirmDialog } from '../../../ui/ConfirmDialog';
import { PersonPicker } from '../people/PersonPicker';
import { initials, type SpeakerOption } from '../agenda/agendaData';
import { boardKey, boardTables, teamPeople, useGroupOptions, usePeople, useTeam, useTeamGroups, useTeamRoles, type Board, type TeamGroup, type TeamMember } from './teamData';

const PEOPLE_GROUPS = [{ group: 'team' as const, label: 'People in your organisation' }];

const COPY = {
  event: {
    intro: 'Only people on the team, and members of groups on it, can open this event and post on the board.',
    removed: "They'll no longer be able to open this event or post on its board, unless a group on the team includes them. If they speak in an agenda session as a team member, they'll be taken off it.",
    groupRemoved: "Its members lose the access it gave them on this event, unless they're on the team themselves or through another group.",
    others: 'Access rules add groups by country and event type (marked Auto); admins manage those in Admin. Business and System Admins can see every event.',
  },
  request: {
    intro: 'Only people on the team, and members of groups on it, can open this request and post on the board.',
    removed: "They'll no longer be able to open this request or post on its board, unless a group on the team includes them.",
    groupRemoved: "Its members lose the access it gave them on this request, unless they're on the team themselves or through another group.",
    others: 'Once submitted, access rules add groups by country and event type (marked Auto), and home office (Event Coordinators, Business Admins) can see it too.',
  },
};

/**
 * Who can access this event or request and why. Owner and organizers edit it and manage the team;
 * approvers and viewers see it and post. The database enforces all of this (event_access,
 * request_access); the panel only offers what it allows. canEdit: my access lets me edit the record.
 */
export function TeamPanel({ board, canEdit }: { board: Board; canEdit: boolean }) {
  const { me } = useAuth();
  const qc = useQueryClient();
  const t = boardTables(board);
  const copy = COPY[board.kind];
  const team = useTeam(board);
  const groups = useTeamGroups(board);
  const roles = useTeamRoles();
  const [adding, setAdding] = useState<'person' | 'group' | null>(null);
  const [removing, setRemoving] = useState<TeamMember | null>(null);
  const [removingGroup, setRemovingGroup] = useState<TeamGroup | null>(null);
  const canManage = canEdit && can(me, t.team, 'create');
  const roleOf = (code: string) => roles.data?.find((r) => r.code === code);
  const sort = (m: TeamMember) => roleOf(m.team_role)?.sort ?? 99;
  const members = [...(team.data ?? [])].sort((a, b) => sort(a) - sort(b) || (a.user?.display_name ?? '').localeCompare(b.user?.display_name ?? ''));
  const teamGroups = [...(groups.data ?? [])].sort((a, b) => (a.group?.name ?? '').localeCompare(b.group?.name ?? ''));
  const headcount = teamPeople(team.data, groups.data).length;
  const refresh = () => qc.invalidateQueries({ queryKey: boardKey(board) });

  const update = useMutation({
    mutationFn: async ({ id, team_role }: { id: string; team_role: string }) => {
      const { error } = await supabase.from(t.team).update({ team_role }).eq('id', id);
      if (error) throw new Error(error.message);
    },
    onSettled: refresh,
  });
  const remove = useMutation({
    mutationFn: async (m: TeamMember) => {
      const { error } = await supabase.from(t.team).delete().eq('id', m.id);
      if (error) throw new Error(error.message);
    },
    onSuccess: () => { refresh(); setRemoving(null); },
  });
  const updateGroup = useMutation({
    mutationFn: async ({ id, team_role }: { id: string; team_role: string }) => {
      const { error } = await supabase.from(t.groups).update({ team_role }).eq('id', id);
      if (error) throw new Error(error.message);
    },
    onSettled: refresh,
  });
  const removeGroup = useMutation({
    mutationFn: async (g: TeamGroup) => {
      const { error } = await supabase.from(t.groups).delete().eq('id', g.id);
      if (error) throw new Error(error.message);
    },
    onSuccess: () => { refresh(); setRemovingGroup(null); },
  });

  const assignable = (roles.data ?? []).filter((r) => r.code !== 'owner');
  // Groups give Organizer or Viewer access; approving comes with approval processes
  const groupRoles = assignable.filter((r) => r.code === 'organizer' || r.code === 'viewer');
  const error = update.error ?? updateGroup.error;

  return (
    <section className="card team-card team-panel" aria-labelledby="team-title">
      <div className="ov-head">
        <div className="ov-title-row">
          <h2 id="team-title" className="ov-title">Team</h2>
          <span className="card-sub">{headcount} {headcount === 1 ? 'person' : 'people'}{teamGroups.length > 0 && ` · ${teamGroups.length} ${teamGroups.length === 1 ? 'group' : 'groups'}`}</span>
        </div>
        {canManage && !adding && (
          <Menu label="Add to the team" width={180} items={[
            { key: 'person', label: 'Person', icon: <UserRound size={15} />, onSelect: () => setAdding('person') },
            { key: 'group', label: 'Group', icon: <UsersRound size={15} />, onSelect: () => setAdding('group') },
          ]} trigger={(t) => <button type="button" className="btn btn-outline btn-sm" {...t}><Plus size={14} strokeWidth={2.6} />Add<ChevronDown size={14} /></button>} />
        )}
      </div>
      <p className="team-intro">{copy.intro}</p>
      {error && <div className="form-error" role="alert">{error.message}</div>}

      {adding === 'person' && <AddMember board={board} taken={members.map((m) => m.user_id)} roles={assignable} onDone={() => setAdding(null)} />}
      {adding === 'group' && <AddGroup board={board} taken={teamGroups.map((g) => g.group_id)} roles={groupRoles} onDone={() => setAdding(null)} />}

      <ul className="team-list">
        {members.map((m) => {
          const role = roleOf(m.team_role);
          const owner = m.team_role === 'owner';
          const name = m.user?.display_name ?? 'Former user';
          return (
            <li key={m.id} className="team-member">
              <Avatar size={34} initials={m.user?.initials} color={m.user?.avatar_color ?? avatarColorFor(name)} isAgent={m.user?.user_type === 'agent'} />
              <div className="team-who">
                <span className="team-name">{name}{m.user_id === me?.id && <span className="team-you">You</span>}</span>
                <span className="team-sub">{m.role_label ?? m.user?.job_title ?? ''}</span>
              </div>
              <div className="team-role">
                {canManage && !owner ? (
                  <div className="cell-select team-role-select" data-tip={role?.description}>
                    <Select aria-label={`Access for ${name}`} value={m.team_role} onChange={(v) => update.mutate({ id: m.id, team_role: v })}
                      options={assignable.map((r) => ({ value: r.code, label: r.label }))} />
                  </div>
                ) : (
                  <span className={`team-role-pill${owner ? ' owner' : ''}`} tabIndex={0} data-tip={role?.description}>{role?.label ?? m.team_role}</span>
                )}
                {canManage && !owner && (
                  <button type="button" className="icon-btn icon-btn-danger" aria-label={`Remove ${name} from the team`} title="Remove from team" onClick={() => setRemoving(m)}><X size={15} /></button>
                )}
              </div>
            </li>
          );
        })}
      </ul>

      {teamGroups.length > 0 && <>
        <h3 className="team-subhead">Groups</h3>
        <ul className="team-list">
          {teamGroups.map((g) => {
            const role = roleOf(g.team_role);
            const name = g.group?.name ?? 'Group';
            const people = (g.group?.members ?? []).flatMap((m) => (m.user ? [m.user] : [])).sort((a, b) => a.display_name.localeCompare(b.display_name));
            const mine = people.some((p) => p.id === me?.id);
            const inactive = g.group && !g.group.is_active;
            const sub = inactive ? 'Inactive: gives no access'
              : people.length ? people.map((p) => p.display_name).join(', ') : 'No members yet';
            return (
              <li key={g.id} className={`team-member team-group${inactive ? ' inactive' : ''}`}>
                <span className="team-group-icon" aria-hidden><UsersRound size={17} /></span>
                <div className="team-who">
                  <span className="team-name"><span className="team-name-text">{name}</span>{mine && <span className="team-you">You</span>}
                    {g.is_auto && <span className="team-auto" tabIndex={0} data-tip="Added by an access rule. Admins change it in Admin → Access rules.">Auto</span>}
                  </span>
                  <span className="team-sub" title={sub}>{sub}</span>
                </div>
                <div className="team-role">
                  {canManage && !g.is_auto ? (
                    <div className="cell-select team-role-select" data-tip={role?.description}>
                      <Select aria-label={`Access for ${name}`} value={g.team_role} onChange={(v) => updateGroup.mutate({ id: g.id, team_role: v })}
                        options={groupRoles.map((r) => ({ value: r.code, label: r.label }))} />
                    </div>
                  ) : (
                    <span className="team-role-pill" tabIndex={0} data-tip={role?.description}>{role?.label ?? g.team_role}</span>
                  )}
                  {canManage && (g.is_auto
                    ? <span className="icon-btn-spacer" aria-hidden />
                    : <button type="button" className="icon-btn icon-btn-danger" aria-label={`Remove ${name} from the team`} title="Remove from team" onClick={() => setRemovingGroup(g)}><X size={15} /></button>)}
                </div>
              </li>
            );
          })}
        </ul>
      </>}

      <dl className="team-legend">
        {(roles.data ?? []).map((r) => (
          <div key={r.code}><dt>{r.label}</dt><dd>{board.kind === 'event' ? r.description.replace(/ Approves or rejects requests\.$/, '') : r.description}</dd></div>
        ))}
      </dl>
      <p className="field-hint">{copy.others}</p>

      {removing && (
        <ConfirmDialog title={`Remove ${removing.user?.display_name ?? 'this person'}?`} confirmLabel="Remove from team" pending={remove.isPending} error={remove.error?.message}
          onConfirm={() => remove.mutate(removing)} onCancel={() => { remove.reset(); setRemoving(null); }}>
          {copy.removed}
        </ConfirmDialog>
      )}
      {removingGroup && (
        <ConfirmDialog title={`Remove ${removingGroup.group?.name ?? 'this group'}?`} confirmLabel="Remove from team" pending={removeGroup.isPending} error={removeGroup.error?.message}
          onConfirm={() => removeGroup.mutate(removingGroup)} onCancel={() => { removeGroup.reset(); setRemovingGroup(null); }}>
          {copy.groupRemoved}
        </ConfirmDialog>
      )}
    </section>
  );
}

/** Pick a person, their access and an optional label (e.g. "Medical lead"), then add them. */
function AddMember({ board, taken, roles, onDone }: { board: Board; taken: string[]; roles: { code: string; label: string }[]; onDone: () => void }) {
  const qc = useQueryClient();
  const people = usePeople(true);
  const [who, setWho] = useState<SpeakerOption | null>(null);
  const [role, setRole] = useState('viewer');
  const [label, setLabel] = useState('');
  const [error, setError] = useState<string | null>(null);
  const options = (people.data ?? []).filter((p) => !taken.includes(p.id)).map((p): SpeakerOption => ({
    key: `u:${p.id}`, user_id: p.id, name: p.display_name, sub: p.job_title ?? '', initials: p.initials ?? initials(p.display_name), color: p.avatar_color, group: 'team' }));

  const add = useMutation({
    mutationFn: async () => {
      const t = boardTables(board);
      const { error } = await supabase.from(t.team).insert({ [t.key]: board.id, user_id: who!.user_id, team_role: role, role_label: label.trim() || null });
      if (error) throw new Error(error.message);
    },
    onSuccess: () => { qc.invalidateQueries({ queryKey: boardKey(board) }); onDone(); },
    onError: (e) => setError(e.message),
  });
  const submit = () => { if (!who) { setError('Choose a person'); return; } setError(null); add.mutate(); };

  return (
    <div className="team-add" onKeyDown={(e) => {
      if (e.defaultPrevented) return;
      if (e.key === 'Enter' && (e.target as HTMLElement).tagName === 'INPUT') { e.preventDefault(); submit(); }
      if (e.key === 'Escape') { e.preventDefault(); onDone(); }
    }}>
      <PersonPicker label="Choose a person" options={options} groups={PEOPLE_GROUPS} canSearchCrm={false} autoOpen
        onPick={(o) => { setWho(o); setError(null); }}
        trigger={(t) => (
          <button type="button" className="input sel-trigger picker-field" aria-label="Person" aria-invalid={error === 'Choose a person' || undefined} {...t}>
            <span className={who ? 'sel-value' : 'sel-value placeholder'}>{who?.name ?? 'Choose a person…'}</span><ChevronDown size={15} className="sel-chevron" aria-hidden />
          </button>
        )} />
      <div className="team-add-row">
        <Select aria-label="Access" value={role} onChange={setRole} options={roles.map((r) => ({ value: r.code, label: r.label }))} />
        <input className="input" aria-label="Label (optional)" placeholder="Label, e.g. Medical lead" value={label} onChange={(e) => setLabel(e.target.value)} />
      </div>
      {error && <span className="field-error" role="alert">{error}</span>}
      <div className="team-add-actions">
        <button type="button" className="btn btn-ghost btn-sm" onClick={onDone}>Cancel</button>
        <button type="button" className="btn btn-primary btn-sm" disabled={add.isPending} onClick={submit}>Add to team</button>
      </div>
    </div>
  );
}

/** Pick a group and the access its members get, then add it. */
function AddGroup({ board, taken, roles, onDone }: { board: Board; taken: string[]; roles: { code: string; label: string }[]; onDone: () => void }) {
  const qc = useQueryClient();
  const options = useGroupOptions(true);
  const [groupId, setGroupId] = useState('');
  const [role, setRole] = useState('viewer');
  const [error, setError] = useState<string | null>(null);
  const available = (options.data ?? []).filter((g) => !taken.includes(g.id));

  const add = useMutation({
    mutationFn: async () => {
      const t = boardTables(board);
      const { error } = await supabase.from(t.groups).insert({ [t.key]: board.id, group_id: groupId, team_role: role });
      if (error) throw new Error(error.message);
    },
    onSuccess: () => { qc.invalidateQueries({ queryKey: boardKey(board) }); onDone(); },
    onError: (e) => setError(e.message),
  });
  const submit = () => { if (!groupId) { setError('Choose a group'); return; } setError(null); add.mutate(); };

  return (
    <div className="team-add" onKeyDown={(e) => { if (e.key === 'Escape' && !e.defaultPrevented) { e.preventDefault(); onDone(); } }}>
      <div className="team-add-row team-add-group">
        <Select aria-label="Group" aria-invalid={error === 'Choose a group' || undefined} value={groupId} searchable placeholder="Choose a group…"
          onChange={(v) => { setGroupId(v); setError(null); }}
          options={available.map((g) => ({ value: g.id, label: g.name }))} />
        <Select aria-label="Access" value={role} onChange={setRole} options={roles.map((r) => ({ value: r.code, label: r.label }))} />
      </div>
      <span className="field-hint">Everyone in the group gets this access, for as long as they're in it.</span>
      {error && <span className="field-error" role="alert">{error}</span>}
      <div className="team-add-actions">
        <button type="button" className="btn btn-ghost btn-sm" onClick={onDone}>Cancel</button>
        <button type="button" className="btn btn-primary btn-sm" disabled={add.isPending} onClick={submit}>Add to team</button>
      </div>
    </div>
  );
}
