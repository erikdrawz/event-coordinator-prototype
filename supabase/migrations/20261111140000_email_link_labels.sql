-- =====================================================================
-- Event Center — Email links named after what they open
-- The last line of a mention or approval email is "Open <what>: <link>". Mail clients that show
-- HTML get a button saying "Open the SMA Board discussion" (email-send turns the line into one);
-- plain-text clients keep the address.
-- =====================================================================

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
        format('Open the %s discussion: %s', v_name, app.app_link(case when v_event then 'event' else 'request' end, v_record, new.id))),
      case when v_event then 'event' else 'request' end, v_record, new.id, new.created_at);
  end loop;
  return null;
end $$;

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
      format('Open %s: %s', r.title, app.app_link('request', r.id))),
    'request', r.id, null, p_at);
end $$;
