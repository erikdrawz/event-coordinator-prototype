-- =====================================================================
-- Event Coordinator — Agenda
-- - session_kind: the kinds of agenda item (Presentation, Break…), per tenant, so clients
--   read them instead of hard-coding them. event_session.session_kind stores the name.
-- - Speakers on a session are the event's own experts or members of its team.
-- - save_event_session(): a session and its speakers in one call, with local times.
-- =====================================================================

create table public.session_kind (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null references public.tenant(id),
  name        text not null,
  sort        int not null default 100,
  is_active   boolean not null default true,
  created_at  timestamptz not null default now(),
  created_by  uuid references public.app_user(id),
  unique (tenant_id, name)
);
comment on table public.session_kind is 'Kinds of agenda item. event_session.session_kind holds the name.';
select app.secure_table('session_kind');

-- Speakers: fill event_id from the session, and keep speakers inside the event
create or replace function app.check_session_speaker() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
declare ev uuid;
begin
  select event_id into ev from public.event_session where id = new.session_id;
  new.event_id := ev;
  if new.event_expert_id is not null
     and not exists (select 1 from public.event_expert where id = new.event_expert_id and event_id = ev) then
    raise exception 'That speaker isn''t one of this event''s experts' using errcode = '23514';
  end if;
  if new.user_id is not null
     and not exists (select 1 from public.event_team_member where user_id = new.user_id and event_id = ev) then
    raise exception 'Internal speakers must be on the event team' using errcode = '23514';
  end if;
  return new;
end $$;
create trigger check_session_speaker before insert or update on public.event_session_speaker
  for each row execute function app.check_session_speaker();

-- ---------------------------------------------------------------------
-- save_event_session(p): create (no id) or update (id) a session.
-- Keys: id, event_id (new only), title, session_kind, location,
--       starts_local / ends_local ('2026-11-14T09:00' in the event's zone) or starts_at / ends_at,
--       speakers: [{ "event_expert_id" | "user_id": uuid, "minutes": int }] replaces the list when present.
-- ---------------------------------------------------------------------
create or replace function public.save_event_session(p jsonb) returns public.event_session
language plpgsql as $$
declare
  s    public.event_session;
  tz   text;
  bad  text;
  i    int := 0;
  sp   jsonb;
begin
  if jsonb_typeof(p) is distinct from 'object' then raise exception 'Payload must be a JSON object' using errcode = '22023'; end if;
  select string_agg(k, ', ') into bad from jsonb_object_keys(p) k
   where k <> all(array['id','event_id','title','session_kind','location','starts_local','ends_local','starts_at','ends_at','speakers']);
  if bad is not null then raise exception 'Unknown field(s): %', bad using errcode = '22023'; end if;

  if p ? 'id' then
    select * into s from public.event_session where id = (p ->> 'id')::uuid;
    if not found then raise exception 'Session not found or not visible' using errcode = 'P0002'; end if;
  else
    s.event_id := (p ->> 'event_id')::uuid;
    if s.event_id is null then raise exception 'event_id is required for a new session' using errcode = '23502'; end if;
  end if;
  select timezone into tz from public.event where id = s.event_id;
  if tz is null then raise exception 'Event not found or not visible' using errcode = 'P0002'; end if;

  if p ? 'title' then s.title := nullif(trim(p ->> 'title'), ''); end if;
  if p ? 'session_kind' then s.session_kind := nullif(trim(p ->> 'session_kind'), ''); end if;
  if p ? 'location' then s.location := nullif(trim(p ->> 'location'), ''); end if;
  if p ? 'starts_at' then s.starts_at := (p ->> 'starts_at')::timestamptz; end if;
  if p ? 'ends_at' then s.ends_at := (p ->> 'ends_at')::timestamptz; end if;
  if p ? 'starts_local' then s.starts_at := (p ->> 'starts_local')::timestamp at time zone tz; end if;
  if p ? 'ends_local' then s.ends_at := (p ->> 'ends_local')::timestamp at time zone tz; end if;

  if s.title is null then raise exception 'Give the session a title' using errcode = '23502'; end if;
  if s.starts_at is null or s.ends_at is null then raise exception 'A session needs a start and an end time' using errcode = '23502'; end if;
  if s.ends_at < s.starts_at then raise exception 'The session ends before it starts' using errcode = '22023'; end if;

  if p ? 'id' then
    update public.event_session set title = s.title, session_kind = s.session_kind, location = s.location,
           starts_at = s.starts_at, ends_at = s.ends_at
     where id = s.id returning * into s;
    if not found then raise exception 'You don''t have permission to edit this session' using errcode = '42501'; end if;
  else
    insert into public.event_session (event_id, title, session_kind, location, starts_at, ends_at)
    values (s.event_id, s.title, s.session_kind, s.location, s.starts_at, s.ends_at)
    returning * into s;
  end if;

  if p ? 'speakers' then
    if jsonb_typeof(p -> 'speakers') <> 'array' then raise exception 'speakers must be an array' using errcode = '22023'; end if;
    delete from public.event_session_speaker where session_id = s.id;
    for sp in select * from jsonb_array_elements(p -> 'speakers') loop
      i := i + 1;
      insert into public.event_session_speaker (event_id, session_id, event_expert_id, user_id, minutes, sort)
      values (s.event_id, s.id, (sp ->> 'event_expert_id')::uuid, (sp ->> 'user_id')::uuid, (sp ->> 'minutes')::int, i);
    end loop;
  end if;
  return s;
end $$;
comment on function public.save_event_session(jsonb) is
  'Creates or updates an agenda session and (optionally) replaces its speakers. starts_local/ends_local are wall-clock times in the event''s zone.';
grant execute on function public.save_event_session(jsonb) to authenticated;
grant execute on all functions in schema app to authenticated, service_role;
