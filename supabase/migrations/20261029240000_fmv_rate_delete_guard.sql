-- =====================================================================
-- FMV rates are added, edited and deleted on the expert page. A rate an engagement was priced from
-- stays on record: deleting it is refused with a clear reason (set an expiration date instead).
-- =====================================================================
create or replace function app.check_fmv_rate_delete() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
declare n int;
begin
  -- Deleting the expert takes their rates with them
  if not exists (select 1 from public.hcp where id = old.hcp_id) then return old; end if;
  select count(*) into n from public.event_expert where fmv_rate_id = old.id;
  if n > 0 then
    raise exception 'This FMV rate priced % engagement%, so it stays on record. Set an expiration date instead',
      n, case when n = 1 then '' else 's' end using errcode = '23503';
  end if;
  return old;
end $$;
create trigger check_fmv_rate_delete before delete on public.fmv_rate
  for each row execute function app.check_fmv_rate_delete();

grant execute on all functions in schema app to authenticated, service_role;
