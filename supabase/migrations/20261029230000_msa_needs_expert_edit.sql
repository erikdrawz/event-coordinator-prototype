-- =====================================================================
-- A Master Service Agreement is an agreement with the expert, not with an event: adding one needs
-- the right to edit experts. Account Managers create event contracts, but not MSAs.
-- =====================================================================
create or replace function app.check_msa_creator() returns trigger
language plpgsql as $$
begin
  -- Seeds and migrations (no signed-in user) may write any state
  if app.current_user_id() is not null and new.contract_type = 'msa' and not app.has_perm('hcp', 'edit') then
    raise exception 'Only people who manage experts can add a Master Service Agreement' using errcode = '42501';
  end if;
  return new;
end $$;
create trigger check_msa_creator before insert on public.contract
  for each row execute function app.check_msa_creator();

grant execute on all functions in schema app to authenticated, service_role;
