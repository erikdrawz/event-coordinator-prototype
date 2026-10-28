-- =====================================================================
-- Event Center — Contracting, first version
-- * Four contract types for experts:
--     Master Service Agreement (MSA): the expert's umbrella agreement, no event
--     Work Order: one engagement (an expert on an event), under a signed MSA that covers the event's date
--     Single-event Contract: one engagement, standalone
--     Addendum: changes a Work Order or Single-event Contract of the same engagement
--   Venue contracts (with an organisation) stay as they are.
-- * A contract is drafted from a template: Markdown with {{merge fields}}. EC fills the fields in
--   (expert, event, the agreed honorarium) and keeps the text and the honorarium on the contract.
-- * Templates are uploaded in Admin and made available per event type (event_type_contract_template),
--   in every country the event type is available in unless the template names countries.
-- * A template has versions, each in effect from a date (contract_template_version). A contract gets
--   the version in effect on its event's date (an MSA: its start date), so next year's version can
--   be prepared ahead. A version is fixed once a contract made from it has been sent.
-- * Statuses: draft → sent (a PDF is stored, handed to the contracting tool) → executed (signed);
--   draft or sent → cancelled. Only drafts change.
-- * An event contract belongs to its event: it is visible and editable with the event (Team access).
-- =====================================================================

-- ---------------------------------------------------------------------
-- Types and statuses
-- ---------------------------------------------------------------------
create table public.contract_type (
  code         text primary key,
  label        text not null,
  prefix       text not null,
  description  text,
  sort         int  not null
);
insert into public.contract_type (code, label, prefix, description, sort) values
  ('msa',            'Master Service Agreement', 'MSA', 'The expert''s umbrella agreement. Belongs to the expert, not to an event.', 10),
  ('work_order',     'Work Order',               'WO',  'One engagement on an event, under a signed Master Service Agreement.',   20),
  ('event_contract', 'Single-event Contract',    'SEC', 'One engagement on an event, standalone.',                                  30),
  ('addendum',       'Addendum',                 'ADD', 'Changes a Work Order or Single-event Contract.',                           40),
  ('venue',          'Venue contract',           'VEN', 'With a venue or another organisation.',                                    90);

create table public.contract_status (
  code   text primary key,
  label  text not null,
  tone   text not null,
  sort   int  not null
);
insert into public.contract_status (code, label, tone, sort) values
  ('draft',     'Draft',              'grey',  10),
  ('sent',      'Sent for signature', 'blue',  20),
  ('executed',  'Signed',             'green', 30),
  ('cancelled', 'Cancelled',          'grey',  40);

