-- =====================================================================
-- Event Center — Email settings
-- * Organisation settings (Admin → Settings, System Admins):
--     email_mentions  email people when they're mentioned on a board (off: in-app notification only)
--     email_replies   people may reply to Event Center emails: a mention reply is posted in the
--                     thread, an approval reply decides. Off: emails carry no reply address or reply
--                     line, and a reply that still arrives is refused.
-- * Per approval process (Admin → Approvals), copied onto each approval when it's submitted so a
--   running approval keeps the settings it started with:
--     email_approvers   email each step's approvers when their step starts
--     approve_by_email  approvers may decide by replying (needs email_replies); off: in Event Center only
--     email_submitter   email the outcome (approved or rejected, with the reason) to the requester,
--                       or to the event's owner and whoever submitted it
-- * In-app notifications don't change: they always go out.
-- =====================================================================

-- ---------------------------------------------------------------------
-- Settings
-- ---------------------------------------------------------------------
alter table public.tenant
  add column email_mentions boolean not null default true,
  add column email_replies  boolean not null default true;
comment on column public.tenant.email_mentions is 'Email people when they''re mentioned on a board (otherwise in-app notification only).';
comment on column public.tenant.email_replies is 'People may reply to Event Center emails (mention replies, approval decisions). Off: no reply address, and replies are refused.';
grant update (show_profile_badge, demo_inbox, email_mentions, email_replies) on public.tenant to authenticated;

alter table public.approval_process
  add column email_approvers  boolean not null default true,
  add column approve_by_email boolean not null default true,
  add column email_submitter  boolean not null default true;
comment on column public.approval_process.email_approvers is 'Email each step''s approvers when their step starts.';
comment on column public.approval_process.approve_by_email is 'Approvers may approve or reject by replying to the email (when the organisation allows replies).';
comment on column public.approval_process.email_submitter is 'Email the outcome to the requester, or to the event''s owner and submitter.';

alter table public.approval
  add column email_approvers  boolean not null default true,
  add column approve_by_email boolean not null default true,
  add column email_submitter  boolean not null default true;
comment on column public.approval.approve_by_email is 'As the process said when this approval was submitted.';

insert into public.email_kind (code, label, sort) values ('outcome', 'Approval outcome', 25);
-- Outgoing emails may have no reply token now (replies off, outcome emails); incoming ones never do
alter table public.email_message drop constraint email_message_check;
alter table public.email_message add constraint email_message_reply_token_check check (direction = 'outbound' or reply_token is null);

-- me().tenant carries the email settings for the UI
create or replace function public.me() returns jsonb
language sql stable as $$
  select jsonb_build_object(
    'id', u.id,
    'user_type', u.user_type,
    'display_name', u.display_name,
    'first_name', u.first_name,
    'last_name', u.last_name,
    'email', u.email,
    'job_title', u.job_title,
    'initials', u.initials,
    'avatar_color', u.avatar_color,
    'country_code', u.country_code,
    'event_countries', coalesce((select jsonb_agg(c.country_code order by c.country_code)
                                   from public.app_user_country c where c.user_id = u.id), '[]'::jsonb),
    'profile', jsonb_build_object('id', p.id, 'name', p.name, 'is_admin', p.is_admin, 'can_access_admin', p.can_access_admin),
    'tenant', jsonb_build_object('id', t.id, 'name', t.name, 'brand_name', t.brand_name, 'brand_color', t.brand_color,
                              'show_profile_badge', t.show_profile_badge,
                              'email_mentions', t.email_mentions, 'email_replies', t.email_replies),
    'permissions', coalesce((select jsonb_object_agg(pm.object_name, jsonb_build_object(
                      'read', pm.can_read or pm.view_all, 'create', pm.can_create,
                      'edit', pm.can_edit or pm.modify_all, 'delete', pm.can_delete or pm.modify_all,
                      'view_all', pm.view_all or pm.modify_all))
                    from public.permission pm where pm.profile_id = p.id), '{}'::jsonb)
  )
  from public.app_user u
  join public.profile p on p.id = u.profile_id
  join public.tenant  t on t.id = u.tenant_id
  where u.id = app.current_user_id()
$$;

create or replace function app.replies_allowed(p_tenant uuid) returns boolean
language sql stable security definer set search_path = public, pg_temp as $$
  select coalesce((select email_replies from public.tenant where id = p_tenant), false)
$$;

-- ---------------------------------------------------------------------
-- Queuing: an email without replies has no reply address
-- ---------------------------------------------------------------------
drop function app.queue_email(uuid, text, text, text, text, uuid, uuid, timestamptz);
create function app.queue_email(p_user_id uuid, p_kind text, p_subject text, p_body text, p_record_type text, p_record_id uuid,
                                 p_post_id uuid default null, p_at timestamptz default now(), p_allow_reply boolean default true)
