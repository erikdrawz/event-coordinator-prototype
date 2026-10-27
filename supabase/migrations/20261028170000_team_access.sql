-- =====================================================================
-- Event Coordinator — the Team decides who can access an event
-- Profiles still say what kind of things someone may do (object permissions). The event's Team
-- now says which events: you see an event when you're on its Team, and you change it when your
-- Team role allows editing. Profiles with "view all" / "modify all" on event (Business Admin,
-- System Admin) see or change every event regardless.
--   owner      created or leads the event; edits everything, manages the team (one per event)
--   organizer  edits everything, manages the team
--   approver   views and posts; approving comes with approvals
--   viewer     views and posts
-- An agent acting for a human (X-On-Behalf-Of) gets that human's access.
-- Everything hanging off an event follows it. Posts, reactions and tasks only need access to the
-- event (any team member can post); everything else needs edit access.
-- =====================================================================

-- Roles are data (labels, what they allow), like event_status
create table public.team_role (
  code         text primary key,
  label        text not null,
  description  text not null,
  can_edit     boolean not null,
  sort         int not null
);
insert into public.team_role (code, label, description, can_edit, sort) values
  ('owner',     'Owner',     'Leads the event. Can edit everything and manage the team.', true,  10),
  ('organizer', 'Organizer', 'Can edit everything and manage the team.',                 true,  20),
  ('approver',  'Approver',  'Can view the event and post. Approvals come later.',        false, 30),
  ('viewer',    'Viewer',    'Can view the event and post.',                              false, 40);
alter table public.team_role enable row level security;
create policy team_role_read on public.team_role for select to authenticated using (true);
revoke all on public.team_role from anon;
grant select on public.team_role to authenticated;
comment on table public.team_role is 'Event team access roles: what each allows on the event.';

alter table public.event_team_member drop constraint event_team_member_team_role_check;
update public.event_team_member set team_role = case team_role
  when 'owner' then 'owner' when 'co_host' then 'organizer' when 'logistics' then 'organizer'
  when 'medical' then 'approver' when 'compliance' then 'approver' else 'viewer' end;
alter table public.event_team_member alter column team_role set default 'viewer';
alter table public.event_team_member add constraint event_team_member_team_role_fkey foreign key (team_role) references public.team_role(code);
comment on column public.event_team_member.team_role is 'Access on this event (team_role). role_label is the free functional label, e.g. "Medical lead".';

-- ---------------------------------------------------------------------
-- Access
-- ---------------------------------------------------------------------
create or replace function app.access_user_id() returns uuid
language sql stable security definer set search_path = public, pg_temp as $$
  select coalesce(app.on_behalf_of_user_id(), app.current_user_id())
$$;
comment on function app.access_user_id() is 'Whose event access applies: the human an agent acts for, else the caller.';

create or replace function app.perm_flag(p_object text, p_flag text) returns boolean
language sql stable security definer set search_path = public, pg_temp as $$
  select coalesce((select case p_flag when 'view_all' then pm.view_all or pm.modify_all when 'modify_all' then pm.modify_all end
                     from public.permission pm
                    where pm.profile_id = app.current_profile_id() and pm.object_name = p_object), false)
$$;

-- 'edit', 'view' or null
create or replace function app.event_access(p_event_id uuid) returns text
language sql stable security definer set search_path = public, pg_temp as $$
  select case
    when app.is_admin() or app.perm_flag('event', 'modify_all') then 'edit'
    when exists (select 1 from public.event_team_member m join public.team_role r on r.code = m.team_role
                  where m.event_id = p_event_id and m.user_id = app.access_user_id() and r.can_edit) then 'edit'
    when app.perm_flag('event', 'view_all')
      or exists (select 1 from public.event_team_member m where m.event_id = p_event_id and m.user_id = app.access_user_id()) then 'view'
  end
$$;
create or replace function app.can_view_event(p_event_id uuid) returns boolean
language sql stable as $$ select app.event_access(p_event_id) is not null $$;
create or replace function app.can_edit_event(p_event_id uuid) returns boolean
language sql stable as $$ select app.event_access(p_event_id) = 'edit' $$;

-- For clients: my access to an event, so the UI only offers what the database allows
create or replace function public.my_event_access(p_event_id uuid) returns jsonb
language sql stable security definer set search_path = public, pg_temp as $$
  select jsonb_build_object('access', app.event_access(p_event_id),
    'team_role', (select m.team_role from public.event_team_member m where m.event_id = p_event_id and m.user_id = app.access_user_id()))
$$;
comment on function public.my_event_access(uuid) is 'The caller''s access to an event: {access: edit|view|null, team_role}.';
grant execute on function public.my_event_access(uuid) to authenticated;

-- ---------------------------------------------------------------------
-- Policies
-- ---------------------------------------------------------------------
drop policy event_read on public.event;
drop policy event_update on public.event;
drop policy event_delete on public.event;
-- The owner clause covers the moment of creation, before the owner-on-team trigger has run
create policy event_read on public.event for select to authenticated
  using (tenant_id = app.current_tenant_id() and app.has_perm('event', 'read')
         and (owner_id = app.access_user_id() or app.can_view_event(id)));
create policy event_update on public.event for update to authenticated
  using (tenant_id = app.current_tenant_id() and app.has_perm('event', 'edit')
         and (owner_id = app.access_user_id() or app.can_edit_event(id)))
  with check (tenant_id = app.current_tenant_id());
