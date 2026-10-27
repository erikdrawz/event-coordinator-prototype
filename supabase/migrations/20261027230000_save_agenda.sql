-- =====================================================================
-- Event Coordinator — the agenda is saved as a whole
-- save_agenda(p) takes every session of an event in one call and one transaction:
-- sessions with an id are updated, sessions without one are added, sessions left out are deleted.
-- Speaker changes (joining the speakers, service hours, leaving with the last session) are
-- settled once, on the final agenda, so moving a speaker between sessions keeps their record.
-- agenda_version(event) is a fingerprint of the agenda. A save that passes the version it started
-- from is refused when someone else changed the agenda since (HTTP 409).
-- save_event_session(p) stays for single-session changes through the API.
-- =====================================================================

create or replace function public.agenda_version(p_event_id uuid) returns text
language sql stable as $$
  select md5(coalesce(string_agg(r, '|' order by r), ''))
    from (select concat_ws('~', s.id, s.title, s.session_kind, s.location, s.starts_at, s.ends_at,
                   (select string_agg(concat_ws(':', ss.sort, ss.event_expert_id, ss.user_id, ss.minutes), ',' order by ss.sort, ss.event_expert_id, ss.user_id)
                      from public.event_session_speaker ss where ss.session_id = s.id)) as r
            from public.event_session s where s.event_id = p_event_id) t
$$;
comment on function public.agenda_version(uuid) is 'Fingerprint of an event''s agenda (sessions and speakers). Pass it to save_agenda to detect concurrent edits.';

create or replace function public.save_agenda(p jsonb) returns jsonb
language plpgsql as $$
declare
  ev       uuid;
  bad      text;
  keep     uuid[];
  stray    uuid;
  item     jsonb;
  n        int;
  expected int;
  gone     int;
begin
  if jsonb_typeof(p) is distinct from 'object' then raise exception 'Payload must be a JSON object' using errcode = '22023'; end if;
  select string_agg(k, ', ') into bad from jsonb_object_keys(p) k where k <> all(array['event_id','version','sessions']);
  if bad is not null then raise exception 'Unknown field(s): %', bad using errcode = '22023'; end if;
  ev := (p ->> 'event_id')::uuid;
  if ev is null then raise exception 'event_id is required' using errcode = '23502'; end if;
  if not exists (select 1 from public.event where id = ev) then raise exception 'Event not found or not visible' using errcode = 'P0002'; end if;
  if jsonb_typeof(p -> 'sessions') is distinct from 'array' then raise exception 'sessions must be an array' using errcode = '22023'; end if;

  -- One agenda save per event at a time; the version check then sees the other save's result
  perform pg_advisory_xact_lock(hashtextextended('agenda:' || ev::text, 0));
  if p ? 'version' and (p ->> 'version') is distinct from public.agenda_version(ev) then
    raise exception 'Someone else changed the agenda while you were editing. Reload to see their changes, then make yours again.'
      using errcode = 'PT409';
  end if;

  select coalesce(array_agg((x ->> 'id')::uuid), '{}') into keep from jsonb_array_elements(p -> 'sessions') x where x ? 'id';
  if cardinality(keep) <> (select count(distinct k) from unnest(keep) k) then
    raise exception 'A session appears twice in the agenda' using errcode = '22023';
  end if;
  select k into stray from unnest(keep) k
   where not exists (select 1 from public.event_session where id = k and event_id = ev) limit 1;
  if stray is not null then raise exception 'Session % is not part of this event''s agenda', stray using errcode = 'P0002'; end if;

  -- Sessions left out are deleted
  select count(*) into expected from public.event_session where event_id = ev and id <> all(keep);
  with d as (delete from public.event_session where event_id = ev and id <> all(keep) returning 1) select count(*) into gone from d;
  if gone < expected then raise exception 'You don''t have permission to delete sessions' using errcode = '42501'; end if;

  for item, n in select x, i from jsonb_array_elements(p -> 'sessions') with ordinality as t(x, i) loop
    begin
      perform public.save_event_session(case when item ? 'id' then item - 'event_id' else item || jsonb_build_object('event_id', ev) end);
    exception when others then
      raise exception '%: %', coalesce(nullif(trim(item ->> 'title'), ''), 'Session ' || n), sqlerrm using errcode = sqlstate;
    end;
  end loop;

  return jsonb_build_object('version', public.agenda_version(ev), 'sessions', jsonb_array_length(p -> 'sessions'));
end $$;
comment on function public.save_agenda(jsonb) is
  'Saves an event''s whole agenda: {event_id, version?, sessions: [{id?, title, session_kind, location, starts_local, ends_local, speakers}]}. Sessions left out are deleted. Speakers omitted on a session are left as they are. Refused with 409 when version is given and the agenda changed since.';
