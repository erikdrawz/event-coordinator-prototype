-- =====================================================================
-- Event Center — Event approvals
-- * Approval processes apply to events too (record_type event). Entry criteria: event type, country,
--   therapeutic area and the event's custom fields (expected attendees, estimated spend, …).
-- * Submitting an event (Draft → Review, change_event_status) starts the process that applies,
--   with the submitter's manager, groups or people as approvers, exactly as for requests. When
--   every step is approved the event moves to Contract; any rejection sends it back to Draft with
--   the reason. Only the approval moves an event from Review to Contract.
-- * Withdraw: an editor moves it back to Draft (or cancels it); the running approval is cancelled.
-- * While in Review the event is locked: its details, products, agenda and the experts' terms
--   (role, rate, prep and travel hours, custom fields) can't change. Team, discussion, attendees,
--   spend, documents and content stay open; experts' eligibility and checks too.
-- * Approvers see the event and post on its board as Approver; they decide with decide_event()
--   or by replying to the approval email.
-- =====================================================================

-- ---------------------------------------------------------------------
-- Processes and approvals for events
-- ---------------------------------------------------------------------
alter table public.approval_process drop constraint approval_process_record_type_check;
alter table public.approval_process add constraint approval_process_record_type_check check (record_type in ('request', 'event'));
alter table public.approval drop constraint approval_record_type_check;
alter table public.approval add constraint approval_record_type_check check (record_type in ('request', 'event'));

insert into public.approval_criteria_field (record_type, code, label, kind, sort) values
  ('event', 'event_type_id',       'Event type',       'choice', 10),
  ('event', 'country_code',        'Country',          'choice', 20),
  ('event', 'therapeutic_area_id', 'Therapeutic area', 'choice', 30);
comment on table public.approval_criteria_field is 'Fields approval entry criteria can test, per record type. Custom fields (picklist, number, currency, checkbox) of the record''s object are used as custom.<api_name>.';

-- Criteria: custom fields of the process's own object
create or replace function app.check_approval_process() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
declare c jsonb; v_field text; v_op text; v_kind text;
  v_object text := case new.record_type when 'event' then 'event' else 'event_request' end;
begin
  new.tenant_id := coalesce(new.tenant_id, app.current_tenant_id());   -- runs before stamp_row
  new.description := nullif(btrim(new.description), '');
  if tg_op = 'UPDATE' and new.record_type is distinct from old.record_type then
    raise exception 'What a process applies to can''t change; create a new process instead' using errcode = '23514';
  end if;
  for c in select * from jsonb_array_elements(new.criteria) loop
    v_field := c ->> 'field'; v_op := c ->> 'op'; v_kind := null;
    if v_field like 'custom.%' then
      select case when f.field_type in ('picklist') then 'choice' when f.field_type in ('number', 'currency') then 'number'
                  when f.field_type = 'checkbox' then 'boolean' end
        into v_kind from public.custom_field f
       where f.tenant_id = new.tenant_id and f.object_name = v_object and f.api_name = substr(v_field, 8) and f.is_active;
    else
      select k.kind into v_kind from public.approval_criteria_field k where k.record_type = new.record_type and k.code = v_field;
    end if;
    if v_kind is null then
      raise exception 'Entry criteria can''t use the field %', coalesce(v_field, '(none)') using errcode = '22023';
    end if;
    if not (v_kind = 'choice' and v_op in ('in', 'not_in') and jsonb_typeof(c -> 'values') = 'array' and jsonb_array_length(c -> 'values') > 0
         or v_kind = 'number' and v_op in ('gt', 'gte', 'lt', 'lte') and jsonb_typeof(c -> 'value') = 'number'
         or v_kind = 'boolean' and v_op in ('is_true', 'is_false')) then
      raise exception 'Complete the condition on %', v_field using errcode = '22023';
    end if;
  end loop;
  return new;
end $$;

-- The record as criteria see it
create or replace function app.approval_record(p_record_type text, p_record_id uuid) returns jsonb
language sql stable security definer set search_path = public, pg_temp as $$
  select case p_record_type
    when 'event' then (select to_jsonb(e) from public.event e where e.id = p_record_id)
    else (select to_jsonb(q) from public.event_request q where q.id = p_record_id) end
$$;

create or replace function app.find_approval_process(p_record_type text, p_record_id uuid) returns public.approval_process
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare v_rec jsonb := app.approval_record(p_record_type, p_record_id); p public.approval_process;
begin
  for p in select * from public.approval_process x
            where x.tenant_id = (v_rec ->> 'tenant_id')::uuid and x.record_type = p_record_type and x.is_active
              and exists (select 1 from public.approval_process_step s where s.process_id = x.id)
            order by x.priority, x.name loop
    if app.criteria_match(p.criteria, v_rec) then return p; end if;
  end loop;
  return null;
