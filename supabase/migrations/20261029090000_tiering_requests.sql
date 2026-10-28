-- =====================================================================
-- Event Center — Tiering requests
-- * Requests have a type (request_type): Event request (as before) or Tiering request.
-- * A tiering request asks for an expert's tier or eligibility to be reviewed. It names the expert
--   (hcp_id) and a business justification; when logged from an event, it also names that event
--   (related_event_id). Its name is made from the expert's name.
-- * Same lifecycle, team, board and access as event requests. Submitting needs the expert and the
--   business justification.
-- =====================================================================

create table public.request_type (
  code         text primary key,
  label        text not null,
  description  text,
  sort         int  not null
);
insert into public.request_type (code, label, description, sort) values
  ('event',   'Event request',   'Ask for an event to be organised.',                       10),
  ('tiering', 'Tiering request', 'Ask for an expert''s tier or eligibility to be reviewed.', 20);
alter table public.request_type enable row level security;
create policy request_type_read on public.request_type for select to authenticated using (true);
revoke all on public.request_type from anon;
grant select on public.request_type to authenticated;
comment on table public.request_type is 'Kinds of request: event request, tiering request.';

alter table public.event_request
  add column request_type      text not null default 'event' references public.request_type(code),
  add column hcp_id            uuid references public.hcp(id),
  add column related_event_id  uuid references public.event(id) on delete set null,
  alter column event_type_id drop not null,
  add constraint event_request_type_fields check (
    case request_type when 'event' then event_type_id is not null
                      when 'tiering' then hcp_id is not null and event_type_id is null
                      else true end);
create index event_request_hcp_idx on public.event_request (hcp_id);
comment on column public.event_request.request_type is 'Event request or tiering request (request_type).';
comment on column public.event_request.hcp_id is 'Tiering request: the expert to review.';
comment on column public.event_request.related_event_id is 'Tiering request: the event the expert is needed for, when logged from one.';

create or replace function app.check_request() returns trigger
language plpgsql as $$
begin
  -- Seeds and migrations (no signed-in user) may write any state
  if app.current_user_id() is null then return new; end if;
  if tg_op = 'INSERT' then
    new.requested_by := app.access_user_id();
    new.status := 'draft';
    new.submitted_at := null;
    return new;
  end if;
  if new.requested_by is distinct from old.requested_by then
    raise exception 'The requester can''t be changed' using errcode = '23514';
  end if;
  if new.request_type is distinct from old.request_type then
    raise exception 'A request''s type can''t be changed' using errcode = '23514';
  end if;
  if old.status <> 'draft'
     and (new.title, new.event_type_id, new.event_date, new.duration, new.rationale, new.hcp_id, new.related_event_id)
         is distinct from (old.title, old.event_type_id, old.event_date, old.duration, old.rationale, old.hcp_id, old.related_event_id) then
    raise exception 'Only draft requests can be changed' using errcode = '23514';
  end if;
  if new.status is distinct from old.status then
    if not (old.status = 'draft' and new.status = 'review') then
      raise exception 'Approving and rejecting requests comes with approvals' using errcode = '23514';
    end if;
    if new.request_type = 'tiering' and (new.hcp_id is null or coalesce(btrim(new.rationale), '') = '') then
      raise exception 'Add the expert and the business justification before submitting' using errcode = '23514';
    end if;
    if new.request_type = 'event' and (new.event_date is null or new.duration is null or coalesce(btrim(new.rationale), '') = '') then
      raise exception 'Add the date, duration and business justification before submitting' using errcode = '23514';
    end if;
    new.submitted_at := now();
  end if;
  return new;
end $$;

-- Create or change a draft request.
-- Event request: {request_type: 'event', title, event_type_id, event_date, duration, rationale}
-- Tiering request: {request_type: 'tiering', hcp_id, related_event_id?, rationale}; named after the expert
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
    insert into public.event_request (request_type, title, event_type_id, event_date, duration, rationale, hcp_id, related_event_id)
    values (r.request_type, r.title, r.event_type_id, r.event_date, r.duration, r.rationale, r.hcp_id, r.related_event_id)
    returning * into r;
  else
    update public.event_request set title = r.title, event_type_id = r.event_type_id, event_date = r.event_date,
           duration = r.duration, rationale = r.rationale, hcp_id = r.hcp_id, related_event_id = r.related_event_id
     where id = r.id
    returning * into r;
    if not found then raise exception 'You can''t change this request' using errcode = '42501'; end if;
  end if;
  return r;
end $$;
comment on function public.save_request(jsonb) is
  'Create or change a draft request. Event request: {request_type: event, title, event_type_id, event_date, duration, rationale}. Tiering request: {request_type: tiering, hcp_id, related_event_id?, rationale}.';
grant execute on function public.save_request(jsonb) to authenticated;

grant execute on all functions in schema app to authenticated, service_role;
