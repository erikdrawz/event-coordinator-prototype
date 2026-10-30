-- =====================================================================
-- Every expert on an event is also one of its attendees
-- * Adding an expert adds them as an attendee, however they're added (Experts grid, agenda, agent).
--   Someone already attending keeps their row, so their RSVP and attendance stay. Whether an attendee
--   counts as an expert isn't stored: it's read from event_expert.
-- * An attendee who is still an expert can't be removed; remove them from the experts first. Removing
--   an expert keeps their attendee row, with its attendance and any spend attributed to it.
-- =====================================================================

create or replace function app.add_expert_as_attendee() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  insert into public.event_attendee (tenant_id, event_id, attendee_kind, hcp_id)
  values (new.tenant_id, new.event_id, 'hcp', new.hcp_id)
  on conflict (event_id, hcp_id) where hcp_id is not null do nothing;
  return null;
end $$;
create trigger add_expert_as_attendee after insert on public.event_expert
  for each row execute function app.add_expert_as_attendee();

create or replace function app.check_attendee_removal() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  -- When the event itself is being deleted it's gone already, and everything on it may go
  if old.hcp_id is not null
     and exists (select 1 from public.event_expert x where x.event_id = old.event_id and x.hcp_id = old.hcp_id)
     and exists (select 1 from public.event e where e.id = old.event_id) then
    raise exception 'They''re one of this event''s experts. Remove them from the experts first.' using errcode = '23514';
  end if;
  return old;
end $$;
create trigger check_attendee_removal before delete on public.event_attendee
  for each row execute function app.check_attendee_removal();

-- Experts added before this rule (no signed-in user here, so fill_attendee leaves the details to us)
insert into public.event_attendee (tenant_id, event_id, attendee_kind, hcp_id, organisation, role_label, crm_connection_id, crm_external_id, crm_status)
select x.tenant_id, x.event_id, 'hcp', x.hcp_id, o.name, initcap(x.role), h.crm_connection_id, h.crm_external_id,
       case when h.crm_connection_id is not null then 'reconciled' else 'pending' end
  from public.event_expert x
  join public.hcp h on h.id = x.hcp_id
  left join public.hco o on o.id = h.primary_hco_id
 where not exists (select 1 from public.event_attendee a where a.event_id = x.event_id and a.hcp_id = x.hcp_id);

grant execute on all functions in schema app to authenticated, service_role;
