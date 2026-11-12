-- =====================================================================
-- Event Center — Groups, access rules and managers
-- * Groups (user_group) are named sets of people, with no purpose of their own. Someone can be in
--   several groups. The same group can get access through access rules, be added to a team by hand
--   and (next phase) approve in an approval process.
-- * A group sits on a team as one row (event_team_group / request_team_group). Its members get the
--   row's access on that record for as long as they're in the group and the group is active.
--   Groups join as Organizer or Viewer; nobody is Owner or Approver through a group.
-- * Access rules (access_rule) put groups on teams automatically: "this group gets this access on
--   events and/or requests in these countries, of these event types". Leaving countries or event
--   types empty means all of them. A tiering request has no event type, so only rules for every
--   event type match it.
--   Rules apply when an event is created or changes country or event type, when a request is
--   submitted, and to open events and requests in review whenever a rule or a group's status
--   changes. When several rules give a group access to a record, it gets the strongest.
--   A group a rule added (is_auto) is managed by the rules only: team editors can't remove it or
--   change its access. Editors can add other groups by hand, which rules leave alone.
-- * Every person can have a manager (app_user.manager_id): an active person in the organisation,
--   never themselves or someone they manage. Only people who manage users set it.
-- =====================================================================

-- ---------------------------------------------------------------------
-- Groups: status and timestamps
-- ---------------------------------------------------------------------
alter table public.user_group
  add column is_active   boolean not null default true,
  add column created_at  timestamptz not null default now(),
  add column updated_at  timestamptz not null default now(),
  add constraint user_group_name_check check (btrim(name) <> '');
comment on table public.user_group is 'Groups of people. Access rules put them on teams; approval processes use them to approve.';
comment on column public.user_group.is_active is 'An inactive group gives its members no access and no rule applies to it.';

-- Members are active people of the group's organisation; agents act through their owner instead
create or replace function app.check_group_member() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  new.tenant_id := coalesce(new.tenant_id, app.current_tenant_id());   -- runs before stamp_row
  if not exists (select 1 from public.user_group g where g.id = new.group_id and g.tenant_id = new.tenant_id) then
    raise exception 'Group not found' using errcode = 'P0002';
  end if;
  if not exists (select 1 from public.app_user u where u.id = new.user_id and u.tenant_id = new.tenant_id
                    and u.user_type = 'human' and u.status = 'active') then
    raise exception 'Only active people of your organisation can join a group' using errcode = '23514';
  end if;
  return new;
end $$;
create trigger check_group_member before insert or update on public.user_group_member
  for each row execute function app.check_group_member();

-- ---------------------------------------------------------------------
-- Groups on teams
-- ---------------------------------------------------------------------
create table public.event_team_group (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null references public.tenant(id),
  event_id    uuid not null references public.event(id) on delete cascade,
  group_id    uuid not null references public.user_group(id) on delete cascade,
  team_role   text not null default 'viewer' references public.team_role(code),
  is_auto     boolean not null default false,
  created_at  timestamptz not null default now(),
  created_by  uuid references public.app_user(id),
  updated_at  timestamptz not null default now(),
  updated_by  uuid references public.app_user(id),
  unique (event_id, group_id)
);
comment on table public.event_team_group is 'Groups on an event''s team: every member gets the row''s access. is_auto: added by an access rule.';
create index event_team_group_group_idx on public.event_team_group (group_id);

create table public.request_team_group (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null references public.tenant(id),
  request_id  uuid not null references public.event_request(id) on delete cascade,
  group_id    uuid not null references public.user_group(id) on delete cascade,
  team_role   text not null default 'viewer' references public.team_role(code),
  is_auto     boolean not null default false,
  created_at  timestamptz not null default now(),
  created_by  uuid references public.app_user(id),
  updated_at  timestamptz not null default now(),
  updated_by  uuid references public.app_user(id),
  unique (request_id, group_id)
);
comment on table public.request_team_group is 'Groups on a request''s team: every member gets the row''s access. is_auto: added by an access rule.';
create index request_team_group_group_idx on public.request_team_group (group_id);

select app.secure_table('event_team_group');
select app.secure_event_table('event_team_group');
select app.secure_table('request_team_group');
select app.secure_request_table('request_team_group');