end $$;

-- ---------------------------------------------------------------------
-- The engine, for both record types
-- ---------------------------------------------------------------------
-- What an approval is about, for notifications: the record's name
create or replace function app.approval_title(p_record_type text, p_record_id uuid) returns text
language sql stable security definer set search_path = public, pg_temp as $$
  select case p_record_type when 'event' then (select name from public.event where id = p_record_id)
                            else (select title from public.event_request where id = p_record_id) end
$$;

-- An event's approval email: what's asked for, with the event's details
create or replace function app.queue_event_approval_email(p_event_id uuid, p_user_id uuid, p_submitter uuid, p_at timestamptz default now()) returns uuid
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  e public.event; v_submitter text; v_type text; v_country text; v_ta text; v_owner text; v_products text; v_when text;
begin
  select * into e from public.event where id = p_event_id;
  if e.id is null then return null; end if;
  select display_name into v_submitter from public.app_user where id = p_submitter;
  select name into v_type from public.event_type where id = e.event_type_id;
  select name into v_country from public.country where code = e.country_code;
  select name into v_ta from public.therapeutic_area where id = e.therapeutic_area_id;
  select display_name into v_owner from public.app_user where id = e.owner_id;
  select string_agg(p.name, ', ' order by p.name) into v_products from public.event_product x join public.product p on p.id = x.product_id where x.event_id = e.id;
  v_when := case when e.starts_at is not null then
    trim(to_char(e.starts_at at time zone e.timezone, 'Dy FMDD Mon YYYY, HH24:MI'))
    || coalesce('–' || to_char(e.ends_at at time zone e.timezone, case when (e.ends_at at time zone e.timezone)::date = (e.starts_at at time zone e.timezone)::date then 'HH24:MI' else 'Dy FMDD Mon YYYY, HH24:MI' end), '')
    || ' (' || replace(e.timezone, '_', ' ') || ')' end;
  return app.queue_email(p_user_id, 'approval',
    format('Approval needed: %s (%s)', e.name, e.event_number),
    concat_ws(E'\n',
      app.email_reply_line(),
      'Reply with Approve or Reject on the first line. Anything after it is kept as your comment; a rejection needs one.', '',
      format('%s submitted an event for your approval.', coalesce(v_submitter, 'Someone')), '',
      format('%s (%s)', e.name, e.event_number),
      'Type: ' || v_type,
      'When: ' || v_when,
      'Where: ' || nullif(concat_ws(', ', e.venue_name, e.city, v_country), ''),
      'Owner: ' || v_owner,
      'Therapeutic area: ' || v_ta,
      'Products: ' || v_products,
      'Expected attendees: ' || (e.custom_fields ->> 'expected_attendees__c'),
      'Estimated spend: ' || app.money_text((e.custom_fields ->> 'estimated_spend__c')::numeric, 'EUR'),
      case when coalesce(btrim(e.description), '') <> '' then E'\nDescription:\n' || app.email_quote(e.description) end,
      '',
      format('Open %s: %s', e.name, rtrim(coalesce(app.setting('app_url'), 'http://localhost:5173'), '/') || '/events/' || e.id || '?tab=details')),
    'event', e.id, null, p_at);
end $$;

create or replace function app.announce_task(p_task_id uuid, p_at timestamptz) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
declare a public.approval; v_title text; v_submitter text; m uuid;
begin
  select x.* into a from public.approval x join public.approval_task t on t.approval_id = x.id where t.id = p_task_id;
  v_title := app.approval_title(a.record_type, a.record_id);
  select display_name into v_submitter from public.app_user where id = a.submitted_by;
  for m in select app.task_approvers(p_task_id) loop
    if not exists (select 1 from public.notification n where n.user_id = m and n.kind = 'approval_required'
                      and n.record_id = a.record_id and n.read_at is null) then
      insert into public.notification (tenant_id, user_id, kind, title, body, record_type, record_id, created_at)
      values (a.tenant_id, m, 'approval_required', v_title, 'submitted for your approval by ' || coalesce(v_submitter, 'a former user'),
              a.record_type, a.record_id, p_at);
      if a.record_type = 'event' then perform app.queue_event_approval_email(a.record_id, m, a.submitted_by, p_at);
      else perform app.queue_approval_email(a.record_id, m, p_at); end if;
    end if;
  end loop;
end $$;

