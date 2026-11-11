-- =====================================================================
-- Event Center — Sending and receiving email (Resend)
-- * Queued emails are sent by the email-send edge function, which signs in as the Email Agent:
--   claim_outbound_emails() hands it what's queued, email_sent() records what happened.
--   A new queued email wakes it through pg_net when app.setting 'email_send_url' is set
--   (set on hosted by the deploy workflows; unset locally, so emails stay queued there).
-- * Replies arrive through the email-inbound edge function (Resend's email.received webhook),
--   which passes them to receive_email() as before. Each reply is taken once (provider_id).
-- * Demo inbox (tenant.demo_inbox): when set, every email goes to that one address, named for
--   the person it's for, and a reply from that address counts as theirs. For demos only:
--   demo users have made-up addresses.
-- * Links in emails point at app.setting 'app_url' and open the post they're about.
-- =====================================================================

-- ---------------------------------------------------------------------
-- Deployment settings (not tenant data): read by functions only
-- ---------------------------------------------------------------------
create table app.setting (key text primary key, value text, note text);
revoke all on app.setting from public, anon, authenticated;
insert into app.setting (key, value, note) values
  ('app_url',        'http://localhost:5173', 'Where links in emails open Event Center'),
  ('email_send_url', null,                    'The email-send function; when set, new emails wake it');

create or replace function app.setting(p_key text) returns text
language sql stable security definer set search_path = app, pg_temp as $$
  select value from app.setting where key = p_key
$$;

-- Links open the record, at the post when there is one
drop function app.app_link(text, uuid);
create function app.app_link(p_record_type text, p_record_id uuid, p_post_id uuid default null) returns text
language sql stable as $$
  select rtrim(coalesce(app.setting('app_url'), 'http://localhost:5173'), '/')
      || case p_record_type when 'event' then '/events/' || p_record_id || '?tab=team' || coalesce('&post=' || p_post_id, '')
                            else '/requests/' || p_record_id || coalesce('?post=' || p_post_id, '') end
$$;

-- ---------------------------------------------------------------------
-- Delivery details
-- ---------------------------------------------------------------------
insert into public.email_status (code, label, tone, sort) values ('sending', 'Sending', 'grey', 15);

alter table public.email_message
  add column delivered_to text,
  add column provider_id  text,
  add column claimed_at   timestamptz;
comment on column public.email_message.delivered_to is 'Outbound: the address it actually went to (the demo inbox, when one is set).';
comment on column public.email_message.provider_id is 'The email service''s id: of the email sent, or of the reply received (each reply is taken once).';
comment on column public.email_message.claimed_at is 'Outbound: when the sender picked it up.';
create unique index email_message_provider_idx on public.email_message (tenant_id, direction, provider_id) where provider_id is not null;

-- ---------------------------------------------------------------------
-- Demo inbox
-- ---------------------------------------------------------------------
alter table public.tenant add column demo_inbox text
  check (demo_inbox is null or demo_inbox ~* '^[^@\s<>]+@[^@\s<>]+\.[^@\s<>]+$');
comment on column public.tenant.demo_inbox is 'Demo only: every email goes to this address, and replies from it count as the person the email was for.';
grant update (show_profile_badge, demo_inbox) on public.tenant to authenticated;

-- ---------------------------------------------------------------------
-- Sending
-- ---------------------------------------------------------------------
create extension if not exists pg_net;

-- New queued emails wake the sender (when there is one)
create or replace function app.wake_email_sender() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
declare v_url text := app.setting('email_send_url');
begin
  if v_url is null or not exists (select 1 from new_rows where direction = 'outbound' and status = 'queued') then return null; end if;
  perform net.http_post(url := v_url, body := '{}'::jsonb, headers := '{"Content-Type": "application/json"}'::jsonb,
                        timeout_milliseconds := 10000);
  return null;
end $$;
create trigger email_message_wake after insert on public.email_message
  referencing new table as new_rows for each statement execute function app.wake_email_sender();

-- The Email Agent (agents with create on email_message), or an error
create or replace function app.email_agent() returns public.app_user
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare v public.app_user;
begin
  select * into v from public.app_user where id = app.current_user_id();
  if v.user_type is distinct from 'agent' or not app.has_perm('email_message', 'create') then
    raise exception 'Only the email service sends and receives emails' using errcode = '42501';
  end if;
  return v;
end $$;

/**
 * Queued emails for the email service to send (oldest first, at most p_limit), marked Sending.
 * Each: {id, to, subject, text, reply_token}. With a demo inbox, every email goes there and the
 * subject names who it's for. Emails left Sending for 10 minutes are handed out again.
 */
create or replace function public.claim_outbound_emails(p_limit int default 10) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare v_agent public.app_user := app.email_agent(); v_inbox text; v_rows jsonb;
begin
  select demo_inbox into v_inbox from public.tenant where id = v_agent.tenant_id;
  with picked as (
    select id from public.email_message
     where tenant_id = v_agent.tenant_id and direction = 'outbound'
       and (status = 'queued' or (status = 'sending' and claimed_at < now() - interval '10 minutes'))
     order by created_at
     limit least(greatest(coalesce(p_limit, 10), 1), 50)
     for update skip locked),
  upd as (
    update public.email_message e set status = 'sending', claimed_at = now()
      from picked where e.id = picked.id
    returning e.*)
  select coalesce(jsonb_agg(jsonb_build_object(
           'id', u.id,
           'to', coalesce(v_inbox, u.to_address),
           'subject', case when v_inbox is null then u.subject
                           else '[For ' || coalesce(p.display_name, u.to_address) || '] ' || u.subject end,
           'text', u.body,
           'reply_token', u.reply_token) order by u.created_at), '[]'::jsonb)
    into v_rows
    from upd u left join public.app_user p on p.id = u.user_id;
  return v_rows;
end $$;
comment on function public.claim_outbound_emails(int) is
  'For the email service: queued emails to send, marked Sending. Email Agent only.';

/**
 * What happened to an email the service tried to send. p: {id, ok, provider_id?, from?, reply_to?, to?, error?}.
 */
create or replace function public.email_sent(p jsonb) returns public.email_message
language plpgsql security definer set search_path = public, pg_temp as $$
declare v_agent public.app_user := app.email_agent(); v public.email_message;
begin
  update public.email_message
     set status       = case when (p->>'ok')::boolean then 'sent' else 'failed' end,
         sent_at      = case when (p->>'ok')::boolean then now() end,
         provider_id  = nullif(p->>'provider_id', ''),
         delivered_to = case when (p->>'ok')::boolean then coalesce(nullif(p->>'to', ''), to_address) end,
         from_address = coalesce(nullif(p->>'from', ''), from_address),
         reply_to     = coalesce(nullif(p->>'reply_to', ''), reply_to),
         status_note  = case when (p->>'ok')::boolean then null else coalesce(nullif(p->>'error', ''), 'The email service didn''t take it') end
   where id = (p->>'id')::uuid and tenant_id = v_agent.tenant_id and direction = 'outbound' and status = 'sending'
  returning * into v;
  if v.id is null then raise exception 'No email waiting to be sent with that id' using errcode = 'P0002'; end if;
  return v;
end $$;
comment on function public.email_sent(jsonb) is 'For the email service: records whether an email went out. Email Agent only.';

revoke all on function public.claim_outbound_emails(int), public.email_sent(jsonb) from public, anon;
grant execute on function public.claim_outbound_emails(int), public.email_sent(jsonb) to authenticated;

-- ---------------------------------------------------------------------
-- Mentions link to the post
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
        'Open the discussion: ' || app.app_link(case when v_event then 'event' else 'request' end, v_record, new.id)),
      case when v_event then 'event' else 'request' end, v_record, new.id, new.created_at);
  end loop;
  return null;
