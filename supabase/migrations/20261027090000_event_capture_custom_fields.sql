-- =====================================================================
-- Event Coordinator — Event capture + custom fields
-- - custom_field / custom_field_layout: admin-defined fields, Salesforce/Vault style
-- - <table>.custom_fields jsonb: the values, validated against the definitions
-- - report.<table> views: one typed column per custom field, for reporting
-- - create_event() / update_event(): event capture in one call
-- See docs/BUILD-PLAN.md ("Custom fields") for why jsonb + generated views.
-- =====================================================================

-- ---------------------------------------------------------------------
-- Definitions
-- ---------------------------------------------------------------------
create table public.custom_field (
  id           uuid primary key default gen_random_uuid(),
  tenant_id    uuid not null references public.tenant(id),
  object_name  text not null,                                   -- the table the field extends, e.g. 'event'
  api_name     text not null check (api_name ~ '^[a-z][a-z0-9_]{0,40}__c$'),
  label        text not null,
  field_type   text not null check (field_type in ('text','long_text','number','currency','date','checkbox',
                                                   'picklist','multi_picklist','lookup_user')),
  options      jsonb not null default '[]',                     -- picklists: [{"value": "...", "label": "..."}]
  is_required  boolean not null default false,
  help_text    text,
  is_active    boolean not null default true,
  created_at   timestamptz not null default now(),
  created_by   uuid references public.app_user(id),
  updated_at   timestamptz not null default now(),
  updated_by   uuid references public.app_user(id),
  unique (tenant_id, object_name, api_name),
  constraint custom_field_options_array check (jsonb_typeof(options) = 'array'),
  constraint custom_field_picklist_options check (field_type not in ('picklist','multi_picklist') or jsonb_array_length(options) > 0)
);
comment on table public.custom_field is 'Admin-defined fields on a business table. Values live in that table''s custom_fields jsonb column.';

-- Where a field shows: for which event types (null = all) and in which UI section, in what order
create table public.custom_field_layout (
  id               uuid primary key default gen_random_uuid(),
  tenant_id        uuid not null references public.tenant(id),
  custom_field_id  uuid not null references public.custom_field(id) on delete cascade,
  event_type_id    uuid references public.event_type(id) on delete cascade,
  section          text not null default 'details' check (section ~ '^[a-z][a-z0-9_]*$'),
  sort             int not null default 100,
  created_at       timestamptz not null default now(),
  created_by       uuid references public.app_user(id),
  unique nulls not distinct (custom_field_id, event_type_id)
);
comment on table public.custom_field_layout is 'Layout assignment: which event types show a custom field (null = all), in which UI section and order. Required fields are enforced only where they are shown.';

select app.secure_table('custom_field');
select app.secure_table('custom_field_layout');

-- ---------------------------------------------------------------------
-- Values: the event is the first customisable table
-- ---------------------------------------------------------------------
alter table public.event add column custom_fields jsonb not null default '{}'
  constraint event_custom_fields_object check (jsonb_typeof(custom_fields) = 'object');
create index event_custom_fields_idx on public.event using gin (custom_fields jsonb_path_ops);
comment on column public.event.custom_fields is 'Custom field values {api_name: value}, validated against custom_field. Filter through the API with custom_fields->>api_name.';

-- Checks custom_fields against the definitions for this table and tenant.
-- Unknown fields and wrong types are always rejected. Required fields are enforced on insert,
-- and on update when custom_fields or the event type changes, so an admin adding a required
-- field doesn't block unrelated edits such as status changes.
create or replace function app.validate_custom_fields() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  rec       jsonb := to_jsonb(new);
  type_id   uuid := (rec ->> 'event_type_id')::uuid;
  k         text;
  v         jsonb;
  f         public.custom_field;
  allowed   text[];