-- Submit a record for approval. p_submitter: who submitted (default: the caller, else the
-- requester or the event's owner). Refuses when no process applies or a step has nobody to approve.
drop function if exists app.start_approval(text, uuid, timestamptz);
create or replace function app.start_approval(p_record_type text, p_record_id uuid, p_at timestamptz default now(), p_submitter uuid default null)
returns uuid
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_rec jsonb := app.approval_record(p_record_type, p_record_id);
  v_tenant uuid := (v_rec ->> 'tenant_id')::uuid;
  v_noun text := case p_record_type when 'event' then 'event' else 'request' end;
  v_submitter uuid := coalesce(p_submitter,
    case p_record_type when 'event' then coalesce(app.access_user_id(), (v_rec ->> 'owner_id')::uuid)
                       else (v_rec ->> 'requested_by')::uuid end);
  p public.approval_process; s public.approval_process_step;
  v_approval uuid; v_manager public.app_user; v_group public.user_group; v_task uuid; v_user uuid; v_grp uuid;
begin
  p := app.find_approval_process(p_record_type, p_record_id);
  if p.id is null then
    raise exception 'No approval process applies to this %. Ask an admin to set one up in Admin → Approvals.', v_noun using errcode = '23514';
  end if;
  update public.approval set status = 'cancelled', decided_at = p_at, current_step = null
   where record_type = p_record_type and record_id = p_record_id and status = 'pending';
  insert into public.approval (tenant_id, process_id, process_name, record_type, record_id, submitted_by, submitted_at)
  values (v_tenant, p.id, p.name, p_record_type, p_record_id, v_submitter, p_at) returning id into v_approval;

  for s in select * from public.approval_process_step where process_id = p.id order by step_number, name loop
    v_user := null; v_grp := null;
    if s.approver_type = 'manager' then
      select m.* into v_manager from public.app_user u join public.app_user m on m.id = u.manager_id
       where u.id = v_submitter and m.status = 'active' and m.user_type = 'human';
      if v_manager.id is not null then v_user := v_manager.id;
      elsif s.fallback_group_id is not null then v_grp := s.fallback_group_id;
      else
        raise exception 'You don''t have a manager in Event Center, so nobody can do the step “%”. Ask an admin to set your manager.', s.name
          using errcode = '23514';
      end if;
    elsif s.approver_type = 'group' then v_grp := s.approver_group_id;
    else v_user := s.approver_user_id;
    end if;
    insert into public.approval_task (tenant_id, approval_id, step_number, step_name, approver_type, approver_id, approver_group_id)
    values (v_tenant, v_approval, s.step_number, s.name, s.approver_type, v_user, v_grp) returning id into v_task;
    if not exists (select app.task_approvers(v_task)) then
      select * into v_group from public.user_group where id = v_grp;
      raise exception '%', case
          when v_grp is not null then format('Nobody in %s can approve this %s for the step “%s”: it needs an active member other than you.', coalesce(v_group.name, 'the group'), v_noun, s.name)
          when v_user = v_submitter then format('You''re the approver of the step “%s”, and nobody approves their own %s. Ask an admin to change the process.', s.name, v_noun)
          else format('The approver of the step “%s” is no longer active. Ask an admin to change the process.', s.name) end
        using errcode = '23514';
    end if;
  end loop;

  perform app.advance_approval(v_approval, p_at);
  return v_approval;
end $$;

-- Record a decision on a task and carry it through to the record
create or replace function app.apply_task_decision(p_task_id uuid, p_user_id uuid, p_decision text, p_note text,
                                                   p_via text default 'app', p_at timestamptz default now()) returns text
language plpgsql security definer set search_path = public, pg_temp as $$
declare t public.approval_task; a public.approval; v_result text; r public.event_request; e public.event;
  v_note text := nullif(btrim(p_note), '');
begin
  select * into t from public.approval_task where id = p_task_id for update;
  select * into a from public.approval where id = t.approval_id for update;
  if t.status <> 'pending' or a.status <> 'pending' then
    raise exception 'This step was already decided' using errcode = '23514';
  end if;
  update public.approval_task set status = p_decision, decided_by = p_user_id, decided_at = p_at, decided_via = p_via, comment = v_note
   where id = t.id;

  if p_decision = 'rejected' then
    update public.approval_task set status = 'cancelled' where approval_id = a.id and status in ('waiting', 'pending');
    update public.approval set status = 'rejected', decided_at = p_at, current_step = null where id = a.id;
    v_result := 'rejected';
  else
    v_result := app.advance_approval(a.id, p_at);
  end if;

  -- Approval requests nobody needs to answer any more are done
  update public.notification n set read_at = p_at
   where n.kind = 'approval_required' and n.record_id = a.record_id and n.read_at is null
     and not exists (select 1 from public.approval_task x where x.approval_id = a.id and x.status = 'pending'
                        and n.user_id in (select app.task_approvers(x.id)));

  if v_result in ('approved', 'rejected') and a.record_type = 'request' then
    perform set_config('app.request_decision', 'on', true);
    update public.event_request
       set status = v_result, decided_by = p_user_id, decided_at = p_at, decision_note = v_note, decided_via = p_via
     where id = a.record_id
    returning * into r;
    perform set_config('app.request_decision', 'off', true);
    insert into public.notification (tenant_id, user_id, kind, title, body, record_type, record_id, created_at)
    values (r.tenant_id, r.requested_by, v_result,
            case v_result when 'approved' then 'Request approved: ' else 'Request rejected: ' end || r.title, v_note, 'request', r.id, p_at);
  elsif v_result in ('approved', 'rejected') and a.record_type = 'event' then
    -- Approved: on to Contract. Rejected: back to Draft, to change and submit again
    perform set_config('app.event_decision', 'on', true);
    update public.event set status = case v_result when 'approved' then 'contract' else 'draft' end
     where id = a.record_id and status = 'review'
    returning * into e;
    perform set_config('app.event_decision', 'off', true);
    select * into e from public.event where id = a.record_id;
    insert into public.notification (tenant_id, user_id, kind, title, body, record_type, record_id, created_at)
    select e.tenant_id, u, v_result, e.name,
           case v_result when 'approved' then 'approved: moved to Contract' else 'rejected: back to Draft' || coalesce(' — ' || v_note, '') end,
           'event', e.id, p_at
      from (select distinct unnest(array[e.owner_id, a.submitted_by]) u) x
     where u is not null and u is distinct from p_user_id;
  end if;
  return v_result;
end $$;

-- ---------------------------------------------------------------------
-- Deciding
-- ---------------------------------------------------------------------
-- The caller's open tasks on a record
create or replace function app.my_approval_tasks(p_record_type text, p_record_id uuid) returns setof uuid
language sql stable security definer set search_path = public, pg_temp as $$
  select t.id from public.approval a
    join public.approval_task t on t.approval_id = a.id and t.status = 'pending'
   where a.record_type = p_record_type and a.record_id = p_record_id and a.status = 'pending'
     and a.tenant_id = app.current_tenant_id()
     and app.access_user_id() in (select app.task_approvers(t.id))
$$;
create or replace function app.my_request_tasks(p_request_id uuid) returns setof uuid
language sql stable security definer set search_path = public, pg_temp as $$
  select app.my_approval_tasks('request', p_request_id)
$$;

create or replace function app.can_decide_event(p_event_id uuid) returns boolean
language sql stable security definer set search_path = public, pg_temp as $$
  select exists (select app.my_approval_tasks('event', p_event_id))
$$;
comment on function app.can_decide_event(uuid) is 'True when the caller has an open approval task on the event (never the submitter).';

-- Approve or reject: decides the caller's open tasks on the event (as themselves, by app or email)
create or replace function public.decide_event(p_event_id uuid, p_decision text, p_note text default null) returns public.event
language plpgsql security definer set search_path = public, pg_temp as $$
declare e public.event; note text := nullif(btrim(p_note), ''); t uuid; v_done boolean := false;
  v_via text := case when coalesce(current_setting('app.channel', true), '') = 'email' then 'email' else 'app' end;
begin
  select * into e from public.event where id = p_event_id and tenant_id = app.current_tenant_id();
  if not found or not app.can_view_event(e.id) then
    raise exception 'Event not found' using errcode = 'P0002';
  end if;
  if p_decision is null or p_decision not in ('approved', 'rejected') then
    raise exception 'Choose to approve or reject the event' using errcode = '22023';
  end if;
  if e.status <> 'review' then
    raise exception 'Only events in review can be approved or rejected' using errcode = '23514';
  end if;
  if p_decision = 'rejected' and note is null then
    raise exception 'Add a reason so the team knows what to change' using errcode = '23502';
  end if;
  for t in select app.my_approval_tasks('event', e.id) loop
    if exists (select 1 from public.approval_task where id = t and status = 'pending') then
      perform app.apply_task_decision(t, app.access_user_id(), p_decision, note, v_via);
      v_done := true;
    end if;
  end loop;
  if not v_done then
    if exists (select 1 from public.approval a where a.record_type = 'event' and a.record_id = e.id and a.status = 'pending'
                  and a.submitted_by = app.access_user_id()) then
      raise exception 'You submitted this event, so someone else approves or rejects it' using errcode = '42501';
    end if;
    raise exception 'You''re not an approver at this step of the event''s approval' using errcode = '42501';
  end if;
  select * into e from public.event where id = e.id;
  return e;
end $$;
comment on function public.decide_event(uuid, text, text) is
  'Approve or reject the caller''s open approval step on an event in review (p_decision approved|rejected; a rejection needs p_note). All approved: Contract; rejected: Draft.';
revoke all on function public.decide_event(uuid, text, text) from public, anon;
grant execute on function public.decide_event(uuid, text, text) to authenticated;

-- ---------------------------------------------------------------------
-- Status: submitting starts the approval; only the approval moves Review → Contract;
-- leaving Review otherwise (withdraw, cancel) cancels it
-- ---------------------------------------------------------------------
create or replace function app.guard_event_status() returns trigger
language plpgsql as $$
begin
  if new.status is distinct from old.status
     and not exists (select 1 from public.event_status_transition where from_status = old.status and to_status = new.status) then
    raise exception 'Cannot move event from % to %', old.status, new.status using errcode = '22023';
  end if;
  if old.status = 'review' and new.status = 'contract' and app.current_user_id() is not null
     and coalesce(current_setting('app.event_decision', true), '') <> 'on' then
    raise exception 'An event moves to Contract when its approval is complete' using errcode = '23514';
  end if;
  return new;
end $$;

create or replace function app.event_approval_follows() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if new.status = 'review' then
    perform app.start_approval('event', new.id);
  elsif old.status = 'review' and coalesce(current_setting('app.event_decision', true), '') <> 'on' then
    -- Withdrawn or cancelled while in review
    update public.approval_task t set status = 'cancelled'
      from public.approval a
     where a.id = t.approval_id and a.record_type = 'event' and a.record_id = new.id and a.status = 'pending'
       and t.status in ('waiting', 'pending');
    update public.approval set status = 'cancelled', decided_at = now(), current_step = null
     where record_type = 'event' and record_id = new.id and status = 'pending';
    update public.notification set read_at = now()
     where kind = 'approval_required' and record_type = 'event' and record_id = new.id and read_at is null;
  end if;
  return null;
end $$;
create trigger event_approval_follows after update of status on public.event
  for each row when (old.status is distinct from new.status and (new.status = 'review' or old.status = 'review') and app.current_user_id() is not null)
  execute function app.event_approval_follows();

-- ---------------------------------------------------------------------
-- Locked while in review (direct changes only: what triggers derive, e.g. an expert's eligibility
-- carried from their profile, still applies)
-- ---------------------------------------------------------------------
create or replace function app.event_in_review(p_event_id uuid) returns boolean
language sql stable security definer set search_path = public, pg_temp as $$
  select coalesce((select status = 'review' from public.event where id = p_event_id), false)
$$;

create or replace function app.lock_event_in_review() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
declare v_event uuid := (to_jsonb(coalesce(new, old)) ->> case tg_table_name when 'event' then 'id' else 'event_id' end)::uuid;
begin
  if pg_trigger_depth() > 1 or app.current_user_id() is null then return coalesce(new, old); end if;
  if tg_table_name = 'event' then
    -- Status moves (submit, withdraw, decisions) are fine; the event's data isn't
    if old.status <> 'review' or new.status <> 'review'
       or (to_jsonb(new) - array['status', 'updated_at', 'updated_by']) = (to_jsonb(old) - array['status', 'updated_at', 'updated_by']) then
      return new;
    end if;
  elsif not app.event_in_review(v_event) then
    return coalesce(new, old);
  end if;
  raise exception '% is in review, so its details, agenda and experts can''t change. Withdraw it to make changes.',
    (select name from public.event where id = v_event) using errcode = '23514';
end $$;
create trigger lock_event_in_review before update on public.event
  for each row execute function app.lock_event_in_review();
create trigger lock_event_in_review before insert or update or delete on public.event_product
  for each row execute function app.lock_event_in_review();
create trigger lock_event_in_review before insert or update or delete on public.event_session
  for each row execute function app.lock_event_in_review();
create trigger lock_event_in_review before insert or update or delete on public.event_session_speaker
  for each row execute function app.lock_event_in_review();
create trigger lock_event_in_review before insert or delete on public.event_expert
  for each row execute function app.lock_event_in_review();
create trigger lock_event_terms_in_review before update of role, hourly_rate, prep_hours, travel_hours, custom_fields on public.event_expert
  for each row execute function app.lock_event_in_review();

-- ---------------------------------------------------------------------
-- Approvers see the event and post on its board (role Approver)
-- ---------------------------------------------------------------------
create or replace function app.record_approver_ids(p_record_type text, p_record_id uuid) returns setof uuid
language sql stable security definer set search_path = public, pg_temp as $$
  select t.approver_id from public.approval a join public.approval_task t on t.approval_id = a.id
   where a.record_type = p_record_type and a.record_id = p_record_id and t.approver_id is not null and t.status <> 'cancelled'
  union
  select m.user_id from public.approval a join public.approval_task t on t.approval_id = a.id
    join public.user_group g on g.id = t.approver_group_id and g.is_active
    join public.user_group_member m on m.group_id = g.id
   where a.record_type = p_record_type and a.record_id = p_record_id and t.status <> 'cancelled'
$$;
comment on function app.record_approver_ids(text, uuid) is 'Everyone who approves, approved or is still to approve an event or request (people and members of approving groups).';
create or replace function app.request_approver_ids(p_request_id uuid) returns setof uuid
language sql stable security definer set search_path = public, pg_temp as $$
  select app.record_approver_ids('request', p_request_id)
$$;

create or replace function app.team_user_ids(p_kind text, p_record_id uuid) returns setof uuid
language sql stable security definer set search_path = public, pg_temp as $$
  select m.user_id from public.event_team_member m where p_kind = 'event' and m.event_id = p_record_id
  union
  select gm.user_id from public.event_team_group t
    join public.user_group g on g.id = t.group_id and g.is_active
    join public.user_group_member gm on gm.group_id = t.group_id
   where p_kind = 'event' and t.event_id = p_record_id
  union
  select m.user_id from public.request_team_member m where p_kind = 'request' and m.request_id = p_record_id
  union
  select gm.user_id from public.request_team_group t
    join public.user_group g on g.id = t.group_id and g.is_active
    join public.user_group_member gm on gm.group_id = t.group_id
   where p_kind = 'request' and t.request_id = p_record_id
  union
  select x from app.record_approver_ids(p_kind, p_record_id) x
$$;
comment on function app.team_user_ids(text, uuid) is 'Everyone on an event''s or request''s team (p_kind event|request): direct members, members of its active groups, and its approvers.';

create or replace function app.my_team_roles(p_kind text, p_record_id uuid) returns setof text
language sql stable security definer set search_path = public, pg_temp as $$
  select m.team_role from public.event_team_member m
   where p_kind = 'event' and m.event_id = p_record_id and m.user_id = app.access_user_id()
  union all
  select t.team_role from public.event_team_group t
    join public.user_group g on g.id = t.group_id and g.is_active
    join public.user_group_member gm on gm.group_id = t.group_id and gm.user_id = app.access_user_id()
   where p_kind = 'event' and t.event_id = p_record_id
  union all
  select m.team_role from public.request_team_member m
   where p_kind = 'request' and m.request_id = p_record_id and m.user_id = app.access_user_id()
  union all
  select t.team_role from public.request_team_group t
    join public.user_group g on g.id = t.group_id and g.is_active
    join public.user_group_member gm on gm.group_id = t.group_id and gm.user_id = app.access_user_id()
   where p_kind = 'request' and t.request_id = p_record_id
  union all
  select 'approver' where app.access_user_id() in (select app.record_approver_ids(p_kind, p_record_id))
$$;

-- team_role: your own, a group's, else Approver; locked: in review; can_decide: an open step is yours
create or replace function public.my_event_access(p_event_id uuid) returns jsonb
language sql stable security definer set search_path = public, pg_temp as $$
  with own as (select m.team_role from public.event_team_member m where m.event_id = p_event_id and m.user_id = app.access_user_id()),
  grp as (select t.team_role, g.name from public.event_team_group t
            join public.user_group g on g.id = t.group_id and g.is_active
            join public.user_group_member gm on gm.group_id = t.group_id and gm.user_id = app.access_user_id()
            join public.team_role r on r.code = t.team_role
           where t.event_id = p_event_id order by r.sort, g.name limit 1)
  select jsonb_build_object('access', app.event_access(p_event_id),
    'team_role', coalesce((select team_role from own), (select team_role from grp),
                          case when app.access_user_id() in (select app.record_approver_ids('event', p_event_id)) then 'approver' end),
    'via_group', case when not exists (select 1 from own) then (select name from grp) end,
    'locked', app.event_in_review(p_event_id),
    'can_decide', app.can_decide_event(p_event_id))
$$;
comment on function public.my_event_access(uuid) is
  'The caller''s access to an event: {access: edit|view|null, team_role, via_group, locked (in review: details, agenda and experts are fixed), can_decide}.';

-- Approvals and their tasks: readable by whoever sees the record
drop policy approval_read on public.approval;
create policy approval_read on public.approval for select to authenticated
  using (tenant_id = app.current_tenant_id()
         and case record_type when 'event' then app.can_view_event(record_id) else app.can_view_request(record_id) end);
drop policy approval_task_read on public.approval_task;
create policy approval_task_read on public.approval_task for select to authenticated
  using (tenant_id = app.current_tenant_id()
         and exists (select 1 from public.approval a where a.id = approval_id
                        and case a.record_type when 'event' then app.can_view_event(a.record_id) else app.can_view_request(a.record_id) end));

-- A deleted event takes its approvals with it
create or replace function app.delete_record_approvals() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  delete from public.approval where record_type = case tg_table_name when 'event' then 'event' else 'request' end and record_id = old.id;
  return null;
end $$;
create trigger delete_event_approvals after delete on public.event
  for each row execute function app.delete_record_approvals();

-- Approvals waiting on the caller, events and requests, newest first (Home)
drop function if exists public.my_pending_approvals();
create function public.my_pending_approvals() returns table (
  approval_id uuid, record_type text, record_id uuid, title text, event_date date, step_name text,
  submitted_at timestamptz, submitter jsonb)
language sql stable security definer set search_path = public, pg_temp as $$
  select distinct on (a.id) a.id, a.record_type, a.record_id,
         coalesce(q.title, e.name), coalesce(q.event_date, (e.starts_at at time zone e.timezone)::date), t.step_name, a.submitted_at,
         jsonb_build_object('id', u.id, 'display_name', u.display_name, 'initials', u.initials, 'avatar_color', u.avatar_color)
    from public.approval a
    join public.approval_task t on t.approval_id = a.id and t.status = 'pending'
    left join public.event_request q on a.record_type = 'request' and q.id = a.record_id
    left join public.event e on a.record_type = 'event' and e.id = a.record_id
    left join public.app_user u on u.id = a.submitted_by
   where a.tenant_id = app.current_tenant_id() and a.status = 'pending'
     and app.access_user_id() in (select app.task_approvers(t.id))
   order by a.id, t.step_number
$$;
comment on function public.my_pending_approvals() is 'Approvals (events and requests) with an open step the caller can decide.';
revoke all on function public.my_pending_approvals() from public, anon;
grant execute on function public.my_pending_approvals() to authenticated;

-- ---------------------------------------------------------------------
-- Email replies decide events too (receive_email as in 20261112100000_groups_and_managers,
-- with an event branch for approvals)
-- ---------------------------------------------------------------------
create or replace function public.receive_email(p jsonb) returns public.email_message
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_caller public.app_user;
  v_in public.email_message;
  v_out public.email_message;
  v_from text := lower(coalesce(substring(p->>'from' from '<([^>]+)>'), btrim(p->>'from')));
  v_token text := lower(substring(p->>'to' from '(?i)reply[+-]([a-z0-9]+)@'));
  v_text text := app.email_reply_text(p->>'text');
  v_provider text := nullif(p->>'id', '');
  v_inbox text;
  v_user public.app_user;
  v_headers text := current_setting('request.headers', true);
  v_post uuid; v_root uuid; v_name text; v_mentions uuid[];
  v_m text[]; v_decision text; v_note text; r public.event_request; ev public.event;
begin
  select * into v_caller from public.app_user where id = app.current_user_id();
  if v_caller.user_type is distinct from 'agent' or not app.has_perm('email_message', 'create') then
    raise exception 'Only the email service delivers replies' using errcode = '42501';
  end if;
  if coalesce(p->>'from', '') = '' or coalesce(p->>'to', '') = '' then
    raise exception 'A reply needs from and to addresses' using errcode = '22023';
  end if;

  -- Taken already (the service delivers again when it isn't sure we got it)
  if v_provider is not null then
    select * into v_in from public.email_message
     where tenant_id = v_caller.tenant_id and direction = 'inbound' and provider_id = v_provider;
    if v_in.id is not null then return v_in; end if;
  end if;

  select * into v_out from public.email_message
   where reply_token = v_token and direction = 'outbound' and tenant_id = v_caller.tenant_id;
  select * into v_user from public.app_user
   where tenant_id = v_caller.tenant_id and user_type = 'human' and lower(email) = v_from;
  -- Demo inbox: a reply from it is the reply of the person the email was for
  select lower(demo_inbox) into v_inbox from public.tenant where id = v_caller.tenant_id;
  if v_out.id is not null and v_inbox is not null and v_from = v_inbox then
    select * into v_user from public.app_user where id = v_out.user_id;
  end if;

  insert into public.email_message (tenant_id, direction, kind, status, user_id, from_address, to_address, subject, body,
                                    record_type, record_id, in_reply_to, provider_id)
  values (v_caller.tenant_id, 'inbound', 'reply', 'received', v_user.id, p->>'from', p->>'to',
          coalesce(nullif(p->>'subject', ''), '(no subject)'), coalesce(p->>'text', ''),
          v_out.record_type, v_out.record_id, v_out.id, v_provider)
  returning * into v_in;

  begin
    if v_out.id is null then
      raise exception 'This isn''t a reply to an Event Center email';
    end if;
    if v_user.id is null or v_user.id <> v_out.user_id then
      raise exception 'Sent from %, not the address this email went to', v_from;
    end if;
    if p ? 'authentication' and jsonb_typeof(p->'authentication') = 'object'
       and coalesce(lower(p->'authentication'->>'spf'), '') <> 'pass' and coalesce(lower(p->'authentication'->>'dkim'), '') <> 'pass' then
      raise exception 'Couldn''t confirm the reply really came from %', v_from;
    end if;
    if v_text is null then
      raise exception 'The reply had no text above the reply line';
    end if;

    -- Act as the person who replied: the agent's on-behalf-of, and the email channel
    perform set_config('request.headers',
      (coalesce(nullif(v_headers, '')::jsonb, '{}'::jsonb) || jsonb_build_object('x-on-behalf-of', v_user.id))::text, true);
    perform set_config('app.channel', 'email', true);

    if v_out.kind = 'mention' then
      if v_out.record_type = 'event' then
        if not app.can_view_event(v_out.record_id) then raise exception 'You''re no longer on this event''s team'; end if;
        select coalesce(parent_id, id) into v_root from public.event_post where id = v_out.post_id;
        if v_root is null then raise exception 'The post you were mentioned in was deleted'; end if;
        select coalesce(array_agg(t.user_id), '{}') into v_mentions from app.team_user_ids('event', v_out.record_id) t(user_id) join public.app_user u on u.id = t.user_id
         where position(lower('@' || u.display_name) in lower(v_text)) > 0;
        insert into public.event_post (tenant_id, event_id, parent_id, body, mentions)
        values (v_caller.tenant_id, v_out.record_id, v_root, v_text, v_mentions) returning id into v_post;
        select name into v_name from public.event where id = v_out.record_id;
      else
        if not app.can_view_request(v_out.record_id) then raise exception 'You''re no longer on this request''s team'; end if;
        select coalesce(parent_id, id) into v_root from public.request_post where id = v_out.post_id;
        if v_root is null then raise exception 'The post you were mentioned in was deleted'; end if;
        select coalesce(array_agg(t.user_id), '{}') into v_mentions from app.team_user_ids('request', v_out.record_id) t(user_id) join public.app_user u on u.id = t.user_id
         where position(lower('@' || u.display_name) in lower(v_text)) > 0;
        insert into public.request_post (tenant_id, request_id, parent_id, body, mentions)
        values (v_caller.tenant_id, v_out.record_id, v_root, v_text, v_mentions) returning id into v_post;
        select title into v_name from public.event_request where id = v_out.record_id;
      end if;
      update public.email_message set status = 'processed', processed_at = now(), post_id = v_post,
             status_note = format('Posted as a reply in the %s discussion', v_name)
       where id = v_in.id returning * into v_in;

    elsif v_out.kind = 'approval' then
      v_m := regexp_match(v_text, '^\s*(approved?|reject(?:ed)?)\M[\s.,:;!–—-]*(.*)$', 'is');
      if v_m is null then
        raise exception 'Start the reply with Approve or Reject';
      end if;
      v_decision := case when lower(v_m[1]) like 'approve%' then 'approved' else 'rejected' end;
      v_note := nullif(btrim(v_m[2], E' \t\r\n'), '');
      if v_out.record_type = 'event' then
        ev := public.decide_event(v_out.record_id, v_decision, v_note);
        v_name := ev.name;
      else
        r := public.decide_request(v_out.record_id, v_decision, v_note);
        v_name := r.title;
      end if;
      update public.email_message set status = 'processed', processed_at = now(),
             status_note = format('%s %s', case v_decision when 'approved' then 'Approved' else 'Rejected' end, v_name)
       where id = v_in.id returning * into v_in;
    end if;
  exception when others then
    update public.email_message set status = 'failed', processed_at = now(), status_note = sqlerrm
     where id = v_in.id returning * into v_in;
  end;

  perform set_config('app.channel', '', true);
  perform set_config('request.headers', coalesce(v_headers, ''), true);
  return v_in;
end $$;

grant execute on all functions in schema app to authenticated, service_role;
