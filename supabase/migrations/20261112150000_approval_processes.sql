-- =====================================================================
-- Event Center — Approval processes (requests)
-- * An approval process (Admin → Approvals) applies to requests that match its entry criteria
--   (all must match; none: every request). The active process with the lowest priority number
--   wins; when none matches, submitting is refused.
-- * Steps run in order of their step number; steps with the same number run in parallel. A step's
--   approver is the submitter's manager (or a fallback group when they have none), a group (any
--   one member decides for it, never the submitter), or a named person.
-- * Submitting takes a snapshot: who approves each step is fixed then (approval_task), so later
--   changes to processes, managers or groups don't change approvals already running. Group tasks
--   follow the group's current members.
-- * Each step's approvers are notified and emailed when the step starts. Any rejection rejects the
--   request and cancels the rest; when every step is approved, the request is approved.
-- * decide_request() stays: it decides the caller's open tasks on the request, so the Request page,
--   email replies and the API work as before. Home office no longer decides by default; processes
--   say who does. Approvers can see the request and post on its board.
-- * The original placeholder tables (approval_process, approval_process_step, approval,
--   approval_action) held demo data only; they're replaced.
-- =====================================================================

drop table if exists public.approval_action, public.approval, public.approval_process_step, public.approval_process cascade;
drop trigger if exists notify_approver_added on public.request_team_member;
drop function if exists app.notify_approver_added();

-- ---------------------------------------------------------------------
-- Fields entry criteria can use
-- ---------------------------------------------------------------------
create table public.approval_criteria_field (
  record_type  text not null,
  code         text not null,
  label        text not null,
  kind         text not null check (kind in ('choice', 'number')),
  sort         int  not null,
  primary key (record_type, code)
);
insert into public.approval_criteria_field (record_type, code, label, kind, sort) values
  ('request', 'request_type',        'Request type',       'choice', 10),
  ('request', 'event_type_id',       'Event type',         'choice', 20),
  ('request', 'country_code',        'Country',            'choice', 30),
  ('request', 'therapeutic_area_id', 'Therapeutic area',   'choice', 40),
  ('request', 'estimated_spend',     'Estimated spend',    'number', 50),
  ('request', 'expected_attendees',  'Expected attendees', 'number', 60);
alter table public.approval_criteria_field enable row level security;
create policy approval_criteria_field_read on public.approval_criteria_field for select to authenticated using (true);
revoke all on public.approval_criteria_field from anon;
grant select on public.approval_criteria_field to authenticated;
comment on table public.approval_criteria_field is 'Fields approval entry criteria can test. Custom fields (picklist, number, currency, checkbox) are used as custom.<api_name>.';

-- ---------------------------------------------------------------------
-- Configuration
-- ---------------------------------------------------------------------
create table public.approval_process (
  id           uuid primary key default gen_random_uuid(),
  tenant_id    uuid not null references public.tenant(id),
  name         text not null check (btrim(name) <> ''),
  description  text,
  record_type  text not null default 'request' check (record_type in ('request')),
  priority     int  not null default 100,
  criteria     jsonb not null default '[]' check (jsonb_typeof(criteria) = 'array'),
  is_active    boolean not null default true,
  created_at   timestamptz not null default now(),
  created_by   uuid references public.app_user(id),
  updated_at   timestamptz not null default now(),
  updated_by   uuid references public.app_user(id),
  unique (tenant_id, name)
);
comment on table public.approval_process is 'Who approves which requests: entry criteria and steps. The active process with the lowest priority whose criteria all match applies.';
comment on column public.approval_process.criteria is
  'Entry criteria, all must match: [{field, op, values|value}]. op: in / not_in (values: codes or ids), gt / gte / lt / lte (value: a number), is_true / is_false (checkbox custom fields).';

