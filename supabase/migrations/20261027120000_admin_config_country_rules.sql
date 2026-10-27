-- =====================================================================
-- Event Coordinator — Admin config layer + country rules
-- - Event types are enabled per country; users manage events in a set of countries.
--   Creating an event (or moving it to another country or type) needs both.
-- - Products and therapeutic areas can be assigned to event types. No assignments = all allowed.
-- - Master data can be switched off (is_active) instead of deleted.
-- - Admin area access per profile; business admins manage users within limits.
-- =====================================================================

-- ---------------------------------------------------------------------
-- Master data: active flags
-- ---------------------------------------------------------------------
alter table public.product add column is_active boolean not null default true;
alter table public.therapeutic_area add column is_active boolean not null default true;

-- ---------------------------------------------------------------------
-- Profiles: who may open the Admin area (the UI gate; data access is still permission rows)
-- ---------------------------------------------------------------------
alter table public.profile add column can_access_admin boolean not null default false;
update public.profile set can_access_admin = true where is_admin;
comment on column public.profile.can_access_admin is 'Shows the Admin area. What can be changed there is decided by permission rows and RLS.';

create or replace function app.profile_is_admin(p_profile_id uuid) returns boolean
language sql stable security definer set search_path = public, pg_temp as $$
  select coalesce((select p.is_admin from public.profile p where p.id = p_profile_id), false)
$$;

-- ---------------------------------------------------------------------
-- Users: home country and the countries they manage events in
-- ---------------------------------------------------------------------
alter table public.app_user add column country_code char(2) references public.country(code);
comment on column public.app_user.country_code is 'Home country. New events default to it when the user may create events there.';

create table public.app_user_country (
  user_id       uuid not null references public.app_user(id) on delete cascade,
  country_code  char(2) not null references public.country(code),
  tenant_id     uuid not null references public.tenant(id),
  created_at    timestamptz not null default now(),
  created_by    uuid references public.app_user(id),
  primary key (user_id, country_code)
);
comment on table public.app_user_country is 'Countries a user may create events in, or move events into.';

-- ---------------------------------------------------------------------
-- Event type configuration
-- ---------------------------------------------------------------------
create table public.event_type_country (
  event_type_id  uuid not null references public.event_type(id) on delete cascade,
  country_code   char(2) not null references public.country(code),
  tenant_id      uuid not null references public.tenant(id),
  created_at     timestamptz not null default now(),
  created_by     uuid references public.app_user(id),
  primary key (event_type_id, country_code)
);
comment on table public.event_type_country is 'Countries an event type is available in (country-level event type sharing).';

create table public.event_type_product (
  event_type_id  uuid not null references public.event_type(id) on delete cascade,
  product_id     uuid not null references public.product(id) on delete cascade,
  tenant_id      uuid not null references public.tenant(id),
  created_at     timestamptz not null default now(),
  created_by     uuid references public.app_user(id),
  primary key (event_type_id, product_id)
);
comment on table public.event_type_product is 'Products allowed on an event type. An event type with none allows every active product.';

create table public.event_type_therapeutic_area (
  event_type_id        uuid not null references public.event_type(id) on delete cascade,
  therapeutic_area_id  uuid not null references public.therapeutic_area(id) on delete cascade,
  tenant_id            uuid not null references public.tenant(id),
  created_at           timestamptz not null default now(),
  created_by           uuid references public.app_user(id),
  primary key (event_type_id, therapeutic_area_id)
);
comment on table public.event_type_therapeutic_area is 'Therapeutic areas allowed on an event type. An event type with none allows every active area.';

select app.secure_table('app_user_country');
select app.secure_table('event_type_country');
select app.secure_table('event_type_product');
select app.secure_table('event_type_therapeutic_area');

-- ---------------------------------------------------------------------
-- Rules on events. Skipped when there is no signed-in user (seed and maintenance scripts).
-- Country rule: on create, and when the country or type changes. Admins are exempt.
-- Assignment rule: the therapeutic area and products must be allowed for the event type.
-- ---------------------------------------------------------------------
create or replace function app.check_event_rules() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  me        uuid := app.current_user_id();
  type_name text;
  ctry_name text;
  bad       text;
