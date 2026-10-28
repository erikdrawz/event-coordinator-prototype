-- =====================================================================
-- Event Coordinator — Requests
-- A request is a short form so managers and home office see incoming event volume:
-- name, event type, start and end, business justification, and a status
-- (draft → review → approved | rejected). Like an event, it has a Team that decides who
-- can open it, and a discussion board for the team.
--   * The creator owns it and is on its team from the start.
--   * Drafts are private to the team. Once submitted, profiles with "view all" on
--     event_request (home office: Event Coordinators, Business Admins) see it too.
--   * Only drafts change or get deleted (System Admins can delete any request). Submitting moves draft → review; approving and
--     rejecting come with approvals.
-- =====================================================================

-- ---------------------------------------------------------------------
-- Statuses: draft, review, approved, rejected
-- ---------------------------------------------------------------------
insert into public.request_status (code, label, tone, sort) values ('review', 'Review', 'yellow', 20);
update public.event_request set status = 'review' where status in ('submitted', 'under_review');
delete from public.request_status where code in ('submitted', 'under_review');
update public.request_status set sort = case code when 'draft' then 10 when 'review' then 20 when 'approved' then 30 when 'rejected' then 40 end;

-- ---------------------------------------------------------------------
-- Start and end are date and time, in the request's time zone (like events)
-- ---------------------------------------------------------------------
alter table public.event_request
  add column timezone  text not null default 'Europe/London',
  add column starts_at timestamptz,
  add column ends_at   timestamptz;
update public.event_request r set
  timezone  = coalesce(c.default_timezone, 'Europe/London'),
  starts_at = (r.proposed_start + time '09:00') at time zone coalesce(c.default_timezone, 'Europe/London'),
  ends_at   = (coalesce(r.proposed_end, r.proposed_start) + time '17:00') at time zone coalesce(c.default_timezone, 'Europe/London')
  from public.event_request r2 left join public.country c on c.code = r2.country_code
 where r2.id = r.id and r.proposed_start is not null;
alter table public.event_request
  drop column proposed_start,
  drop column proposed_end,
  add constraint event_request_dates_ok check (ends_at is null or starts_at is null or ends_at >= starts_at);
comment on column public.event_request.title is 'The request''s name (shown as Name).';
comment on column public.event_request.rationale is 'Business justification.';
comment on column public.event_request.timezone is 'IANA zone the start and end are entered and shown in.';
create index event_request_status_idx on public.event_request (tenant_id, status);

-- Team role descriptions now apply to events and requests
update public.team_role set description = case code
  when 'owner'     then 'Leads it. Can edit everything and manage the team.'
  when 'organizer' then 'Can edit everything and manage the team.'
  when 'approver'  then 'Can view and post. Approvals come later.'
  when 'viewer'    then 'Can view and post.' end;
comment on table public.team_role is 'Team access roles on events and requests: what each allows.';

-- ---------------------------------------------------------------------
-- Team and discussion board
-- ---------------------------------------------------------------------
create table public.request_team_member (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null references public.tenant(id),
  request_id  uuid not null references public.event_request(id) on delete cascade,
  user_id     uuid not null references public.app_user(id),
  team_role   text not null default 'viewer' references public.team_role(code),
  role_label  text,
  created_at  timestamptz not null default now(),
  created_by  uuid references public.app_user(id),
  updated_at  timestamptz not null default now(),
  updated_by  uuid references public.app_user(id),
  unique (request_id, user_id)
);
comment on table public.request_team_member is 'Who can access a request and how (team_role). The creator is the owner.';

