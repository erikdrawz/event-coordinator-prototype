-- =====================================================================
-- Event Coordinator — Experts (the HCP table seen as experts)
-- * Eligibility belongs to the expert (hcp.eligibility: eligible, in review, not eligible).
--   An expert added to an event starts with that eligibility; the event can still differ
--   (event_expert.eligibility, e.g. an annual cap reached for one engagement).
-- * FMV is simpler: one record per period with effective and expiration dates, a rate and the
--   negotiable range (min, max). No service type for now.
-- * The rate policy comes from the FMV record valid on the event's date. Without one, the
--   tenant default applies (EUR 100, 80–120). A new speaker's rate defaults from it.
-- =====================================================================

-- ---------------------------------------------------------------------
-- Eligibility
-- ---------------------------------------------------------------------
create table public.expert_eligibility (
  code   text primary key,
  label  text not null,
  tone   text not null,
  sort   int  not null
);
insert into public.expert_eligibility (code, label, tone, sort) values
  ('eligible',   'Eligible',     'green',  10),
  ('pending',    'In review',    'yellow', 20),
  ('ineligible', 'Not eligible', 'red',    30);
alter table public.expert_eligibility enable row level security;
create policy expert_eligibility_read on public.expert_eligibility for select to authenticated using (true);
revoke all on public.expert_eligibility from anon;
grant select on public.expert_eligibility to authenticated;
comment on table public.expert_eligibility is 'Whether an expert may be engaged: eligible, in review, not eligible.';

alter table public.hcp
  add column eligibility      text not null default 'pending' references public.expert_eligibility(code),
  add column eligibility_note text;
comment on column public.hcp.eligibility is 'Whether the expert may be engaged (expert_eligibility). New and imported experts start in review.';
comment on column public.hcp.eligibility_note is 'Why, when not simply eligible (e.g. annual cap reached, debarment check open).';
update public.hcp h set eligibility = 'eligible'
 where exists (select 1 from public.event_expert x where x.hcp_id = h.id and x.eligibility = 'eligible');

-- An expert joins an event with their own eligibility unless one is given
alter table public.event_expert alter column eligibility drop default;
create or replace function app.default_expert_eligibility() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if new.eligibility is null then
    new.eligibility := coalesce((select h.eligibility from public.hcp h where h.id = new.hcp_id), 'pending');
  end if;
  return new;
end $$;
create trigger default_expert_eligibility before insert on public.event_expert
  for each row execute function app.default_expert_eligibility();

-- ---------------------------------------------------------------------
-- FMV: effective date, expiration date, rate, min rate, max rate
-- ---------------------------------------------------------------------
-- One record per HCP and period: keep the highest rate where several services overlapped
update public.event_expert x set fmv_rate_id = k.keep
  from (select id, first_value(id) over (partition by hcp_id, valid_from order by hourly_rate desc, id) as keep from public.fmv_rate) k
 where x.fmv_rate_id = k.id and k.id <> k.keep;
delete from public.fmv_rate f
 using (select id, first_value(id) over (partition by hcp_id, valid_from order by hourly_rate desc, id) as keep from public.fmv_rate) k
 where f.id = k.id and k.id <> k.keep;

alter table public.fmv_rate rename column valid_from to effective_date;
alter table public.fmv_rate rename column valid_to to expiration_date;
alter table public.fmv_rate rename column hourly_rate to rate;
alter table public.fmv_rate
  add column min_rate numeric(12,2),
  add column max_rate numeric(12,2);
update public.fmv_rate set min_rate = round(rate * 0.8 / 10) * 10, max_rate = round(rate * 1.2 / 10) * 10;
alter table public.fmv_rate
  alter column min_rate set not null,
  alter column max_rate set not null,
  drop column service_type,
  drop column scope,
  drop column tier,
  add constraint fmv_rate_range_ok check (min_rate <= rate and rate <= max_rate),
  add constraint fmv_rate_dates_ok check (expiration_date is null or expiration_date >= effective_date);
create index fmv_rate_hcp_idx on public.fmv_rate (hcp_id, effective_date desc);
comment on table public.fmv_rate is 'Fair-market-value hourly rate per expert and period: the default rate and the range it can be negotiated in.';
comment on column public.fmv_rate.rate is 'Default hourly rate for a new engagement.';
comment on column public.fmv_rate.min_rate is 'Lowest hourly rate that may be agreed.';
comment on column public.fmv_rate.max_rate is 'Highest hourly rate that may be agreed.';
comment on column public.fmv_rate.expiration_date is 'Last day the record applies; null = until replaced.';

-- Periods of one expert don't overlap, so one record applies on any date
create or replace function app.check_fmv_rate() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if exists (select 1 from public.fmv_rate r
              where r.hcp_id = new.hcp_id and r.id <> new.id
                and daterange(r.effective_date, r.expiration_date, '[]') && daterange(new.effective_date, new.expiration_date, '[]')) then
    raise exception 'This expert already has an FMV rate for part of that period' using errcode = '23514';
  end if;
  return new;
end $$;
create trigger check_fmv_rate before insert or update on public.fmv_rate
  for each row execute function app.check_fmv_rate();

-- ---------------------------------------------------------------------
-- Rate policy from FMV
-- ---------------------------------------------------------------------
drop function public.expert_rate_policy(uuid);
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
    jsonb_build_object('mode', 'negotiable', 'default', app.expert_rate(), 'min', 80, 'max', 120, 'currency', 'EUR', 'source', 'default'))
$$;
comment on function public.expert_rate_policy(uuid, uuid) is
  'How an expert''s hourly rate may be set on an event: {mode, default, min, max, currency, source: fmv|default, fmv_rate_id}. From the FMV record valid on the event''s date (today without an event); EUR 100, 80–120 when there is none.';
grant execute on function public.expert_rate_policy(uuid, uuid) to authenticated;

-- Every expert on an event with their policy, for the honorarium grid: {hcp_id: policy}
create or replace function public.event_rate_policies(p_event_id uuid) returns jsonb
language sql stable as $$
  select coalesce(jsonb_object_agg(x.hcp_id, public.expert_rate_policy(x.hcp_id, p_event_id)), '{}'::jsonb)
    from public.event_expert x where x.event_id = p_event_id
$$;
comment on function public.event_rate_policies(uuid) is 'The rate policy of every expert on an event, keyed by hcp_id.';
grant execute on function public.event_rate_policies(uuid) to authenticated;

create or replace function app.money_text(p_amount numeric, p_currency text) returns text
language sql immutable as $$
  select case p_currency when 'EUR' then '€' when 'GBP' then '£' when 'USD' then '$' else p_currency || ' ' end
         || rtrim(to_char(p_amount, 'FM999G999D99'), '.')
$$;

-- A new speaker's rate (and currency, and the FMV record it came from) defaults from the policy;
-- any rate written must stay within it
alter table public.event_expert alter column hourly_rate drop default;   -- the policy decides, not a flat default
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
  if pol ->> 'mode' = 'fixed' and new.hourly_rate <> (pol ->> 'default')::numeric then
    raise exception 'The rate is fixed at % per hour', app.money_text((pol ->> 'default')::numeric, cur) using errcode = '23514';
  end if;
  if new.hourly_rate < (pol ->> 'min')::numeric or new.hourly_rate > (pol ->> 'max')::numeric then
    raise exception 'The rate must be between % and % per hour', app.money_text((pol ->> 'min')::numeric, cur), app.money_text((pol ->> 'max')::numeric, cur)
      using errcode = '23514';
  end if;
  return new;
end $$;

grant execute on all functions in schema app to authenticated, service_role;