create table public.approval_process_step (
  id                 uuid primary key default gen_random_uuid(),
  tenant_id          uuid not null references public.tenant(id),
  process_id         uuid not null references public.approval_process(id) on delete cascade,
  step_number        int  not null check (step_number between 1 and 20),
  name               text not null check (btrim(name) <> ''),
  approver_type      text not null check (approver_type in ('manager', 'group', 'user')),
  approver_user_id   uuid references public.app_user(id),
  approver_group_id  uuid references public.user_group(id),
  fallback_group_id  uuid references public.user_group(id),
  created_at         timestamptz not null default now(),
  created_by         uuid references public.app_user(id),
  updated_at         timestamptz not null default now(),
  updated_by         uuid references public.app_user(id),
  check (case approver_type
           when 'manager' then approver_user_id is null and approver_group_id is null
           when 'group'   then approver_group_id is not null and approver_user_id is null and fallback_group_id is null
           else                approver_user_id is not null and approver_group_id is null and fallback_group_id is null end)
);
comment on table public.approval_process_step is 'A step of a process. Same step_number: in parallel; a higher number waits for the lower ones.';
comment on column public.approval_process_step.fallback_group_id is 'Manager steps: the group that approves when the submitter has no manager (otherwise submitting is refused).';
create index approval_process_step_process_idx on public.approval_process_step (process_id, step_number);

select app.secure_table('approval_process');
select app.secure_table('approval_process_step');

-- Criteria name known fields with operators that suit them
create or replace function app.check_approval_process() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
declare c jsonb; v_field text; v_op text; v_kind text;
begin
  new.tenant_id := coalesce(new.tenant_id, app.current_tenant_id());   -- runs before stamp_row
  new.description := nullif(btrim(new.description), '');
  for c in select * from jsonb_array_elements(new.criteria) loop
    v_field := c ->> 'field'; v_op := c ->> 'op';
    if v_field like 'custom.%' then
      select case when f.field_type in ('picklist') then 'choice' when f.field_type in ('number', 'currency') then 'number'
                  when f.field_type = 'checkbox' then 'boolean' end
        into v_kind from public.custom_field f
       where f.tenant_id = new.tenant_id and f.object_name = 'event_request' and f.api_name = substr(v_field, 8) and f.is_active;
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
create trigger check_approval_process before insert or update on public.approval_process
  for each row execute function app.check_approval_process();

create or replace function app.check_approval_step() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  new.tenant_id := coalesce(new.tenant_id, app.current_tenant_id());   -- runs before stamp_row
  if not exists (select 1 from public.approval_process p where p.id = new.process_id and p.tenant_id = new.tenant_id) then
    raise exception 'Approval process not found' using errcode = 'P0002';
  end if;
  if new.approver_user_id is not null and not exists (select 1 from public.app_user u where u.id = new.approver_user_id
       and u.tenant_id = new.tenant_id and u.user_type = 'human' and u.status = 'active') then
    raise exception 'The approver is an active person in your organisation' using errcode = '23514';
  end if;
  if exists (select 1 from public.user_group g where g.id in (new.approver_group_id, new.fallback_group_id) and g.tenant_id <> new.tenant_id) then
    raise exception 'Group not found' using errcode = 'P0002';
  end if;
  return new;
end $$;
create trigger check_approval_step before insert or update on public.approval_process_step
  for each row execute function app.check_approval_step();

-- ---------------------------------------------------------------------
-- Running approvals: one per submission, a task per approver and step
-- ---------------------------------------------------------------------
create table public.approval (
  id            uuid primary key default gen_random_uuid(),
  tenant_id     uuid not null references public.tenant(id),
  process_id    uuid references public.approval_process(id) on delete set null,
  process_name  text not null,
  record_type   text not null check (record_type in ('request')),
  record_id     uuid not null,
  status        text not null default 'pending' check (status in ('pending', 'approved', 'rejected', 'cancelled')),
  current_step  int,
  submitted_by  uuid references public.app_user(id),
  submitted_at  timestamptz not null default now(),
  decided_at    timestamptz
);
comment on table public.approval is 'One run of an approval process for a record (a submission). process_name is kept as it was then.';
create index approval_record_idx on public.approval (record_type, record_id, submitted_at desc);