create table public.request_post (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null references public.tenant(id),
  request_id  uuid not null references public.event_request(id) on delete cascade,
  parent_id   uuid references public.request_post(id) on delete cascade,
  author_id   uuid not null default app.current_user_id() references public.app_user(id),
  body        text not null,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
create index request_post_request_idx on public.request_post (request_id, created_at desc);
comment on table public.request_post is 'The request team''s discussion board: posts and replies (parent_id).';

create table public.request_post_reaction (
  post_id     uuid not null references public.request_post(id) on delete cascade,
  user_id     uuid not null default app.current_user_id() references public.app_user(id),
  emoji       text not null,
  tenant_id   uuid not null references public.tenant(id),
  request_id  uuid not null references public.event_request(id) on delete cascade,
  created_at  timestamptz not null default now(),
  primary key (post_id, user_id, emoji)
);

-- Stamping and grants; the policies follow below. Posts aren't audited (drafts are private).
select app.secure_table('request_team_member');
select app.secure_table('request_post', p_audit => false);
select app.secure_table('request_post_reaction', p_audit => false);

-- ---------------------------------------------------------------------
-- Access: 'edit', 'view' or null
-- ---------------------------------------------------------------------
create or replace function app.request_access(p_request_id uuid) returns text
language sql stable security definer set search_path = public, pg_temp as $$
  select case
    when app.is_admin() or app.perm_flag('event_request', 'modify_all') then 'edit'
    when exists (select 1 from public.request_team_member m join public.team_role r on r.code = m.team_role
                  where m.request_id = p_request_id and m.user_id = app.access_user_id() and r.can_edit) then 'edit'
    when exists (select 1 from public.request_team_member m where m.request_id = p_request_id and m.user_id = app.access_user_id()) then 'view'
    when app.perm_flag('event_request', 'view_all')
     and exists (select 1 from public.event_request q where q.id = p_request_id and q.status <> 'draft') then 'view'
  end
$$;
create or replace function app.can_view_request(p_request_id uuid) returns boolean
language sql stable as $$ select app.request_access(p_request_id) is not null $$;
create or replace function app.can_edit_request(p_request_id uuid) returns boolean
language sql stable as $$ select app.request_access(p_request_id) = 'edit' $$;

create or replace function public.my_request_access(p_request_id uuid) returns jsonb
language sql stable security definer set search_path = public, pg_temp as $$
  select jsonb_build_object('access', app.request_access(p_request_id),
    'team_role', (select m.team_role from public.request_team_member m where m.request_id = p_request_id and m.user_id = app.access_user_id()))
$$;
comment on function public.my_request_access(uuid) is 'The caller''s access to a request: {access: edit|view|null, team_role}.';
grant execute on function public.my_request_access(uuid) to authenticated;

-- ---------------------------------------------------------------------
-- Policies
-- ---------------------------------------------------------------------
drop policy event_request_read on public.event_request;
drop policy event_request_update on public.event_request;
drop policy event_request_delete on public.event_request;
-- The requester clause covers the moment of creation, before the owner-on-team trigger has run
create policy event_request_read on public.event_request for select to authenticated
  using (tenant_id = app.current_tenant_id() and app.has_perm('event_request', 'read')
         and (requested_by = app.access_user_id() or app.can_view_request(id)));
create policy event_request_update on public.event_request for update to authenticated
  using (tenant_id = app.current_tenant_id() and app.has_perm('event_request', 'edit') and app.can_edit_request(id))
  with check (tenant_id = app.current_tenant_id());
create policy event_request_delete on public.event_request for delete to authenticated
  using (tenant_id = app.current_tenant_id() and app.has_perm('event_request', 'delete') and app.can_edit_request(id)
         and (status = 'draft' or app.is_admin()));   -- System Admins can clean up any request

create or replace function app.secure_request_table(p_table text, p_team_writes boolean default false) returns void
language plpgsql as $$
declare w text := case when p_team_writes then 'app.can_view_request(request_id)' else 'app.can_edit_request(request_id)' end;
begin
  execute format('drop policy if exists %I on public.%I', p_table || '_read', p_table);
  execute format('drop policy if exists %I on public.%I', p_table || '_insert', p_table);
  execute format('drop policy if exists %I on public.%I', p_table || '_update', p_table);
  execute format('drop policy if exists %I on public.%I', p_table || '_delete', p_table);
  execute format($p$create policy %I on public.%I for select to authenticated
                   using (tenant_id = app.current_tenant_id() and app.has_perm(%L, 'read') and app.can_view_request(request_id))$p$,
                 p_table || '_read', p_table, p_table);
  execute format($p$create policy %I on public.%I for insert to authenticated
                   with check (coalesce(tenant_id, app.current_tenant_id()) = app.current_tenant_id() and app.has_perm(%L, 'create') and %s)$p$,
                 p_table || '_insert', p_table, p_table, w);
  execute format($p$create policy %I on public.%I for update to authenticated
                   using (tenant_id = app.current_tenant_id() and app.has_perm(%L, 'edit') and %s)
                   with check (tenant_id = app.current_tenant_id())$p$,
                 p_table || '_update', p_table, p_table, w);
  execute format($p$create policy %I on public.%I for delete to authenticated
                   using (tenant_id = app.current_tenant_id() and app.has_perm(%L, 'delete') and %s)$p$,
                 p_table || '_delete', p_table, p_table, w);
end $$;
comment on function app.secure_request_table(text, boolean) is 'Policies for a table with request_id: readable with the request, writable with edit access (or any access when p_team_writes).';

select app.secure_request_table('request_team_member');
select app.secure_request_table(t, true) from unnest(array['request_post', 'request_post_reaction']) t;

-- Posts: only the author (or an editor of the request) changes or deletes; reactions are your own
drop policy request_post_update on public.request_post;
drop policy request_post_delete on public.request_post;
create policy request_post_update on public.request_post for update to authenticated
  using (tenant_id = app.current_tenant_id() and app.has_perm('request_post', 'edit') and app.can_view_request(request_id)
         and (author_id = app.current_user_id() or app.can_edit_request(request_id)))
  with check (tenant_id = app.current_tenant_id());
create policy request_post_delete on public.request_post for delete to authenticated
  using (tenant_id = app.current_tenant_id() and app.can_view_request(request_id)
         and (author_id = app.current_user_id() or (app.has_perm('request_post', 'delete') and app.can_edit_request(request_id))));
drop policy request_post_reaction_insert on public.request_post_reaction;
drop policy request_post_reaction_delete on public.request_post_reaction;
create policy request_post_reaction_insert on public.request_post_reaction for insert to authenticated
  with check (coalesce(tenant_id, app.current_tenant_id()) = app.current_tenant_id() and app.has_perm('request_post_reaction', 'create')
              and app.can_view_request(request_id) and user_id = app.current_user_id());
create policy request_post_reaction_delete on public.request_post_reaction for delete to authenticated
  using (tenant_id = app.current_tenant_id() and app.can_view_request(request_id) and user_id = app.current_user_id());

-- The audit trail of a request is visible with the request
drop policy audit_log_read on public.audit_log;
create policy audit_log_read on public.audit_log for select to authenticated
  using (tenant_id = app.current_tenant_id() and app.has_perm('audit_log', 'read')
         and (event_id is null or app.can_view_event(event_id))
         and (table_name <> 'event_request' or app.can_view_request(record_id))
         and (table_name <> 'request_team_member' or app.is_admin() or app.perm_flag('event_request', 'view_all')));

-- ---------------------------------------------------------------------
-- Rules
-- ---------------------------------------------------------------------
create or replace function app.check_request() returns trigger
language plpgsql as $$
begin
  -- Seeds and migrations (no signed-in user) may write any state
  if app.current_user_id() is null then return new; end if;
  if tg_op = 'INSERT' then
    new.requested_by := app.access_user_id();
    new.status := 'draft';
    new.submitted_at := null;
    return new;
  end if;
  if new.requested_by is distinct from old.requested_by then
    raise exception 'The requester can''t be changed' using errcode = '23514';
  end if;
  if old.status <> 'draft' and (new.title, new.event_type_id, new.timezone, new.starts_at, new.ends_at, new.rationale)
       is distinct from (old.title, old.event_type_id, old.timezone, old.starts_at, old.ends_at, old.rationale) then
    raise exception 'Only draft requests can be changed' using errcode = '23514';
  end if;
  if new.status is distinct from old.status then
    if not (old.status = 'draft' and new.status = 'review') then
      raise exception 'Approving and rejecting requests comes with approvals' using errcode = '23514';
    end if;
    if new.starts_at is null or new.ends_at is null or coalesce(btrim(new.rationale), '') = '' then
      raise exception 'Add the start, end and business justification before submitting' using errcode = '23514';
    end if;
    new.submitted_at := now();
  end if;
  return new;
end $$;
create trigger check_request before insert or update on public.event_request
  for each row execute function app.check_request();

-- The requester owns the request and is on its team from the start
create or replace function app.request_owner_on_team() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if new.requested_by is not null then
    insert into public.request_team_member (tenant_id, request_id, user_id, team_role, created_by)
    values (new.tenant_id, new.id, new.requested_by, 'owner', new.created_by)
    on conflict (request_id, user_id) do update set team_role = 'owner';
  end if;
  return null;
end $$;
create trigger request_owner_on_team after insert on public.event_request
  for each row execute function app.request_owner_on_team();

create or replace function app.check_request_team_member() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
declare owner uuid;
begin
  select requested_by into owner from public.event_request where id = coalesce(new.request_id, old.request_id);
  if tg_op = 'DELETE' then
    if old.user_id = owner then raise exception 'The requester can''t be removed from the team' using errcode = '23514'; end if;
    return old;
  end if;
  if new.team_role = 'owner' and new.user_id is distinct from owner then
    raise exception 'Only the requester has the Owner role' using errcode = '23514';
  end if;
  if tg_op = 'UPDATE' and old.user_id = owner and new.team_role <> 'owner' then
    raise exception 'The requester keeps the Owner role' using errcode = '23514';
  end if;
  if not exists (select 1 from public.app_user u where u.id = new.user_id and u.status = 'active' and u.tenant_id = coalesce(new.tenant_id, app.current_tenant_id())) then
    raise exception 'Only active users of your organisation can join the team' using errcode = '23514';
  end if;
  return new;
end $$;
create trigger check_request_team_member before insert or update or delete on public.request_team_member
  for each row execute function app.check_request_team_member();
-- (a request being deleted takes its team with it: the owner check above finds no request then)

-- ---------------------------------------------------------------------
-- API: create or change a draft. Start and end come as local wall-clock time in p.timezone.
--   save_request({id?, title, event_type_id, timezone, starts_local, ends_local, rationale})
-- Submitting is update event_request set status = 'review' (the rules above check it).
-- ---------------------------------------------------------------------
create or replace function public.save_request(p jsonb) returns public.event_request
language plpgsql set search_path = public, pg_temp as $$
declare r public.event_request; tz text;
begin
  if p ? 'id' then
    select * into r from public.event_request where id = (p ->> 'id')::uuid;
    if not found then raise exception 'Request not found' using errcode = 'P0002'; end if;
  end if;
  tz := coalesce(nullif(p ->> 'timezone', ''), r.timezone, 'Europe/London');
  if not exists (select 1 from pg_timezone_names where name = tz) then
    raise exception 'Unknown time zone %', tz using errcode = '22023';
  end if;
  if p ? 'title' then r.title := nullif(btrim(p ->> 'title'), ''); end if;
  if p ? 'event_type_id' then r.event_type_id := nullif(p ->> 'event_type_id', '')::uuid; end if;
  if p ? 'rationale' then r.rationale := nullif(btrim(p ->> 'rationale'), ''); end if;
  r.timezone := tz;
  if p ? 'starts_local' then r.starts_at := nullif(p ->> 'starts_local', '')::timestamp at time zone tz; end if;
  if p ? 'ends_local' then r.ends_at := nullif(p ->> 'ends_local', '')::timestamp at time zone tz; end if;
  if r.title is null then raise exception 'Give the request a name' using errcode = '23502'; end if;
  if r.event_type_id is null then raise exception 'Choose an event type' using errcode = '23502'; end if;
  if r.ends_at < r.starts_at then raise exception 'The request ends before it starts' using errcode = '23514'; end if;

  if r.id is null then
    insert into public.event_request (title, event_type_id, timezone, starts_at, ends_at, rationale)
    values (r.title, r.event_type_id, r.timezone, r.starts_at, r.ends_at, r.rationale)
    returning * into r;
  else
    update public.event_request set title = r.title, event_type_id = r.event_type_id, timezone = r.timezone,
           starts_at = r.starts_at, ends_at = r.ends_at, rationale = r.rationale
     where id = r.id
    returning * into r;
    if not found then raise exception 'You can''t change this request' using errcode = '42501'; end if;
  end if;
  return r;
end $$;
comment on function public.save_request(jsonb) is 'Create or change a draft request; start and end are local times in the request''s time zone.';
grant execute on function public.save_request(jsonb) to authenticated;

-- Number sequences continue after the highest number in use (seeds and imports set numbers
-- explicitly; new records must not collide with them)
create or replace function app.sync_number_sequences() returns void
language sql security definer set search_path = public, pg_temp as $$
  select setval('public.event_request_number_seq', greatest(coalesce((select max(split_part(request_number, '-', 3)::int) from public.event_request where request_number ~ '^REQ-\d{4}-\d+$'), 0), 50) + 1, false);
  select setval('public.event_number_seq', greatest(coalesce((select max(split_part(event_number, '-', 3)::int) from public.event where event_number ~ '^EV-\d{4}-\d+$'), 0), 100) + 1, false);
$$;
comment on function app.sync_number_sequences() is 'Moves the request and event number sequences past the highest number in use. Run after seeding or importing.';
select app.sync_number_sequences();

grant execute on all functions in schema app to authenticated, service_role;
