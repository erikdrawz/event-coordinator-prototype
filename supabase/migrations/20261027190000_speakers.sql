-- =====================================================================
-- Event Coordinator — Speakers (event_expert) driven by the agenda
-- - Service hours come from the agenda: the sum of the expert's session minutes
--   (or the full session when no minutes are set). Kept up to date by triggers;
--   writes to service_hours are ignored.
-- - Adding an HCP to a session adds them to the event's speakers if needed.
-- - Removing a speaker removes them from the sessions (FK cascade, already in place).
-- - Rate: a temporary flat rate until FMV rates are wired in (app.expert_rate()).
-- - Total payable counts every speaker except ineligible ones.
-- =====================================================================

-- Temporary flat honorarium rate. Replace with an FMV lookup (fmv_rate by HCP, tier, service).
create or replace function app.expert_rate() returns numeric language sql immutable as $$ select 100.00::numeric $$;
comment on function app.expert_rate() is 'Temporary flat hourly rate (EUR) for new speakers until FMV rates are wired in.';
alter table public.event_expert alter column hourly_rate set default app.expert_rate();
alter table public.event_expert alter column currency set default 'EUR';

alter table public.event_expert drop column total_payable;
alter table public.event_expert add column total_payable numeric(12,2) generated always as (
  case when eligibility = 'ineligible' then 0
       else round(coalesce(hourly_rate, 0) * (prep_hours + service_hours + travel_hours), 2) end) stored;
comment on column public.event_expert.total_payable is '(prep + service + travel) × hourly_rate; 0 for ineligible speakers.';
comment on column public.event_expert.service_hours is 'From the agenda: the expert''s session minutes (or full session) / 60. Read-only.';

-- Service hours for one expert, from the agenda
create or replace function app.expert_service_hours(p_expert_id uuid) returns numeric
language sql stable security definer set search_path = public, pg_temp as $$
  select coalesce(round(sum(coalesce(ss.minutes, extract(epoch from (s.ends_at - s.starts_at)) / 60)) / 60.0, 2), 0)
    from public.event_session_speaker ss
    join public.event_session s on s.id = ss.session_id
   where ss.event_expert_id = p_expert_id
$$;

-- Any write to event_expert gets the computed value, so the API can't set it by hand
create or replace function app.expert_service_hours_fill() returns trigger
language plpgsql as $$
begin
  new.service_hours := case when tg_op = 'INSERT' then 0 else app.expert_service_hours(new.id) end;
  return new;
end $$;
create trigger expert_service_hours_fill before insert or update on public.event_expert
  for each row execute function app.expert_service_hours_fill();

-- Recompute when speakers or session times change. Security definer: the caller may change the
-- agenda without having edit rights on the honorarium grid.
create or replace function app.refresh_expert_hours(p_ids uuid[]) returns void
language sql security definer set search_path = public, pg_temp as $$
  update public.event_expert set service_hours = service_hours where id = any(p_ids)
$$;

create or replace function app.session_speaker_changed() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  perform app.refresh_expert_hours(array_remove(array[
    case when tg_op <> 'DELETE' then new.event_expert_id end,
    case when tg_op <> 'INSERT' then old.event_expert_id end], null));
  return null;
end $$;
create trigger session_speaker_changed after insert or update or delete on public.event_session_speaker
  for each row execute function app.session_speaker_changed();

create or replace function app.session_times_changed() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  perform app.refresh_expert_hours(array(
    select event_expert_id from public.event_session_speaker where session_id = new.id and event_expert_id is not null));
  return null;
end $$;
create trigger session_times_changed after update of starts_at, ends_at on public.event_session
  for each row execute function app.session_times_changed();

-- ---------------------------------------------------------------------
-- save_event_session(): speakers may also be given as { "hcp_id": … }. An HCP who isn't one of
-- the event's speakers yet is added (role speaker, flat rate) before being put on the session.
-- ---------------------------------------------------------------------
create or replace function public.save_event_session(p jsonb) returns public.event_session
language plpgsql as $$
declare
  s    public.event_session;
  tz   text;
  bad  text;
  i    int := 0;
  sp   jsonb;
  xid  uuid;
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
      xid := (sp ->> 'event_expert_id')::uuid;
      if xid is null and sp ->> 'hcp_id' is not null then
        select id into xid from public.event_expert where event_id = s.event_id and hcp_id = (sp ->> 'hcp_id')::uuid;
        if xid is null then
          insert into public.event_expert (event_id, hcp_id, role) values (s.event_id, (sp ->> 'hcp_id')::uuid, 'speaker')
          returning id into xid;
        end if;
      end if;
      insert into public.event_session_speaker (event_id, session_id, event_expert_id, user_id, minutes, sort)
      values (s.event_id, s.id, xid, case when xid is null then (sp ->> 'user_id')::uuid end, (sp ->> 'minutes')::int, i);
    end loop;
  end if;
  return s;
end $$;
comment on function public.save_event_session(jsonb) is
  'Creates or updates an agenda session and (optionally) replaces its speakers: {event_expert_id | hcp_id | user_id, minutes}. An hcp_id not yet on the event is added as a speaker. starts_local/ends_local are wall-clock times in the event''s zone.';

grant execute on all functions in schema app to authenticated, service_role;