create table public.approval_task (
  id                 uuid primary key default gen_random_uuid(),
  tenant_id          uuid not null references public.tenant(id),
  approval_id        uuid not null references public.approval(id) on delete cascade,
  step_number        int  not null,
  step_name          text not null,
  approver_type      text not null check (approver_type in ('manager', 'group', 'user')),
  approver_id        uuid references public.app_user(id),
  approver_group_id  uuid references public.user_group(id) on delete set null,
  status             text not null default 'waiting' check (status in ('waiting', 'pending', 'approved', 'rejected', 'cancelled')),
  activated_at       timestamptz,
  decided_by         uuid references public.app_user(id),
  decided_at         timestamptz,
  decided_via        text references public.message_channel(code),
  comment            text
);
comment on table public.approval_task is 'Who approves a step of a running approval: a person (approver_id) or a group (any one member decides). waiting → pending when its step starts → approved | rejected | cancelled.';
create index approval_task_approval_idx on public.approval_task (approval_id, step_number);
create index approval_task_open_idx on public.approval_task (approver_id) where status = 'pending';

-- Readable by whoever sees the record; written only by the functions below
alter table public.approval enable row level security;
alter table public.approval_task enable row level security;
create policy approval_read on public.approval for select to authenticated
  using (tenant_id = app.current_tenant_id() and record_type = 'request' and app.can_view_request(record_id));
create policy approval_task_read on public.approval_task for select to authenticated
  using (tenant_id = app.current_tenant_id()
         and exists (select 1 from public.approval a where a.id = approval_id and a.record_type = 'request' and app.can_view_request(a.record_id)));
revoke all on public.approval, public.approval_task from anon;
grant select on public.approval, public.approval_task to authenticated;

-- ---------------------------------------------------------------------
-- Matching
-- ---------------------------------------------------------------------
-- Whether a record (as jsonb, custom fields under custom_fields) meets every criterion
create or replace function app.criteria_match(p_criteria jsonb, p_record jsonb) returns boolean
language plpgsql immutable as $$
declare c jsonb; v text; v_field text;
begin
  for c in select * from jsonb_array_elements(coalesce(p_criteria, '[]')) loop
    v_field := c ->> 'field';
    v := case when v_field like 'custom.%' then p_record -> 'custom_fields' ->> substr(v_field, 8) else p_record ->> v_field end;
    if not coalesce(case c ->> 'op'
         when 'in'       then v is not null and (c -> 'values') ? v
         when 'not_in'   then v is null or not (c -> 'values') ? v
         when 'gt'       then v::numeric >  (c ->> 'value')::numeric
         when 'gte'      then v::numeric >= (c ->> 'value')::numeric
         when 'lt'       then v::numeric <  (c ->> 'value')::numeric
         when 'lte'      then v::numeric <= (c ->> 'value')::numeric
         when 'is_true'  then v = 'true'
         when 'is_false' then coalesce(v, 'false') = 'false'
       end, false) then
      return false;
    end if;
  end loop;
  return true;
end $$;

create or replace function app.find_approval_process(p_record_type text, p_record_id uuid) returns public.approval_process
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare v_rec jsonb; v_tenant uuid; p public.approval_process;
begin
  select to_jsonb(q), q.tenant_id into v_rec, v_tenant from public.event_request q where q.id = p_record_id;
  for p in select * from public.approval_process x
            where x.tenant_id = v_tenant and x.record_type = p_record_type and x.is_active
              and exists (select 1 from public.approval_process_step s where s.process_id = x.id)
            order by x.priority, x.name loop
    if app.criteria_match(p.criteria, v_rec) then return p; end if;
  end loop;
  return null;
end $$;
comment on function app.find_approval_process(text, uuid) is 'The process that applies to a record: active, with steps, lowest priority first, every criterion matching.';

-- ---------------------------------------------------------------------
-- The engine
-- ---------------------------------------------------------------------
-- People who may decide a task: its person, or the group's active members; never the submitter
create or replace function app.task_approvers(p_task_id uuid) returns setof uuid
language sql stable security definer set search_path = public, pg_temp as $$
  select u.id
    from public.approval_task t
    join public.approval a on a.id = t.approval_id
    join public.app_user u on u.status = 'active' and u.user_type = 'human' and u.id is distinct from a.submitted_by
     and (u.id = t.approver_id
          or u.id in (select m.user_id from public.user_group_member m join public.user_group g on g.id = m.group_id and g.is_active
                       where m.group_id = t.approver_group_id))
   where t.id = p_task_id
$$;

