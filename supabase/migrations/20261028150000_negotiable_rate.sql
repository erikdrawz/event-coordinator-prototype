-- =====================================================================
-- Event Coordinator — negotiable speaker rates
-- expert_rate_policy(hcp) says how a speaker's hourly rate may be set:
--   mode 'negotiable': default, and anywhere from min to max   (today: EUR 100, 80–120)
--   mode 'fixed':      always the default                      (for later)
-- Today it is one policy for everyone; it will come from the HCP's FMV record (fmv_rate).
-- A trigger holds every rate written to event_expert to the policy.
-- =====================================================================

create or replace function public.expert_rate_policy(p_hcp_id uuid default null) returns jsonb
language sql stable as $$
  select jsonb_build_object('mode', 'negotiable', 'default', app.expert_rate(), 'min', 80, 'max', 120, 'currency', 'EUR')
$$;
comment on function public.expert_rate_policy(uuid) is
  'How a speaker''s hourly rate may be set: {mode: negotiable|fixed, default, min, max, currency}. Today EUR 100, negotiable 80–120 for everyone; later from the HCP''s FMV record.';
grant execute on function public.expert_rate_policy(uuid) to authenticated;

create or replace function app.check_expert_rate() returns trigger
language plpgsql as $$
declare pol jsonb := public.expert_rate_policy(new.hcp_id);
begin
  if new.hourly_rate is null then new.hourly_rate := (pol ->> 'default')::numeric; end if;
  if pol ->> 'mode' = 'fixed' and new.hourly_rate <> (pol ->> 'default')::numeric then
    raise exception 'The rate is fixed at €% per hour', pol ->> 'default' using errcode = '23514';
  end if;
  if new.hourly_rate < (pol ->> 'min')::numeric or new.hourly_rate > (pol ->> 'max')::numeric then
    raise exception 'The rate must be between €% and €% per hour', pol ->> 'min', pol ->> 'max' using errcode = '23514';
  end if;
  return new;
end $$;
create trigger check_expert_rate before insert or update of hourly_rate on public.event_expert
  for each row execute function app.check_expert_rate();