begin
  new.custom_fields := jsonb_strip_nulls(coalesce(new.custom_fields, '{}'));

  for k, v in select * from jsonb_each(new.custom_fields) loop
    select * into f from public.custom_field
     where tenant_id = new.tenant_id and object_name = tg_table_name and api_name = k and is_active;
    if not found then
      raise exception 'Unknown custom field "%" on %', k, tg_table_name using errcode = '22023';
    end if;
    allowed := array(select o ->> 'value' from jsonb_array_elements(f.options) o);

    if (f.field_type in ('text','long_text') and (jsonb_typeof(v) <> 'string'
          or length(v #>> '{}') > case f.field_type when 'text' then 255 else 32000 end))
       or (f.field_type in ('number','currency') and jsonb_typeof(v) <> 'number')
       or (f.field_type = 'checkbox' and jsonb_typeof(v) <> 'boolean')
       or (f.field_type = 'date' and (jsonb_typeof(v) <> 'string' or (v #>> '{}') !~ '^\d{4}-\d{2}-\d{2}$'))
       or (f.field_type = 'picklist' and (jsonb_typeof(v) <> 'string' or not (v #>> '{}') = any(allowed)))
       or (f.field_type = 'multi_picklist' and (jsonb_typeof(v) <> 'array'
             or exists (select 1 from jsonb_array_elements(v) x where jsonb_typeof(x) <> 'string' or not (x #>> '{}') = any(allowed))))
       or (f.field_type = 'lookup_user' and (jsonb_typeof(v) <> 'string' or (v #>> '{}') !~* '^[0-9a-f-]{36}$'
             or not exists (select 1 from public.app_user u where u.id = (v #>> '{}')::uuid and u.tenant_id = new.tenant_id)))
    then
      raise exception 'Invalid value for custom field "%" (%): %', f.label, f.field_type, v using errcode = '22023';
    end if;
    if f.field_type = 'date' then perform (v #>> '{}')::date; end if;   -- rejects 2026-02-31
  end loop;

  if tg_op = 'INSERT' or new.custom_fields is distinct from old.custom_fields
     or (rec ->> 'event_type_id') is distinct from (to_jsonb(old) ->> 'event_type_id') then
    for f in
      select cf.* from public.custom_field cf
       where cf.tenant_id = new.tenant_id and cf.object_name = tg_table_name and cf.is_active and cf.is_required
         and exists (select 1 from public.custom_field_layout l
                      where l.custom_field_id = cf.id and (l.event_type_id is null or l.event_type_id = type_id))
         and not (new.custom_fields ? cf.api_name)
    loop
      raise exception '% is required', f.label using errcode = '23502';
    end loop;
  end if;
  return new;
end $$;

-- Runs after stamp_row (trigger names fire alphabetically), so tenant_id is set
create trigger validate_custom_fields before insert or update on public.event
  for each row execute function app.validate_custom_fields();

-- ---------------------------------------------------------------------
-- Reporting views: report.<table> = the table plus one typed column per custom field.
-- Regenerated whenever definitions change. security_invoker, so RLS still applies.
-- ---------------------------------------------------------------------
create schema if not exists report;
grant usage on schema report to authenticated, service_role;

create or replace function app.refresh_report_view(p_object text) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
declare cols text;
begin
  select coalesce(string_agg(format(case field_type
             when 'number'         then '(t.custom_fields ->> %1$L)::numeric as %1$I'
             when 'currency'       then '(t.custom_fields ->> %1$L)::numeric as %1$I'
             when 'date'           then '(t.custom_fields ->> %1$L)::date as %1$I'
             when 'checkbox'       then '(t.custom_fields ->> %1$L)::boolean as %1$I'
             when 'lookup_user'    then '(t.custom_fields ->> %1$L)::uuid as %1$I'
             when 'multi_picklist' then 'array(select jsonb_array_elements_text(t.custom_fields -> %1$L)) as %1$I'
             else                       '(t.custom_fields ->> %1$L) as %1$I'
           end, api_name), ', ' order by api_name), '')
    into cols
    from (select distinct on (api_name) api_name, field_type from public.custom_field
           where object_name = p_object and is_active order by api_name, updated_at desc) f;

  execute format('drop view if exists report.%I', p_object);
  execute format('create view report.%I with (security_invoker = true) as select t.*%s from public.%I t',
                 p_object, case when cols = '' then '' else ', ' || cols end, p_object);
  execute format('grant select on report.%I to authenticated', p_object);
  execute format('comment on view report.%I is %L', p_object,
                 'Generated by app.refresh_report_view(): ' || p_object || ' with one typed column per custom field.');
end $$;
comment on function app.refresh_report_view(text) is 'Rebuilds report.<object> with a typed column per active custom field.';

-- Statement-level, so a bulk change rebuilds each view once
create or replace function app.custom_field_changed() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
declare o text;
begin
  for o in select distinct object_name from public.custom_field union select 'event' loop
    perform app.refresh_report_view(o);
  end loop;
  return null;
end $$;
create trigger custom_field_changed after insert or update or delete on public.custom_field
  for each statement execute function app.custom_field_changed();

select app.refresh_report_view('event');

-- ---------------------------------------------------------------------
-- Time zones: a sensible default per country, and only real IANA zones on events
-- ---------------------------------------------------------------------
alter table public.country add column default_timezone text;
update public.country c set default_timezone = z.tz from (values
  ('AT','Europe/Vienna'), ('BE','Europe/Brussels'), ('CH','Europe/Zurich'), ('CZ','Europe/Prague'),
  ('DE','Europe/Berlin'), ('DK','Europe/Copenhagen'), ('ES','Europe/Madrid'), ('FI','Europe/Helsinki'),
  ('FR','Europe/Paris'), ('GB','Europe/London'), ('GR','Europe/Athens'), ('HU','Europe/Budapest'),
  ('IE','Europe/Dublin'), ('IT','Europe/Rome'), ('NL','Europe/Amsterdam'), ('NO','Europe/Oslo'),
  ('PL','Europe/Warsaw'), ('PT','Europe/Lisbon'), ('RO','Europe/Bucharest'), ('SE','Europe/Stockholm'),
  ('AE','Asia/Dubai'), ('IL','Asia/Jerusalem'), ('ZA','Africa/Johannesburg'),
  ('US','America/New_York'), ('CA','America/Toronto'), ('BR','America/Sao_Paulo'), ('MX','America/Mexico_City'),
  ('AR','America/Argentina/Buenos_Aires'), ('AU','Australia/Sydney'), ('CN','Asia/Shanghai'), ('IN','Asia/Kolkata'),
  ('KR','Asia/Seoul'), ('SG','Asia/Singapore'), ('JP','Asia/Tokyo')
) as z(code, tz) where z.code = c.code;
comment on column public.country.default_timezone is 'Suggested IANA zone for new events in this country (main zone for multi-zone countries).';

create or replace function app.check_event_timezone() returns trigger
language plpgsql as $$
begin
  if not exists (select 1 from pg_timezone_names where name = new.timezone) then
    raise exception 'Unknown time zone "%". Use an IANA name such as Europe/Copenhagen', new.timezone using errcode = '22023';
  end if;
  return new;
end $$;
create trigger check_event_timezone before insert or update of timezone on public.event
  for each row execute function app.check_event_timezone();

-- ---------------------------------------------------------------------
-- Event capture API
-- Payload keys are event columns. Times can be given as instants (starts_at, ends_at)
-- or as wall-clock times in the event's zone (starts_local, ends_local: '2026-11-14T09:00'),
-- which the database converts. product_ids replaces the event's products.
-- Both functions are SECURITY INVOKER: row-level security decides what the caller may do.
-- ---------------------------------------------------------------------
create or replace function app.event_payload_keys() returns text[]
language sql immutable as $$
  select array['name','event_type_id','owner_id','therapeutic_area_id','country_code','city','venue_name','venue_address',
               'timezone','starts_at','ends_at','starts_local','ends_local','expected_attendees','estimated_spend',
               'currency','description','custom_fields','product_ids']
$$;

create or replace function app.check_event_payload(p jsonb) returns void
language plpgsql as $$
declare bad text;
begin
  if jsonb_typeof(p) is distinct from 'object' then
    raise exception 'Payload must be a JSON object' using errcode = '22023';
  end if;
  select string_agg(k, ', ') into bad from jsonb_object_keys(p) k where k <> all(app.event_payload_keys());
  if bad is not null then
    raise exception 'Unknown or read-only field(s): %. Allowed: %', bad, array_to_string(app.event_payload_keys(), ', ')
      using errcode = '22023';
  end if;
  if p ? 'product_ids' and jsonb_typeof(p -> 'product_ids') <> 'array' then
    raise exception 'product_ids must be an array of ids' using errcode = '22023';
  end if;
end $$;

-- Applies payload keys onto an event row; keys that are absent keep the row's value.
create or replace function app.apply_event_payload(e public.event, p jsonb) returns public.event
language plpgsql as $$
declare
  r public.event := jsonb_populate_record(e, p - 'custom_fields' - 'product_ids' - 'starts_local' - 'ends_local');
begin
  if p ? 'starts_local' then r.starts_at := (p ->> 'starts_local')::timestamp at time zone r.timezone; end if;
  if p ? 'ends_local'   then r.ends_at   := (p ->> 'ends_local')::timestamp   at time zone r.timezone; end if;
  -- custom_fields merge: listed keys are set, null removes a value
  if p ? 'custom_fields' then
    if jsonb_typeof(p -> 'custom_fields') <> 'object' then
      raise exception 'custom_fields must be an object' using errcode = '22023';
    end if;
    r.custom_fields := coalesce(e.custom_fields, '{}') || (p -> 'custom_fields');
  end if;
  return r;
end $$;

create or replace function app.set_event_products(p_event public.event, p jsonb) returns void
language plpgsql as $$
begin
  if not p ? 'product_ids' then return; end if;
  delete from public.event_product where event_id = p_event.id
    and product_id <> all(array(select jsonb_array_elements_text(p -> 'product_ids')::uuid));
  insert into public.event_product (event_id, product_id, tenant_id)
  select p_event.id, x::uuid, p_event.tenant_id from jsonb_array_elements_text(p -> 'product_ids') x
  on conflict do nothing;
end $$;

create or replace function public.create_event(p jsonb) returns public.event
language plpgsql as $$
declare e public.event;
begin
  perform app.check_event_payload(p);
  if coalesce(trim(p ->> 'name'), '') = '' then raise exception 'Event name is required' using errcode = '23502'; end if;
  if p ->> 'event_type_id' is null then raise exception 'Event type is required' using errcode = '23502'; end if;

  e := app.apply_event_payload(jsonb_populate_record(null::public.event, '{}'), p);
  -- No zone given: use the country's default zone, then the column default
  e.timezone := coalesce(p ->> 'timezone',
                         (select c.default_timezone from public.country c where c.code = e.country_code),
                         'Europe/London');
  if p ? 'starts_local' or p ? 'ends_local' then e := app.apply_event_payload(e, p - 'custom_fields'); end if;

  insert into public.event (name, event_type_id, owner_id, therapeutic_area_id, country_code, city, venue_name, venue_address,
                            timezone, starts_at, ends_at, expected_attendees, estimated_spend, currency, description, custom_fields)
  values (trim(e.name), e.event_type_id, e.owner_id, e.therapeutic_area_id, e.country_code, e.city, e.venue_name, e.venue_address,
          e.timezone, e.starts_at, e.ends_at, e.expected_attendees, e.estimated_spend, e.currency, e.description,
          coalesce(e.custom_fields, '{}'))
  returning * into e;

  perform app.set_event_products(e, p);
  return e;
end $$;
comment on function public.create_event(jsonb) is
  'Creates an event (status draft) with products and custom fields in one call. Keys: see app.event_payload_keys(). starts_local/ends_local are wall-clock times in the event''s zone.';

create or replace function public.update_event(p_event_id uuid, p jsonb) returns public.event
language plpgsql as $$
declare e public.event; n public.event;
begin
  perform app.check_event_payload(p);
  select * into e from public.event where id = p_event_id;
  if not found then raise exception 'Event not found or not visible' using errcode = 'P0002'; end if;
  if p ? 'name' and coalesce(trim(p ->> 'name'), '') = '' then raise exception 'Event name is required' using errcode = '23502'; end if;

  n := app.apply_event_payload(e, p);
  update public.event set
    name = trim(n.name), event_type_id = n.event_type_id, owner_id = n.owner_id, therapeutic_area_id = n.therapeutic_area_id,
    country_code = n.country_code, city = n.city, venue_name = n.venue_name, venue_address = n.venue_address,
    timezone = n.timezone, starts_at = n.starts_at, ends_at = n.ends_at, expected_attendees = n.expected_attendees,
    estimated_spend = n.estimated_spend, currency = n.currency, description = n.description, custom_fields = n.custom_fields
  where id = p_event_id
  returning * into n;
  if not found then raise exception 'You don''t have permission to edit this event' using errcode = '42501'; end if;

  perform app.set_event_products(n, p);
  return n;
end $$;
comment on function public.update_event(uuid, jsonb) is
  'Partial update: only keys present change. custom_fields merges (null removes a value); product_ids replaces the set. Status changes go through change_event_status().';

grant execute on function public.create_event(jsonb), public.update_event(uuid, jsonb) to authenticated;
grant execute on all functions in schema app to authenticated, service_role;