-- Tell a task's approvers it's their turn: a notification and an approval email each
create or replace function app.announce_task(p_task_id uuid, p_at timestamptz) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
declare a public.approval; v_title text; v_submitter text; m uuid;
begin
  select x.* into a from public.approval x join public.approval_task t on t.approval_id = x.id where t.id = p_task_id;
  select title into v_title from public.event_request where id = a.record_id;
  select display_name into v_submitter from public.app_user where id = a.submitted_by;
  for m in select app.task_approvers(p_task_id) loop
    if not exists (select 1 from public.notification n where n.user_id = m and n.kind = 'approval_required'
                      and n.record_id = a.record_id and n.read_at is null) then
      insert into public.notification (tenant_id, user_id, kind, title, body, record_type, record_id, created_at)
      values (a.tenant_id, m, 'approval_required', v_title, 'submitted for your approval by ' || coalesce(v_submitter, 'a former user'),
              'request', a.record_id, p_at);
      perform app.queue_approval_email(a.record_id, m, p_at);
    end if;
  end loop;
end $$;

-- Start the next step that has tasks; with none left, the approval is approved
create or replace function app.advance_approval(p_approval_id uuid, p_at timestamptz) returns text
language plpgsql security definer set search_path = public, pg_temp as $$
declare v_next int; t uuid;
begin
  if exists (select 1 from public.approval_task where approval_id = p_approval_id and status = 'pending') then
    return 'pending';
  end if;
  select min(step_number) into v_next from public.approval_task where approval_id = p_approval_id and status = 'waiting';
  if v_next is null then
    update public.approval set status = 'approved', decided_at = p_at, current_step = null where id = p_approval_id;
    return 'approved';
  end if;
  update public.approval set current_step = v_next where id = p_approval_id;
  for t in update public.approval_task set status = 'pending', activated_at = p_at
            where approval_id = p_approval_id and step_number = v_next and status = 'waiting' returning id loop
    perform app.announce_task(t, p_at);
  end loop;
  return 'pending';
end $$;

-- Submit a record for approval: find its process, fix who approves each step, start the first step.
-- Refuses (and so refuses the submission) when no process applies or a step has nobody to approve it.
create or replace function app.start_approval(p_record_type text, p_record_id uuid, p_at timestamptz default now()) returns uuid
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  r public.event_request; p public.approval_process; s public.approval_process_step;
  v_approval uuid; v_manager public.app_user; v_group public.user_group; v_task uuid; v_type text; v_user uuid; v_grp uuid;
begin
  select * into r from public.event_request where id = p_record_id;
  p := app.find_approval_process(p_record_type, p_record_id);
  if p.id is null then
    raise exception 'No approval process applies to this request. Ask an admin to set one up in Admin → Approvals.' using errcode = '23514';
  end if;
  update public.approval set status = 'cancelled', decided_at = p_at, current_step = null
   where record_type = p_record_type and record_id = p_record_id and status = 'pending';
  insert into public.approval (tenant_id, process_id, process_name, record_type, record_id, submitted_by, submitted_at)
  values (r.tenant_id, p.id, p.name, p_record_type, p_record_id, r.requested_by, p_at) returning id into v_approval;

  for s in select * from public.approval_process_step where process_id = p.id order by step_number, name loop
    v_type := s.approver_type; v_user := null; v_grp := null;
    if s.approver_type = 'manager' then
      select m.* into v_manager from public.app_user u join public.app_user m on m.id = u.manager_id
       where u.id = r.requested_by and m.status = 'active' and m.user_type = 'human';
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
    values (r.tenant_id, v_approval, s.step_number, s.name, v_type, v_user, v_grp) returning id into v_task;
    if not exists (select app.task_approvers(v_task)) then
      select * into v_group from public.user_group where id = v_grp;
      raise exception '%', case
          when v_grp is not null then format('Nobody in %s can approve this request for the step “%s”: it needs an active member other than you.', coalesce(v_group.name, 'the group'), s.name)
          when v_user = r.requested_by then format('You''re the approver of the step “%s”, and nobody approves their own request. Ask an admin to change the process.', s.name)
          else format('The approver of the step “%s” is no longer active. Ask an admin to change the process.', s.name) end
        using errcode = '23514';
    end if;
  end loop;

  perform app.advance_approval(v_approval, p_at);
  return v_approval;