-- Team editors manage the groups they added; rules manage the ones they added
create or replace function app.check_team_group() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
declare v_sync boolean := coalesce(current_setting('app.access_sync', true), '') = 'on';
begin
  new.tenant_id := coalesce(new.tenant_id, app.current_tenant_id());   -- runs before stamp_row
  if new.team_role not in ('organizer', 'viewer') then
    raise exception 'A group joins the team as Organizer or Viewer' using errcode = '23514';
  end if;
  if tg_op = 'INSERT' and not exists (select 1 from public.user_group g where g.id = new.group_id
                                         and g.tenant_id = new.tenant_id and g.is_active) then
    raise exception 'Only active groups of your organisation can join the team' using errcode = '23514';
  end if;
  if tg_op = 'UPDATE' and new.group_id is distinct from old.group_id then
    raise exception 'Remove the group and add the other one instead' using errcode = '23514';
  end if;
  if not v_sync then
    if tg_op = 'INSERT' and new.is_auto then
      raise exception 'Only access rules add groups automatically' using errcode = '42501';
    end if;
    if tg_op = 'UPDATE' and (old.is_auto or new.is_auto) then
      raise exception 'This group is on the team through an access rule; an admin changes it in Admin → Access rules'
        using errcode = '42501';
    end if;
  end if;
  return new;
end $$;
create trigger check_team_group before insert or update on public.event_team_group
  for each row execute function app.check_team_group();
create trigger check_team_group before insert or update on public.request_team_group
  for each row execute function app.check_team_group();

-- Only rules remove what rules added (deleting the record or the group still removes it)
create or replace function app.guard_rule_team_group() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_record_exists boolean := exists (select 1 from public.event e where e.id = (to_jsonb(old) ->> 'event_id')::uuid)
                          or exists (select 1 from public.event_request q where q.id = (to_jsonb(old) ->> 'request_id')::uuid);
begin
  if old.is_auto and coalesce(current_setting('app.access_sync', true), '') <> 'on'
     and v_record_exists and exists (select 1 from public.user_group g where g.id = old.group_id) then
    raise exception 'This group is on the team through an access rule; an admin changes it in Admin → Access rules'
      using errcode = '42501';
  end if;
  return old;
end $$;
create trigger guard_rule_team_group before delete on public.event_team_group
  for each row execute function app.guard_rule_team_group();
create trigger guard_rule_team_group before delete on public.request_team_group
  for each row execute function app.guard_rule_team_group();

-- ---------------------------------------------------------------------
-- Access rules
-- ---------------------------------------------------------------------
create table public.access_rule (
  id              uuid primary key default gen_random_uuid(),
  tenant_id       uuid not null references public.tenant(id),
  group_id        uuid not null references public.user_group(id) on delete cascade,
  applies_to      text not null default 'all' check (applies_to in ('all', 'events', 'requests')),
  country_codes   text[] check (country_codes is null or cardinality(country_codes) > 0),
  event_type_ids  uuid[] check (event_type_ids is null or cardinality(event_type_ids) > 0),
  team_role       text not null default 'viewer' references public.team_role(code)
                    check (team_role in ('organizer', 'viewer')),
  note            text,
  is_active       boolean not null default true,
  created_at      timestamptz not null default now(),
  created_by      uuid references public.app_user(id),
  updated_at      timestamptz not null default now(),
  updated_by      uuid references public.app_user(id)
);
comment on table public.access_rule is 'Puts a group on the team of matching events and submitted requests, with the access given.';
comment on column public.access_rule.applies_to is 'all (events and requests), events, or requests.';
comment on column public.access_rule.country_codes is 'The countries it applies to; null: every country.';
comment on column public.access_rule.event_type_ids is 'The event types it applies to; null: every event type (and tiering requests, which have none).';
comment on column public.access_rule.team_role is 'The access the group gets: organizer or viewer.';
create index access_rule_group_idx on public.access_rule (group_id);
select app.secure_table('access_rule');

