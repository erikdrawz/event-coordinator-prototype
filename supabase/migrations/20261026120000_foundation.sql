-- =====================================================================
-- Event Coordinator — Foundation
-- Tenancy, users (human + agent), profiles & permissions, audit log,
-- and the helper functions every security policy builds on.
-- Plain Postgres; the only Supabase touch-point is auth.uid().
-- =====================================================================

create schema if not exists app;
grant usage on schema app to authenticated, service_role;

-- ---------------------------------------------------------------------
-- Tenancy
-- ---------------------------------------------------------------------
create table public.tenant (
  id           uuid primary key default gen_random_uuid(),
  name         text not null,
  slug         text not null unique,
  brand_name   text not null,
  brand_color  text not null default '#b42318',
  created_at   timestamptz not null default now()
);
comment on table public.tenant is 'A customer organisation. Single tenant seeded in the prototype; every business row carries tenant_id.';

-- ---------------------------------------------------------------------
-- Profiles & permissions (Salesforce-style object permissions)
-- ---------------------------------------------------------------------
create table public.profile (
  id           uuid primary key default gen_random_uuid(),
  tenant_id    uuid not null references public.tenant(id),
  name         text not null,
  description  text,
  is_admin     boolean not null default false,
  created_at   timestamptz not null default now(),
  unique (tenant_id, name)
);
comment on table public.profile is 'Permission profile assigned to a user (System Admin, Event Coordinator, Collaborator, Agent).';

create table public.permission (
  id           uuid primary key default gen_random_uuid(),
  tenant_id    uuid not null references public.tenant(id),
  profile_id   uuid not null references public.profile(id) on delete cascade,
  object_name  text not null,
  can_read     boolean not null default true,
  can_create   boolean not null default false,
  can_edit     boolean not null default false,
  can_delete   boolean not null default false,
  view_all     boolean not null default false,
  modify_all   boolean not null default false,
  unique (profile_id, object_name)
);
comment on table public.permission is 'Object-level permissions per profile. object_name = table name. Enforced by RLS via app.has_perm().';

-- ---------------------------------------------------------------------
-- Users — humans and agents
-- ---------------------------------------------------------------------
create table public.app_user (
  id             uuid primary key default gen_random_uuid(),
  tenant_id      uuid not null references public.tenant(id),
  user_type      text not null default 'human' check (user_type in ('human','agent')),
  auth_user_id   uuid unique,                       -- auth.users.id (Supabase Auth today; any IdP later)
  first_name     text,
  last_name      text,
  display_name   text not null,
  email          text,
  job_title      text,
  initials       text,
  avatar_color   text,
  profile_id     uuid not null references public.profile(id),
  owner_user_id  uuid references public.app_user(id),  -- agents: the human accountable for them
  agent_purpose  text,                                  -- agents: what the agent does
  status         text not null default 'active' check (status in ('active','inactive')),
  last_login_at  timestamptz,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  constraint agent_has_owner check (user_type = 'human' or owner_user_id is not null)
);
comment on table public.app_user is 'Every principal that acts in EC. user_type = human | agent. Agents have an owner and their own profile; both are bound by the same RLS.';

create table public.user_group (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null references public.tenant(id),
  name        text not null,
  description text,
  unique (tenant_id, name)
);

create table public.user_group_member (
  group_id  uuid not null references public.user_group(id) on delete cascade,
  user_id   uuid not null references public.app_user(id) on delete cascade,
  tenant_id uuid not null references public.tenant(id),
  primary key (group_id, user_id)
);

-- ---------------------------------------------------------------------
-- Audit log — every change, with actor and on-behalf-of
-- ---------------------------------------------------------------------
create table public.audit_log (
  id                    bigint generated always as identity primary key,
  tenant_id             uuid,
  table_name            text not null,
  record_id             uuid,
  event_id              uuid,
  action                text not null check (action in ('insert','update','delete')),
  actor_user_id         uuid,
  on_behalf_of_user_id  uuid,
  changed               jsonb,
  at                    timestamptz not null default now()
);
create index audit_log_event_idx on public.audit_log (event_id, at desc);
create index audit_log_record_idx on public.audit_log (table_name, record_id, at desc);
comment on table public.audit_log is 'Append-only change log. Written by app.audit_row() triggers only.';

-- =====================================================================
-- Helper functions (security definer: they read app_user/permission
-- without recursing through RLS)
-- =====================================================================

create or replace function app.current_user_id() returns uuid
language sql stable security definer set search_path = public, pg_temp as $$
  select u.id from public.app_user u
  where u.auth_user_id = auth.uid() and u.status = 'active'
$$;
comment on function app.current_user_id() is 'The app_user behind the current JWT. The single place that touches the auth provider.';

create or replace function app.current_tenant_id() returns uuid
language sql stable security definer set search_path = public, pg_temp as $$
  select u.tenant_id from public.app_user u where u.id = app.current_user_id()
$$;

create or replace function app.current_profile_id() returns uuid
language sql stable security definer set search_path = public, pg_temp as $$
  select u.profile_id from public.app_user u where u.id = app.current_user_id()
$$;

create or replace function app.is_admin() returns boolean
language sql stable security definer set search_path = public, pg_temp as $$
  select coalesce((select p.is_admin from public.profile p where p.id = app.current_profile_id()), false)
$$;

create or replace function app.has_perm(p_object text, p_action text) returns boolean
language sql stable security definer set search_path = public, pg_temp as $$
  select app.is_admin() or coalesce((
    select case p_action
             when 'read'   then pm.can_read or pm.view_all
             when 'create' then pm.can_create
             when 'edit'   then pm.can_edit or pm.modify_all
             when 'delete' then pm.can_delete or pm.modify_all
           end
    from public.permission pm
    where pm.profile_id = app.current_profile_id() and pm.object_name = p_object
  ), false)