end $$;

-- Record a decision on a task (callers check who may decide) and carry it through:
-- a rejection rejects the approval; the last approval of a step starts the next; the end decides the record
create or replace function app.apply_task_decision(p_task_id uuid, p_user_id uuid, p_decision text, p_note text,
                                                   p_via text default 'app', p_at timestamptz default now()) returns text
language plpgsql security definer set search_path = public, pg_temp as $$
declare t public.approval_task; a public.approval; v_result text; r public.event_request; v_note text := nullif(btrim(p_note), '');
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
  end if;
  return v_result;
end $$;

-- ---------------------------------------------------------------------
-- Requests on the engine
-- ---------------------------------------------------------------------
-- The caller's open tasks on a request
create or replace function app.my_request_tasks(p_request_id uuid) returns setof uuid
language sql stable security definer set search_path = public, pg_temp as $$
  select t.id from public.approval a
    join public.approval_task t on t.approval_id = a.id and t.status = 'pending'
   where a.record_type = 'request' and a.record_id = p_request_id and a.status = 'pending'
     and a.tenant_id = app.current_tenant_id()
     and app.access_user_id() in (select app.task_approvers(t.id))
$$;

create or replace function app.can_decide_request(p_request_id uuid) returns boolean
language sql stable security definer set search_path = public, pg_temp as $$
  select exists (select app.my_request_tasks(p_request_id))
$$;
comment on function app.can_decide_request(uuid) is 'True when the caller has an open approval task on the request (never the requester).';

-- Approve or reject: decides the caller's open tasks on the request (as themselves, by app or email)
create or replace function public.decide_request(p_request_id uuid, p_decision text, p_note text default null) returns public.event_request
language plpgsql security definer set search_path = public, pg_temp as $$
declare r public.event_request; note text := nullif(btrim(p_note), ''); t uuid; v_done boolean := false;
  v_via text := case when coalesce(current_setting('app.channel', true), '') = 'email' then 'email' else 'app' end;
begin
  select * into r from public.event_request where id = p_request_id and tenant_id = app.current_tenant_id();
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
  if p_decision = 'rejected' and note is null then
    raise exception 'Add a reason so the requester knows why' using errcode = '23502';
  end if;
  for t in select app.my_request_tasks(r.id) loop
    -- One rejection ends the approval; later tasks of the caller's are then cancelled
    if exists (select 1 from public.approval_task where id = t and status = 'pending') then
      perform app.apply_task_decision(t, app.access_user_id(), p_decision, note, v_via);
      v_done := true;
    end if;
  end loop;
  if not v_done then
    raise exception 'You''re not an approver at this step of the request''s approval' using errcode = '42501';
  end if;
  select * into r from public.event_request where id = r.id;
  return r;
end $$;
comment on function public.decide_request(uuid, text, text) is
  'Approve or reject the caller''s open approval step on a request in review (p_decision approved|rejected; a rejection needs p_note). The request is decided when the process is.';
revoke all on function public.decide_request(uuid, text, text) from public, anon;
grant execute on function public.decide_request(uuid, text, text) to authenticated;

