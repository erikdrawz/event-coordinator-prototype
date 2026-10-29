-- =====================================================================
-- Event Center — No FMV, no rate
-- * Without an FMV record valid on the event's date an expert's rate is €0, fixed: the flat
--   EUR 100 (80–120) was a stand-in from before the FMV table and gave a made-up honorarium.
-- * Recording an FMV rate fills it in for the expert's engagements still at €0 without one
--   (unless a contract has been sent or signed).
-- =====================================================================

create or replace function public.expert_rate_policy(p_hcp_id uuid default null, p_event_id uuid default null) returns jsonb
language sql stable security definer set search_path = public, pg_temp as $$
  with d as (
    select coalesce((select (e.starts_at at time zone e.timezone)::date from public.event e where e.id = p_event_id and e.starts_at is not null),
                    current_date) as on_date
  ), f as (
    select r.* from public.fmv_rate r, d
     where r.hcp_id = p_hcp_id and r.tenant_id = coalesce(app.current_tenant_id(), r.tenant_id)
       and r.effective_date <= d.on_date and (r.expiration_date is null or r.expiration_date >= d.on_date)
     order by r.effective_date desc limit 1
  )
  select coalesce(
    (select jsonb_build_object('mode', 'negotiable', 'default', f.rate, 'min', f.min_rate, 'max', f.max_rate, 'currency', f.currency,
                               'source', 'fmv', 'fmv_rate_id', f.id, 'effective_date', f.effective_date, 'expiration_date', f.expiration_date) from f),
    jsonb_build_object('mode', 'fixed', 'default', 0, 'min', 0, 'max', 0, 'currency', 'EUR', 'source', 'none'))
$$;
comment on function public.expert_rate_policy(uuid, uuid) is
  'How an expert''s hourly rate may be set on an event: {mode, default, min, max, currency, source: fmv|none, fmv_rate_id}. From the FMV record valid on the event''s date (today without an event); fixed at 0 when there is none.';

drop function app.expert_rate();

create or replace function app.check_expert_rate() returns trigger
language plpgsql as $$
declare pol jsonb := public.expert_rate_policy(new.hcp_id, new.event_id);
        cur text := pol ->> 'currency';
begin
  if new.hourly_rate is null then
    new.hourly_rate := (pol ->> 'default')::numeric;
    new.currency := cur;
    new.fmv_rate_id := (pol ->> 'fmv_rate_id')::uuid;
  end if;
  if tg_op = 'INSERT' and new.fmv_rate_id is null then new.fmv_rate_id := (pol ->> 'fmv_rate_id')::uuid; end if;
  if pol ->> 'source' = 'none' and new.hourly_rate <> 0 then
    raise exception 'This expert has no FMV rate for the event''s date. Record one on their expert page to set a rate' using errcode = '23514';
  end if;
  if pol ->> 'mode' = 'fixed' and new.hourly_rate <> (pol ->> 'default')::numeric then
    raise exception 'The rate is fixed at % per hour', app.money_text((pol ->> 'default')::numeric, cur) using errcode = '23514';
  end if;
  if new.hourly_rate < (pol ->> 'min')::numeric or new.hourly_rate > (pol ->> 'max')::numeric then
    raise exception 'The rate must be between % and % per hour', app.money_text((pol ->> 'min')::numeric, cur), app.money_text((pol ->> 'max')::numeric, cur)
      using errcode = '23514';
  end if;
  return new;
end $$;

-- A new FMV record fills in the rate where the expert had none. Security definer: whoever records
-- FMV may do this without edit access to each event; it only replaces the €0 placeholder.
create or replace function app.apply_fmv_rate() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  update public.event_expert x set hourly_rate = null   -- check_expert_rate fills it from the policy on the event's date
   where x.hcp_id = new.hcp_id and x.tenant_id = new.tenant_id and x.fmv_rate_id is null and x.hourly_rate = 0
     and not app.expert_keeps_without_sessions(x.id);
  return null;
end $$;
create trigger apply_fmv_rate after insert or update on public.fmv_rate
  for each row execute function app.apply_fmv_rate();

-- Engagements that took the old flat rate start again from the policy: €0, or their FMV rate
update public.event_expert x set hourly_rate = null
 where x.fmv_rate_id is null and not app.expert_keeps_without_sessions(x.id);

grant execute on all functions in schema app to authenticated, service_role;
