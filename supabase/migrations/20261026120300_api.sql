-- =====================================================================
-- Event Coordinator — API functions & workflow rules
-- Everything a client (our UI, an agent, a customer-built UI) needs
-- beyond plain table access lives here, exposed as POST /rest/v1/rpc/<name>.
-- Functions are SECURITY INVOKER unless noted, so RLS still applies.
-- =====================================================================

-- ---------------------------------------------------------------------
-- me(): who am I, what can I do — the shell's first call
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
    'profile', jsonb_build_object('id', p.id, 'name', p.name, 'is_admin', p.is_admin),
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
comment on function public.me() is 'Current user, profile, tenant branding and object permissions.';
grant execute on function public.me() to authenticated;

-- Records the login time (called by the client after sign-in)
create or replace function public.touch_last_login() returns void
language sql security definer set search_path = public, pg_temp as $$
  update public.app_user set last_login_at = now() where id = app.current_user_id()
$$;
grant execute on function public.touch_last_login() to authenticated;

-- ---------------------------------------------------------------------
-- Event lifecycle
-- draft → review → contract → execution → closed ; any open stage → cancelled
-- review → draft (sent back) ; contract → review (re-review)
-- ---------------------------------------------------------------------
create table public.event_status_transition (
  from_status text not null references public.event_status(code),
  to_status   text not null references public.event_status(code),
  primary key (from_status, to_status)
);
insert into public.event_status_transition values
  ('draft','review'), ('review','draft'), ('review','contract'), ('contract','review'),
  ('contract','execution'), ('execution','closed'),
  ('draft','cancelled'), ('review','cancelled'), ('contract','cancelled'), ('execution','cancelled');
alter table public.event_status_transition enable row level security;
create policy event_status_transition_read on public.event_status_transition for select to authenticated using (true);
revoke all on public.event_status_transition from anon;
grant select on public.event_status_transition to authenticated;
comment on table public.event_status_transition is 'Allowed lifecycle moves — data, so clients can render valid next steps.';

create or replace function public.change_event_status(p_event_id uuid, p_status text, p_reason text default null)
returns public.event
language plpgsql as $$
declare e public.event;
begin
  select * into e from public.event where id = p_event_id for update;
  if not found then raise exception 'Event not found or not visible' using errcode = 'P0002'; end if;
  if e.status = p_status then return e; end if;
  if not exists (select 1 from public.event_status_transition where from_status = e.status and to_status = p_status) then
    raise exception 'Cannot move event from % to %', e.status, p_status using errcode = '22023';
  end if;
  if p_status = 'cancelled' and coalesce(trim(p_reason), '') = '' then
    raise exception 'A reason is required to cancel an event' using errcode = '22023';
  end if;
  update public.event
     set status = p_status,
         cancel_reason = case when p_status = 'cancelled' then p_reason else cancel_reason end
   where id = p_event_id
  returning * into e;
  return e;
end $$;
comment on function public.change_event_status(uuid, text, text) is 'The only supported way to move an event through its lifecycle.';
grant execute on function public.change_event_status(uuid, text, text) to authenticated;

-- Direct status edits are blocked; status changes go through change_event_status()
create or replace function app.guard_event_status() returns trigger
language plpgsql as $$
begin
  if new.status is distinct from old.status
     and not exists (select 1 from public.event_status_transition where from_status = old.status and to_status = new.status) then
    raise exception 'Cannot move event from % to %', old.status, new.status using errcode = '22023';
  end if;
  return new;
end $$;
create trigger guard_event_status before update of status on public.event
  for each row execute function app.guard_event_status();

-- ---------------------------------------------------------------------
-- New events: owner defaults to the creator and joins the team
-- ---------------------------------------------------------------------
create or replace function app.event_defaults() returns trigger
language plpgsql as $$
begin
  if new.owner_id is null then new.owner_id := app.current_user_id(); end if;
  return new;
end $$;
create trigger event_defaults before insert on public.event
  for each row execute function app.event_defaults();

create or replace function app.event_owner_on_team() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if new.owner_id is not null then
    insert into public.event_team_member (tenant_id, event_id, user_id, team_role, role_label, created_by)
    values (new.tenant_id, new.id, new.owner_id, 'owner', 'Organiser', new.created_by)
    on conflict (event_id, user_id) do update set team_role = 'owner';
  end if;
  return null;
end $$;
create trigger event_owner_on_team after insert or update of owner_id on public.event
  for each row execute function app.event_owner_on_team();

-- ---------------------------------------------------------------------
-- Notifications: created by the system on behalf of workflows
-- ---------------------------------------------------------------------
create or replace function app.notify(p_user_id uuid, p_kind text, p_title text, p_body text,
                                      p_record_type text, p_record_id uuid)
returns void language sql security definer set search_path = public, pg_temp as $$
  insert into public.notification (tenant_id, user_id, kind, title, body, record_type, record_id)
  select u.tenant_id, u.id, p_kind, p_title, p_body, p_record_type, p_record_id
    from public.app_user u where u.id = p_user_id
$$;

create or replace function public.mark_notifications_read(p_ids uuid[] default null) returns int
language sql as $$
  with upd as (
    update public.notification set read_at = now()
     where user_id = app.current_user_id() and read_at is null
       and (p_ids is null or id = any(p_ids))
    returning 1)
  select count(*)::int from upd
$$;
grant execute on function public.mark_notifications_read(uuid[]) to authenticated;

-- ---------------------------------------------------------------------
-- Pre-login branding: the sign-in screen may show the tenant name/colour
-- (and nothing else) before anyone is authenticated.
-- ---------------------------------------------------------------------
create or replace function public.tenant_branding(p_slug text)
returns table (name text, brand_name text, brand_color text)
language sql stable security definer set search_path = public, pg_temp as $$
  select t.name, t.brand_name, t.brand_color from public.tenant t where t.slug = p_slug
$$;
revoke all on function public.tenant_branding(text) from public;
grant execute on function public.tenant_branding(text) to anon, authenticated;
