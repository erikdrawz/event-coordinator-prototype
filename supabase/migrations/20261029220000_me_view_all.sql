-- =====================================================================
-- me(): each object permission also says whether the profile sees all records (view_all), so the UI
-- can tell home office (e.g. every submitted request) from people who see only their own.
-- =====================================================================
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
    'tenant', jsonb_build_object('id', t.id, 'name', t.name, 'brand_name', t.brand_name, 'brand_color', t.brand_color),
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
comment on function public.me() is 'Current user, profile (incl. admin access), tenant branding, object permissions (incl. view_all), home country and event countries.';
