-- =====================================================================
-- Event Center — Working by email
-- * Being mentioned on a board, or asked to approve a request, also queues an email
--   (email_message, direction outbound). Each email carries a reply address with its own token.
-- * Replies come back through receive_email(p), called by the email service's agent (the Email
--   Agent): a reply to a mention is posted as a reply in the discussion, a reply to an approval
--   request that starts with Approve or Reject decides the request. Both happen as the person
--   who replied (the agent acts on their behalf, so the audit shows both), and are marked as
--   made by email: posts and decisions carry a channel (message_channel: app | email).
-- * Nothing sends or receives mail yet: outbound emails stay queued until a provider is connected.
-- * Everyone reads their own emails; Admins and Business Admins read them all (Admin → Emails).
--   Only these functions write them.
-- =====================================================================

-- ---------------------------------------------------------------------
-- Lookups
-- ---------------------------------------------------------------------
create table public.message_channel (code text primary key, label text not null, sort int not null);
insert into public.message_channel (code, label, sort) values
  ('app',   'Event Center', 10),
  ('email', 'Email',        20);

create table public.email_kind (code text primary key, label text not null, sort int not null);
insert into public.email_kind (code, label, sort) values
  ('mention',  'Mention',          10),
  ('approval', 'Approval request', 20),
  ('reply',    'Reply',            30);

create table public.email_status (code text primary key, label text not null, tone text not null, sort int not null);
insert into public.email_status (code, label, tone, sort) values
  ('queued',    'Queued',              'grey',   10),
  ('sent',      'Sent',                'blue',   20),
  ('received',  'Received',            'yellow', 30),
  ('processed', 'Done',                'green',  40),
  ('failed',    'Couldn''t process',   'red',    50);