$$;
comment on function app.has_perm(text, text) is 'Object permission check used by every RLS policy. action: read | create | edit | delete.';

create or replace function app.on_behalf_of_user_id() returns uuid
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare v text; target uuid;
begin
  -- PostgREST exposes request headers; agents send X-On-Behalf-Of: <app_user.id>.
  -- Honoured only when the caller is an agent and the target is an active human in the same tenant.
  v := nullif(current_setting('request.headers', true), '')::json ->> 'x-on-behalf-of';
  if v is null or v !~* '^[0-9a-f-]{36}$' then return null; end if;
  select h.id into target
    from public.app_user h
    join public.app_user a on a.id = app.current_user_id()
   where h.id = v::uuid and a.user_type = 'agent' and h.user_type = 'human'
     and h.status = 'active' and h.tenant_id = a.tenant_id;
  return target;
exception when others then return null;
end $$;

grant execute on all functions in schema app to authenticated, service_role;

-- =====================================================================
-- Generic triggers
-- =====================================================================

-- Fills tenant_id / created_by / updated_at / updated_by from the caller.
create or replace function app.stamp_row() returns trigger
language plpgsql as $$
declare j jsonb := to_jsonb(new);
begin
  -- nested IFs: plpgsql must not evaluate new.<col> on tables without that column
  if tg_op = 'INSERT' then
    if j ? 'tenant_id' then
      if new.tenant_id is null then new.tenant_id := app.current_tenant_id(); end if;
    end if;
    if j ? 'created_by' then
      if new.created_by is null then new.created_by := app.current_user_id(); end if;
    end if;
  end if;
  if j ? 'updated_at' then
    if tg_op = 'UPDATE' then new.updated_at := now(); end if;
  end if;
  if j ? 'updated_by' then
    new.updated_by := coalesce(app.current_user_id(), new.updated_by);
  end if;
  return new;
end $$;

-- Writes an audit_log row for every change.
create or replace function app.audit_row() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  o jsonb := case when tg_op in ('UPDATE','DELETE') then to_jsonb(old) end;
  n jsonb := case when tg_op in ('INSERT','UPDATE') then to_jsonb(new) end;
  r jsonb := coalesce(n, o);
  diff jsonb;
begin
  if tg_op = 'UPDATE' then
    select jsonb_object_agg(k, jsonb_build_object('from', o -> k, 'to', n -> k))
      into diff
      from jsonb_object_keys(n) k
     where k not in ('updated_at','updated_by') and (o -> k) is distinct from (n -> k);
    if diff is null then return new; end if;   -- no real change
  elsif tg_op = 'INSERT' then
    diff := n;
  else
    diff := o;
  end if;

  insert into public.audit_log (tenant_id, table_name, record_id, event_id, action,
                                actor_user_id, on_behalf_of_user_id, changed)
  values ((r ->> 'tenant_id')::uuid,
          tg_table_name,
          (r ->> 'id')::uuid,
          case when tg_table_name = 'event' then (r ->> 'id')::uuid else (r ->> 'event_id')::uuid end,
          lower(tg_op),
          app.current_user_id(),
          app.on_behalf_of_user_id(),
          diff);
  return coalesce(new, old);
end $$;

-- Applies the standard policy set + triggers to a tenant-scoped business table.
create or replace function app.secure_table(p_table text, p_object text default null, p_audit boolean default true)
returns void language plpgsql as $$
declare obj text := coalesce(p_object, p_table);
begin
  execute format('alter table public.%I enable row level security', p_table);
  execute format('drop policy if exists %I on public.%I', p_table || '_read', p_table);
  execute format('drop policy if exists %I on public.%I', p_table || '_insert', p_table);
  execute format('drop policy if exists %I on public.%I', p_table || '_update', p_table);
  execute format('drop policy if exists %I on public.%I', p_table || '_delete', p_table);
  execute format($p$create policy %I on public.%I for select to authenticated
                   using (tenant_id = app.current_tenant_id() and app.has_perm(%L,'read'))$p$,
                 p_table || '_read', p_table, obj);
  execute format($p$create policy %I on public.%I for insert to authenticated
                   with check (coalesce(tenant_id, app.current_tenant_id()) = app.current_tenant_id() and app.has_perm(%L,'create'))$p$,
                 p_table || '_insert', p_table, obj);
  execute format($p$create policy %I on public.%I for update to authenticated
                   using (tenant_id = app.current_tenant_id() and app.has_perm(%L,'edit'))
                   with check (tenant_id = app.current_tenant_id())$p$,
                 p_table || '_update', p_table, obj);
  execute format($p$create policy %I on public.%I for delete to authenticated
                   using (tenant_id = app.current_tenant_id() and app.has_perm(%L,'delete'))$p$,
                 p_table || '_delete', p_table, obj);
  execute format('drop trigger if exists stamp_row on public.%I', p_table);
  execute format('create trigger stamp_row before insert or update on public.%I for each row execute function app.stamp_row()', p_table);
  if p_audit then
    execute format('drop trigger if exists audit_row on public.%I', p_table);
    execute format('create trigger audit_row after insert or update or delete on public.%I for each row execute function app.audit_row()', p_table);
  end if;
  execute format('revoke all on public.%I from anon', p_table);
  execute format('grant select, insert, update, delete on public.%I to authenticated', p_table);
end $$;
comment on function app.secure_table(text, text, boolean) is 'Standard security for a tenant-scoped table: tenant isolation + object permissions + stamping + audit.';
