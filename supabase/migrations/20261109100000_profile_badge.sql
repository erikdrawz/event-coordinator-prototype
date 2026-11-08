-- =====================================================================
-- Event Center — Show people their profile
-- A tenant-wide setting: when on, the top bar shows the signed-in person's profile beside their
-- name ("System Admin", "Account Manager"), which helps when demoing as different people and
-- reminds everyone which rights they're working with. System Admins switch it in Admin → Settings.
-- =====================================================================

alter table public.tenant add column show_profile_badge boolean not null default false;
comment on column public.tenant.show_profile_badge is 'Show each person''s profile beside their name in the top bar.';

-- System Admins change their tenant's settings (only the setting columns)
create policy tenant_admin_update on public.tenant for update to authenticated
  using (id = app.current_tenant_id() and app.is_admin())
  with check (id = app.current_tenant_id() and app.is_admin());
revoke insert, update, delete, truncate on public.tenant from authenticated;
grant update (show_profile_badge) on public.tenant to authenticated;

-- me() says whether to show it
create or replace function public.me() returns jsonb
language sql stable as $$
  select jsonb_build_object(
    'id', u.id,
    'user_type', u.user_type,
    'display_name', u.display_name,
    'first_name', u.first_name,
    'last_name', u.last_name,
    'email', u.email,
    'job_title', u.job_title,
    'initials', u.initials,
    'avatar_color', u.avatar_color,
    'country_code', u.country_code,
    'event_countries', coalesce((select jsonb_agg(c.country_code order by c.country_code)
                                   from public.app_user_country c where c.user_id = u.id), '[]'::jsonb),
    'profile', jsonb_build_object('id', p.id, 'name', p.name, 'is_admin', p.is_admin, 'can_access_admin', p.can_access_admin),
    'tenant', jsonb_build_object('id', t.id, 'name', t.name, 'brand_name', t.brand_name, 'brand_color', t.brand_color,
                              'show_profile_badge', t.show_profile_badge),
    'permissions', coalesce((select jsonb_object_agg(pm.object_name, jsonb_build_object(
                      'read', pm.can_read or pm.view_all, 'create', pm.can_create,
                      'edit', pm.can_edit or pm.modify_all, 'delete', pm.can_delete or pm.modify_all,
                      'view_all', pm.view_all or pm.modify_all))
                    from public.permission pm where pm.profile_id = p.id), '{}'::jsonb)
  )
  from public.app_user u
  join public.profile p on p.id = u.profile_id
  join public.tenant  t on t.id = u.tenant_id
  where u.id = app.current_user_id()
$$;
comment on function public.me() is 'Current user, profile (incl. admin access), tenant branding and settings, object permissions (incl. view_all), home country and event countries.';
