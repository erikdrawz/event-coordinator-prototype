-- =====================================================================
-- Event Center — Reading the audit trail quickly
-- * audit_log_read checked "can I see this event?" (app.can_view_event) once per audit row, so a
--   query over someone's whole history (Home → Recently worked on) took seconds and timed out.
-- * The same rule now works out the events the caller can see once per query
--   (app.visible_event_ids(), evaluated as an init plan) and checks each row against that list;
--   the caller's tenant and permissions are also worked out once.
--   Who can read what is unchanged.
-- =====================================================================

create or replace function app.visible_event_ids() returns uuid[]
language sql stable security definer set search_path = public, pg_temp as $$
  select coalesce(array_agg(e.id), '{}') from public.event e
   where e.tenant_id = app.current_tenant_id() and app.can_view_event(e.id)
$$;
comment on function app.visible_event_ids() is 'Ids of the events the caller can see. Use as (select app.visible_event_ids()) in policies, so it runs once per query.';

drop policy audit_log_read on public.audit_log;
create policy audit_log_read on public.audit_log for select to authenticated
  using (tenant_id = (select app.current_tenant_id()) and (select app.has_perm('audit_log', 'read'))
         and (event_id is null or event_id = any (coalesce((select app.visible_event_ids()), '{}'::uuid[])))
         and (table_name <> 'event_request' or app.can_view_request(record_id))
         and (table_name <> 'request_team_member' or (select app.is_admin() or app.perm_flag('event_request', 'view_all'))));

-- Someone's own history, newest first (Home → Recently worked on)
create index if not exists audit_log_actor_idx on public.audit_log (actor_user_id, at desc);

grant execute on all functions in schema app to authenticated, service_role;
