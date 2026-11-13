-- =====================================================================
-- Event Center — Expected attendees and Estimated spend become custom fields
-- * They were built-in event columns with nothing built on them. They're now custom fields
--   (expected_attendees__c, estimated_spend__c) shown with the other custom fields under
--   Additional details, so admins can rename, require, limit to event types or switch them off
--   like any other. Existing values move across; the columns (and the event's currency, always
--   EUR) are dropped.
-- * Requests keep their own expected attendees and estimated spend (approval criteria use them).
-- =====================================================================

-- The two fields, for every organisation, on every event type
insert into public.custom_field (tenant_id, object_name, api_name, label, field_type, help_text, decimals, created_at)
select t.id, 'event', f.api, f.label, f.ty, f.help, 0, now() - f.age
  from public.tenant t
 cross join (values
   ('expected_attendees__c', 'Expected attendees', 'number',   'Roughly how many people will attend.', interval '2 minutes'),
   ('estimated_spend__c',    'Estimated spend',    'currency', 'Rough total cost in EUR.',             interval '1 minute')
 ) as f(api, label, ty, help, age)
on conflict (tenant_id, object_name, api_name) do nothing;

insert into public.custom_field_layout (tenant_id, custom_field_id, event_type_id)
select f.tenant_id, f.id, null
  from public.custom_field f
 where f.object_name = 'event' and f.api_name in ('expected_attendees__c', 'estimated_spend__c')
on conflict (custom_field_id, event_type_id) do nothing;

-- Values move across (only events that had them)
update public.event e
   set custom_fields = coalesce(e.custom_fields, '{}') || jsonb_strip_nulls(jsonb_build_object(
         'expected_attendees__c', e.expected_attendees,
         'estimated_spend__c', round(e.estimated_spend)))
 where e.expected_attendees is not null or e.estimated_spend is not null;

-- ---------------------------------------------------------------------
-- The columns go; create_event / update_event no longer take them
-- ---------------------------------------------------------------------
create or replace function app.event_payload_keys() returns text[]
language sql immutable as $$
  select array['name','event_type_id','owner_id','therapeutic_area_id','country_code','city','venue_name','venue_address',
               'timezone','starts_at','ends_at','starts_local','ends_local','description','custom_fields','product_ids']
$$;

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
                            timezone, starts_at, ends_at, description, custom_fields)
  values (trim(e.name), e.event_type_id, e.owner_id, e.therapeutic_area_id, e.country_code, e.city, e.venue_name, e.venue_address,
          e.timezone, e.starts_at, e.ends_at, e.description, coalesce(e.custom_fields, '{}'))
  returning * into e;

  perform app.set_event_products(e, p);
  return e;
end $$;

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
    timezone = n.timezone, starts_at = n.starts_at, ends_at = n.ends_at, description = n.description, custom_fields = n.custom_fields
  where id = p_event_id
  returning * into n;
  if not found then raise exception 'You don''t have permission to edit this event' using errcode = '42501'; end if;

  perform app.set_event_products(n, p);
  return n;
end $$;

-- report.event selects t.*, so it's rebuilt without the old columns (and with the new fields)
drop view if exists report.event;
alter table public.event drop column expected_attendees, drop column estimated_spend, drop column currency;
select app.refresh_report_view('event');