returns uuid
language plpgsql security definer set search_path = public, pg_temp as $$
declare u public.app_user; v_token text; v_id uuid;
begin
  select * into u from public.app_user where id = p_user_id;
  if u.id is null or u.user_type <> 'human' or coalesce(u.email, '') = '' or u.status <> 'active' then return null; end if;
  if p_allow_reply and app.replies_allowed(u.tenant_id) then v_token := substr(md5(gen_random_uuid()::text), 1, 20); end if;
  insert into public.email_message (tenant_id, direction, kind, status, user_id, from_address, to_address, reply_to,
                                    subject, body, record_type, record_id, post_id, reply_token, created_at)
  values (u.tenant_id, 'outbound', p_kind, 'queued', u.id, 'Event Center <notifications@' || app.email_domain() || '>',
          u.email, case when v_token is not null then 'reply+' || v_token || '@reply.' || app.email_domain() end,
          p_subject, p_body, p_record_type, p_record_id, p_post_id, v_token, p_at)
  returning id into v_id;
  return v_id;
end $$;
comment on function app.queue_email(uuid, text, text, text, text, uuid, uuid, timestamptz, boolean) is
  'Queue an email to a person. p_allow_reply (and the organisation allowing replies) gives it a reply address; otherwise it has none.';

-- ---------------------------------------------------------------------
-- Mentions: emailed only when the organisation says so; the reply invitation only with replies on
-- (notify_post_mentions as in 20261111160000_post_editing)
-- ---------------------------------------------------------------------
create or replace function app.notify_post_mentions() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_event boolean := tg_table_name = 'event_post';
  v_record uuid := (to_jsonb(new) ->> case when v_event then 'event_id' else 'request_id' end)::uuid;
  v_name text;
  v_author text;
  v_snippet text := regexp_replace(btrim(new.body), '\s+', ' ', 'g');
  -- A new post's time (seeds post in the past); an edit's mentions are new now
  v_at timestamptz := case when tg_op = 'INSERT' then new.created_at else now() end;
  v_email boolean := coalesce((select email_mentions from public.tenant where id = new.tenant_id), true);
  v_reply boolean := app.replies_allowed(new.tenant_id);
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
           case when v_event then 'event' else 'request' end, v_record, v_at
      from public.app_user u where u.id = m;
    if v_email then
      perform app.queue_email(m, 'mention', format('%s mentioned you on %s', v_author, v_name),
        concat_ws(E'\n',
          case when v_reply then app.email_reply_line() end, case when v_reply then '' end,
          format('%s mentioned you in the %s discussion:', v_author, v_name), '',
          app.email_quote(new.body), '',
          case when v_reply then 'Reply to this email to answer in the discussion. Your reply is posted as you.' end,
          format('Open the %s discussion: %s', v_name, app.app_link(case when v_event then 'event' else 'request' end, v_record, new.id))),
        case when v_event then 'event' else 'request' end, v_record, new.id, v_at);
    end if;
  end loop;
  return null;
end $$;

-- Posts by email reply are refused when the organisation doesn't allow replies
create or replace function app.check_email_reply_allowed() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if coalesce(current_setting('app.channel', true), '') = 'email' and not app.replies_allowed(new.tenant_id) then
    raise exception 'Replying by email is turned off; answer in Event Center' using errcode = '42501';
  end if;
  return new;
end $$;
create trigger check_email_reply_allowed before insert on public.event_post
  for each row execute function app.check_email_reply_allowed();
create trigger check_email_reply_allowed before insert on public.request_post
  for each row execute function app.check_email_reply_allowed();

-- ---------------------------------------------------------------------
-- Approvals: the process's email settings, kept on the approval
-- ---------------------------------------------------------------------
create or replace function app.approval_email_settings() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
declare p public.approval_process;
begin
  select * into p from public.approval_process where id = new.process_id;
  if p.id is not null then
    new.email_approvers := p.email_approvers;
    new.approve_by_email := p.approve_by_email;
    new.email_submitter := p.email_submitter;
  end if;
  return new;
end $$;
create trigger approval_email_settings before insert on public.approval
  for each row execute function app.approval_email_settings();

-- A request's approval email: replying is offered only when it may decide
drop function app.queue_approval_email(uuid, uuid, timestamptz);
create function app.queue_approval_email(p_request_id uuid, p_user_id uuid, p_at timestamptz default now(), p_reply boolean default true)
returns uuid
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  r public.event_request;
  v_requester text; v_type text; v_event_type text; v_duration text; v_country text; v_ta text; v_expert text; v_related text;
  v_reply boolean;
begin
  select * into r from public.event_request where id = p_request_id;
  if r.id is null then return null; end if;
  v_reply := p_reply and app.replies_allowed(r.tenant_id);
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
      case when v_reply then app.email_reply_line() end,
      case when v_reply then 'Reply with Approve or Reject on the first line. Anything after it is kept as your comment; a rejection needs one.' end,
      case when v_reply then '' end,
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
      case when not v_reply then 'Approve or reject it in Event Center.' end,
      format('Open %s: %s', r.title, app.app_link('request', r.id))),
    'request', r.id, null, p_at, v_reply);
