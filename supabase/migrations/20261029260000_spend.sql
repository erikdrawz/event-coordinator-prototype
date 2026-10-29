-- =====================================================================
-- Event Center — Spend (Phase 5, first slice)
-- * event_spend: what was paid — one invoice or receipt line, for one person or a group (a dinner).
-- * event_spend_attribution: who received it, as clean per-person amounts. An individual expense
--   has one attribution; a group expense is split evenly across the attendees chosen (colleagues
--   count towards the per-head value but aren't reportable); venue hire has none.
-- * event_tov: the Transfer of Value lines for reporting — HCP attributions in a reportable category,
--   plus the honorarium of each engagement's latest signed contract (Fees for service). Fees are
--   never copied into spend, so there is one source.
-- * Invoices are stored in the spend bucket (spend/<event id>/<uuid>/<file>). The Invoice Agent
--   reads them (simulated here: a catalogue of demo invoices, extract_invoice()).
-- =====================================================================

-- ---------------------------------------------------------------------
-- Edit checks answer true or false, never null: "if not app.can_edit_event(…)" in a function
-- must refuse someone with no access at all (null would slip through)
-- ---------------------------------------------------------------------
create or replace function app.can_edit_event(p_event_id uuid) returns boolean
language sql stable as $$ select coalesce(app.event_access(p_event_id) = 'edit', false) $$;
create or replace function app.can_edit_request(p_request_id uuid) returns boolean
language sql stable as $$ select coalesce(app.request_access(p_request_id) = 'edit', false) $$;

-- ---------------------------------------------------------------------
-- Lookups: ToV category (EFPIA-style) and expense type (with its usual category)
-- ---------------------------------------------------------------------
create table public.tov_category (
  code        text primary key,
  label       text not null,
  reportable  boolean not null,
  sort        int  not null
);
insert into public.tov_category (code, label, reportable, sort) values
  ('fees_for_service',     'Fees for service',        true,  10),
  ('travel_accommodation', 'Travel & accommodation',  true,  20),
  ('registration_fees',    'Registration fees',       true,  30),
  ('hospitality',          'Meals & hospitality',     true,  40),
  ('sponsorship',          'Sponsorship',             true,  50),
  ('not_reportable',       'Not reportable',          false, 90);
comment on table public.tov_category is 'Transfer of Value categories for disclosure reporting; not_reportable covers costs that reach no HCP or HCO.';

create table public.spend_type (
  code          text primary key,
  label         text not null,
  tov_category  text not null references public.tov_category(code),
  sort          int  not null
);
insert into public.spend_type (code, label, tov_category, sort) values
  ('venue',         'Venue',           'not_reportable',       10),
  ('meals',         'Meals & catering','hospitality',          20),
  ('accommodation', 'Accommodation',   'travel_accommodation', 30),
  ('travel',        'Travel',          'travel_accommodation', 40),
  ('registration',  'Registration',    'registration_fees',    50),
  ('equipment',     'AV & equipment',  'not_reportable',       60),
  ('materials',     'Print & materials','not_reportable',      70),
  ('other',         'Other',           'not_reportable',       90);
comment on table public.spend_type is 'Kinds of expense; tov_category is the usual ToV category, suggested when one is recorded.';

do $$ declare t text; begin
  foreach t in array array['tov_category', 'spend_type'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('create policy %I on public.%I for select to authenticated using (true)', t || '_read', t);
    execute format('revoke all on public.%I from anon', t);
    execute format('grant select on public.%I to authenticated', t);
  end loop;
end $$;

-- ---------------------------------------------------------------------
-- Spend and who received it
-- ---------------------------------------------------------------------
create table public.event_spend (
  id              uuid primary key default gen_random_uuid(),
  tenant_id       uuid not null references public.tenant(id),
  event_id        uuid not null references public.event(id) on delete cascade,
  spend_type      text not null references public.spend_type(code),
  tov_category    text not null references public.tov_category(code),
  spend_date      date not null,
  description     text not null check (btrim(description) <> ''),
  vendor          text,
  invoice_number  text,
  amount          numeric(12,2) not null check (amount > 0),
  currency        char(3) not null default 'EUR',
  document_path   text,
  document_name   text,
  source          text not null default 'manual' check (source in ('manual', 'scan')),
  drafted_by      uuid references public.app_user(id),
  created_at      timestamptz not null default now(),
  created_by      uuid references public.app_user(id),
  updated_at      timestamptz not null default now(),
  updated_by      uuid references public.app_user(id)
);
create index event_spend_event_idx on public.event_spend (event_id, spend_date);
comment on table public.event_spend is 'What was paid for an event: one invoice or receipt line, for one person or a group. Speaker fees come from signed contracts, not from here.';
comment on column public.event_spend.drafted_by is 'The agent that read the invoice (source = scan); a person confirmed it.';

create table public.event_spend_attribution (
  id                 uuid primary key default gen_random_uuid(),
  tenant_id          uuid not null references public.tenant(id),
  event_id           uuid not null references public.event(id) on delete cascade,
  spend_id           uuid not null references public.event_spend(id) on delete cascade,
  event_attendee_id  uuid references public.event_attendee(id) on delete set null,
  hcp_id             uuid references public.hcp(id),
  user_id            uuid references public.app_user(id),
  recipient_name     text not null,
  amount             numeric(12,2) not null check (amount >= 0),
  created_at         timestamptz not null default now(),
  created_by         uuid references public.app_user(id),
  unique (spend_id, event_attendee_id)
);
create index event_spend_attribution_spend_idx on public.event_spend_attribution (spend_id);
create index event_spend_attribution_hcp_idx on public.event_spend_attribution (hcp_id);
comment on table public.event_spend_attribution is 'Who received a spend line and how much: the clean per-person amount (a dinner split evenly). HCP rows are what ToV reports; colleagues only count towards the per-head value. The recipient is kept if they later leave the attendee list.';

select app.secure_table('event_spend');
select app.secure_table('event_spend_attribution');
select app.secure_event_table('event_spend');
select app.secure_event_table('event_spend_attribution');

-- A scanned line names the agent that read it; the category starts from the expense type
create or replace function app.check_spend() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if new.tov_category is null then
    select tov_category into new.tov_category from public.spend_type where code = new.spend_type;
  end if;
  new.currency := upper(new.currency);
  if new.drafted_by is not null and not exists (select 1 from public.app_user where id = new.drafted_by and user_type = 'agent') then
    raise exception 'drafted_by must be an agent' using errcode = '23514';
  end if;
  return new;
end $$;
create trigger check_spend before insert or update on public.event_spend
  for each row execute function app.check_spend();

-- ---------------------------------------------------------------------
-- Splitting: even shares across the chosen attendees; leftover cents go to the first ones,
-- so the shares always add up to the amount. Changing the amount re-spreads the same people.
-- ---------------------------------------------------------------------
create or replace function app.spread_spend(p_spend_id uuid, p_attendee_ids uuid[]) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
declare s public.event_spend; n int; cents bigint; base bigint; extra int; i int := 0; a record;
begin
  select * into s from public.event_spend where id = p_spend_id;
  delete from public.event_spend_attribution where spend_id = p_spend_id;
  n := coalesce(array_length(p_attendee_ids, 1), 0);
  if n = 0 then return; end if;
  cents := round(s.amount * 100); base := cents / n; extra := (cents % n)::int;
  for a in
    select x.id, x.hcp_id, x.user_id, coalesce(h.display_name, u.display_name, x.display_name, 'Unknown') as name, ord
      from unnest(p_attendee_ids) with ordinality as t(id, ord)
      join public.event_attendee x on x.id = t.id and x.event_id = s.event_id
      left join public.hcp h on h.id = x.hcp_id
      left join public.app_user u on u.id = x.user_id
     order by ord
  loop
    i := i + 1;
    insert into public.event_spend_attribution (tenant_id, event_id, spend_id, event_attendee_id, hcp_id, user_id, recipient_name, amount)
    values (s.tenant_id, s.event_id, s.id, a.id, a.hcp_id, a.user_id, a.name, (base + case when i <= extra then 1 else 0 end) / 100.0);
  end loop;
  if i <> n then raise exception 'Every person must be an attendee of this event' using errcode = '22023'; end if;
end $$;

-- Who received a spend line: one attendee (an expert's hotel) or several (a dinner, split evenly); none clears it
create or replace function public.split_spend(p_spend_id uuid, p_attendee_ids uuid[]) returns void
language plpgsql set search_path = public, pg_temp as $$
declare ev uuid;
begin
  select event_id into ev from public.event_spend where id = p_spend_id;   -- RLS: only spend you can see
  if ev is null then raise exception 'Spend line not found' using errcode = 'P0002'; end if;
  if not (app.has_perm('event_spend_attribution', 'create') and app.can_edit_event(ev)) then
    raise exception 'You can''t change who received this spend' using errcode = '42501';
  end if;
  if coalesce(array_length(p_attendee_ids, 1), 0) > 500 then
    raise exception 'Split across at most 500 people' using errcode = '22023';
  end if;
  perform app.spread_spend(p_spend_id, coalesce(p_attendee_ids, '{}'));
end $$;
comment on function public.split_spend(uuid, uuid[]) is 'Sets who received a spend line: even shares across the attendees given (leftover cents to the first), or none.';
revoke all on function public.split_spend(uuid, uuid[]) from public, anon;
grant execute on function public.split_spend(uuid, uuid[]) to authenticated;

create or replace function app.respread_spend() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  perform app.spread_spend(new.id, array(select event_attendee_id from public.event_spend_attribution
                                           where spend_id = new.id and event_attendee_id is not null order by created_at, id));
  return null;
end $$;
create trigger respread_spend after update of amount on public.event_spend
  for each row when (new.amount is distinct from old.amount) execute function app.respread_spend();

-- ---------------------------------------------------------------------
-- ToV: reportable transfers to HCPs, from spend and from signed contracts
-- ---------------------------------------------------------------------
create or replace view public.event_tov with (security_invoker = true) as
  select a.event_id, 'spend'::text as source, s.id as source_id, a.id as line_id, a.hcp_id, h.display_name as hcp_name,
         h.onekey_id, h.crm_external_id, h.country_code, s.tov_category, a.amount, s.currency, s.spend_date as tov_date,
         s.description, s.vendor, s.invoice_number
    from public.event_spend_attribution a
    join public.event_spend s on s.id = a.spend_id
    join public.tov_category c on c.code = s.tov_category and c.reportable
    join public.hcp h on h.id = a.hcp_id
  union all
  select k.event_id, 'contract', k.id, k.id, k.counterparty_hcp_id, h.display_name, h.onekey_id, h.crm_external_id, h.country_code,
         'fees_for_service', (k.honorarium ->> 'total')::numeric, coalesce(k.honorarium ->> 'currency', 'EUR'), k.signed_at::date,
         t.label || ' ' || k.contract_number, null, k.contract_number
    from (select distinct on (c.event_expert_id) c.*
            from public.contract c
           where c.status = 'executed' and c.event_expert_id is not null and c.honorarium is not null
           order by c.event_expert_id, c.signed_at desc nulls last) k
    join public.hcp h on h.id = k.counterparty_hcp_id
    join public.contract_type t on t.code = k.contract_type;
comment on view public.event_tov is 'Transfer of Value lines per event: HCP shares of reportable spend, and each engagement''s latest signed contract honorarium (Fees for service).';
grant select on public.event_tov to authenticated;

-- ---------------------------------------------------------------------
-- Invoices: spend/<event id>/<uuid>/<file>, readable with the event, written with edit access
-- ---------------------------------------------------------------------
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('spend', 'spend', false, 10485760, array['application/pdf', 'image/png', 'image/jpeg'])
on conflict (id) do nothing;
create or replace function app.event_id_of_path(p_name text) returns uuid
language sql immutable as $$
  select case when split_part(p_name, '/', 1) ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
              then split_part(p_name, '/', 1)::uuid end
$$;
drop policy if exists spend_files_read on storage.objects;
drop policy if exists spend_files_insert on storage.objects;
drop policy if exists spend_files_delete on storage.objects;
create policy spend_files_read on storage.objects for select to authenticated
  using (bucket_id = 'spend' and app.can_view_event(app.event_id_of_path(name)));
create policy spend_files_insert on storage.objects for insert to authenticated
  with check (bucket_id = 'spend' and app.has_perm('event_spend', 'create') and app.can_edit_event(app.event_id_of_path(name)));
create policy spend_files_delete on storage.objects for delete to authenticated
  using (bucket_id = 'spend' and app.can_edit_event(app.event_id_of_path(name)));

-- ---------------------------------------------------------------------
-- The Invoice Agent (simulated): reads an invoice into a draft spend line for a person to confirm.
-- A catalogue of demo invoices stands in for real extraction; anything else comes back with the
-- file name and empty fields. Swap extract_invoice() for a real reader without touching the UI.
-- ---------------------------------------------------------------------
create table public.demo_invoice (
  file_pattern    text primary key,          -- matched case-insensitively against the file name
  vendor          text not null,
  invoice_number  text not null,
  invoice_date_offset int not null,          -- days from the event's start
  description     text not null,
  spend_type      text not null references public.spend_type(code),
  amount          numeric(12,2) not null,
  currency        char(3) not null default 'EUR',
  recipient       text not null default 'none' check (recipient in ('none', 'one', 'attended')),
  guest_name      text,                      -- recipient = 'one': the guest named on the invoice
  lines           jsonb not null default '[]'
);
comment on table public.demo_invoice is 'Demo stand-in for invoice extraction: what the Invoice Agent "reads" from the bundled demo invoices.';
alter table public.demo_invoice enable row level security;
revoke all on public.demo_invoice from anon, authenticated;

create or replace function public.extract_invoice(p_event_id uuid, p_file_name text) returns jsonb
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare d public.demo_invoice; e public.event; agent public.app_user; guest uuid;
begin
  select * into e from public.event where id = p_event_id;
  if e.id is null or not app.can_edit_event(p_event_id) then
    raise exception 'Event not found, or you can''t record its spend' using errcode = '42501';
  end if;
  select * into agent from public.app_user
   where tenant_id = e.tenant_id and user_type = 'agent' and status = 'active' and agent_purpose ilike '%invoice%' limit 1;
  select * into d from public.demo_invoice where p_file_name ilike '%' || file_pattern || '%' limit 1;
  if d.file_pattern is null then
    return jsonb_build_object('found', false, 'agent', jsonb_build_object('id', agent.id, 'name', agent.display_name),
      'description', regexp_replace(p_file_name, '\.[a-z0-9]+$', '', 'i'), 'spend_type', 'other', 'tov_category', 'not_reportable',
      'currency', 'EUR', 'spend_date', coalesce((e.starts_at at time zone e.timezone)::date, current_date), 'recipient', 'none');
  end if;
  if d.recipient = 'one' then
    select x.id into guest from public.event_attendee x left join public.hcp h on h.id = x.hcp_id
     where x.event_id = p_event_id and h.display_name ilike '%' || d.guest_name || '%' limit 1;
  end if;
  return jsonb_build_object('found', true, 'agent', jsonb_build_object('id', agent.id, 'name', agent.display_name),
    'vendor', d.vendor, 'invoice_number', d.invoice_number, 'description', d.description,
    'spend_type', d.spend_type, 'tov_category', (select tov_category from public.spend_type where code = d.spend_type),
    'amount', d.amount, 'currency', d.currency, 'lines', d.lines,
    'spend_date', coalesce((e.starts_at at time zone e.timezone)::date, current_date) + d.invoice_date_offset,
    'recipient', d.recipient, 'guest_name', d.guest_name,
    -- one guest: the attendee named on the invoice (when they are one); attended: everyone marked attended, else everyone who accepted
    'attendee_ids', case d.recipient
      when 'one' then case when guest is null then '[]'::jsonb else jsonb_build_array(guest) end
      when 'attended' then coalesce((select jsonb_agg(x.id order by x.attendee_kind, x.created_at) from public.event_attendee x
                                      where x.event_id = p_event_id and (x.attended or (not exists (select 1 from public.event_attendee y where y.event_id = p_event_id and y.attended) and x.rsvp = 'accepted'))), '[]'::jsonb)
      else '[]'::jsonb end);
end $$;
comment on function public.extract_invoice(uuid, text) is 'The Invoice Agent reading an invoice (simulated from demo_invoice): a draft spend line with a suggested recipient or split.';
revoke all on function public.extract_invoice(uuid, text) from public, anon;
grant execute on function public.extract_invoice(uuid, text) to authenticated;

-- Permissions: like attendees (seed 00 does the same on a fresh database)
insert into public.permission (tenant_id, profile_id, object_name, can_read, can_create, can_edit, can_delete, view_all, modify_all)
select tenant_id, profile_id, o, can_read, can_create, can_edit, can_delete, view_all, modify_all
  from public.permission, unnest(array['event_spend', 'event_spend_attribution']) o
 where object_name = 'event_attendee'
on conflict do nothing;

grant execute on all functions in schema app to authenticated, service_role;
