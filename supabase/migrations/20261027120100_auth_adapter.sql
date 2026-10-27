-- =====================================================================
-- Event Coordinator — Auth adapter
-- The only database code that writes to the identity provider (Supabase Auth today).
-- Swapping to Cognito or customer SSO means replacing these two functions
-- (plus app.current_user_id() and apps/web/src/lib/auth.tsx). Nothing else touches auth.
-- =====================================================================

-- Checks shared by both functions; returns the target user
create or replace function app.login_target(p_user_id uuid, p_password text) returns public.app_user
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare u public.app_user;
begin
  select * into u from public.app_user where id = p_user_id and tenant_id = app.current_tenant_id();
  if not found then raise exception 'User not found' using errcode = 'P0002'; end if;
  if app.profile_is_admin(u.profile_id) and not app.is_admin() then
    raise exception 'Only a System Admin can manage logins for System Admin accounts' using errcode = '42501';
  end if;
  if length(coalesce(p_password, '')) < 10 then
    raise exception 'Use at least 10 characters for the password' using errcode = '22023';
  end if;
  return u;
end $$;

-- Gives an EC user a login with a temporary password
create or replace function public.create_user_login(p_user_id uuid, p_password text) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
declare u public.app_user; aid uuid := gen_random_uuid(); mail text;
begin
  if not app.has_perm('app_user', 'create') then
    raise exception 'You don''t have permission to create logins' using errcode = '42501';
  end if;
  u := app.login_target(p_user_id, p_password);
  if u.auth_user_id is not null then raise exception '% already has a login', u.display_name using errcode = '23505'; end if;
  mail := lower(trim(u.email));
  if coalesce(mail, '') = '' then raise exception 'Add an email address before creating a login' using errcode = '23502'; end if;
  if exists (select 1 from auth.users where lower(email) = mail) then
    raise exception 'A login with % already exists', mail using errcode = '23505';
  end if;

  insert into auth.users (instance_id, id, aud, role, email, encrypted_password, email_confirmed_at,
                          raw_app_meta_data, raw_user_meta_data, created_at, updated_at,
                          confirmation_token, recovery_token, email_change_token_new, email_change)
  values ('00000000-0000-0000-0000-000000000000', aid, 'authenticated', 'authenticated', mail,
          extensions.crypt(p_password, extensions.gen_salt('bf')), now(),
          '{"provider":"email","providers":["email"]}'::jsonb, '{}'::jsonb, now(), now(), '', '', '', '');
  insert into auth.identities (provider_id, user_id, identity_data, provider, created_at, updated_at)
  values (aid::text, aid, jsonb_build_object('sub', aid::text, 'email', mail, 'email_verified', true), 'email', now(), now());

  update public.app_user set auth_user_id = aid where id = u.id;
end $$;
comment on function public.create_user_login(uuid, text) is 'Creates a sign-in for an EC user with a temporary password. Needs app_user create permission.';

-- Sets a new temporary password
create or replace function public.set_user_password(p_user_id uuid, p_password text) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
declare u public.app_user;
begin
  if not app.has_perm('app_user', 'edit') then
    raise exception 'You don''t have permission to reset passwords' using errcode = '42501';
  end if;
  u := app.login_target(p_user_id, p_password);
  if u.auth_user_id is null then raise exception '% has no login yet', u.display_name using errcode = 'P0002'; end if;
  update auth.users set encrypted_password = extensions.crypt(p_password, extensions.gen_salt('bf')), updated_at = now()
   where id = u.auth_user_id;
end $$;
comment on function public.set_user_password(uuid, text) is 'Sets a new temporary password for an EC user''s login. Needs app_user edit permission.';

revoke all on function public.create_user_login(uuid, text), public.set_user_password(uuid, text) from public, anon;
grant execute on function public.create_user_login(uuid, text), public.set_user_password(uuid, text) to authenticated;
revoke all on function app.login_target(uuid, text) from public, anon;