end $$;

-- An event's approval email, likewise
drop function app.queue_event_approval_email(uuid, uuid, uuid, timestamptz);
create function app.queue_event_approval_email(p_event_id uuid, p_user_id uuid, p_submitter uuid, p_at timestamptz default now(), p_reply boolean default true)
returns uuid
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  e public.event; v_submitter text; v_type text; v_country text; v_ta text; v_owner text; v_products text; v_when text;
  v_reply boolean;
begin
  select * into e from public.event where id = p_event_id;
  if e.id is null then return null; end if;
  v_reply := p_reply and app.replies_allowed(e.tenant_id);
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
      case when v_reply then app.email_reply_line() end,
      case when v_reply then 'Reply with Approve or Reject on the first line. Anything after it is kept as your comment; a rejection needs one.' end,
      case when v_reply then '' end,
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
      case when not v_reply then 'Approve or reject it in Event Center.' end,
      format('Open %s: %s', e.name, rtrim(coalesce(app.setting('app_url'), 'http://localhost:5173'), '/') || '/events/' || e.id || '?tab=details')),
    'event', e.id, null, p_at, v_reply);
end $$;

-- Tell a task's approvers it's their turn: always in the app; by email when the process says so
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
      if a.email_approvers then
        if a.record_type = 'event' then perform app.queue_event_approval_email(a.record_id, m, a.submitted_by, p_at, a.approve_by_email);
        else perform app.queue_approval_email(a.record_id, m, p_at, a.approve_by_email); end if;
      end if;
    end if;
  end loop;
end $$;

-- Deciding by email reply: only when the organisation allows replies and the process allows it
create or replace function app.check_email_decision() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
declare a public.approval;
begin
  if new.decided_via is distinct from 'email' or new.decided_via is not distinct from old.decided_via then return new; end if;
  select * into a from public.approval where id = new.approval_id;
  if not app.replies_allowed(a.tenant_id) then
    raise exception 'Replying by email is turned off; approve or reject in Event Center' using errcode = '42501';
  end if;
  if not a.approve_by_email then
    raise exception '%', format('“%s” is approved or rejected in Event Center only, not by email reply', a.process_name) using errcode = '42501';
  end if;
  return new;
end $$;
create trigger check_email_decision before update of decided_via on public.approval_task
  for each row execute function app.check_email_decision();

-- The outcome, by email: to the requester, or the event's owner and submitter (not whoever decided last)
create or replace function app.email_approval_outcome() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_title text := app.approval_title(new.record_type, new.record_id);
  v_noun text := case new.record_type when 'event' then 'event' else 'request' end;
  v_last public.approval_task; v_decider text; u uuid; v_link text;
begin
  select * into v_last from public.approval_task where approval_id = new.id and status in ('approved', 'rejected')
   order by (status = 'rejected') desc, decided_at desc limit 1;
  select display_name into v_decider from public.app_user where id = v_last.decided_by;
  v_link := case new.record_type when 'event'
              then rtrim(coalesce(app.setting('app_url'), 'http://localhost:5173'), '/') || '/events/' || new.record_id || '?tab=details'
              else app.app_link('request', new.record_id) end;
  for u in select distinct x from unnest(case new.record_type
             when 'event' then array[(select owner_id from public.event where id = new.record_id), new.submitted_by]
             else array[(select requested_by from public.event_request where id = new.record_id)] end) x
            where x is not null and x is distinct from v_last.decided_by loop
    perform app.queue_email(u, 'outcome',
      format('%s %s: %s', case new.status when 'approved' then 'Approved' else 'Rejected' end, v_noun, v_title),
      concat_ws(E'\n',
        case new.status
          when 'approved' then format('%s is approved: every step of “%s” said yes.', v_title, new.process_name)
               || case when new.record_type = 'event' then ' It has moved to Contract.' else '' end
          else format('%s was rejected by %s at the step “%s”.', v_title, coalesce(v_decider, 'an approver'), v_last.step_name)
               || case when new.record_type = 'event' then ' It is back in Draft, so it can be changed and submitted again.' else '' end
        end,
        case when v_last.comment is not null then E'\n' || case new.status when 'approved' then 'Note' else 'Reason' end
                                                 || E':\n' || app.email_quote(v_last.comment) end,
        '',
        format('Open %s: %s', v_title, v_link)),
      new.record_type, new.record_id, null, coalesce(new.decided_at, now()), false);
  end loop;
  return null;
end $$;
create trigger email_approval_outcome after update of status on public.approval
  for each row when (old.status = 'pending' and new.status in ('approved', 'rejected') and new.email_submitter)
  execute function app.email_approval_outcome();

grant execute on all functions in schema app to authenticated, service_role;
