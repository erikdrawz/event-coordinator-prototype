-- =====================================================================
-- Event Coordinator — Security
-- Row-level security on every table. Standard tables get:
--   tenant isolation + object permission (app.has_perm) + stamping + audit.
-- Special cases are spelled out explicitly below.
-- =====================================================================

set client_min_messages = warning;

-- Standard tenant-scoped business tables
do $$
declare t text;
begin
  foreach t in array array[
    'event_type','therapeutic_area','product','specialty','crm_connection',
    'hco','hcp','fmv_rate',
    'event_request','event','event_product','event_team_member','event_session',
    'event_expert','event_session_speaker','event_attendee','event_contracting_org',
    'content','event_content','contract',
    'event_expert_contract','event_attendee_contract','org_contract',
    'event_post','event_post_reaction','event_task',
    'approval_process','approval_process_step','approval','approval_action',
    'user_group','user_group_member'
  ] loop
    perform app.secure_table(t);
  end loop;
end $$;

-- ---------------------------------------------------------------------
-- Global lookups: readable by any signed-in user, written only by migrations
-- ---------------------------------------------------------------------
do $$
declare t text;
begin
  foreach t in array array['country','event_status','request_status'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('create policy %I on public.%I for select to authenticated using (true)', t || '_read', t);
    execute format('revoke all on public.%I from anon', t);
    execute format('grant select on public.%I to authenticated', t);
  end loop;
end $$;

-- ---------------------------------------------------------------------
-- Tenant: you can see your own tenant
-- ---------------------------------------------------------------------
alter table public.tenant enable row level security;
create policy tenant_read on public.tenant for select to authenticated using (id = app.current_tenant_id());
revoke all on public.tenant from anon;
grant select on public.tenant to authenticated;

-- ---------------------------------------------------------------------
-- Profiles & permissions: readable in tenant, admin-managed
-- ---------------------------------------------------------------------
alter table public.profile enable row level security;
create policy profile_read  on public.profile for select to authenticated using (tenant_id = app.current_tenant_id());
create policy profile_admin on public.profile for all    to authenticated using (tenant_id = app.current_tenant_id() and app.is_admin())
                                                           with check (tenant_id = app.current_tenant_id() and app.is_admin());
alter table public.permission enable row level security;
create policy permission_read  on public.permission for select to authenticated using (tenant_id = app.current_tenant_id());
create policy permission_admin on public.permission for all    to authenticated using (tenant_id = app.current_tenant_id() and app.is_admin())
                                                                 with check (tenant_id = app.current_tenant_id() and app.is_admin());
revoke all on public.profile, public.permission from anon;
grant select, insert, update, delete on public.profile, public.permission to authenticated;

-- ---------------------------------------------------------------------
-- Users: everyone in the tenant is visible (names/avatars);
-- you can update yourself, admins can manage everyone.
-- ---------------------------------------------------------------------
alter table public.app_user enable row level security;
create policy app_user_read on public.app_user for select to authenticated
  using (tenant_id = app.current_tenant_id());
create policy app_user_self_update on public.app_user for update to authenticated
  using (id = app.current_user_id())
  with check (id = app.current_user_id()
              and profile_id = app.current_profile_id()        -- cannot promote yourself
              and user_type  = (select u.user_type from public.app_user u where u.id = app.current_user_id()));
create policy app_user_admin on public.app_user for all to authenticated
  using (tenant_id = app.current_tenant_id() and app.is_admin())
  with check (tenant_id = app.current_tenant_id() and app.is_admin());
revoke all on public.app_user from anon;
grant select, insert, update, delete on public.app_user to authenticated;
create trigger stamp_row before insert or update on public.app_user for each row execute function app.stamp_row();
create trigger audit_row after insert or update or delete on public.app_user for each row execute function app.audit_row();

-- ---------------------------------------------------------------------
-- Notifications: strictly your own
-- ---------------------------------------------------------------------
alter table public.notification enable row level security;
create policy notification_own_read   on public.notification for select to authenticated using (user_id = app.current_user_id());
create policy notification_own_update on public.notification for update to authenticated using (user_id = app.current_user_id())
                                                                          with check (user_id = app.current_user_id());
create policy notification_own_delete on public.notification for delete to authenticated using (user_id = app.current_user_id());
-- inserts happen through workflow functions (security definer), not directly
revoke all on public.notification from anon;
grant select, update, delete on public.notification to authenticated;

-- ---------------------------------------------------------------------
-- Reactions: anyone who can read the event can react; only remove your own
-- ---------------------------------------------------------------------
drop policy if exists event_post_reaction_delete on public.event_post_reaction;
create policy event_post_reaction_delete on public.event_post_reaction for delete to authenticated
  using (tenant_id = app.current_tenant_id() and user_id = app.current_user_id());

-- Posts: only the author edits/deletes their own post (admins via modify_all)
drop policy if exists event_post_update on public.event_post;
create policy event_post_update on public.event_post for update to authenticated
  using (tenant_id = app.current_tenant_id() and (author_id = app.current_user_id() or app.has_perm('event_post','edit') and app.is_admin()))
  with check (tenant_id = app.current_tenant_id());
drop policy if exists event_post_delete on public.event_post;
create policy event_post_delete on public.event_post for delete to authenticated
  using (tenant_id = app.current_tenant_id() and (author_id = app.current_user_id() or app.is_admin()));

-- ---------------------------------------------------------------------
-- Audit log: read-only, tenant-scoped, needs read permission on audit_log
-- ---------------------------------------------------------------------
alter table public.audit_log enable row level security;
create policy audit_log_read on public.audit_log for select to authenticated
  using (tenant_id = app.current_tenant_id() and app.has_perm('audit_log','read'));
revoke all on public.audit_log from anon;
grant select on public.audit_log to authenticated;

-- Event History (ERD) = the audit trail of an event and everything on it
create view public.event_history with (security_invoker = true) as
  select a.id, a.event_id, a.at, a.table_name, a.record_id, a.action, a.changed,
         a.actor_user_id, actor.display_name as actor_name, actor.user_type as actor_type,
         a.on_behalf_of_user_id, obo.display_name as on_behalf_of_name
    from public.audit_log a
    left join public.app_user actor on actor.id = a.actor_user_id
    left join public.app_user obo   on obo.id   = a.on_behalf_of_user_id
   where a.event_id is not null;
grant select on public.event_history to authenticated;

-- Sequences used for human-readable numbers
grant usage on sequence public.event_request_number_seq, public.event_number_seq to authenticated;