do $$
declare t text;
begin
  foreach t in array array['message_channel', 'email_kind', 'email_status'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('create policy %I on public.%I for select to authenticated using (true)', t || '_read', t);
    execute format('revoke all on public.%I from anon', t);
    execute format('grant select on public.%I to authenticated', t);
  end loop;
end $$;

-- ---------------------------------------------------------------------
-- Where posts and decisions came from
-- ---------------------------------------------------------------------
alter table public.event_post   add column channel text not null default 'app' references public.message_channel(code);
alter table public.request_post add column channel text not null default 'app' references public.message_channel(code);
alter table public.event_request add column decided_via text references public.message_channel(code);
comment on column public.event_post.channel is 'Where the post was written: app, or email (a reply to an Event Center email).';
comment on column public.request_post.channel is 'Where the post was written: app, or email (a reply to an Event Center email).';
comment on column public.event_request.decided_via is 'Where the decision was made: app, or email (a reply to the approval request).';

-- The author is whoever posts (an agent posts as itself), except a reply by email: the person
-- who replied. Only receive_email() marks a post as written by email.
create or replace function app.stamp_post() returns trigger
language plpgsql as $$
begin
  if app.current_user_id() is null then return new; end if;   -- seeds and migrations
  if tg_op = 'INSERT' then
    if coalesce(current_setting('app.channel', true), '') = 'email' then
      new.author_id := app.access_user_id();
      new.channel := 'email';
    else
      new.author_id := app.current_user_id();
      new.channel := 'app';
    end if;
  elsif (new.author_id, new.channel) is distinct from (old.author_id, old.channel) then
    raise exception 'A post''s author and channel can''t be changed' using errcode = '23514';
  end if;
  return new;
end $$;
create trigger event_post_stamp before insert or update on public.event_post for each row execute function app.stamp_post();
create trigger request_post_stamp before insert or update on public.request_post for each row execute function app.stamp_post();

-- decided_via is written only with the decision
create or replace function app.check_decided_via() returns trigger
language plpgsql as $$
begin
  if app.current_user_id() is null then return new; end if;
  if tg_op = 'INSERT' then new.decided_via := null; return new; end if;
  if new.decided_via is distinct from old.decided_via and coalesce(current_setting('app.request_decision', true), '') <> 'on' then
    raise exception 'A decision is recorded by approving or rejecting the request' using errcode = '23514';
  end if;
  return new;
end $$;
create trigger event_request_decided_via before insert or update on public.event_request
  for each row execute function app.check_decided_via();

-- ---------------------------------------------------------------------
-- The email log
-- ---------------------------------------------------------------------
create table public.email_message (
  id             uuid primary key default gen_random_uuid(),
  tenant_id      uuid not null references public.tenant(id),
  direction      text not null check (direction in ('outbound', 'inbound')),
  kind           text not null references public.email_kind(code),
  status         text not null references public.email_status(code),
  user_id        uuid references public.app_user(id) on delete set null,
  from_address   text not null,
  to_address     text not null,
  reply_to       text,
  subject        text not null,
  body           text not null,
  record_type    text check (record_type in ('event', 'request')),
  record_id      uuid,
  post_id        uuid,
  reply_token    text unique,
  in_reply_to    uuid references public.email_message(id) on delete set null,
  status_note    text,
  created_at     timestamptz not null default now(),
  sent_at        timestamptz,
  processed_at   timestamptz,
  check ((direction = 'outbound') = (reply_token is not null))
);
create index email_message_user_idx on public.email_message (user_id, created_at desc);
create index email_message_record_idx on public.email_message (record_type, record_id);
comment on table public.email_message is 'Emails Event Center sends (outbound: mentions, approval requests) and replies it receives (inbound).';
comment on column public.email_message.user_id is 'Outbound: the recipient. Inbound: the person who replied (when known).';
comment on column public.email_message.post_id is 'Mention: the post that mentions the recipient. Reply: the post it became.';
comment on column public.email_message.reply_token is 'Outbound: the token in the reply address, reply+<token>@…, that ties a reply to this email.';
comment on column public.email_message.status_note is 'What happened: why sending or processing failed, or what a reply did.';

alter table public.email_message enable row level security;
create policy email_message_read on public.email_message for select to authenticated
  using (tenant_id = app.current_tenant_id()
         and (user_id = app.current_user_id() or app.is_admin() or app.perm_flag('email_message', 'view_all')));
-- Test and demo cleanup only; emails are written by the functions below
create policy email_message_delete on public.email_message for delete to authenticated
  using (tenant_id = app.current_tenant_id() and app.is_admin());
revoke all on public.email_message from anon;
grant select, delete on public.email_message to authenticated;

-- Business Admins read every email (System Admins do as admins)
insert into public.permission (tenant_id, profile_id, object_name, can_read, can_create, can_edit, can_delete, view_all, modify_all)
select p.tenant_id, p.id, 'email_message', true, false, false, false, true, false
  from public.profile p
 where p.can_access_admin and not p.is_admin
on conflict do nothing;

-- Addresses and links. One place to change when a real domain and the app's URL are set up.
create or replace function app.email_domain() returns text language sql immutable as $$ select 'eventcenter.example' $$;
create or replace function app.app_link(p_record_type text, p_record_id uuid) returns text language sql immutable as $$
  select 'https://' || app.email_domain() || case p_record_type when 'event' then '/events/' || p_record_id || '?tab=team'
                                                                else '/requests/' || p_record_id end
$$;
-- Marks where a reply ends: everything from this line down is our own email
create or replace function app.email_reply_line() returns text language sql immutable as $$ select '—— Reply above this line ——' $$;

-- Queues an email to a person (not agents, not people without an address). Returns its id.
create or replace function app.queue_email(p_user_id uuid, p_kind text, p_subject text, p_body text,
                                           p_record_type text, p_record_id uuid, p_post_id uuid default null,
                                           p_at timestamptz default now()) returns uuid
language plpgsql security definer set search_path = public, pg_temp as $$
declare u public.app_user; v_token text := substr(md5(gen_random_uuid()::text), 1, 20); v_id uuid;
begin
  select * into u from public.app_user where id = p_user_id;
  if u.id is null or u.user_type <> 'human' or coalesce(u.email, '') = '' or u.status <> 'active' then return null; end if;
  insert into public.email_message (tenant_id, direction, kind, status, user_id, from_address, to_address, reply_to,
                                    subject, body, record_type, record_id, post_id, reply_token, created_at)
  values (u.tenant_id, 'outbound', p_kind, 'queued', u.id, 'Event Center <notifications@' || app.email_domain() || '>',
          u.email, 'reply+' || v_token || '@reply.' || app.email_domain(),
          p_subject, p_body, p_record_type, p_record_id, p_post_id, v_token, p_at)
  returning id into v_id;
  return v_id;
end $$;

-- "> " before every line, for quoting
create or replace function app.email_quote(p text) returns text language sql immutable as $$
  select string_agg('> ' || l, E'\n' order by n) from unnest(regexp_split_to_array(btrim(coalesce(p, '')), E'\r?\n')) with ordinality as x(l, n)
$$;

-- ---------------------------------------------------------------------
-- Mentions: a notification and an email with the post's text
-- ---------------------------------------------------------------------
create or replace function app.notify_post_mentions() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_event boolean := tg_table_name = 'event_post';
  v_record uuid := (to_jsonb(new) ->> case when v_event then 'event_id' else 'request_id' end)::uuid;
  v_name text;
  v_author text;
  v_snippet text := regexp_replace(btrim(new.body), '\s+', ' ', 'g');
  m uuid;
begin
  if new.mentions = '{}' then return null; end if;
  if v_event then select e.name into v_name from public.event e where e.id = v_record;
  else select q.title into v_name from public.event_request q where q.id = v_record; end if;
  select u.display_name into v_author from public.app_user u where u.id = new.author_id;
  v_author := coalesce(v_author, 'Someone');
  if length(v_snippet) > 90 then v_snippet := left(v_snippet, 89) || '…'; end if;

  for m in select x from unnest(new.mentions) x
            where x <> new.author_id and (tg_op = 'INSERT' or not x = any(old.mentions)) loop
    insert into public.notification (tenant_id, user_id, kind, title, body, record_type, record_id, created_at)
    select u.tenant_id, u.id, 'mention', v_author, format('mentioned you in the %s discussion: “%s”', v_name, v_snippet),
           case when v_event then 'event' else 'request' end, v_record, new.created_at
      from public.app_user u where u.id = m;
    perform app.queue_email(m, 'mention', format('%s mentioned you on %s', v_author, v_name),
      concat_ws(E'\n',
        app.email_reply_line(), '',
        format('%s mentioned you in the %s discussion:', v_author, v_name), '',
        app.email_quote(new.body), '',
        'Reply to this email to answer in the discussion. Your reply is posted as you.',
        'Open the discussion: ' || app.app_link(case when v_event then 'event' else 'request' end, v_record)),
      case when v_event then 'event' else 'request' end, v_record, new.id, new.created_at);
  end loop;
  return null;
end $$;

-- ---------------------------------------------------------------------
-- Approval requests: an email with the request's details, to reply Approve or Reject
-- ---------------------------------------------------------------------
create or replace function app.queue_approval_email(p_request_id uuid, p_user_id uuid, p_at timestamptz default now()) returns uuid
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  r public.event_request;
  v_requester text; v_type text; v_event_type text; v_duration text; v_country text; v_ta text; v_expert text; v_related text;
begin
  select * into r from public.event_request where id = p_request_id;
  if r.id is null then return null; end if;
  select display_name into v_requester from public.app_user where id = r.requested_by;
  select label into v_type from public.request_type where code = r.request_type;
  select name into v_event_type from public.event_type where id = r.event_type_id;
  select label into v_duration from public.request_duration where code = r.duration;
  select name into v_country from public.country where code = r.country_code;
  select name into v_ta from public.therapeutic_area where id = r.therapeutic_area_id;
  select display_name into v_expert from public.hcp where id = r.hcp_id;
  select name into v_related from public.event where id = r.related_event_id;
  return app.queue_email(p_user_id, 'approval',
    format('Approval needed: %s (%s)', r.title, r.request_number),
    concat_ws(E'\n',
      app.email_reply_line(),
      'Reply with Approve or Reject on the first line. Anything after it is kept as your comment; a rejection needs one.', '',
      format('%s submitted a request for your approval.', coalesce(v_requester, 'Someone')), '',
      format('%s (%s)', r.title, r.request_number),
      'Type: ' || concat_ws(' · ', v_type, v_event_type),
      'Expert: ' || v_expert,
      'For: ' || v_related,
      'Date: ' || nullif(concat_ws(' · ', trim(to_char(r.event_date, 'Dy FMDD Mon YYYY')), v_duration), ''),
      'Where: ' || nullif(concat_ws(', ', r.city, v_country), ''),
      'Expected attendees: ' || r.expected_attendees,
      'Estimated spend: ' || concat_ws(' ', r.currency, trim(to_char(r.estimated_spend, 'FM999G999G990')))
        || case when r.estimated_spend is null then null else '' end,
      'Therapeutic area: ' || v_ta,
      case when coalesce(btrim(r.rationale), '') <> '' then E'\nBusiness justification:\n' || app.email_quote(r.rationale) end,
      '',
      'Open the request: ' || app.app_link('request', r.id)),
    'request', r.id, null, p_at);
end $$;

-- Submitting tells the request's approvers, in the app and by email
create or replace function app.notify_request_submitted() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
declare m uuid;
begin
  for m in select t.user_id from public.request_team_member t
            where t.request_id = new.id and t.team_role = 'approver' and t.user_id <> new.requested_by loop
    perform app.notify(m, 'approval_required', new.title,
                       'submitted for your approval by ' || coalesce((select display_name from public.app_user where id = new.requested_by), 'a former user'),
                       'request', new.id);
    perform app.queue_approval_email(new.id, m);
  end loop;
  return null;
end $$;

-- Someone made an approver of a request already in review is asked too
create or replace function app.notify_approver_added() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
declare r public.event_request;
begin
  if app.current_user_id() is null then return null; end if;   -- seeds queue their own
  if new.team_role <> 'approver' or (tg_op = 'UPDATE' and old.team_role = 'approver') then return null; end if;
  select * into r from public.event_request where id = new.request_id;
  if r.status <> 'review' or r.requested_by = new.user_id then return null; end if;
  perform app.notify(new.user_id, 'approval_required', r.title,
                     'submitted for your approval by ' || coalesce((select display_name from public.app_user where id = r.requested_by), 'a former user'),
                     'request', r.id);
  perform app.queue_approval_email(r.id, new.user_id);
  return null;
end $$;
create trigger notify_approver_added after insert or update of team_role on public.request_team_member
  for each row execute function app.notify_approver_added();

-- decide_request records where the decision was made
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
     set status = p_decision, decided_by = app.access_user_id(), decided_at = now(), decision_note = note,
         decided_via = case when coalesce(current_setting('app.channel', true), '') = 'email' then 'email' else 'app' end
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

-- ---------------------------------------------------------------------
-- Replies
-- ---------------------------------------------------------------------
-- The new part of a reply: everything above our reply line, the client's "On … wrote:" or quoted text
create or replace function app.email_reply_text(p_text text) returns text
language plpgsql immutable as $$
declare l text; out text[] := '{}';
begin
  foreach l in array regexp_split_to_array(coalesce(p_text, ''), E'\r?\n') loop
    exit when l ~* '^\s*[—–-]{2,}.*reply above this line'
           or l ~* '^\s*on .+wrote:\s*$'
           or l ~ '^\s*>'
           or l ~* '^\s*(from|sent|von|de|fra|från):\s'
           or l ~* '^\s*-{2,}\s*original message'
           or l ~* '^\s*sent from my '
           or l = '-- ';
    out := out || l;
  end loop;
  return nullif(btrim(array_to_string(out, E'\n'), E' \t\r\n'), '');
end $$;

/**
 * A reply to an Event Center email, from the email service. p: {from, to, subject?, text}.
 * Finds the email it answers from the token in the reply address, checks it comes from that
 * email's recipient, and acts as them: a mention reply is posted in the discussion, an approval
 * reply (Approve / Reject on the first line, then an optional comment) decides the request.
 * Every reply is logged; one that can't be used is marked failed with the reason.
 * Callable by the Email Agent only (agents with create on email_message).
 */
create or replace function public.receive_email(p jsonb) returns public.email_message
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_caller public.app_user;
  v_in public.email_message;
  v_out public.email_message;
  v_from text := lower(coalesce(substring(p->>'from' from '<([^>]+)>'), btrim(p->>'from')));
  v_token text := lower(substring(p->>'to' from '(?i)reply\+([a-z0-9]+)@'));
  v_text text := app.email_reply_text(p->>'text');
  v_user public.app_user;
  v_headers text := current_setting('request.headers', true);
  v_post uuid; v_root uuid; v_name text; v_mentions uuid[];
  v_m text[]; v_decision text; v_note text; r public.event_request;
begin
  select * into v_caller from public.app_user where id = app.current_user_id();
  if v_caller.user_type is distinct from 'agent' or not app.has_perm('email_message', 'create') then
    raise exception 'Only the email service delivers replies' using errcode = '42501';
  end if;
  if coalesce(p->>'from', '') = '' or coalesce(p->>'to', '') = '' then
    raise exception 'A reply needs from and to addresses' using errcode = '22023';
  end if;

  select * into v_out from public.email_message
   where reply_token = v_token and direction = 'outbound' and tenant_id = v_caller.tenant_id;
  select * into v_user from public.app_user
   where tenant_id = v_caller.tenant_id and user_type = 'human' and lower(email) = v_from;

  insert into public.email_message (tenant_id, direction, kind, status, user_id, from_address, to_address, subject, body,
                                    record_type, record_id, in_reply_to)
  values (v_caller.tenant_id, 'inbound', 'reply', 'received', v_user.id, p->>'from', p->>'to',
          coalesce(nullif(p->>'subject', ''), '(no subject)'), coalesce(p->>'text', ''),
          v_out.record_type, v_out.record_id, v_out.id)
  returning * into v_in;

  begin
    if v_out.id is null then
      raise exception 'This isn''t a reply to an Event Center email';
    end if;
    if v_user.id is null or v_user.id <> v_out.user_id then
      raise exception 'Sent from %, not the address this email went to', v_from;
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
        select coalesce(array_agg(t.user_id), '{}') into v_mentions from public.event_team_member t join public.app_user u on u.id = t.user_id
         where t.event_id = v_out.record_id and position(lower('@' || u.display_name) in lower(v_text)) > 0;
        insert into public.event_post (tenant_id, event_id, parent_id, body, mentions)
        values (v_caller.tenant_id, v_out.record_id, v_root, v_text, v_mentions) returning id into v_post;
        select name into v_name from public.event where id = v_out.record_id;
      else
        if not app.can_view_request(v_out.record_id) then raise exception 'You''re no longer on this request''s team'; end if;
        select coalesce(parent_id, id) into v_root from public.request_post where id = v_out.post_id;
        if v_root is null then raise exception 'The post you were mentioned in was deleted'; end if;
        select coalesce(array_agg(t.user_id), '{}') into v_mentions from public.request_team_member t join public.app_user u on u.id = t.user_id
         where t.request_id = v_out.record_id and position(lower('@' || u.display_name) in lower(v_text)) > 0;
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
      r := public.decide_request(v_out.record_id, v_decision, v_note);
      update public.email_message set status = 'processed', processed_at = now(),
             status_note = format('%s %s', case v_decision when 'approved' then 'Approved' else 'Rejected' end, r.title)
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
comment on function public.receive_email(jsonb) is
  'A reply to an Event Center email (p: {from, to, subject, text}), from the email service''s agent. Posts it in the discussion or approves/rejects the request as the person who replied; returns the logged email with what happened.';
revoke all on function public.receive_email(jsonb) from public, anon;
grant execute on function public.receive_email(jsonb) to authenticated;

grant execute on all functions in schema app to authenticated, service_role;
