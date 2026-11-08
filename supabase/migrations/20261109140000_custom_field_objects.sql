-- =====================================================================
-- Event Center — Custom fields on more objects
-- A custom field now says which object it extends (custom_field_object): Event, Request,
-- Expert (HCP), HCO, Event attendee, Event expert. Each of those tables gets a custom_fields
-- jsonb column, checked by the same trigger, and a report.<table> view.
-- * Event, Request, Event attendee and Event expert fields are shown per event type
--   (custom_field_layout), attendees and experts by their event's type. Expert (HCP) and HCO fields
--   apply everywhere: they get an all-types layout row on creation, and can't be tied to types.
-- * Only Event and Request fields can be required: those are created through a form. Attendees,
--   experts and HCOs also arrive in bulk, from CRMs and imports, where nobody fills fields in.
-- * A request's custom fields are fixed once it's submitted, like the rest of it.
-- =====================================================================

create table public.custom_field_object (
  code           text primary key,
  label          text not null,
  by_event_type  boolean not null,
  sort           int not null
);
comment on table public.custom_field_object is 'The objects custom fields can extend (a table name), and whether their fields are shown per event type.';
insert into public.custom_field_object (code, label, by_event_type, sort) values
  ('event',          'Event',          true,  10),
  ('event_request',  'Request',        true,  20),
  ('hcp',            'Expert (HCP)',   false, 30),
  ('hco',            'HCO',            false, 40),
  ('event_attendee', 'Event attendee', true,  50),
  ('event_expert',   'Event expert',   true,  60);
alter table public.custom_field_object enable row level security;
create policy custom_field_object_read on public.custom_field_object for select to authenticated using (true);
revoke all on public.custom_field_object from anon;
grant select on public.custom_field_object to authenticated;

alter table public.custom_field add constraint custom_field_object_name_fkey
  foreign key (object_name) references public.custom_field_object(code);
alter table public.custom_field add constraint custom_field_required_on_forms
  check (not is_required or object_name in ('event', 'event_request'));
comment on column public.custom_field.object_name is 'The object (table) the field extends: custom_field_object.code. Fixed once created.';

-- Values: a custom_fields column on each new object, checked like the event's
do $$
declare t text;
begin
  foreach t in array array['event_request', 'hcp', 'hco', 'event_attendee', 'event_expert'] loop
    execute format('alter table public.%I add column custom_fields jsonb not null default ''{}'' constraint %I check (jsonb_typeof(custom_fields) = ''object'')',
                   t, t || '_custom_fields_object');
    execute format('create index %I on public.%I using gin (custom_fields jsonb_path_ops)', t || '_custom_fields_idx', t);
    execute format('comment on column public.%I.custom_fields is %L', t,
                   'Custom field values {api_name: value}, validated against custom_field. Filter through the API with custom_fields->>api_name.');
    execute format('create trigger validate_custom_fields before insert or update on public.%I for each row execute function app.validate_custom_fields()', t);
  end loop;
end $$;

-- Same checks; the event type now also comes from the record's event (attendees, experts)
create or replace function app.validate_custom_fields() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  rec       jsonb := to_jsonb(new);
  -- The record's event type: its own, or (attendees, experts) its event's; none for experts and HCOs
  type_id   uuid := coalesce((rec ->> 'event_type_id')::uuid,
                             (select e.event_type_id from public.event e where e.id = (rec ->> 'event_id')::uuid));
  k         text;
  v         jsonb;
  f         public.custom_field;
  allowed   text[];
