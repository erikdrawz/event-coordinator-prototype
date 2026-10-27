-- =====================================================================
-- Event Coordinator — Custom fields managed from Admin
-- - New field type: url. Numbers can set how many decimals they accept.
-- - A field's name (api_name), object and type are fixed once created, because stored
--   values are keyed by the name and shaped by the type. Create a new field instead.
-- - Assignment to event types reuses custom_field_layout (event_type_id null = all types).
-- =====================================================================

alter table public.custom_field add column decimals int
  constraint custom_field_decimals_range check (decimals between 0 and 6);
alter table public.custom_field add constraint custom_field_decimals_number
  check (decimals is null or field_type in ('number', 'currency'));
comment on column public.custom_field.decimals is 'Numbers: how many decimal places a value may have (0 = whole numbers). Null = any.';
comment on column public.custom_field.help_text is 'Description shown to people filling in the field.';

alter table public.custom_field drop constraint custom_field_field_type_check;
alter table public.custom_field add constraint custom_field_field_type_check
  check (field_type in ('text','long_text','number','currency','date','checkbox','picklist','multi_picklist','lookup_user','url'));

create or replace function app.custom_field_keys_fixed() returns trigger
language plpgsql as $$
begin
  if new.api_name is distinct from old.api_name or new.object_name is distinct from old.object_name
     or new.field_type is distinct from old.field_type then
    raise exception 'A custom field''s name and type can''t change once it exists. Create a new field instead.'
      using errcode = '22023';
  end if;
  return new;
end $$;
create trigger custom_field_keys_fixed before update on public.custom_field
  for each row execute function app.custom_field_keys_fixed();

-- Same rules as before, plus url format, number decimals, and switched-off fields keeping their values
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
