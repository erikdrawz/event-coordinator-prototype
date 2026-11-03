-- =====================================================================
-- Agenda templates: approved, fillable PDF invitations in the Library
-- * A Library item of kind 'template' is an agency-made PDF form (fixed artwork, job code) whose
--   blanks are filled from the event: date, venue, contact, and one row per agenda session.
-- * content.template_fields maps each PDF field to what fills it:
--     { "<pdf field name>": { "source": "<template_field_source code>", "row": 1, "label": "…" } }
--   `row` (1, 2, …) is required for session sources; `label` for 'ask' (asked for when generating).
--   Fields left out keep the template's own text.
-- * Templates are offered to events like other Library items (event type, countries), through
--   event_agenda_templates(); they aren't event content. The filled PDF is kept as an Agenda document.
-- =====================================================================

create table public.template_field_source (code text primary key, label text not null, grp text not null, sort int not null);
insert into public.template_field_source (code, label, grp, sort) values
  ('event.name',       'Event name',               'event',   10),
  ('event.number',     'Event number',             'event',   20),
  ('event.date',       'Date',                     'event',   30),
  ('event.time',       'Time (start–end)',         'event',   40),
  ('event.venue',      'Venue',                    'event',   50),
  ('event.address',    'Venue address',            'event',   60),
  ('event.city',       'City',                     'event',   70),
  ('contact.name',     'Contact name (owner)',     'contact', 110),
  ('contact.email',    'Contact email (owner)',    'contact', 120),
  ('chair.name',       'Chair',                    'contact', 130),
  ('session.time',     'Session start time',       'session', 210),
  ('session.title',    'Session title',            'session', 220),
  ('session.speakers', 'Session speakers',         'session', 230),
  ('ask',              'Ask when generating',      'other',   310),
  ('blank',            'Leave blank',              'other',   320);
alter table public.template_field_source enable row level security;
create policy template_field_source_read on public.template_field_source for select to authenticated using (true);
revoke all on public.template_field_source from anon;
grant select on public.template_field_source to authenticated;

alter table public.content add column template_fields jsonb;
comment on column public.content.template_fields is
  'Agenda templates: which event data fills each PDF form field ({field: {source, row?, label?}}). Unlisted fields keep the template''s text.';

create or replace function app.check_template_fields() returns trigger
language plpgsql set search_path = public, pg_temp as $$
declare
  f record; src record;
begin
  if new.content_kind = 'template' and not new.is_library then
    raise exception 'Agenda templates live in the Library' using errcode = '22023';
  end if;
  if new.template_fields is null then return new; end if;
  if new.content_kind <> 'template' then
    raise exception 'Only agenda templates have field mappings' using errcode = '22023';
  end if;
  if jsonb_typeof(new.template_fields) <> 'object' then
    raise exception 'Field mappings must be an object of field names' using errcode = '22023';
  end if;
  for f in select key, value from jsonb_each(new.template_fields) loop
    select * into src from public.template_field_source where code = f.value->>'source';
    if src is null then
      raise exception 'Field "%" has an unknown source', f.key using errcode = '22023';
    end if;
    if src.grp = 'session' and coalesce(f.value->>'row', '') !~ '^[1-9][0-9]?$' then
      raise exception 'Field "%" needs the agenda row it shows (1, 2, …)', f.key using errcode = '22023';
    end if;
    if src.code = 'ask' and nullif(trim(f.value->>'label'), '') is null then
      raise exception 'Field "%" needs a label to ask for', f.key using errcode = '22023';
    end if;
  end loop;
  return new;
end $$;
create trigger check_template_fields before insert or update of template_fields, content_kind, is_library on public.content
  for each row execute function app.check_template_fields();

-- Templates aren't offered as content or used on events as content
create or replace function public.event_library_options(p_event_id uuid) returns setof public.content
language sql stable security definer set search_path = public, pg_temp as $$
  select c.* from public.content c
   where app.can_view_event(p_event_id) and app.library_available(c.id, p_event_id) and c.content_kind <> 'template'
   order by c.title
$$;

create or replace function public.event_agenda_templates(p_event_id uuid) returns setof public.content
language sql stable security definer set search_path = public, pg_temp as $$
  select c.* from public.content c
   where app.can_view_event(p_event_id) and app.library_available(c.id, p_event_id) and c.content_kind = 'template'
   order by c.title
$$;
comment on function public.event_agenda_templates(uuid) is 'The agenda templates an event can use, by its event type and country.';
grant execute on function public.event_agenda_templates(uuid) to authenticated;

create or replace function app.check_event_content_kind() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if exists (select 1 from public.content where id = new.content_id and content_kind = 'template' and is_library) then
    raise exception 'Agenda templates aren''t event content; use one to make a branded agenda' using errcode = '22023';
  end if;
  return new;
end $$;
create trigger check_event_content_kind before insert or update of content_id on public.event_content
  for each row execute function app.check_event_content_kind();