-- Submitting starts the approval (and is refused when it can't start)
create or replace function app.notify_request_submitted() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  perform app.start_approval('request', new.id);
  return null;
end $$;

-- A deleted request takes its approvals with it (record_id isn't a foreign key: it's per record type)
create or replace function app.delete_record_approvals() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  delete from public.approval where record_type = 'request' and record_id = old.id;
  return null;
end $$;
create trigger delete_request_approvals after delete on public.event_request
  for each row execute function app.delete_record_approvals();

-- Approvals waiting on the caller, newest first (Home)
create or replace function public.my_pending_approvals() returns table (
  approval_id uuid, record_type text, record_id uuid, title text, event_date date, step_name text,
  submitted_at timestamptz, submitter jsonb)
language sql stable security definer set search_path = public, pg_temp as $$
  select distinct on (a.id) a.id, a.record_type, a.record_id, q.title, q.event_date, t.step_name, a.submitted_at,
         jsonb_build_object('id', u.id, 'display_name', u.display_name, 'initials', u.initials, 'avatar_color', u.avatar_color)
    from public.approval a
    join public.approval_task t on t.approval_id = a.id and t.status = 'pending'
    join public.event_request q on q.id = a.record_id
    left join public.app_user u on u.id = a.submitted_by
   where a.tenant_id = app.current_tenant_id() and a.status = 'pending'
     and app.access_user_id() in (select app.task_approvers(t.id))
   order by a.id, t.step_number
$$;
comment on function public.my_pending_approvals() is 'Approvals with an open step the caller can decide.';
revoke all on function public.my_pending_approvals() from public, anon;
grant execute on function public.my_pending_approvals() to authenticated;

-- ---------------------------------------------------------------------
-- Approvers see the request and post on its board (role Approver)
-- ---------------------------------------------------------------------
create or replace function app.request_approver_ids(p_request_id uuid) returns setof uuid
language sql stable security definer set search_path = public, pg_temp as $$
  select t.approver_id from public.approval a join public.approval_task t on t.approval_id = a.id
   where a.record_type = 'request' and a.record_id = p_request_id and t.approver_id is not null and t.status <> 'cancelled'
  union
  select m.user_id from public.approval a join public.approval_task t on t.approval_id = a.id
    join public.user_group g on g.id = t.approver_group_id and g.is_active
    join public.user_group_member m on m.group_id = g.id
   where a.record_type = 'request' and a.record_id = p_request_id and t.status <> 'cancelled'
$$;
comment on function app.request_approver_ids(uuid) is 'Everyone who approves, approved or is still to approve a request (people and members of approving groups).';

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
  select x from app.request_approver_ids(p_record_id) x where p_kind = 'request'
$$;
comment on function app.team_user_ids(text, uuid) is 'Everyone on an event''s or request''s team (p_kind event|request): direct members, members of its active groups, and a request''s approvers.';

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
  select 'approver' where p_kind = 'request' and app.access_user_id() in (select app.request_approver_ids(p_record_id))
$$;

-- team_role: your own role, else a group's, else Approver when the approval names you
create or replace function public.my_request_access(p_request_id uuid) returns jsonb
language sql stable security definer set search_path = public, pg_temp as $$
  with own as (select m.team_role from public.request_team_member m where m.request_id = p_request_id and m.user_id = app.access_user_id()),
  grp as (select t.team_role, g.name from public.request_team_group t
            join public.user_group g on g.id = t.group_id and g.is_active
            join public.user_group_member gm on gm.group_id = t.group_id and gm.user_id = app.access_user_id()
            join public.team_role r on r.code = t.team_role
           where t.request_id = p_request_id order by r.sort, g.name limit 1)
  select jsonb_build_object('access', app.request_access(p_request_id),
    'team_role', coalesce((select team_role from own), (select team_role from grp),
                          case when app.access_user_id() in (select app.request_approver_ids(p_request_id)) then 'approver' end),
    'via_group', case when not exists (select 1 from own) then (select name from grp) end,
    'can_decide', app.can_decide_request(p_request_id))
$$;

-- ---------------------------------------------------------------------
-- Permissions (seeds add the same for a fresh database)
-- ---------------------------------------------------------------------
delete from public.permission where object_name in ('approval', 'approval_action');
-- Everyone who works on events reads processes; admin-area profiles that manage users manage them
insert into public.permission (tenant_id, profile_id, object_name, can_read)
select p.tenant_id, p.id, o, true
  from public.profile p
 cross join unnest(array['approval_process', 'approval_process_step']) o
 where exists (select 1 from public.permission x where x.profile_id = p.id and x.object_name = 'event' and x.can_read)
on conflict (profile_id, object_name) do update set can_read = true;
update public.permission x set can_read = true, can_create = true, can_edit = true, can_delete = true
  from public.profile p
 where p.id = x.profile_id and p.can_access_admin
   and x.object_name in ('approval_process', 'approval_process_step')
   and exists (select 1 from public.permission u where u.profile_id = p.id and u.object_name = 'app_user' and u.can_edit);

grant execute on all functions in schema app to authenticated, service_role;

update public.team_role set description = 'Can view and post. Named by the request''s approval process.' where code = 'approver';
