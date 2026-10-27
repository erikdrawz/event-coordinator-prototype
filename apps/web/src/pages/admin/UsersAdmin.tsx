import { useMemo, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { KeyRound, Plus, RefreshCw } from 'lucide-react';
import { supabase } from '../../lib/supabase';
import { useAuth } from '../../lib/auth';
import { can } from '../../lib/permissions';
import { avatarColorFor, initialsFor } from '../../lib/avatar';
import { timeAgo } from '../../lib/format';
import { Avatar } from '../../components/Avatar';
import { DataTable, useTableSort, type Column } from '../../ui/DataTable';
import { FilterSelect, SearchInput, Segmented, Toolbar } from '../../ui/Toolbar';
import { Modal } from '../../ui/Modal';
import { CheckboxField, Field, FormSection } from '../../ui/Form';
import { Select } from '../../ui/Select';
import { MultiSelect } from '../../ui/MultiSelect';
import { AdminPage } from './AdminLayout';
import { ADMIN_KEY, must, syncLinks, useCountries, useProfiles, useUsers, type Profile, type UserRow } from './adminData';

/** A readable temporary password: 3 short words' worth of letters, digits and a dash. */
function tempPassword() {
  const chars = 'abcdefghjkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const pick = (n: number) => Array.from(crypto.getRandomValues(new Uint32Array(n)), (x) => chars[x % chars.length]).join('');
  return `${pick(5)}-${pick(5)}-${pick(4)}`;
}

export function UsersAdmin() {
  const { me } = useAuth();
  const users = useUsers();
  const profiles = useProfiles();
  const [q, setQ] = useState('');
  const [profile, setProfile] = useState('');
  const [status, setStatus] = useState('active');
  const [editing, setEditing] = useState<UserRow | 'new' | null>(null);

  const columns = useMemo<Column<UserRow>[]>(() => [
    { id: 'name', header: 'User', width: '30%', sortValue: (u) => u.display_name,
      cell: (u) => (
        <span className="dt-person">
          <Avatar size={28} initials={u.initials} color={u.avatar_color} isAgent={u.user_type === 'agent'} />
          <span>
            <button className="dt-primary as-button" onClick={() => setEditing(u)}>{u.display_name}</button>
            <div className="dt-sub">{u.email ?? 'No email'}</div>
          </span>
        </span>
      ) },
    { id: 'profile', header: 'Profile', width: '17%', sortValue: (u) => u.profile?.name, cell: (u) => u.profile?.name },
    { id: 'home', header: 'Home', width: '8%', sortValue: (u) => u.country_code, cell: (u) => u.country_code ?? <span className="text-muted">—</span> },
    { id: 'countries', header: 'Creates events in', width: '23%', sortValue: (u) => u.app_user_country.length,
      cell: (u) => u.app_user_country.length
        ? <span className="admin-codes">{u.app_user_country.map((c) => c.country_code).sort().map((c) => <span key={c} className="admin-code">{c}</span>)}</span>
        : <span className="admin-all">None</span> },
    { id: 'login', header: 'Last sign-in', width: '12%', sortValue: (u) => u.last_login_at ?? (u.auth_user_id ? '0' : ''),
      cell: (u) => <span className="dt-sub dt-nowrap">{!u.auth_user_id ? 'No login' : u.last_login_at ? timeAgo(u.last_login_at) : 'Never'}</span> },
    { id: 'status', header: 'Status', width: '10%', sortValue: (u) => u.status,
      cell: (u) => <span className={`pill ${u.status === 'active' ? 'pill-green' : 'pill-grey'}`}>{u.status === 'active' ? 'Active' : 'Inactive'}</span> },
  ], []);

  const filtered = useMemo(() => users.data?.filter((u) => (!status || u.status === status) && (!profile || u.profile_id === profile)
    && (!q || [u.display_name, u.email, u.job_title].some((v) => v?.toLowerCase().includes(q.toLowerCase())))), [users.data, q, profile, status]);
  const { rows, sort, setSort } = useTableSort(filtered, columns, { columnId: 'name', dir: 'asc' });

  return (
    <AdminPage title="Users" sub="Who can sign in, what their profile allows, and which countries they create events in."
      action={can(me, 'app_user', 'create') && <button className="btn btn-primary" onClick={() => setEditing('new')}><Plus size={15} strokeWidth={2.6} />New user</button>}>
      <Toolbar label="Filter users">
        <SearchInput value={q} onChange={setQ} placeholder="Search name, email or title" />
        <FilterSelect label="Profile" value={profile} onChange={setProfile} options={(profiles.data ?? []).map((p) => ({ value: p.id, label: p.name }))} />
        <FilterSelect label="Status" value={status} onChange={setStatus} options={[{ value: 'active', label: 'Active' }, { value: 'inactive', label: 'Inactive' }]} />
      </Toolbar>
      <DataTable label="Users" columns={columns} rows={rows} rowKey={(u) => u.id} sort={sort} onSortChange={setSort}
        loading={users.isLoading} error={users.error} empty="No users match." />
      {editing && profiles.data && <UserEditor user={editing === 'new' ? null : editing} profiles={profiles.data} onClose={() => setEditing(null)} />}
    </AdminPage>
  );
}

function UserEditor({ user, profiles, onClose }: { user: UserRow | null; profiles: Profile[]; onClose: () => void }) {
  const { me } = useAuth();
  const qc = useQueryClient();
  const countries = useCountries();
  const iAmAdmin = Boolean(me?.profile.is_admin);
  // Only System Admins touch System Admin accounts; the database enforces the same
  const editable = (user ? can(me, 'app_user', 'edit') : can(me, 'app_user', 'create')) && (iAmAdmin || !user?.profile?.is_admin);
  const isAgent = user?.user_type === 'agent';
  const beforeCountries = user?.app_user_country.map((c) => c.country_code) ?? [];

  const [first, setFirst] = useState(user?.first_name ?? '');
  const [last, setLast] = useState(user?.last_name ?? '');
  const [email, setEmail] = useState(user?.email ?? '');
  const [title, setTitle] = useState(user?.job_title ?? '');
  const [profileId, setProfileId] = useState(user?.profile_id ?? profiles.find((p) => p.name === 'Collaborator')?.id ?? '');
  const [status, setStatus] = useState<'active' | 'inactive'>(user?.status ?? 'active');
  const [home, setHome] = useState(user?.country_code ?? '');
  const [ctry, setCtry] = useState(beforeCountries);
  const [withLogin, setWithLogin] = useState(true);
  const [password, setPassword] = useState(tempPassword);
  const [resetting, setResetting] = useState(false);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [done, setDone] = useState<string | null>(null);

  const profileOptions = profiles.filter((p) => iAmAdmin || !p.is_admin || p.id === profileId).map((p) => ({ value: p.id, label: p.name }));
  const countryOptions = (countries.data ?? []).map((c) => ({ value: c.code, label: `${c.name} (${c.code})` }));

  const save = useMutation({
    mutationFn: async () => {
      const display = `${first.trim()} ${last.trim()}`.trim();
      const row = {
        first_name: first.trim() || null, last_name: last.trim() || null, display_name: display || email.trim(),
        email: email.trim() || null, job_title: title.trim() || null, profile_id: profileId, status, country_code: home || null,
        initials: initialsFor(first, last, display || email),
      };
      let id = user?.id;
      if (id) await must(supabase.from('app_user').update(row).eq('id', id));
      else id = (await must(supabase.from('app_user').insert({ ...row, user_type: 'human', avatar_color: avatarColorFor(display) }).select('id').single()))!.id;
      await syncLinks('app_user_country', 'user_id', id!, 'country_code', beforeCountries, ctry);
      if (!user && withLogin) await must(supabase.rpc('create_user_login', { p_user_id: id, p_password: password }));
      return !user && withLogin ? `Login created. Share the temporary password with ${first || display} securely: ${password}` : null;
    },
    onSuccess: (msg) => {
      qc.invalidateQueries({ queryKey: [ADMIN_KEY] });
      if (msg) setDone(msg); else onClose();
    },
  });

  const loginAction = useMutation({
    mutationFn: async () => {
      if (!user) return '';
      await must(supabase.rpc(user.auth_user_id ? 'set_user_password' : 'create_user_login', { p_user_id: user.id, p_password: password }));
      return user.auth_user_id ? 'New temporary password set.' : 'Login created.';
    },
    onSuccess: (msg) => { qc.invalidateQueries({ queryKey: [ADMIN_KEY] }); setResetting(false); setDone(`${msg} Share it securely: ${password}`); },
  });

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    const errs: Record<string, string> = {};
    if (!first.trim() && !last.trim() && !isAgent) errs.name = 'Add a first or last name';
    if (!email.trim() || !/^\S+@\S+\.\S+$/.test(email.trim())) errs.email = 'Add a valid email address';
    if (!profileId) errs.profile = 'Choose a profile';
    if (!user && withLogin && password.length < 10) errs.password = 'Use at least 10 characters';
    setErrors(errs);
    if (!Object.keys(errs).length) save.mutate();
  };

  if (done) {
    return (
      <Modal open title={user ? user.display_name : 'User created'} onClose={onClose}
        footer={<button type="button" className="btn btn-primary" onClick={onClose}>Done</button>}>
        <div className="login-box"><span>{done}</span>
          <span className="admin-section-note">This password isn't shown again. They can sign in with it straight away.</span></div>
      </Modal>
    );
  }

  return (
    <Modal open size="lg" title={user ? user.display_name : 'New user'} onClose={onClose}
      footer={<>
        <button type="button" className="btn" onClick={onClose}>{editable ? 'Cancel' : 'Close'}</button>
        {editable && <button type="submit" form="user-form" className="btn btn-primary" disabled={save.isPending}>{save.isPending ? 'Saving…' : user ? 'Save changes' : 'Create user'}</button>}
      </>}>
      <form id="user-form" className="form" onSubmit={submit} noValidate>
        {!editable && <div className="admin-note">Only a System Admin can change this account.</div>}
        {(save.error || loginAction.error) && <div className="form-error" role="alert" style={{ marginBottom: 16 }}>{(save.error ?? loginAction.error)!.message}</div>}

        <FormSection title="Person">
          <Field label="First name" required={!isAgent} error={errors.name}>
            {(id, d) => <input id={id} aria-describedby={d} aria-invalid={Boolean(errors.name) || undefined} className="input" value={first}
              disabled={!editable} autoFocus={!user} onChange={(e) => setFirst(e.target.value)} />}
          </Field>
          <Field label="Last name">
            {(id) => <input id={id} className="input" value={last} disabled={!editable} onChange={(e) => setLast(e.target.value)} />}
          </Field>
          <Field label="Email" required error={errors.email} hint={user?.auth_user_id ? 'Also their sign-in. Changing it here does not change the login.' : null}>
            {(id, d) => <input id={id} aria-describedby={d} aria-invalid={Boolean(errors.email) || undefined} type="email" className="input"
              value={email} disabled={!editable} onChange={(e) => setEmail(e.target.value)} />}
          </Field>
          <Field label="Job title">
            {(id) => <input id={id} className="input" value={title} disabled={!editable} onChange={(e) => setTitle(e.target.value)} />}
          </Field>
        </FormSection>

        <FormSection title="Access">
          <Field label="Profile" required error={errors.profile} hint="Decides what they can see and change.">
            {(id, d) => <Select id={id} aria-describedby={d} aria-invalid={Boolean(errors.profile) || undefined} value={profileId}
              onChange={setProfileId} options={profileOptions} disabled={!editable || isAgent} />}
          </Field>
          <Field label="Status" hint="Inactive users can't sign in to EC.">
            {() => <Segmented label="Status" value={status} onChange={editable ? setStatus : () => {}}
              options={[{ value: 'active', label: 'Active' }, { value: 'inactive', label: 'Inactive' }]} />}
          </Field>
        </FormSection>

        <FormSection title="Countries">
          <Field label="Home country" hint="New events default to it.">
            {(id, d) => <Select id={id} aria-describedby={d} value={home} onChange={setHome} emptyLabel="None" options={countryOptions} disabled={!editable} />}
          </Field>
          <Field label="Creates events in" wide hint="They can create events, or move events, only in these countries and only for event types available there. Seeing events isn't limited.">
            {(id, d) => <MultiSelect id={id} aria-describedby={d} aria-label="Creates events in" value={ctry} onChange={setCtry}
              disabled={!editable} placeholder="No countries: can't create events" options={countryOptions} />}
          </Field>
        </FormSection>

        <FormSection title="Sign-in">
          {!user ? (
            <div className="field field-wide">
              <CheckboxField label="Create a login now" checked={withLogin} onChange={setWithLogin} disabled={!editable} />
              {withLogin && <PasswordRow password={password} setPassword={setPassword} error={errors.password} />}
            </div>
          ) : (
            <div className="field field-wide login-box">
              <span className="login-row"><KeyRound size={16} aria-hidden />
                {user.auth_user_id ? (user.last_login_at ? `Has a login. Last signed in ${timeAgo(user.last_login_at)}.` : 'Has a login. Hasn\'t signed in yet.') : 'No login yet.'}
              </span>
              {editable && (resetting ? (
                <>
                  <PasswordRow password={password} setPassword={setPassword} />
                  <span className="login-row">
                    <button type="button" className="btn btn-primary" disabled={loginAction.isPending || password.length < 10} onClick={() => loginAction.mutate()}>
                      {user.auth_user_id ? 'Set password' : 'Create login'}
                    </button>
                    <button type="button" className="btn btn-ghost" onClick={() => setResetting(false)}>Cancel</button>
                  </span>
                </>
              ) : (
                <span><button type="button" className="btn" onClick={() => { setPassword(tempPassword()); setResetting(true); }}>
                  {user.auth_user_id ? 'Set a new temporary password' : 'Create login'}
                </button></span>
              ))}
            </div>
          )}
        </FormSection>
      </form>
    </Modal>
  );
}

function PasswordRow({ password, setPassword, error }: { password: string; setPassword: (v: string) => void; error?: string }) {
  return (
    <Field label="Temporary password" error={error} hint="Share it with them securely. They can sign in with it straight away.">
      {(id, d) => (
        <span className="login-row">
          <input id={id} aria-describedby={d} className="input" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="off" spellCheck={false} />
          <button type="button" className="btn" aria-label="Generate another password" title="Generate another" onClick={() => setPassword(tempPassword())}><RefreshCw size={15} /></button>
        </span>
      )}
    </Field>
  );
}