begin
  if me is null then return new; end if;
  select name into type_name from public.event_type where id = new.event_type_id;
  select name into ctry_name from public.country where code = new.country_code;

  if (tg_op = 'INSERT' or new.country_code is distinct from old.country_code or new.event_type_id is distinct from old.event_type_id)
     and not app.is_admin() then
    if new.country_code is null then
      raise exception 'Choose a country for the event' using errcode = '23502';
    end if;
    if not exists (select 1 from public.event_type_country
                    where event_type_id = new.event_type_id and country_code = new.country_code) then
      raise exception '% events aren''t available in %', type_name, ctry_name using errcode = '42501';
    end if;
    if not exists (select 1 from public.app_user_country where user_id = me and country_code = new.country_code) then
      raise exception 'You can''t create events in %. Ask an admin to add it to your countries.', ctry_name using errcode = '42501';
    end if;
  end if;

  if new.therapeutic_area_id is not null
     and (tg_op = 'INSERT' or new.therapeutic_area_id is distinct from old.therapeutic_area_id or new.event_type_id is distinct from old.event_type_id)
     and exists (select 1 from public.event_type_therapeutic_area where event_type_id = new.event_type_id)
     and not exists (select 1 from public.event_type_therapeutic_area
                      where event_type_id = new.event_type_id and therapeutic_area_id = new.therapeutic_area_id) then
    raise exception 'That therapeutic area isn''t available for % events', type_name using errcode = '42501';
  end if;

  -- Changing the type must not leave products the new type doesn't allow
  if tg_op = 'UPDATE' and new.event_type_id is distinct from old.event_type_id
     and exists (select 1 from public.event_type_product where event_type_id = new.event_type_id) then
    select string_agg(p.name, ', ') into bad
      from public.event_product ep join public.product p on p.id = ep.product_id
     where ep.event_id = new.id
       and not exists (select 1 from public.event_type_product t where t.event_type_id = new.event_type_id and t.product_id = ep.product_id);
    if bad is not null then
      raise exception '% isn''t available for % events. Remove it first.', bad, type_name using errcode = '42501';
    end if;
  end if;
  return new;
end $$;
create trigger check_event_rules before insert or update on public.event
  for each row execute function app.check_event_rules();

create or replace function app.check_event_product() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
declare type_id uuid; p public.product;
begin
  if app.current_user_id() is null then return new; end if;
  select event_type_id into type_id from public.event where id = new.event_id;
  select * into p from public.product where id = new.product_id;
  if not p.is_active then
    raise exception '% is no longer available', p.name using errcode = '42501';
  end if;
  if exists (select 1 from public.event_type_product where event_type_id = type_id)
     and not exists (select 1 from public.event_type_product where event_type_id = type_id and product_id = new.product_id) then
    raise exception '% isn''t available for % events', p.name, (select name from public.event_type where id = type_id) using errcode = '42501';
  end if;
  return new;
end $$;
create trigger check_event_product before insert on public.event_product
  for each row execute function app.check_event_product();

-- ---------------------------------------------------------------------
-- User management beyond System Admin: profiles with app_user create/edit permission
-- (Business Admin) may manage users, but never System Admin accounts or profiles.
-- ---------------------------------------------------------------------
create policy app_user_manage_insert on public.app_user for insert to authenticated
  with check (tenant_id = app.current_tenant_id() and app.has_perm('app_user', 'create')
              and user_type = 'human' and not app.profile_is_admin(profile_id));
create policy app_user_manage_update on public.app_user for update to authenticated
  using (tenant_id = app.current_tenant_id() and app.has_perm('app_user', 'edit') and not app.profile_is_admin(profile_id))
  with check (tenant_id = app.current_tenant_id() and not app.profile_is_admin(profile_id));

-- ---------------------------------------------------------------------
-- me(): adds home country, the countries I can create events in, and admin access
-- ---------------------------------------------------------------------
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
                      'edit', pm.can_edit or pm.modify_all, 'delete', pm.can_delete or pm.modify_all))
                    from public.permission pm where pm.profile_id = p.id), '{}'::jsonb)
  )
  from public.app_user u
  join public.profile p on p.id = u.profile_id
  join public.tenant  t on t.id = u.tenant_id
  where u.id = app.current_user_id()
$$;
comment on function public.me() is 'Current user, profile (incl. admin access), tenant branding, object permissions, home country and event countries.';

grant execute on all functions in schema app to authenticated, service_role;