end $$;

-- ---------------------------------------------------------------------
-- Replies
-- ---------------------------------------------------------------------
-- The new part of a reply. Also stops at an "On … wrote:" that the mail client wrapped over two lines.
create or replace function app.email_reply_text(p_text text) returns text
language plpgsql immutable as $$
declare
  lines text[] := regexp_split_to_array(coalesce(p_text, ''), E'\r?\n');
  n int := coalesce(array_length(lines, 1), 0);
  l text; out text[] := '{}';
begin
  for i in 1 .. n loop
    l := lines[i];
    exit when l ~* '^\s*[—–-]{2,}.*reply above this line'
           or l ~* '^\s*on .+wrote:\s*$'
           or (l ~* '^\s*on \S.*\d' and i < n and lines[i + 1] ~* 'wrote:\s*$')
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
 * A reply to an Event Center email, from the email service. p: {from, to, subject?, text, id?, authentication?}.
 * Finds the email it answers from the token in the reply address (reply+<token>@ or reply-<token>@),
 * checks it comes from that email's recipient (or the demo inbox), and acts as them: a mention reply
 * is posted in the discussion, an approval reply (Approve / Reject on the first line, then an optional
 * comment) decides the request. id is the service's id for the reply: one already taken is returned
 * as it was. authentication ({spf, dkim}) is the receiving server's check; when given, one must pass.
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
  v_token text := lower(substring(p->>'to' from '(?i)reply[+-]([a-z0-9]+)@'));
  v_text text := app.email_reply_text(p->>'text');
  v_provider text := nullif(p->>'id', '');
  v_inbox text;
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

grant execute on all functions in schema app to authenticated, service_role;
revoke all on function app.setting(text) from public, anon, authenticated;
