-- =====================================================================
-- Event Center — Event eligibility follows the expert
-- * An expert joins an event with their eligibility (a copy, so one event can differ). When the
--   expert's eligibility changes, it now carries to their engagements that still had the old value,
--   on events that aren't closed or cancelled, unless a contract has been sent or signed.
--   Engagements set differently on purpose keep their own value.
-- =====================================================================

-- Security definer: whoever may edit the expert updates their engagements, without edit access to each event
create or replace function app.carry_expert_eligibility() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  update public.event_expert x set eligibility = new.eligibility
    from public.event e
   where x.hcp_id = new.id and x.tenant_id = new.tenant_id and e.id = x.event_id
     and x.eligibility = old.eligibility
     and e.status not in ('closed', 'cancelled')
     and not app.expert_keeps_without_sessions(x.id);
  return null;
end $$;
comment on function app.carry_expert_eligibility() is
  'Carries an expert''s new eligibility to their open engagements that still had the old value (no sent or signed contract).';
create trigger carry_expert_eligibility after update of eligibility on public.hcp
  for each row when (new.eligibility is distinct from old.eligibility) execute function app.carry_expert_eligibility();

-- Engagements left pending by an expert decided before this: follow the expert now
update public.event_expert x set eligibility = h.eligibility
  from public.hcp h, public.event e
 where h.id = x.hcp_id and e.id = x.event_id
   and x.eligibility = 'pending' and h.eligibility <> 'pending'
   and e.status not in ('closed', 'cancelled')
   and not app.expert_keeps_without_sessions(x.id);

grant execute on all functions in schema app to authenticated, service_role;