create or replace function app.check_access_rule() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
declare v_bad text;
begin
  new.tenant_id := coalesce(new.tenant_id, app.current_tenant_id());   -- runs before stamp_row
  if not exists (select 1 from public.user_group g where g.id = new.group_id and g.tenant_id = new.tenant_id) then
    raise exception 'Group not found' using errcode = 'P0002';
  end if;
  if new.country_codes is not null then
    if cardinality(new.country_codes) = 0 then
      raise exception 'Choose at least one country, or all countries' using errcode = '23514';
    end if;
    new.country_codes := (select array_agg(distinct upper(btrim(c)) order by upper(btrim(c))) from unnest(new.country_codes) c);
    select string_agg(c, ', ') into v_bad from unnest(new.country_codes) c
     where not exists (select 1 from public.country k where k.code = c);
    if v_bad is not null then raise exception 'Unknown country: %', v_bad using errcode = '22023'; end if;
  end if;
  if new.event_type_ids is not null then
    if cardinality(new.event_type_ids) = 0 then
      raise exception 'Choose at least one event type, or all event types' using errcode = '23514';
    end if;
    new.event_type_ids := (select array_agg(distinct t order by t) from unnest(new.event_type_ids) t);
    if exists (select 1 from unnest(new.event_type_ids) t
                where not exists (select 1 from public.event_type k where k.id = t and k.tenant_id = new.tenant_id)) then
      raise exception 'Unknown event type' using errcode = '22023';
    end if;
  end if;
  new.note := nullif(btrim(new.note), '');
  return new;
end $$;
create trigger check_access_rule before insert or update on public.access_rule
  for each row execute function app.check_access_rule();

-- The groups the rules put on a record, each with the strongest access a rule gives it
create or replace function app.rule_groups(p_tenant uuid, p_kind text, p_country text, p_event_type uuid)
returns table (group_id uuid, team_role text)
language sql stable security definer set search_path = public, pg_temp as $$
  select distinct on (r.group_id) r.group_id, r.team_role
    from public.access_rule r
    join public.user_group g on g.id = r.group_id and g.is_active
    join public.team_role tr on tr.code = r.team_role
   where r.tenant_id = p_tenant and r.is_active
     and r.applies_to in ('all', p_kind || 's')
     and (r.country_codes is null or p_country = any(r.country_codes))
     and (r.event_type_ids is null or coalesce(p_event_type = any(r.event_type_ids), false))
   order by r.group_id, tr.sort
$$;
comment on function app.rule_groups(uuid, text, text, uuid) is 'The groups access rules put on an event or request (p_kind event|request) in this country, of this event type.';

-- A record's rule groups: groups the rules no longer give leave, new ones join, access follows the
-- rules. Groups added by hand stay as they are.
create or replace function app.sync_event_access(p_event_id uuid) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
declare e public.event;
begin
  select * into e from public.event where id = p_event_id;
  if not found then return; end if;
  perform set_config('app.access_sync', 'on', true);
  delete from public.event_team_group t
   where t.event_id = e.id and t.is_auto
     and t.group_id not in (select x.group_id from app.rule_groups(e.tenant_id, 'event', e.country_code, e.event_type_id) x);
  insert into public.event_team_group as t (tenant_id, event_id, group_id, team_role, is_auto, created_by)
  select e.tenant_id, e.id, x.group_id, x.team_role, true, app.current_user_id()
    from app.rule_groups(e.tenant_id, 'event', e.country_code, e.event_type_id) x
  on conflict (event_id, group_id) do update set team_role = excluded.team_role
   where t.is_auto and t.team_role is distinct from excluded.team_role;
  perform set_config('app.access_sync', '', true);
end $$;