create policy event_delete on public.event for delete to authenticated
  using (tenant_id = app.current_tenant_id() and app.has_perm('event', 'delete') and app.can_edit_event(id));

-- Tables that belong to an event: read with the event; write with edit access (or, for team
-- writes, with any access to the event)
create or replace function app.secure_event_table(p_table text, p_team_writes boolean default false) returns void
language plpgsql as $$
declare w text := case when p_team_writes then 'app.can_view_event(event_id)' else 'app.can_edit_event(event_id)' end;
begin
  execute format('drop policy if exists %I on public.%I', p_table || '_read', p_table);
  execute format('drop policy if exists %I on public.%I', p_table || '_insert', p_table);
  execute format('drop policy if exists %I on public.%I', p_table || '_update', p_table);
  execute format('drop policy if exists %I on public.%I', p_table || '_delete', p_table);
  execute format($p$create policy %I on public.%I for select to authenticated
                   using (tenant_id = app.current_tenant_id() and app.has_perm(%L, 'read') and app.can_view_event(event_id))$p$,
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
comment on function app.secure_event_table(text, boolean) is 'Policies for a table with event_id: readable with the event, writable with edit access (or any access when p_team_writes).';

select app.secure_event_table(t) from unnest(array[
  'event_product', 'event_team_member', 'event_session', 'event_expert', 'event_session_speaker', 'event_attendee',
  'event_contracting_org', 'event_content', 'event_expert_contract', 'event_attendee_contract', 'org_contract']) t;
select app.secure_event_table(t, true) from unnest(array['event_post', 'event_post_reaction', 'event_task']) t;

-- Posts: anyone on the team writes; only the author (or an editor of the event) changes or deletes
drop policy event_post_update on public.event_post;
drop policy event_post_delete on public.event_post;
create policy event_post_update on public.event_post for update to authenticated
  using (tenant_id = app.current_tenant_id() and app.has_perm('event_post', 'edit') and app.can_view_event(event_id)
         and (author_id = app.current_user_id() or app.can_edit_event(event_id)))
  with check (tenant_id = app.current_tenant_id());
create policy event_post_delete on public.event_post for delete to authenticated
  using (tenant_id = app.current_tenant_id() and app.can_view_event(event_id)
         and (author_id = app.current_user_id() or (app.has_perm('event_post', 'delete') and app.can_edit_event(event_id))));
-- Reactions are your own
drop policy event_post_reaction_insert on public.event_post_reaction;
drop policy event_post_reaction_delete on public.event_post_reaction;
create policy event_post_reaction_insert on public.event_post_reaction for insert to authenticated
  with check (coalesce(tenant_id, app.current_tenant_id()) = app.current_tenant_id() and app.has_perm('event_post_reaction', 'create')
              and app.can_view_event(event_id) and user_id = app.current_user_id());
create policy event_post_reaction_delete on public.event_post_reaction for delete to authenticated
  using (tenant_id = app.current_tenant_id() and app.can_view_event(event_id) and user_id = app.current_user_id());

-- The audit trail of an event is visible with the event
drop policy audit_log_read on public.audit_log;
create policy audit_log_read on public.audit_log for select to authenticated
  using (tenant_id = app.current_tenant_id() and app.has_perm('audit_log', 'read') and (event_id is null or app.can_view_event(event_id)));

-- ---------------------------------------------------------------------
-- Team rules
-- ---------------------------------------------------------------------
-- One owner: the event's owner_id. Owner changes go through the event (update_event), which
-- moves the owner role; the previous owner stays on as organizer.
create or replace function app.event_owner_on_team() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if tg_op = 'UPDATE' and old.owner_id is distinct from new.owner_id and old.owner_id is not null then
    update public.event_team_member set team_role = 'organizer' where event_id = new.id and user_id = old.owner_id;
  end if;
  if new.owner_id is not null then
    insert into public.event_team_member (tenant_id, event_id, user_id, team_role, created_by)
    values (new.tenant_id, new.id, new.owner_id, 'owner', new.created_by)
    on conflict (event_id, user_id) do update set team_role = 'owner';
  end if;
  return null;
end $$;

create or replace function app.check_team_member() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
declare owner uuid;
begin
  select owner_id into owner from public.event where id = coalesce(new.event_id, old.event_id);
  if tg_op = 'DELETE' then
    if old.user_id = owner then raise exception 'The event owner can''t be removed from the team' using errcode = '23514'; end if;
    -- Internal speakers leave the agenda with the team
    delete from public.event_session_speaker where event_id = old.event_id and user_id = old.user_id;
    return old;
  end if;
  if new.team_role = 'owner' and new.user_id is distinct from owner then
    raise exception 'Only the event''s owner has the Owner role. Change the owner on the event instead.' using errcode = '23514';
  end if;
  if tg_op = 'UPDATE' and old.user_id = owner and new.team_role <> 'owner' then
    raise exception 'The event owner keeps the Owner role' using errcode = '23514';
  end if;
  if not exists (select 1 from public.app_user u where u.id = new.user_id and u.status = 'active' and u.tenant_id = coalesce(new.tenant_id, app.current_tenant_id())) then
    raise exception 'Only active users of your organisation can join the team' using errcode = '23514';
  end if;
  return new;
end $$;
create trigger check_team_member before insert or update or delete on public.event_team_member
  for each row execute function app.check_team_member();
-- (an event being deleted takes its team with it: the owner check above finds no event then)

grant execute on all functions in schema app to authenticated, service_role;
