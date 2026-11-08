import { useMutation, useQueryClient } from '@tanstack/react-query';
import { supabase } from '../../lib/supabase';
import { useAuth } from '../../lib/auth';
import { CheckboxField } from '../../ui/Form';
import { AdminPage } from './AdminLayout';

/** Settings for the whole organisation. System Admins change them; the database checks. */
export function SettingsAdmin() {
  const { me } = useAuth();
  const qc = useQueryClient();
  const canChange = Boolean(me?.profile.is_admin);
  const save = useMutation({
    mutationFn: async (v: boolean) => {
      const { error } = await supabase.from('tenant').update({ show_profile_badge: v }).eq('id', me!.tenant.id);
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
          disabled={!canChange || save.isPending} onChange={(v) => save.mutate(v)}
          hint={`Everyone sees which rights they're working with, e.g. "${me.profile.name}". Useful when demoing as different people.`} />
        {save.error && <div className="form-error" role="alert">{save.error.message}</div>}
      </section>
    </AdminPage>
  );
}
