-- =====================================================================
-- Event Coordinator — speaking time never exceeds the session
-- A speaker's minutes count up to the session's length, so shortening a session
-- can't leave someone with more service time than the session has.
-- =====================================================================

create or replace function app.expert_service_hours(p_expert_id uuid) returns numeric
language sql stable security definer set search_path = public, pg_temp as $$
  select coalesce(round(sum(least(coalesce(ss.minutes, len), len)) / 60.0, 2), 0)
    from public.event_session_speaker ss
    join public.event_session s on s.id = ss.session_id
   cross join lateral (select extract(epoch from (s.ends_at - s.starts_at)) / 60 as len) l
   where ss.event_expert_id = p_expert_id
$$;
