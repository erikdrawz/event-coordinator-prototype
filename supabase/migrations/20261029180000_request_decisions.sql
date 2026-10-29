-- =====================================================================
-- Event Center — Approving and rejecting requests
-- * A request in review is approved or rejected with decide_request(); a rejection needs a reason.
--   Who decided, when and why stay on the request (decided_by, decided_at, decision_note).
-- * Home office (view all on requests: Event Coordinators, Business Admins), System Admins and the
--   request's Approvers decide — never on a request they submitted themselves.
-- * Submitting notifies the request's approvers; the decision notifies the requester and clears
--   the open "approval required" notifications.
-- =====================================================================

alter table public.event_request
  add column decided_by     uuid references public.app_user(id),
  add column decided_at     timestamptz,
  add column decision_note  text;
comment on column public.event_request.decided_by is 'Who approved or rejected the request.';
comment on column public.event_request.decided_at is 'When the request was approved or rejected.';
comment on column public.event_request.decision_note is 'Why: required when rejecting, optional when approving.';

update public.team_role set description = 'Can view and post. Approves or rejects requests.' where code = 'approver';

-- Whether the caller may approve or reject this request now
create or replace function app.can_decide_request(p_request_id uuid) returns boolean
language sql stable security definer set search_path = public, pg_temp as $$
  select coalesce((
    select q.status = 'review' and q.requested_by is distinct from app.access_user_id()
           and (app.is_admin() or app.perm_flag('event_request', 'view_all')
                or exists (select 1 from public.request_team_member m
                            where m.request_id = q.id and m.user_id = app.access_user_id() and m.team_role = 'approver'))
      from public.event_request q where q.id = p_request_id and q.tenant_id = app.current_tenant_id()), false)
$$;
comment on function app.can_decide_request(uuid) is
  'True when the caller may approve or reject the request: it is in review, they did not submit it, and they are home office, a System Admin or one of its Approvers.';

create or replace function public.my_request_access(p_request_id uuid) returns jsonb
language sql stable security definer set search_path = public, pg_temp as $$
  select jsonb_build_object('access', app.request_access(p_request_id),
    'team_role', (select m.team_role from public.request_team_member m where m.request_id = p_request_id and m.user_id = app.access_user_id()),
    'can_decide', app.can_decide_request(p_request_id))
$$;
comment on function public.my_request_access(uuid) is 'The caller''s access to a request: {access: edit|view|null, team_role, can_decide}.';

-- Status changes: draft → review by update; review → approved | rejected only through decide_request
create or replace function app.check_request() returns trigger
language plpgsql as $$
declare deciding boolean := coalesce(current_setting('app.request_decision', true), '') = 'on';
begin
  -- Seeds and migrations (no signed-in user) may write any state
  if app.current_user_id() is null then return new; end if;
  if tg_op = 'INSERT' then
    new.requested_by := app.access_user_id();
    new.status := 'draft';
    new.submitted_at := null;
    new.decided_by := null; new.decided_at := null; new.decision_note := null;
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
  if not deciding and (new.decided_by, new.decided_at, new.decision_note) is distinct from (old.decided_by, old.decided_at, old.decision_note) then
    raise exception 'A decision is recorded by approving or rejecting the request' using errcode = '23514';
  end if;
  if new.status is distinct from old.status then
    if deciding and old.status = 'review' and new.status in ('approved', 'rejected') then
      return new;   -- decide_request checked who may decide
    end if;
    if not (old.status = 'draft' and new.status = 'review') then
      raise exception 'Requests in review are approved or rejected from their Actions' using errcode = '23514';
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

-- Approve or reject a request in review. p_decision: 'approved' | 'rejected'; a rejection needs p_note.
create or replace function public.decide_request(p_request_id uuid, p_decision text, p_note text default null) returns public.event_request
language plpgsql security definer set search_path = public, pg_temp as $$
declare r public.event_request; note text := nullif(btrim(p_note), '');
begin
  select * into r from public.event_request where id = p_request_id and tenant_id = app.current_tenant_id() for update;
  if not found or not app.can_view_request(r.id) then
    raise exception 'Request not found' using errcode = 'P0002';
  end if;
  if p_decision is null or p_decision not in ('approved', 'rejected') then
    raise exception 'Choose to approve or reject the request' using errcode = '22023';
  end if;
  if r.status <> 'review' then
    raise exception 'Only requests in review can be approved or rejected' using errcode = '23514';
  end if;
  if r.requested_by = app.access_user_id() then
    raise exception 'You submitted this request, so someone else approves or rejects it' using errcode = '42501';
  end if;
  if not app.can_decide_request(r.id) then
    raise exception 'Only home office and the request''s approvers can approve or reject it' using errcode = '42501';
  end if;
  if p_decision = 'rejected' and note is null then
    raise exception 'Add a reason so the requester knows why' using errcode = '23502';
  end if;

  perform set_config('app.request_decision', 'on', true);
  update public.event_request
     set status = p_decision, decided_by = app.access_user_id(), decided_at = now(), decision_note = note
   where id = r.id
  returning * into r;
  perform set_config('app.request_decision', 'off', true);

  update public.notification set read_at = now()
   where record_type = 'request' and record_id = r.id and kind = 'approval_required' and read_at is null;
  perform app.notify(r.requested_by, p_decision,
    case p_decision when 'approved' then 'Request approved: ' else 'Request rejected: ' end || r.title,
    note, 'request', r.id);
  return r;
end $$;
comment on function public.decide_request(uuid, text, text) is
  'Approve or reject a request in review (p_decision approved|rejected; a rejection needs p_note). Notifies the requester.';
revoke all on function public.decide_request(uuid, text, text) from public, anon;
grant execute on function public.decide_request(uuid, text, text) to authenticated;

-- Submitting tells the request's approvers
create or replace function app.notify_request_submitted() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  perform app.notify(m.user_id, 'approval_required', new.title,
                     'submitted for your approval by ' || coalesce((select display_name from public.app_user where id = new.requested_by), 'a former user'),
                     'request', new.id)
     from public.request_team_member m
    where m.request_id = new.id and m.team_role = 'approver' and m.user_id <> new.requested_by;
  return null;
end $$;
create trigger notify_request_submitted after update of status on public.event_request
  for each row when (old.status = 'draft' and new.status = 'review') execute function app.notify_request_submitted();

grant execute on all functions in schema app to authenticated, service_role;