-- A request gets its rule groups once submitted (drafts stay private to the requester's team)
create or replace function app.sync_request_access(p_request_id uuid) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
declare r public.event_request;
begin
  select * into r from public.event_request where id = p_request_id;
  if not found or r.status = 'draft' then return; end if;
  perform set_config('app.access_sync', 'on', true);
  delete from public.request_team_group t
   where t.request_id = r.id and t.is_auto
     and t.group_id not in (select x.group_id from app.rule_groups(r.tenant_id, 'request', r.country_code, r.event_type_id) x);
  insert into public.request_team_group as t (tenant_id, request_id, group_id, team_role, is_auto, created_by)
  select r.tenant_id, r.id, x.group_id, x.team_role, true, app.current_user_id()
    from app.rule_groups(r.tenant_id, 'request', r.country_code, r.event_type_id) x
  on conflict (request_id, group_id) do update set team_role = excluded.team_role
   where t.is_auto and t.team_role is distinct from excluded.team_role;
  perform set_config('app.access_sync', '', true);
end $$;

-- Rules or a group's status changed: bring open events and requests in review in line.
-- Closed and cancelled events and decided requests keep the access they had.
create or replace function app.sync_tenant_access(p_tenant uuid) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
declare v uuid;
begin
  for v in select e.id from public.event e join public.event_status s on s.code = e.status
            where e.tenant_id = p_tenant and not s.is_terminal loop
    perform app.sync_event_access(v);
  end loop;
  for v in select q.id from public.event_request q where q.tenant_id = p_tenant and q.status = 'review' loop
    perform app.sync_request_access(v);
  end loop;
end $$;

create or replace function app.event_access_follows() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  perform app.sync_event_access(new.id);
  return null;
end $$;
create trigger event_access_follows after insert or update of country_code, event_type_id on public.event
  for each row execute function app.event_access_follows();

create or replace function app.request_access_follows() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  perform app.sync_request_access(new.id);
  return null;
end $$;
create trigger request_access_on_insert after insert on public.event_request
  for each row when (new.status <> 'draft') execute function app.request_access_follows();
create trigger request_access_on_submit after update of status on public.event_request
  for each row when (old.status = 'draft' and new.status <> 'draft') execute function app.request_access_follows();

create or replace function app.rules_changed() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  perform app.sync_tenant_access(coalesce(new.tenant_id, old.tenant_id));
  return null;
end $$;
create trigger access_rule_follows after insert or update or delete on public.access_rule
  for each row execute function app.rules_changed();
create trigger group_access_follows after update of is_active on public.user_group
  for each row when (old.is_active is distinct from new.is_active) execute function app.rules_changed();

-- ---------------------------------------------------------------------
-- Access: your own team role, or the access of a group you're in
-- ---------------------------------------------------------------------
-- Everyone on the record's team: people added directly, and members of its active groups
create or replace function app.team_user_ids(p_kind text, p_record_id uuid) returns setof uuid
language sql stable security definer set search_path = public, pg_temp as $$
  select m.user_id from public.event_team_member m where p_kind = 'event' and m.event_id = p_record_id
  union
  select gm.user_id from public.event_team_group t
    join public.user_group g on g.id = t.group_id and g.is_active
    join public.user_group_member gm on gm.group_id = t.group_id
   where p_kind = 'event' and t.event_id = p_record_id
  union
  select m.user_id from public.request_team_member m where p_kind = 'request' and m.request_id = p_record_id
  union
  select gm.user_id from public.request_team_group t
    join public.user_group g on g.id = t.group_id and g.is_active
    join public.user_group_member gm on gm.group_id = t.group_id
   where p_kind = 'request' and t.request_id = p_record_id
$$;
comment on function app.team_user_ids(text, uuid) is 'Everyone on an event''s or request''s team (p_kind event|request): direct members and members of its active groups.';

-- The caller's roles on a record: their own row and those of groups they're in
create or replace function app.my_team_roles(p_kind text, p_record_id uuid) returns setof text
language sql stable security definer set search_path = public, pg_temp as $$
  select m.team_role from public.event_team_member m
   where p_kind = 'event' and m.event_id = p_record_id and m.user_id = app.access_user_id()
  union all
  select t.team_role from public.event_team_group t
    join public.user_group g on g.id = t.group_id and g.is_active
    join public.user_group_member gm on gm.group_id = t.group_id and gm.user_id = app.access_user_id()
   where p_kind = 'event' and t.event_id = p_record_id
  union all
  select m.team_role from public.request_team_member m
   where p_kind = 'request' and m.request_id = p_record_id and m.user_id = app.access_user_id()
  union all
  select t.team_role from public.request_team_group t
    join public.user_group g on g.id = t.group_id and g.is_active
    join public.user_group_member gm on gm.group_id = t.group_id and gm.user_id = app.access_user_id()
   where p_kind = 'request' and t.request_id = p_record_id
$$;

create or replace function app.event_access(p_event_id uuid) returns text
language sql stable security definer set search_path = public, pg_temp as $$
  select case
    when app.is_admin() or app.perm_flag('event', 'modify_all') then 'edit'
    when exists (select 1 from app.my_team_roles('event', p_event_id) x(role) join public.team_role r on r.code = x.role where r.can_edit) then 'edit'
    when app.perm_flag('event', 'view_all') or exists (select 1 from app.my_team_roles('event', p_event_id)) then 'view'
  end
$$;

create or replace function app.request_access(p_request_id uuid) returns text
language sql stable security definer set search_path = public, pg_temp as $$
  select case
    when app.is_admin() or app.perm_flag('event_request', 'modify_all') then 'edit'
    when exists (select 1 from app.my_team_roles('request', p_request_id) x(role) join public.team_role r on r.code = x.role where r.can_edit) then 'edit'
    when exists (select 1 from app.my_team_roles('request', p_request_id)) then 'view'
    when app.perm_flag('event_request', 'view_all')
     and exists (select 1 from public.event_request q where q.id = p_request_id and q.status <> 'draft') then 'view'
  end
$$;

-- team_role: your own role, else the strongest one a group gives you; via_group: that group's name
create or replace function public.my_event_access(p_event_id uuid) returns jsonb
language sql stable security definer set search_path = public, pg_temp as $$
  with own as (select m.team_role from public.event_team_member m where m.event_id = p_event_id and m.user_id = app.access_user_id()),
  grp as (select t.team_role, g.name from public.event_team_group t
            join public.user_group g on g.id = t.group_id and g.is_active
            join public.user_group_member gm on gm.group_id = t.group_id and gm.user_id = app.access_user_id()
            join public.team_role r on r.code = t.team_role
           where t.event_id = p_event_id order by r.sort, g.name limit 1)
  select jsonb_build_object('access', app.event_access(p_event_id),
    'team_role', coalesce((select team_role from own), (select team_role from grp)),
    'via_group', case when not exists (select 1 from own) then (select name from grp) end)
$$;
comment on function public.my_event_access(uuid) is 'The caller''s access to an event: {access: edit|view|null, team_role, via_group (when only a group puts them on the team)}.';

create or replace function public.my_request_access(p_request_id uuid) returns jsonb
language sql stable security definer set search_path = public, pg_temp as $$
  with own as (select m.team_role from public.request_team_member m where m.request_id = p_request_id and m.user_id = app.access_user_id()),
  grp as (select t.team_role, g.name from public.request_team_group t
            join public.user_group g on g.id = t.group_id and g.is_active
            join public.user_group_member gm on gm.group_id = t.group_id and gm.user_id = app.access_user_id()
            join public.team_role r on r.code = t.team_role
           where t.request_id = p_request_id order by r.sort, g.name limit 1)
  select jsonb_build_object('access', app.request_access(p_request_id),
    'team_role', coalesce((select team_role from own), (select team_role from grp)),
    'via_group', case when not exists (select 1 from own) then (select name from grp) end,
    'can_decide', app.can_decide_request(p_request_id))
$$;
comment on function public.my_request_access(uuid) is 'The caller''s access to a request: {access: edit|view|null, team_role, via_group, can_decide}.';

-- Mentions: anyone on the team, directly or through a group
create or replace function app.check_post_mentions() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  -- Through jsonb: a record can't name a column its table doesn't have, even in a branch not taken
  v_record uuid := (to_jsonb(new) ->> case tg_table_name when 'event_post' then 'event_id' else 'request_id' end)::uuid;
  v_kind text := case tg_table_name when 'event_post' then 'event' else 'request' end;
  v_off text;
begin
  new.mentions := coalesce((select array_agg(distinct m) from unnest(new.mentions) m where m is not null), '{}');
  select string_agg(coalesce(u.display_name, 'Someone'), ', ') into v_off
    from unnest(new.mentions) m
    left join public.app_user u on u.id = m
   where m not in (select app.team_user_ids(v_kind, v_record));
  if v_off is not null then
    raise exception '% isn''t on the team, so they can''t read this board. Add them to the team first.', v_off
      using errcode = '23514';
  end if;
  return new;
end $$;

-- ---------------------------------------------------------------------
-- A request's country: access rules use it. Defaults to the expert's country for a
-- tiering request and to the requester's home country otherwise. Fixed once submitted.
-- ---------------------------------------------------------------------
comment on column public.event_request.country_code is 'Where the event is (tiering: the expert''s country). Access rules use it once submitted.';

create or replace function app.check_request_country() returns trigger
language plpgsql as $$
begin
  if app.current_user_id() is null then return new; end if;
  if tg_op = 'INSERT' then
    new.country_code := coalesce(new.country_code,
      (select h.country_code from public.hcp h where h.id = new.hcp_id),
      (select u.country_code from public.app_user u where u.id = app.access_user_id()));
  elsif old.status <> 'draft' and new.country_code is distinct from old.country_code then
    raise exception 'Only draft requests can be changed' using errcode = '23514';
  end if;
  return new;
end $$;
create trigger check_request_country before insert or update on public.event_request
  for each row execute function app.check_request_country();

-- save_request takes country_code (as before otherwise)
create or replace function public.save_request(p jsonb) returns public.event_request
language plpgsql set search_path = public, pg_temp as $$
declare r public.event_request; expert text;
begin
  if p ? 'id' then
    select * into r from public.event_request where id = (p ->> 'id')::uuid;
    if not found then raise exception 'Request not found' using errcode = 'P0002'; end if;
  else
    r.request_type := coalesce(nullif(p ->> 'request_type', ''), 'event');
    if not exists (select 1 from public.request_type where code = r.request_type) then
      raise exception 'Choose the kind of request' using errcode = '22023';
    end if;
  end if;
  if p ? 'rationale' then r.rationale := nullif(btrim(p ->> 'rationale'), ''); end if;
  if p ? 'custom_fields' then r.custom_fields := coalesce(nullif(p -> 'custom_fields', 'null'::jsonb), '{}'::jsonb); end if;
  if p ? 'country_code' then r.country_code := nullif(p ->> 'country_code', ''); end if;

  if r.request_type = 'tiering' then
    if p ? 'hcp_id' then r.hcp_id := nullif(p ->> 'hcp_id', '')::uuid; end if;
    if p ? 'related_event_id' then r.related_event_id := nullif(p ->> 'related_event_id', '')::uuid; end if;
    if r.hcp_id is null then raise exception 'Choose the expert' using errcode = '23502'; end if;
    select display_name into expert from public.hcp where id = r.hcp_id;
    if expert is null then raise exception 'That expert doesn''t exist' using errcode = '22023'; end if;
    if r.related_event_id is not null and not exists (select 1 from public.event where id = r.related_event_id) then
      raise exception 'That event doesn''t exist, or you can''t see it' using errcode = '22023';
    end if;
    r.title := 'Tiering: ' || expert;
    r.event_type_id := null; r.event_date := null; r.duration := null;
  else
    if p ? 'title' then r.title := nullif(btrim(p ->> 'title'), ''); end if;
    if p ? 'event_type_id' then r.event_type_id := nullif(p ->> 'event_type_id', '')::uuid; end if;
    if p ? 'event_date' then r.event_date := nullif(p ->> 'event_date', '')::date; end if;
    if p ? 'duration' then r.duration := nullif(p ->> 'duration', ''); end if;
    if r.title is null then raise exception 'Give the request a name' using errcode = '23502'; end if;
    if r.event_type_id is null then raise exception 'Choose an event type' using errcode = '23502'; end if;
  end if;

  if r.id is null then
    insert into public.event_request (request_type, title, event_type_id, event_date, duration, rationale, hcp_id, related_event_id, custom_fields, country_code)
    values (r.request_type, r.title, r.event_type_id, r.event_date, r.duration, r.rationale, r.hcp_id, r.related_event_id, coalesce(r.custom_fields, '{}'), r.country_code)
    returning * into r;
  else
    update public.event_request set title = r.title, event_type_id = r.event_type_id, event_date = r.event_date,
           duration = r.duration, rationale = r.rationale, hcp_id = r.hcp_id, related_event_id = r.related_event_id,
           custom_fields = coalesce(r.custom_fields, '{}'), country_code = r.country_code
     where id = r.id
    returning * into r;
    if not found then raise exception 'You can''t change this request' using errcode = '42501'; end if;
  end if;
  return r;
end $$;
comment on function public.save_request(jsonb) is
  'Create or change a draft request. Event request: {request_type: event, title, event_type_id, event_date, duration, country_code, rationale, custom_fields}. Tiering request: {request_type: tiering, hcp_id, related_event_id?, country_code?, rationale, custom_fields}. Country defaults to the expert''s (tiering) or the requester''s home country.';

-- ---------------------------------------------------------------------
-- Managers
-- ---------------------------------------------------------------------
alter table public.app_user add column manager_id uuid references public.app_user(id) on delete set null;
comment on column public.app_user.manager_id is 'Their manager: an active person in the organisation. Approves their requests once approval processes say so.';
create index app_user_manager_idx on public.app_user (manager_id);

create or replace function app.check_manager() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
declare v_name text;
begin
  if tg_op = 'UPDATE' and new.manager_id is not distinct from old.manager_id then return new; end if;
  if tg_op = 'INSERT' and new.manager_id is null then return new; end if;
  if app.current_user_id() is not null and not app.has_perm('app_user', 'edit') then
    raise exception 'Only admins change someone''s manager' using errcode = '42501';
  end if;
  if new.manager_id is null then return new; end if;
  if new.manager_id = new.id then
    raise exception 'Someone can''t be their own manager' using errcode = '23514';
  end if;
  if not exists (select 1 from public.app_user u where u.id = new.manager_id and u.tenant_id = new.tenant_id
                    and u.user_type = 'human' and u.status = 'active') then
    raise exception 'A manager is an active person in your organisation' using errcode = '23514';
  end if;
  -- Nobody manages their own manager, however far up
  with recursive up(id, depth) as (
    select new.manager_id, 1
    union all
    select u.manager_id, up.depth + 1 from public.app_user u join up on u.id = up.id
     where u.manager_id is not null and up.depth < 50)
  select m.display_name into v_name from up join public.app_user m on m.id = new.manager_id where up.id = new.id limit 1;
  if v_name is not null then
    raise exception '% already reports to %, so % can''t be their manager', v_name, new.display_name, v_name using errcode = '23514';
  end if;
  return new;
end $$;
create trigger check_manager before insert or update of manager_id on public.app_user
  for each row execute function app.check_manager();

-- ---------------------------------------------------------------------
-- Permissions (seeds add the same for a fresh database)
-- ---------------------------------------------------------------------
-- Everyone who works on events reads groups and access rules, to see who's on a team and why
insert into public.permission (tenant_id, profile_id, object_name, can_read)
select p.tenant_id, p.id, o, true
  from public.profile p
 cross join unnest(array['user_group', 'user_group_member', 'access_rule']) o
 where exists (select 1 from public.permission x where x.profile_id = p.id and x.object_name = 'event' and x.can_read)
on conflict (profile_id, object_name) do nothing;
-- Admin-area profiles that manage users (Business Admins) manage groups and access rules too
update public.permission x set can_read = true, can_create = true, can_edit = true, can_delete = true
  from public.profile p
 where p.id = x.profile_id and p.can_access_admin
   and x.object_name in ('user_group', 'user_group_member', 'access_rule')
   and exists (select 1 from public.permission u where u.profile_id = p.id and u.object_name = 'app_user' and u.can_edit);
-- Groups on teams go with the team
insert into public.permission (tenant_id, profile_id, object_name, can_read, can_create, can_edit, can_delete, view_all, modify_all)
select tenant_id, profile_id, n.target, can_read, can_create, can_edit, can_delete, view_all, modify_all
  from public.permission x
  join (values ('event_team_member', 'event_team_group'), ('request_team_member', 'request_team_group')) n(source, target)
    on n.source = x.object_name
on conflict (profile_id, object_name) do nothing;

-- ---------------------------------------------------------------------
-- Email replies mention anyone on the team, groups included
-- (receive_email as in 20261111100000_email_delivery, with app.team_user_ids)
-- ---------------------------------------------------------------------
create or replace function public.receive_email(p jsonb) returns public.email_message
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_caller public.app_user;
  v_in public.email_message;
  v_out public.email_message;
  v_from text := lower(coalesce(substring(p->>'from' from '<([^>]+)>'), btrim(p->>'from')));
  v_token text := lower(substring(p->>'to' from '(?i)reply[+-]([a-z0-9]+)@'));
  v_text text := app.email_reply_text(p->>'text');
  v_provider text := nullif(p->>'id', '');
  v_inbox text;
  v_user public.app_user;
  v_headers text := current_setting('request.headers', true);
  v_post uuid; v_root uuid; v_name text; v_mentions uuid[];
  v_m text[]; v_decision text; v_note text; r public.event_request;
begin
  select * into v_caller from public.app_user where id = app.current_user_id();
  if v_caller.user_type is distinct from 'agent' or not app.has_perm('email_message', 'create') then
    raise exception 'Only the email service delivers replies' using errcode = '42501';
  end if;
  if coalesce(p->>'from', '') = '' or coalesce(p->>'to', '') = '' then
    raise exception 'A reply needs from and to addresses' using errcode = '22023';
  end if;

  -- Taken already (the service delivers again when it isn't sure we got it)
  if v_provider is not null then
    select * into v_in from public.email_message
     where tenant_id = v_caller.tenant_id and direction = 'inbound' and provider_id = v_provider;
    if v_in.id is not null then return v_in; end if;
  end if;

  select * into v_out from public.email_message
   where reply_token = v_token and direction = 'outbound' and tenant_id = v_caller.tenant_id;
  select * into v_user from public.app_user
   where tenant_id = v_caller.tenant_id and user_type = 'human' and lower(email) = v_from;
  -- Demo inbox: a reply from it is the reply of the person the email was for
  select lower(demo_inbox) into v_inbox from public.tenant where id = v_caller.tenant_id;
  if v_out.id is not null and v_inbox is not null and v_from = v_inbox then
    select * into v_user from public.app_user where id = v_out.user_id;
  end if;

  insert into public.email_message (tenant_id, direction, kind, status, user_id, from_address, to_address, subject, body,
                                    record_type, record_id, in_reply_to, provider_id)
  values (v_caller.tenant_id, 'inbound', 'reply', 'received', v_user.id, p->>'from', p->>'to',
          coalesce(nullif(p->>'subject', ''), '(no subject)'), coalesce(p->>'text', ''),
          v_out.record_type, v_out.record_id, v_out.id, v_provider)
  returning * into v_in;

  begin
    if v_out.id is null then
      raise exception 'This isn''t a reply to an Event Center email';
    end if;
    if v_user.id is null or v_user.id <> v_out.user_id then
      raise exception 'Sent from %, not the address this email went to', v_from;
    end if;
    if p ? 'authentication' and jsonb_typeof(p->'authentication') = 'object'
       and coalesce(lower(p->'authentication'->>'spf'), '') <> 'pass' and coalesce(lower(p->'authentication'->>'dkim'), '') <> 'pass' then
      raise exception 'Couldn''t confirm the reply really came from %', v_from;
    end if;
    if v_text is null then
      raise exception 'The reply had no text above the reply line';
    end if;

    -- Act as the person who replied: the agent's on-behalf-of, and the email channel
    perform set_config('request.headers',
      (coalesce(nullif(v_headers, '')::jsonb, '{}'::jsonb) || jsonb_build_object('x-on-behalf-of', v_user.id))::text, true);
    perform set_config('app.channel', 'email', true);

    if v_out.kind = 'mention' then
      if v_out.record_type = 'event' then
        if not app.can_view_event(v_out.record_id) then raise exception 'You''re no longer on this event''s team'; end if;
        select coalesce(parent_id, id) into v_root from public.event_post where id = v_out.post_id;
        if v_root is null then raise exception 'The post you were mentioned in was deleted'; end if;
        select coalesce(array_agg(t.user_id), '{}') into v_mentions from app.team_user_ids('event', v_out.record_id) t(user_id) join public.app_user u on u.id = t.user_id
         where position(lower('@' || u.display_name) in lower(v_text)) > 0;
        insert into public.event_post (tenant_id, event_id, parent_id, body, mentions)
        values (v_caller.tenant_id, v_out.record_id, v_root, v_text, v_mentions) returning id into v_post;
        select name into v_name from public.event where id = v_out.record_id;
      else
        if not app.can_view_request(v_out.record_id) then raise exception 'You''re no longer on this request''s team'; end if;
        select coalesce(parent_id, id) into v_root from public.request_post where id = v_out.post_id;
        if v_root is null then raise exception 'The post you were mentioned in was deleted'; end if;
        select coalesce(array_agg(t.user_id), '{}') into v_mentions from app.team_user_ids('request', v_out.record_id) t(user_id) join public.app_user u on u.id = t.user_id
         where position(lower('@' || u.display_name) in lower(v_text)) > 0;
        insert into public.request_post (tenant_id, request_id, parent_id, body, mentions)
        values (v_caller.tenant_id, v_out.record_id, v_root, v_text, v_mentions) returning id into v_post;
        select title into v_name from public.event_request where id = v_out.record_id;
      end if;
      update public.email_message set status = 'processed', processed_at = now(), post_id = v_post,
             status_note = format('Posted as a reply in the %s discussion', v_name)
       where id = v_in.id returning * into v_in;

    elsif v_out.kind = 'approval' then
      v_m := regexp_match(v_text, '^\s*(approved?|reject(?:ed)?)\M[\s.,:;!–—-]*(.*)$', 'is');
      if v_m is null then
        raise exception 'Start the reply with Approve or Reject';
      end if;
      v_decision := case when lower(v_m[1]) like 'approve%' then 'approved' else 'rejected' end;
      v_note := nullif(btrim(v_m[2], E' \t\r\n'), '');
      r := public.decide_request(v_out.record_id, v_decision, v_note);
      update public.email_message set status = 'processed', processed_at = now(),
             status_note = format('%s %s', case v_decision when 'approved' then 'Approved' else 'Rejected' end, r.title)
       where id = v_in.id returning * into v_in;
    end if;
  exception when others then
    update public.email_message set status = 'failed', processed_at = now(), status_note = sqlerrm
     where id = v_in.id returning * into v_in;
  end;

  perform set_config('app.channel', '', true);
  perform set_config('request.headers', coalesce(v_headers, ''), true);
  return v_in;
end $$;

grant execute on all functions in schema app to authenticated, service_role;
