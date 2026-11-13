import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { supabase } from '../../lib/supabase';
import { useAuth } from '../../lib/auth';
import { CheckboxField, Field } from '../../ui/Form';
import { AdminPage } from './AdminLayout';

/** Settings for the whole organisation. System Admins change them; the database checks. */
export function SettingsAdmin() {
  const { me } = useAuth();
  const qc = useQueryClient();
  const canChange = Boolean(me?.profile.is_admin);
  const save = useMutation({
    mutationFn: async (patch: Partial<Pick<NonNullable<typeof me>['tenant'], 'show_profile_badge' | 'email_mentions' | 'email_replies'>>) => {
      const { error } = await supabase.from('tenant').update(patch).eq('id', me!.tenant.id);
      if (error) throw new Error(error.message);
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ['me'] }),
  });
  if (!me) return null;
  return (
    <AdminPage title="Settings" sub={`How Event Center works for everyone at ${me.tenant.name}.`}
      readOnlyNote={!canChange && 'Only System Admins change these settings.'}>
      <section className="card admin-settings">
        <h2 className="ov-title">Top bar</h2>
        <CheckboxField label="Show each person's profile beside their name" checked={me.tenant.show_profile_badge}
          disabled={!canChange || save.isPending} onChange={(v) => save.mutate({ show_profile_badge: v })}
          hint={`Everyone sees which rights they're working with, e.g. "${me.profile.name}". Useful when demoing as different people.`} />
        {save.error && <div className="form-error" role="alert">{save.error.message}</div>}
      </section>
      <section className="card admin-settings">
        <h2 className="ov-title">Email</h2>
        <CheckboxField label="Email people when they're mentioned" checked={me.tenant.email_mentions}
          disabled={!canChange || save.isPending} onChange={(v) => save.mutate({ email_mentions: v })}
          hint="Off: mentions still show in the person's notifications, but no email goes out." />
        <CheckboxField label="Allow replying by email" checked={me.tenant.email_replies}
          disabled={!canChange || save.isPending} onChange={(v) => save.mutate({ email_replies: v })}
          hint="People can answer a mention by replying, and approve or reject by replying where the approval process allows it. Off: emails have no reply address, and replies that still arrive are refused." />
        <p className="field-hint">Which approval emails go out, and whether approvers may reply, is set on each process in Admin → Approvals.</p>
      </section>
      <DemoInbox tenantId={me.tenant.id} canChange={canChange} />
    </AdminPage>
  );
}

/** Demo inbox: every email goes to one real address, and replies from it count as the person's. */
function DemoInbox({ tenantId, canChange }: { tenantId: string; canChange: boolean }) {
  const qc = useQueryClient();
  const current = useQuery({
    queryKey: ['tenant', tenantId, 'demo-inbox'],
    queryFn: async () => {
      const { data, error } = await supabase.from('tenant').select('demo_inbox').eq('id', tenantId).single();
      if (error) throw new Error(error.message);
      return (data as { demo_inbox: string | null }).demo_inbox ?? '';
    },
  });
  const [value, setValue] = useState('');
  useEffect(() => { if (current.data != null) setValue(current.data); }, [current.data]);
  const save = useMutation({
    mutationFn: async (v: string) => {
      const { error } = await supabase.from('tenant').update({ demo_inbox: v.trim() || null }).eq('id', tenantId);
      if (error) throw new Error(/demo_inbox_check/.test(error.message) ? "That doesn't look like an email address" : error.message);
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ['tenant', tenantId, 'demo-inbox'] }),
  });
  const dirty = value.trim() !== (current.data ?? '');
  return (
    <section className="card admin-settings">
      <h2 className="ov-title">Demo inbox</h2>
      <form className="settings-inline" onSubmit={(e) => { e.preventDefault(); save.mutate(value); }}>
        <Field label="Send every email to" error={save.error?.message}
          hint="For demos: every email Event Center sends goes to this address instead, with who it's for in the subject. A reply from this address counts as that person's. Leave empty to email people at their own address.">
          {(id, describedBy) => (
            <div className="settings-input-row">
              <input id={id} aria-describedby={describedBy} className="input" type="email" placeholder="you@example.com"
                value={value} disabled={!canChange || current.isLoading} onChange={(e) => { save.reset(); setValue(e.target.value); }} />
              {canChange && <button type="submit" className="btn btn-primary" disabled={!dirty || save.isPending}>{save.isPending ? 'Saving…' : 'Save'}</button>}
            </div>
          )}
        </Field>
      </form>
    </section>
  );
}