begin
  new.custom_fields := jsonb_strip_nulls(coalesce(new.custom_fields, '{}'));

  for k, v in select * from jsonb_each(new.custom_fields) loop
    select * into f from public.custom_field
     where tenant_id = new.tenant_id and object_name = tg_table_name and api_name = k;
    if not found then
      raise exception 'Unknown custom field "%" on %', k, tg_table_name using errcode = '22023';
    end if;
    -- A switched-off field keeps the values events already have, but takes no new ones
    if not f.is_active then
      if tg_op = 'UPDATE' and (old.custom_fields -> k) = v then continue; end if;
      raise exception '% is no longer in use', f.label using errcode = '22023';
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
       or (f.field_type = 'url' and (jsonb_typeof(v) <> 'string' or length(v #>> '{}') > 2000
             or (v #>> '{}') !~* '^https?://[^\s/$.?#][^\s]*$'))
    then
      raise exception 'Invalid value for custom field "%" (%): %', f.label, f.field_type, v using errcode = '22023';
    end if;
    if f.field_type in ('number','currency') and f.decimals is not null
       and (v #>> '{}')::numeric <> round((v #>> '{}')::numeric, f.decimals) then
      raise exception '% takes at most % decimal place(s)', f.label, f.decimals using errcode = '22023';
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

-- Expert and HCO fields apply everywhere: an all-types layout on creation, and no per-type ones
create or replace function app.custom_field_default_layout() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if not (select by_event_type from public.custom_field_object where code = new.object_name) then
    insert into public.custom_field_layout (tenant_id, custom_field_id, event_type_id) values (new.tenant_id, new.id, null)
    on conflict do nothing;
  end if;
  return null;
end $$;
create trigger custom_field_default_layout after insert on public.custom_field
  for each row execute function app.custom_field_default_layout();

create or replace function app.check_custom_field_layout() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if new.event_type_id is not null and not (select o.by_event_type from public.custom_field cf
                                              join public.custom_field_object o on o.code = cf.object_name
                                             where cf.id = new.custom_field_id) then
    raise exception 'Expert and HCO fields apply to every event type' using errcode = '23514';
  end if;
  return new;
end $$;
create trigger check_custom_field_layout before insert or update on public.custom_field_layout
  for each row execute function app.check_custom_field_layout();

-- A submitted request's custom fields are fixed, like the rest of it
create or replace function app.check_request_custom_fields() returns trigger
language plpgsql as $$
begin
  if app.current_user_id() is not null and old.status <> 'draft' and new.custom_fields is distinct from old.custom_fields then
    raise exception 'Only draft requests can be changed' using errcode = '23514';
  end if;
  return new;
end $$;
create trigger check_request_custom_fields before update of custom_fields on public.event_request
  for each row execute function app.check_request_custom_fields();

-- Requests take their custom fields in save_request
create or replace function public.save_request(p jsonb) returns public.event_request
language plpgsql set search_path = public, pg_temp as $$
declare r public.event_request; expert text;
begin
  if p ? 'id' then
    select * into r from public.event_request where id = (p ->> 'id')::uuid;
    if not found then raise exception 'Request not found' using errcode = 'P0002'; end if;
  else
    r.request_type := coalesce(nullif(p ->> 'request_type', ''), 'event');
    if not exists (select 1 from public.request_type where code = r.request_type) then
      raise exception 'Choose the kind of request' using errcode = '22023';
    end if;
  end if;
  if p ? 'rationale' then r.rationale := nullif(btrim(p ->> 'rationale'), ''); end if;
  if p ? 'custom_fields' then r.custom_fields := coalesce(nullif(p -> 'custom_fields', 'null'::jsonb), '{}'::jsonb); end if;

  if r.request_type = 'tiering' then
    if p ? 'hcp_id' then r.hcp_id := nullif(p ->> 'hcp_id', '')::uuid; end if;
    if p ? 'related_event_id' then r.related_event_id := nullif(p ->> 'related_event_id', '')::uuid; end if;
    if r.hcp_id is null then raise exception 'Choose the expert' using errcode = '23502'; end if;
    select display_name into expert from public.hcp where id = r.hcp_id;
    if expert is null then raise exception 'That expert doesn''t exist' using errcode = '22023'; end if;
    if r.related_event_id is not null and not exists (select 1 from public.event where id = r.related_event_id) then
      raise exception 'That event doesn''t exist, or you can''t see it' using errcode = '22023';
    end if;
    r.title := 'Tiering: ' || expert;
    r.event_type_id := null; r.event_date := null; r.duration := null;
  else
    if p ? 'title' then r.title := nullif(btrim(p ->> 'title'), ''); end if;
    if p ? 'event_type_id' then r.event_type_id := nullif(p ->> 'event_type_id', '')::uuid; end if;
    if p ? 'event_date' then r.event_date := nullif(p ->> 'event_date', '')::date; end if;
    if p ? 'duration' then r.duration := nullif(p ->> 'duration', ''); end if;
    if r.title is null then raise exception 'Give the request a name' using errcode = '23502'; end if;
    if r.event_type_id is null then raise exception 'Choose an event type' using errcode = '23502'; end if;
  end if;

  if r.id is null then
    insert into public.event_request (request_type, title, event_type_id, event_date, duration, rationale, hcp_id, related_event_id, custom_fields)
    values (r.request_type, r.title, r.event_type_id, r.event_date, r.duration, r.rationale, r.hcp_id, r.related_event_id, coalesce(r.custom_fields, '{}'))
    returning * into r;
  else
    update public.event_request set title = r.title, event_type_id = r.event_type_id, event_date = r.event_date,
           duration = r.duration, rationale = r.rationale, hcp_id = r.hcp_id, related_event_id = r.related_event_id,
           custom_fields = coalesce(r.custom_fields, '{}')
     where id = r.id
    returning * into r;
    if not found then raise exception 'You can''t change this request' using errcode = '42501'; end if;
  end if;
  return r;
end $$;
comment on function public.save_request(jsonb) is
  'Create or change a draft request. Event request: {request_type: event, title, event_type_id, event_date, duration, rationale, custom_fields}. Tiering request: {request_type: tiering, hcp_id, related_event_id?, rationale, custom_fields}.';

-- Reporting views for every object, rebuilt whenever definitions change
create or replace function app.custom_field_changed() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
declare o text;
begin
  for o in select code from public.custom_field_object loop
    perform app.refresh_report_view(o);
  end loop;
  return null;
end $$;
select app.refresh_report_view(code) from public.custom_field_object;

grant execute on all functions in schema app to authenticated, service_role;
