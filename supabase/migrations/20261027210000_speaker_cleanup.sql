-- =====================================================================
-- Event Coordinator — speakers leave with their last session
-- A speaker taken off their last agenda session (session edited or deleted) is removed from the
-- event's speakers, unless a contract linked to them is out for signature or signed
-- (sent / executed). Speakers added straight to the list, who never had a session, stay.
-- The check runs at commit: save_event_session replaces a session's speakers by deleting and
-- re-inserting them, so a row-level check would remove speakers who are only being re-saved.
-- =====================================================================

create or replace function app.expert_keeps_without_sessions(p_expert_id uuid) returns boolean
language sql stable security definer set search_path = public, pg_temp as $$
  select exists (select 1 from public.event_expert_contract ec join public.contract c on c.id = ec.contract_id
                  where ec.event_expert_id = p_expert_id and c.status in ('sent', 'executed'))
$$;
comment on function app.expert_keeps_without_sessions(uuid) is
  'True when a speaker has a sent or executed contract, so stays on the event without agenda sessions.';

-- Security definer: whoever may edit the agenda may cause this, without delete rights on speakers
create or replace function app.drop_sessionless_expert() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if old.event_expert_id is not null
     and (tg_op = 'DELETE' or new.event_expert_id is distinct from old.event_expert_id)
     and not exists (select 1 from public.event_session_speaker where event_expert_id = old.event_expert_id)
     and not app.expert_keeps_without_sessions(old.event_expert_id) then
    delete from public.event_expert where id = old.event_expert_id;   -- no-op if already gone
  end if;
  return null;
end $$;
create constraint trigger drop_sessionless_expert after delete or update of event_expert_id on public.event_session_speaker
  deferrable initially deferred for each row execute function app.drop_sessionless_expert();

grant execute on all functions in schema app to authenticated, service_role;