do $$ declare t text; begin
  foreach t in array array['contract_type', 'contract_status'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('create policy %I on public.%I for select to authenticated using (true)', t || '_read', t);
    execute format('revoke all on public.%I from anon', t);
    execute format('grant select on public.%I to authenticated', t);
  end loop;
end $$;
comment on table public.contract_type is 'Kinds of contract: MSA, Work Order, Single-event Contract, Addendum, venue.';
comment on table public.contract_status is 'Contract lifecycle: draft → sent (for signature) → executed (signed); cancelled.';

alter table public.contract drop constraint contract_contract_type_check;
alter table public.contract drop constraint contract_status_check;
update public.contract set contract_type = 'msa' where contract_type = 'service_agreement';
update public.contract set status = 'cancelled' where status in ('expired', 'terminated');
alter table public.contract
  add constraint contract_type_fkey   foreign key (contract_type) references public.contract_type(code),
  add constraint contract_status_fkey foreign key (status) references public.contract_status(code);

-- ---------------------------------------------------------------------
-- Templates
-- ---------------------------------------------------------------------
create table public.contract_template (
  id             uuid primary key default gen_random_uuid(),
  tenant_id      uuid not null references public.tenant(id),
  name           text not null,
  contract_type  text not null references public.contract_type(code),
  country_codes  char(2)[],
  is_active      boolean not null default true,
  created_at     timestamptz not null default now(),
  created_by     uuid references public.app_user(id),
  updated_at     timestamptz not null default now(),
  updated_by     uuid references public.app_user(id),
  unique (tenant_id, name)
);
comment on table public.contract_template is 'A contract template: what it''s for and where it''s used. The text lives in its versions.';
comment on column public.contract_template.country_codes is 'Only in these countries; null = every country the event type is available in.';

create table public.contract_template_version (
  id                    uuid primary key default gen_random_uuid(),
  tenant_id             uuid not null references public.tenant(id),
  contract_template_id  uuid not null references public.contract_template(id) on delete cascade,
  version               int  not null,
  effective_from        date not null,
  body                  text not null,
  file_name             text,
  notes                 text,
  created_at            timestamptz not null default now(),
  created_by            uuid references public.app_user(id),
  updated_at            timestamptz not null default now(),
  updated_by            uuid references public.app_user(id),
  unique (contract_template_id, version),
  unique (contract_template_id, effective_from)
);
comment on table public.contract_template_version is 'A version of a template''s text (Markdown with {{merge fields}}), in effect from a date until the next version.';
comment on column public.contract_template_version.notes is 'What changed in this version.';

create table public.event_type_contract_template (
  event_type_id         uuid not null references public.event_type(id) on delete cascade,
  contract_template_id  uuid not null references public.contract_template(id) on delete cascade,
  tenant_id             uuid not null references public.tenant(id),
  created_at            timestamptz not null default now(),
  created_by            uuid references public.app_user(id),
  primary key (event_type_id, contract_template_id)
);
comment on table public.event_type_contract_template is 'Which contract templates events of a type can use.';

select app.secure_table('contract_template');
select app.secure_table('contract_template_version');
select app.secure_table('event_type_contract_template');

-- The merge fields a template can use, with what they hold
create or replace function public.contract_merge_fields() returns table (field text, description text)
language sql immutable as $$
  select f, d from (values
    ('contract.number',            'Contract number, e.g. WO-2026-1001'),
    ('contract.title',             'Contract title'),
    ('contract.type',              'Contract type, e.g. Work Order'),
    ('contract.start_date',        'Start date'),
    ('contract.end_date',          'End date'),
    ('today',                      'The date the contract is drafted'),
    ('template.name',              'Template name'),
    ('template.version',           'Template version, e.g. 3'),
    ('company.name',               'Your company'),
    ('expert.name',                'Expert''s full name with title'),
    ('expert.first_name',          'Expert''s first name'),
    ('expert.last_name',           'Expert''s last name'),
    ('expert.specialty',           'Specialty'),
    ('expert.organisation',        'Organisation (hospital, university)'),
    ('expert.address',             'Address of the organisation'),
    ('expert.city',                'City'),
    ('expert.country',             'Country'),
    ('expert.email',               'Email'),
    ('expert.tier',                'Tier'),
    ('event.name',                 'Event name'),
    ('event.number',               'Event number'),
    ('event.type',                 'Event type'),
    ('event.dates',                'Event date, or first and last day'),
    ('event.start_date',           'First day of the event'),
    ('event.end_date',             'Last day of the event'),
    ('event.location',             'Venue, city and country'),
    ('event.venue',                'Venue'),
    ('event.city',                 'City'),
    ('event.country',              'Country'),
    ('engagement.role',            'The expert''s role, e.g. Speaker'),
    ('honorarium.currency',        'Currency code, e.g. EUR'),
    ('honorarium.rate',            'Agreed hourly rate'),
    ('honorarium.prep_hours',      'Preparation hours'),
    ('honorarium.prep_amount',     'Preparation amount'),
    ('honorarium.service_hours',   'Service hours (from the agenda)'),
    ('honorarium.service_amount',  'Service amount'),
    ('honorarium.travel_hours',    'Travel hours'),
    ('honorarium.travel_amount',   'Travel amount'),
    ('honorarium.total_hours',     'All hours'),
    ('honorarium.total',           'Total honorarium'),
    ('honorarium.table',           'Table of preparation, service and travel: hours, rate, amount and total'),
    ('parent.number',              'Number of the contract this one sits under or changes'),
    ('parent.type',                'Type of that contract'),
    ('parent.start_date',          'Start date of that contract'),
    ('parent.end_date',            'End date of that contract')
  ) as t(f, d)
$$;
comment on function public.contract_merge_fields() is 'The {{merge fields}} contract templates can use.';
grant execute on function public.contract_merge_fields() to authenticated;

create or replace function app.check_contract_template() returns trigger
language plpgsql as $$
declare bad text;
begin
  if new.country_codes = '{}' then new.country_codes := null; end if;
  select string_agg(c, ', ') into bad from unnest(new.country_codes) c where c not in (select code from public.country);
  if bad is not null then
    raise exception 'Unknown country code: %', bad using errcode = '23514';
  end if;
  if tg_op = 'UPDATE' and new.contract_type <> old.contract_type then
    raise exception 'A template''s contract type can''t change. Add a new template instead.' using errcode = '23514';
  end if;
  return new;
end $$;
create trigger check_contract_template before insert or update on public.contract_template
  for each row execute function app.check_contract_template();

create or replace function app.check_contract_template_version() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
declare unknown text;
begin
  if tg_op = 'DELETE' then
    if public.contracts_using(old) > 0 then
      raise exception 'Contracts were drafted from version %, so it can''t be deleted. Add a new version instead.', old.version using errcode = '23514';
    end if;
    return old;
  end if;
  if coalesce(trim(new.body), '') = '' then
    raise exception 'The template is empty' using errcode = '23514';
  end if;
  select string_agg(distinct '{{' || m[1] || '}}', ', ') into unknown
    from regexp_matches(new.body, '\{\{\s*([^}]*?)\s*\}\}', 'g') m
   where m[1] not in (select field from public.contract_merge_fields());
  if unknown is not null then
    raise exception 'The template uses merge fields that don''t exist: %. Check the spelling against the list of merge fields.', unknown
      using errcode = '23514';
  end if;
  if tg_op = 'INSERT' then
    new.version := coalesce((select max(version) from public.contract_template_version where contract_template_id = new.contract_template_id), 0) + 1;
  else
    if new.contract_template_id <> old.contract_template_id or new.version <> old.version then
      raise exception 'A version belongs to its template and keeps its number' using errcode = '23514';
    end if;
    if public.is_locked(old) and (new.body, new.effective_from) is distinct from (old.body, old.effective_from) then
      raise exception 'Version % was used for contracts sent for signature, so it can''t change. Add a new version instead.', old.version
        using errcode = '23514';
    end if;
  end if;
  if exists (select 1 from public.contract_template_version v where v.contract_template_id = new.contract_template_id
              and v.effective_from = new.effective_from and v.id <> new.id) then
    raise exception 'Another version of this template already starts on %', to_char(new.effective_from, 'FMDD FMMonth YYYY') using errcode = '23514';
  end if;
  return new;
end $$;
create trigger check_contract_template_version before insert or update or delete on public.contract_template_version
  for each row execute function app.check_contract_template_version();

-- The version of a template in effect on a date
create or replace function app.template_version_on(p_template_id uuid, p_on date) returns uuid
language sql stable security definer set search_path = public, pg_temp as $$
  select v.id from public.contract_template_version v
   where v.contract_template_id = p_template_id and v.effective_from <= p_on
   order by v.effective_from desc limit 1
$$;

create or replace function app.check_event_type_contract_template() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if (select contract_type from public.contract_template where id = new.contract_template_id) not in ('work_order', 'event_contract', 'addendum') then
    raise exception 'Only Work Order, Single-event Contract and Addendum templates belong to event types' using errcode = '23514';
  end if;
  return new;
end $$;
create trigger check_event_type_contract_template before insert or update on public.event_type_contract_template
  for each row execute function app.check_event_type_contract_template();

-- ---------------------------------------------------------------------
-- Contracts: event, engagement, template, text, honorarium
-- ---------------------------------------------------------------------
alter table public.contract
  add column title            text,
  add column event_id         uuid references public.event(id) on delete cascade,
  add column event_expert_id  uuid references public.event_expert(id) on delete cascade,
  add column template_version_id uuid references public.contract_template_version(id),
  add column body             text,
  add column honorarium       jsonb,
  add column rendered_at      timestamptz,
  add column sent_at          timestamptz,
  add column signed_at        timestamptz,
  drop column template_content_id;
comment on column public.contract.event_expert_id is 'The engagement (an expert on an event) a Work Order, Single-event Contract or Addendum is for.';
comment on column public.contract.body is 'The contract text (Markdown) as drafted from the template; fixed once sent.';
comment on column public.contract.honorarium is 'The agreed honorarium when drafted: {currency, rate, prep/service/travel hours and amounts, total}.';
comment on column public.contract.document_content_id is 'The PDF sent for signature (content, file in the contracts bucket).';
create index contract_event_expert_idx on public.contract (event_expert_id);
create index contract_event_idx on public.contract (event_id);
create index contract_hcp_idx on public.contract (counterparty_hcp_id);

-- Versions in use: how many contracts were drafted from it, and whether one has been sent (then it's fixed)
create or replace function public.contracts_using(v public.contract_template_version) returns int
language sql stable security definer set search_path = public, pg_temp as $$
  select count(*)::int from public.contract c where c.template_version_id = v.id
$$;
create or replace function public.is_locked(v public.contract_template_version) returns boolean
language sql stable security definer set search_path = public, pg_temp as $$
  select exists (select 1 from public.contract c where c.template_version_id = v.id and c.sent_at is not null)
$$;
comment on function public.contracts_using(public.contract_template_version) is 'Contracts drafted from this version (select it as a column: contracts_using).';
comment on function public.is_locked(public.contract_template_version) is 'True once a contract made from this version has been sent; the version is then fixed (select it as a column: is_locked).';


-- Contracts move from the junction onto the contract itself (one engagement per contract)
update public.contract c set event_expert_id = j.event_expert_id, event_id = j.event_id
  from (select distinct on (contract_id) contract_id, event_expert_id, event_id from public.event_expert_contract order by contract_id) j
 where j.contract_id = c.id and c.contract_type <> 'msa';
update public.contract c set event_id = o.event_id
  from public.org_contract o where o.contract_id = c.id and c.event_id is null;
update public.contract c set title = t.label || coalesce(' — ' || e.name, '')
  from public.contract_type t, public.contract c2 left join public.event e on e.id = c2.event_id
 where c2.id = c.id and t.code = c.contract_type and c.title is null;

create or replace function app.expert_keeps_without_sessions(p_expert_id uuid) returns boolean
language sql stable security definer set search_path = public, pg_temp as $$
  select exists (select 1 from public.contract c where c.event_expert_id = p_expert_id and c.status in ('sent', 'executed'))
$$;
drop table public.event_expert_contract;
delete from public.permission where object_name = 'event_expert_contract';

-- One open Work Order or Single-event Contract per engagement (Addenda change it)
create unique index contract_one_per_engagement on public.contract (event_expert_id)
  where contract_type in ('work_order', 'event_contract') and status <> 'cancelled';

-- Numbers: MSA-2026-1001, WO-2026-1002, …
create sequence public.contract_number_seq start 1001;
create or replace function app.next_contract_number(p_type text) returns text
language sql security definer set search_path = public, pg_temp as $$
  select t.prefix || '-' || to_char(current_date, 'YYYY') || '-' || lpad(nextval('public.contract_number_seq')::text, 4, '0')
    from public.contract_type t where t.code = p_type
$$;

create or replace function app.sync_number_sequences() returns void
language sql security definer set search_path = public, pg_temp as $$
  select setval('public.event_request_number_seq', greatest(coalesce((select max(split_part(request_number, '-', 3)::int) from public.event_request where request_number ~ '^REQ-\d{4}-\d+$'), 0), 50) + 1, false);
  select setval('public.event_number_seq', greatest(coalesce((select max(split_part(event_number, '-', 3)::int) from public.event where event_number ~ '^EV-\d{4}-\d+$'), 0), 100) + 1, false);
  select setval('public.contract_number_seq', greatest(coalesce((select max(split_part(contract_number, '-', 3)::int) from public.contract where contract_number ~ '^[A-Z]+-\d{4}-\d+$'), 0), 1000) + 1, false);
$$;
comment on function app.sync_number_sequences() is 'Moves the request, event and contract number sequences past the highest number in use. Run after seeding or importing.';

-- The MSA that covers a date: signed, dates around it (the latest one if several)
create or replace function app.active_msa(p_hcp_id uuid, p_on date) returns uuid
language sql stable security definer set search_path = public, pg_temp as $$
  select c.id from public.contract c
   where c.counterparty_hcp_id = p_hcp_id and c.contract_type = 'msa' and c.status = 'executed'
     and c.tenant_id = coalesce(app.current_tenant_id(), c.tenant_id)
     and (c.start_date is null or c.start_date <= p_on) and (c.end_date is null or c.end_date >= p_on)
   order by c.start_date desc nulls last limit 1
$$;

-- The rules of a contract
create or replace function app.check_contract() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  is_user boolean := app.current_user_id() is not null;   -- seeds and migrations run without a user
  x record; par public.contract; on_date date; other text;
  lbl text := (select label from public.contract_type where code = new.contract_type);
begin
  if tg_op = 'INSERT' then
    if new.contract_number is null then new.contract_number := app.next_contract_number(new.contract_type); end if;
    if is_user then
      new.status := 'draft'; new.sent_at := null; new.signed_at := null; new.document_content_id := null; new.clm_reference := null;
    end if;

    if new.contract_type in ('work_order', 'event_contract', 'addendum') then
      if new.event_expert_id is null then
        raise exception 'A % is for an expert on an event', lbl using errcode = '23514';
      end if;
      select ee.event_id, ee.hcp_id, ee.eligibility, h.display_name, e.starts_at, e.timezone into x
        from public.event_expert ee join public.event e on e.id = ee.event_id join public.hcp h on h.id = ee.hcp_id
       where ee.id = new.event_expert_id;
      new.event_id := x.event_id; new.counterparty_hcp_id := x.hcp_id; new.counterparty_hco_id := null;
      if x.eligibility <> 'eligible' then
        raise exception '% isn''t eligible for this event, so can''t be contracted for it', x.display_name using errcode = '23514';
      end if;
      on_date := coalesce((x.starts_at at time zone x.timezone)::date, current_date);
    elsif new.contract_type = 'msa' then
      if new.event_expert_id is not null or new.event_id is not null then
        raise exception 'A Master Service Agreement belongs to the expert, not to an event' using errcode = '23514';
      end if;
      if new.counterparty_hcp_id is null then
        raise exception 'Choose the expert for the Master Service Agreement' using errcode = '23514';
      end if;
      if new.parent_contract_id is not null then
        raise exception 'A Master Service Agreement doesn''t sit under another contract' using errcode = '23514';
      end if;
    end if;

    if new.contract_type in ('work_order', 'event_contract') then
      select c.contract_number || ' (' || t.label || ')' into other
        from public.contract c join public.contract_type t on t.code = c.contract_type
       where c.event_expert_id = new.event_expert_id and c.contract_type in ('work_order', 'event_contract') and c.status <> 'cancelled';
      if other is not null then
        raise exception '% already has a contract for this event: %. Add an Addendum to change it.', x.display_name, other using errcode = '23514';
      end if;
    end if;

    if new.contract_type = 'work_order' then
      select * into par from public.contract where id = new.parent_contract_id;
      if par.id is null then
        raise exception 'A Work Order needs a signed Master Service Agreement that covers the event''s date. Add one on the expert''s page, or use a Single-event Contract.'
          using errcode = '23514';
      end if;
      if par.contract_type <> 'msa' or par.counterparty_hcp_id <> new.counterparty_hcp_id then
        raise exception 'A Work Order sits under the expert''s own Master Service Agreement' using errcode = '23514';
      end if;
      if par.status <> 'executed' or par.start_date > on_date or par.end_date < on_date then
        raise exception '% isn''t active on the event''s date: it must be signed and cover %', par.contract_number, to_char(on_date, 'FMDD FMMonth YYYY')
          using errcode = '23514';
      end if;
    elsif new.contract_type = 'event_contract' then
      if new.parent_contract_id is not null then
        raise exception 'A Single-event Contract doesn''t sit under another contract' using errcode = '23514';
      end if;
    elsif new.contract_type = 'addendum' then
      select * into par from public.contract where id = new.parent_contract_id;
      if par.id is null or par.contract_type not in ('work_order', 'event_contract') or par.event_expert_id <> new.event_expert_id or par.status = 'cancelled' then
        raise exception 'An Addendum changes a Work Order or Single-event Contract of the same expert on the same event' using errcode = '23514';
      end if;
    end if;
    return new;
  end if;

  -- UPDATE
  if not is_user then return new; end if;
  if (new.contract_type, new.counterparty_hcp_id, new.counterparty_hco_id, new.event_id, new.event_expert_id, new.parent_contract_id, new.contract_number)
     is distinct from (old.contract_type, old.counterparty_hcp_id, old.counterparty_hco_id, old.event_id, old.event_expert_id, old.parent_contract_id, old.contract_number) then
    raise exception 'A contract''s type, number, expert, event and parent contract can''t change' using errcode = '23514';
  end if;
  if old.status <> 'draft'
     and (new.title, new.body, new.honorarium, new.template_version_id, new.start_date, new.end_date, new.document_content_id)
         is distinct from (old.title, old.body, old.honorarium, old.template_version_id, old.start_date, old.end_date, old.document_content_id) then
    raise exception 'Only draft contracts can be changed. Add an Addendum instead.' using errcode = '23514';
  end if;
  if new.status is distinct from old.status then
    if not ((old.status = 'draft' and new.status in ('sent', 'cancelled')) or (old.status = 'sent' and new.status in ('executed', 'cancelled'))) then
      raise exception 'A contract can''t go from % to %',
        (select label from public.contract_status where code = old.status), (select label from public.contract_status where code = new.status)
        using errcode = '23514';
    end if;
    if new.status = 'sent' and new.document_content_id is null then
      raise exception 'Attach the PDF before sending the contract for signature' using errcode = '23514';
    end if;
  end if;
  return new;
end $$;
create trigger check_contract before insert or update on public.contract
  for each row execute function app.check_contract();

-- An expert with a contract out for signature or signed stays on the event; drafts go with them
create or replace function app.check_expert_contracts() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if exists (select 1 from public.event where id = old.event_id)   -- not when the whole event is deleted
     and exists (select 1 from public.contract where event_expert_id = old.id and status in ('sent', 'executed')) then
    raise exception '% has a contract that is out for signature or signed. Cancel it before removing them from the event.',
      (select display_name from public.hcp where id = old.hcp_id) using errcode = '23514';
  end if;
  return old;
end $$;
create trigger check_expert_contracts before delete on public.event_expert
  for each row execute function app.check_expert_contracts();

-- ---------------------------------------------------------------------
-- Drafting: merge the template with the expert, event and honorarium
-- ---------------------------------------------------------------------
create or replace function app.date_text(p date) returns text
language sql immutable as $$ select to_char(p, 'FMDD FMMonth YYYY') $$;

create or replace function app.num_text(p numeric) returns text
language sql immutable as $$ select rtrim(to_char(p, 'FM999999990.99'), '.') $$;

-- Money for documents: €1,447.60, or €1,450 when whole
create or replace function app.amount_text(p numeric, p_currency text) returns text
language sql immutable as $$
  select case p_currency when 'EUR' then '€' when 'GBP' then '£' when 'USD' then '$' else p_currency || ' ' end
         || case when p = trunc(p) then to_char(p, 'FM999G999G990') else to_char(p, 'FM999G999G990D00') end
$$;

create or replace function app.render_contract(p_id uuid) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  c public.contract; tpl text; tv record; f jsonb; h jsonb; cur text; amt numeric[];
  ex record; ev record; ee public.event_expert; par public.contract; k text; v text;
  d1 date; d2 date;
begin
  select * into c from public.contract where id = p_id;
  select v.body, v.version, t.name into tv from public.contract_template_version v join public.contract_template t on t.id = v.contract_template_id
   where v.id = c.template_version_id;
  tpl := tv.body;
  if tpl is null then return; end if;

  select h.display_name, h.first_name, h.last_name, h.email, h.tier, h.city, s.name as specialty, o.name as org,
         concat_ws(', ', o.address, coalesce(o.city, h.city), co.name) as address, co.name as country
    into ex
    from public.hcp h left join public.specialty s on s.id = h.specialty_id left join public.hco o on o.id = h.primary_hco_id
         left join public.country co on co.code = h.country_code
   where h.id = c.counterparty_hcp_id;
  select e.name, e.event_number, t.name as type, e.venue_name, e.city, co.name as country, e.starts_at, e.ends_at, e.timezone
    into ev
    from public.event e join public.event_type t on t.id = e.event_type_id left join public.country co on co.code = e.country_code
   where e.id = c.event_id;
  select * into ee from public.event_expert where id = c.event_expert_id;
  select * into par from public.contract where id = c.parent_contract_id;
  d1 := (ev.starts_at at time zone ev.timezone)::date;
  d2 := coalesce((ev.ends_at at time zone ev.timezone)::date, d1);

  if ee.id is not null then
    cur := coalesce(ee.currency, 'EUR');
    amt := array[round(ee.hourly_rate * ee.prep_hours, 2), round(ee.hourly_rate * ee.service_hours, 2), round(ee.hourly_rate * ee.travel_hours, 2)];
    h := jsonb_build_object('currency', cur, 'rate', ee.hourly_rate,
           'prep_hours', ee.prep_hours, 'service_hours', ee.service_hours, 'travel_hours', ee.travel_hours,
           'prep_amount', amt[1], 'service_amount', amt[2], 'travel_amount', amt[3], 'total', ee.total_payable);
  end if;

  f := jsonb_build_object(
         'contract.number', c.contract_number, 'contract.title', c.title,
         'contract.type', (select label from public.contract_type where code = c.contract_type),
         'contract.start_date', app.date_text(c.start_date), 'contract.end_date', app.date_text(c.end_date),
         'today', app.date_text(current_date), 'template.name', tv.name, 'template.version', tv.version::text,
         'company.name', (select name from public.tenant where id = c.tenant_id))
    || jsonb_build_object(
         'expert.name', ex.display_name, 'expert.first_name', ex.first_name, 'expert.last_name', ex.last_name,
         'expert.specialty', ex.specialty, 'expert.organisation', ex.org, 'expert.address', nullif(ex.address, ''),
         'expert.city', ex.city, 'expert.country', ex.country, 'expert.email', ex.email, 'expert.tier', ex.tier)
    || jsonb_build_object(
         'event.name', ev.name, 'event.number', ev.event_number, 'event.type', ev.type,
         'event.dates', case when d1 is null then null when d1 = d2 then app.date_text(d1) else app.date_text(d1) || ' – ' || app.date_text(d2) end,
         'event.start_date', app.date_text(d1), 'event.end_date', app.date_text(d2),
         'event.location', nullif(concat_ws(', ', ev.venue_name, ev.city, ev.country), ''),
         'event.venue', ev.venue_name, 'event.city', ev.city, 'event.country', ev.country,
         'engagement.role', initcap(ee.role))
    || jsonb_build_object(
         'honorarium.currency', cur,
         'honorarium.rate', app.amount_text(ee.hourly_rate, cur),
         'honorarium.prep_hours', app.num_text(ee.prep_hours), 'honorarium.prep_amount', app.amount_text(amt[1], cur),
         'honorarium.service_hours', app.num_text(ee.service_hours), 'honorarium.service_amount', app.amount_text(amt[2], cur),
         'honorarium.travel_hours', app.num_text(ee.travel_hours), 'honorarium.travel_amount', app.amount_text(amt[3], cur),
         'honorarium.total_hours', app.num_text(ee.prep_hours + ee.service_hours + ee.travel_hours),
         'honorarium.total', app.amount_text(ee.total_payable, cur),
         'honorarium.table', case when ee.id is not null then
              '| Service | Hours | Rate | Amount |' || chr(10) ||
              '|:---|---:|---:|---:|' || chr(10) ||
              '| Preparation | ' || app.num_text(ee.prep_hours) || ' | ' || app.amount_text(ee.hourly_rate, cur) || ' | ' || app.amount_text(amt[1], cur) || ' |' || chr(10) ||
              '| Service | ' || app.num_text(ee.service_hours) || ' | ' || app.amount_text(ee.hourly_rate, cur) || ' | ' || app.amount_text(amt[2], cur) || ' |' || chr(10) ||
              '| Travel | ' || app.num_text(ee.travel_hours) || ' | ' || app.amount_text(ee.hourly_rate, cur) || ' | ' || app.amount_text(amt[3], cur) || ' |' || chr(10) ||
              '| **Total** | **' || app.num_text(ee.prep_hours + ee.service_hours + ee.travel_hours) || '** |  | **' || app.amount_text(ee.total_payable, cur) || '** |'
            end)
    || jsonb_build_object(
         'parent.number', par.contract_number,
         'parent.type', (select label from public.contract_type where code = par.contract_type),
         'parent.start_date', app.date_text(par.start_date), 'parent.end_date', app.date_text(par.end_date));

  tpl := regexp_replace(tpl, '\{\{\s*([a-z_.]+)\s*\}\}', '{{\1}}', 'g');
  for k, v in select * from jsonb_each_text(f) loop
    tpl := replace(tpl, '{{' || k || '}}', coalesce(v, '—'));
  end loop;
  update public.contract set body = tpl, honorarium = h, rendered_at = now() where id = p_id;
end $$;
comment on function app.render_contract(uuid) is 'Drafts the contract text from its template: merge fields filled in, honorarium kept on the contract.';

-- ---------------------------------------------------------------------
-- API
-- ---------------------------------------------------------------------
-- Templates a contract can use, each with its version in effect on the date (default: the event's
-- date, else today): MSA templates anywhere (or in the expert's country); event templates through
-- the event's type, in the event's country. A template with no version in effect yet isn't offered.
create or replace function public.contract_templates_for(p_contract_type text, p_event_id uuid default null, p_hcp_id uuid default null, p_on date default null)
returns table (id uuid, name text, version_id uuid, version int, effective_from date)
language sql stable set search_path = public, pg_temp as $$
  with d as (
    select coalesce(p_on, (select (e.starts_at at time zone e.timezone)::date from public.event e where e.id = p_event_id and e.starts_at is not null),
                    current_date) as on_date
  )
  select t.id, t.name, v.id, v.version, v.effective_from
    from public.contract_template t cross join d
    join lateral (select * from public.contract_template_version v
                   where v.contract_template_id = t.id and v.effective_from <= d.on_date
                   order by v.effective_from desc limit 1) v on true
   where t.contract_type = p_contract_type and t.is_active
     and case when p_contract_type = 'msa'
              then t.country_codes is null or (select h.country_code from public.hcp h where h.id = p_hcp_id) = any(t.country_codes)
              else exists (select 1 from public.event_type_contract_template l join public.event e on e.event_type_id = l.event_type_id
                            where l.contract_template_id = t.id and e.id = p_event_id
                              and (t.country_codes is null or e.country_code = any(t.country_codes))) end
   order by t.name
$$;
comment on function public.contract_templates_for(text, uuid, uuid, date) is
  'Active templates a contract of this type can use for the event (or, for an MSA, the expert), with the version in effect on p_on (default: the event''s date, else today).';
grant execute on function public.contract_templates_for(text, uuid, uuid, date) to authenticated;

-- What can be created for an engagement (p_event_expert_id) or an expert (p_hcp_id, MSA starting p_on):
-- {eligible, msa, main, templates: {type: [{id, name, version_id, version, effective_from}]}}
create or replace function public.contract_options(p_event_expert_id uuid default null, p_hcp_id uuid default null, p_on date default null) returns jsonb
language plpgsql stable set search_path = public, pg_temp as $$
declare x record; on_date date; tpl jsonb := '{}'; t text;
begin
  if p_event_expert_id is null then
    select coalesce(jsonb_agg(to_jsonb(f)), '[]') into tpl from public.contract_templates_for('msa', null, p_hcp_id, coalesce(p_on, current_date)) f;
    return jsonb_build_object('templates', jsonb_build_object('msa', tpl));
  end if;
  select ee.hcp_id, ee.event_id, ee.eligibility, e.starts_at, e.timezone into x
    from public.event_expert ee join public.event e on e.id = ee.event_id where ee.id = p_event_expert_id;
  if not found then return null; end if;
  on_date := coalesce((x.starts_at at time zone x.timezone)::date, current_date);
  foreach t in array array['work_order', 'event_contract', 'addendum'] loop
    tpl := tpl || jsonb_build_object(t, (select coalesce(jsonb_agg(to_jsonb(f)), '[]') from public.contract_templates_for(t, x.event_id) f));
  end loop;
  return jsonb_build_object(
    'eligible', x.eligibility = 'eligible',
    'on_date', on_date,
    'msa', (select jsonb_build_object('id', c.id, 'contract_number', c.contract_number, 'start_date', c.start_date, 'end_date', c.end_date)
              from public.contract c where c.id = app.active_msa(x.hcp_id, on_date)),
    'main', (select jsonb_build_object('id', c.id, 'contract_number', c.contract_number, 'contract_type', c.contract_type, 'status', c.status)
               from public.contract c where c.event_expert_id = p_event_expert_id and c.contract_type in ('work_order', 'event_contract')
                and c.status <> 'cancelled'),
    'templates', tpl);
end $$;
comment on function public.contract_options(uuid, uuid, date) is
  'What contracts can be created for an engagement (or, with p_hcp_id, an MSA for the expert starting p_on): eligibility, the active MSA, the open contract and the templates per type with their versions.';
grant execute on function public.contract_options(uuid, uuid, date) to authenticated;

-- Create a contract and draft its text.
-- p: {contract_type, event_expert_id (event contracts) | hcp_id (MSA), template_id?, parent_contract_id?, start_date?, end_date?}
-- A Work Order defaults to the active MSA, an Addendum to the engagement's open contract, the
-- template to the first one available. Event contracts take the event's dates; an MSA runs two years.
-- The template's version in effect on the contract's start date is used.
create or replace function public.create_contract(p jsonb) returns public.contract
language plpgsql set search_path = public, pg_temp as $$
declare
  typ text := p ->> 'contract_type';
  ee_id uuid := nullif(p ->> 'event_expert_id', '')::uuid;
  hcp_id uuid := nullif(p ->> 'hcp_id', '')::uuid;
  par uuid := nullif(p ->> 'parent_contract_id', '')::uuid;
  tpl uuid := nullif(p ->> 'template_id', '')::uuid;
  ev_id uuid; s date := nullif(p ->> 'start_date', '')::date; en date := nullif(p ->> 'end_date', '')::date;
  x record; lbl text; ttl text; r public.contract; ver uuid;
begin
  select label into lbl from public.contract_type where code = typ and code <> 'venue';
  if lbl is null then raise exception 'Choose a contract type' using errcode = '22023'; end if;

  if typ = 'msa' then
    if hcp_id is null then raise exception 'Choose the expert' using errcode = '22023'; end if;
    s := coalesce(s, current_date);
    en := coalesce(en, (s + interval '2 years' - interval '1 day')::date);
    if en < s then raise exception 'The end date is before the start date' using errcode = '22023'; end if;
    ttl := lbl;
  else
    if ee_id is null then raise exception 'Choose the expert on the event' using errcode = '22023'; end if;
    select ee.hcp_id, ee.event_id, e.name, e.starts_at, e.ends_at, e.timezone into x
      from public.event_expert ee join public.event e on e.id = ee.event_id where ee.id = ee_id;
    if not found then raise exception 'That expert isn''t on an event you can see' using errcode = '22023'; end if;
    hcp_id := x.hcp_id; ev_id := x.event_id;
    s := (x.starts_at at time zone x.timezone)::date;
    en := coalesce((x.ends_at at time zone x.timezone)::date, s);
    if typ = 'work_order' and par is null then par := app.active_msa(hcp_id, coalesce(s, current_date)); end if;
    if typ = 'addendum' and par is null then
      select c.id into par from public.contract c
       where c.event_expert_id = ee_id and c.contract_type in ('work_order', 'event_contract') and c.status <> 'cancelled';
    end if;
    ttl := lbl || ' — ' || x.name;
  end if;

  if tpl is null then
    select t.id into tpl from public.contract_templates_for(typ, ev_id, hcp_id, s) t limit 1;
    if tpl is null then
      raise exception 'There''s no % template for this %. Ask an admin to add one%.', lbl,
        case when typ = 'msa' then 'expert' else 'event' end, case when typ = 'msa' then '' else ' to the event type' end
        using errcode = '23514';
    end if;
  end if;
  select t.version_id into ver from public.contract_templates_for(typ, ev_id, hcp_id, s) t where t.id = tpl;
  if ver is null then
    raise exception 'That template can''t be used here, or has no version in effect on %', to_char(coalesce(s, current_date), 'FMDD FMMonth YYYY')
      using errcode = '23514';
  end if;

  insert into public.contract (contract_type, counterparty_hcp_id, event_expert_id, parent_contract_id, template_version_id, start_date, end_date, title)
  values (typ, hcp_id, ee_id, par, ver, s, en, ttl)
  returning * into r;
  perform app.render_contract(r.id);
  select * into r from public.contract where id = r.id;
  return r;
end $$;
comment on function public.create_contract(jsonb) is
  'Creates a draft contract and its text: {contract_type: msa|work_order|event_contract|addendum, event_expert_id | hcp_id, template_id?, parent_contract_id?, start_date?, end_date?}.';
grant execute on function public.create_contract(jsonb) to authenticated;

-- Draft the text again: the honorarium, expert and event as they are now, from the template's
-- version in effect on the (event's) start date (drafts only)
create or replace function public.regenerate_contract(p_id uuid) returns public.contract
language plpgsql set search_path = public, pg_temp as $$
declare r public.contract; x record; s date; en date;
begin
  select c.*, e.starts_at, e.ends_at, e.timezone, v.contract_template_id into x
    from public.contract c left join public.event e on e.id = c.event_id
         left join public.contract_template_version v on v.id = c.template_version_id
   where c.id = p_id;
  if not found then raise exception 'Contract not found' using errcode = '22023'; end if;
  if x.status <> 'draft' then raise exception 'Only a draft can be drafted again. Add an Addendum instead.' using errcode = '23514'; end if;
  s := case when x.event_id is not null then (x.starts_at at time zone x.timezone)::date else x.start_date end;
  en := case when x.event_id is not null then coalesce((x.ends_at at time zone x.timezone)::date, s) else x.end_date end;
  update public.contract set start_date = s, end_date = en,
         template_version_id = coalesce(app.template_version_on(x.contract_template_id, coalesce(s, current_date)), template_version_id)
   where id = p_id returning * into r;
  if r.id is null then raise exception 'You can''t change this contract' using errcode = '42501'; end if;
  perform app.render_contract(p_id);
  select * into r from public.contract where id = p_id;
  return r;
end $$;
grant execute on function public.regenerate_contract(uuid) to authenticated;

-- Send for signature: the PDF (already uploaded to contracts/<contract id>/…) is stored with the
-- contract and handed to the contracting tool (mocked: a CLM reference)
create or replace function app.contract_file_exists(p_path text) returns boolean
language sql stable security definer set search_path = public, pg_temp as $$
  select exists (select 1 from storage.objects where bucket_id = 'contracts' and name = p_path)
$$;

create or replace function public.send_contract(p_id uuid, p_file jsonb) returns public.contract
language plpgsql set search_path = public, pg_temp as $$
declare c public.contract; doc uuid; path text := p_file ->> 'path';
begin
  select * into c from public.contract where id = p_id;
  if not found then raise exception 'Contract not found' using errcode = '22023'; end if;
  if c.status <> 'draft' then raise exception 'Only a draft can be sent for signature' using errcode = '23514'; end if;
  if c.body is null then raise exception 'The contract has no text yet. Draft it from a template first.' using errcode = '23514'; end if;
  if path is null or split_part(path, '/', 1) <> p_id::text or not app.contract_file_exists(path) then
    raise exception 'Upload the contract''s PDF first' using errcode = '23514';
  end if;
  insert into public.content (title, content_kind, file_name, mime_type, size_bytes, storage_path, owner_user_id)
  values (c.contract_number || ' ' || coalesce(c.title, ''), 'contract', coalesce(p_file ->> 'file_name', c.contract_number || '.pdf'),
          'application/pdf', nullif(p_file ->> 'size_bytes', '')::bigint, 'contracts/' || path, app.current_user_id())
  returning id into doc;
  update public.contract
     set status = 'sent', document_content_id = doc, sent_at = now(),
         clm_reference = 'ICX-' || to_char(now(), 'YY') || '-' || lpad((floor(random() * 100000))::int::text, 5, '0')
   where id = p_id returning * into c;
  if c.status is distinct from 'sent' then raise exception 'You can''t send this contract' using errcode = '42501'; end if;
  return c;
end $$;
comment on function public.send_contract(uuid, jsonb) is
  'Draft → sent: stores the uploaded PDF ({path, file_name, size_bytes}; path in the contracts bucket under the contract id) and hands it to the contracting tool.';
grant execute on function public.send_contract(uuid, jsonb) to authenticated;

-- Signed: until the contracting tool reports back, marked by hand
create or replace function public.mark_contract_signed(p_id uuid) returns public.contract
language plpgsql set search_path = public, pg_temp as $$
declare c public.contract;
begin
  update public.contract set status = 'executed', signed_at = now() where id = p_id and status = 'sent' returning * into c;
  if c.id is null then raise exception 'Only a contract sent for signature can be marked as signed' using errcode = '23514'; end if;
  return c;
end $$;
grant execute on function public.mark_contract_signed(uuid) to authenticated;

create or replace function public.cancel_contract(p_id uuid) returns public.contract
language plpgsql set search_path = public, pg_temp as $$
declare c public.contract;
begin
  update public.contract set status = 'cancelled' where id = p_id and status in ('draft', 'sent') returning * into c;
  if c.id is null then raise exception 'Only a draft or a contract out for signature can be cancelled' using errcode = '23514'; end if;
  return c;
end $$;
grant execute on function public.cancel_contract(uuid) to authenticated;

-- ---------------------------------------------------------------------
-- Security: event contracts go with their event; MSAs with the contract permission
-- ---------------------------------------------------------------------
drop policy contract_read on public.contract;
drop policy contract_insert on public.contract;
drop policy contract_update on public.contract;
drop policy contract_delete on public.contract;
create policy contract_read on public.contract for select to authenticated
  using (tenant_id = app.current_tenant_id() and app.has_perm('contract', 'read') and (event_id is null or app.can_view_event(event_id)));
create policy contract_insert on public.contract for insert to authenticated
  with check (coalesce(tenant_id, app.current_tenant_id()) = app.current_tenant_id() and app.has_perm('contract', 'create')
              and (event_id is null or app.can_edit_event(event_id)));
create policy contract_update on public.contract for update to authenticated
  using (tenant_id = app.current_tenant_id() and app.has_perm('contract', 'edit') and (event_id is null or app.can_edit_event(event_id)))
  with check (tenant_id = app.current_tenant_id());
create policy contract_delete on public.contract for delete to authenticated
  using (tenant_id = app.current_tenant_id() and app.has_perm('contract', 'delete') and (event_id is null or app.can_edit_event(event_id))
         and (status = 'draft' or app.is_admin()));

create or replace function app.can_view_contract(p_id uuid) returns boolean
language sql stable security definer set search_path = public, pg_temp as $$
  select exists (select 1 from public.contract c
                  where c.id = p_id and c.tenant_id = app.current_tenant_id() and app.has_perm('contract', 'read')
                    and (c.event_id is null or app.can_view_event(c.event_id)))
$$;
create or replace function app.can_edit_contract(p_id uuid) returns boolean
language sql stable security definer set search_path = public, pg_temp as $$
  select exists (select 1 from public.contract c
                  where c.id = p_id and c.tenant_id = app.current_tenant_id() and c.status = 'draft' and app.has_perm('contract', 'edit')
                    and (c.event_id is null or app.can_edit_event(c.event_id)))
$$;
create or replace function app.contract_id_of_path(p_name text) returns uuid
language sql immutable as $$
  select case when split_part(p_name, '/', 1) ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
              then split_part(p_name, '/', 1)::uuid end
$$;

-- Contract PDFs: contracts/<contract id>/<file>.pdf, readable with the contract, written while it's a draft
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('contracts', 'contracts', false, 10485760, array['application/pdf'])
on conflict (id) do nothing;
-- Storage isn't wiped by a database reset, so the policies may already be there
drop policy if exists contract_files_read on storage.objects;
drop policy if exists contract_files_insert on storage.objects;
drop policy if exists contract_files_update on storage.objects;
drop policy if exists contract_files_delete on storage.objects;
create policy contract_files_read on storage.objects for select to authenticated
  using (bucket_id = 'contracts' and (app.is_admin() or app.can_view_contract(app.contract_id_of_path(name))));
create policy contract_files_insert on storage.objects for insert to authenticated
  with check (bucket_id = 'contracts' and app.can_edit_contract(app.contract_id_of_path(name)));
create policy contract_files_update on storage.objects for update to authenticated
  using (bucket_id = 'contracts' and app.can_edit_contract(app.contract_id_of_path(name)));
create policy contract_files_delete on storage.objects for delete to authenticated
  using (bucket_id = 'contracts' and (app.is_admin() or app.can_edit_contract(app.contract_id_of_path(name))));

-- Templates are configuration like event types: whoever manages event types manages them
insert into public.permission (tenant_id, profile_id, object_name, can_read, can_create, can_edit, can_delete, view_all, modify_all)
select tenant_id, profile_id, o, can_read, can_create, can_edit, can_delete, view_all, modify_all
  from public.permission, unnest(array['contract_template', 'contract_template_version', 'event_type_contract_template']) o
 where object_name = 'event_type';

select app.sync_number_sequences();
grant execute on all functions in schema app to authenticated, service_role;
