-- =====================================================================
-- Demo seed 07 — working by email
-- Emails Event Center sent (mentions, approval requests) and the replies that came back:
-- Michael answers a mention on SMA Board by email, approves the Madrid workshop by email,
-- and Paul's reply to the Vienna request couldn't be used (a rejection needs a reason).
-- Mentions queue their emails through the trigger. Seeded requests are inserted already
-- submitted, so their approvals are started here, as of when they were submitted.
-- =====================================================================

-- SMA Board: Paul asks Michael about the registry figures (the trigger notifies and emails him)
insert into public.event_post (id, tenant_id, event_id, author_id, body, mentions, created_at, updated_at) values
  (app.sid('post:sma-4'), app.sid('tenant:alera'), app.sid('event:sma-board'), app.sid('user:paul'),
   '@Michael Chen Richard sent the source for the registry figures in his second deck: the 2025 Danish SMA registry report, which is published. Are you happy for the deck to go to Medical approval?',
   array[app.sid('user:michael')], now() - interval '30 hours', now() - interval '30 hours');

-- Every submitted request went through its approval process (this notifies and emails approvers)
select app.start_approval('request', r.id, r.submitted_at)
  from public.event_request r where r.status <> 'draft' order by r.submitted_at;

-- Events: Neurology Meet and Cardio Workshop are in review (Lisa submitted them); SMA Board went
-- through its approval before moving to Contract (Paul submitted it)
select app.start_approval('event', app.sid('event:' || k), now() - make_interval(hours => h), app.sid('user:' || who))
  from (values ('sma-board', 'paul', 300), ('neuro-meet', 'lisa', 50), ('cardio-workshop', 'lisa', 26)) t(k, who, h)
 order by h desc;

-- Everything above went out a minute after it was queued
update public.email_message set status = 'sent', sent_at = created_at + interval '1 minute'
 where direction = 'outbound' and status = 'queued';

-- Replies, quoting the email they answer the way a mail client does
insert into public.email_message (tenant_id, direction, kind, status, user_id, from_address, to_address, subject, body,
                                  record_type, record_id, in_reply_to, status_note, created_at, processed_at)
select o.tenant_id, 'inbound', 'reply', st, o.user_id, u.display_name || ' <' || u.email || '>', o.reply_to, 'Re: ' || o.subject,
       reply || E'\n\nOn ' || to_char(o.sent_at at time zone 'Europe/Copenhagen', 'Dy FMDD Mon YYYY "at" HH24:MI') || E', Event Center <notifications@eventcenter.example> wrote:\n'
             || app.email_quote(o.body),
       o.record_type, o.record_id, o.id, note, o.sent_at + make_interval(hours => after_h), o.sent_at + make_interval(hours => after_h)
  from (values
    ('post', 'michael', 'sma-4', 'processed', 3,
     E'Yes, that report is published, so it''s fine from my side. Sarah, can you set the deck to Approved in Content once you''ve had a look?',
     'Posted as a reply in the SMA Board discussion'),
    ('req', 'michael', 'cardio-workshop', 'processed', 18,
     E'Approve. Keep the hands-on stations to six fellows each so everyone gets time on the scanner.',
     'Approved Cardio Workshop Madrid'),
    ('req', 'paul', 'rare-vienna', 'failed', 4,
     E'Reject',
     'Add a reason so the requester knows why')
  ) as t(about, who, k, st, after_h, reply, note)
  join public.email_message o on o.direction = 'outbound' and o.user_id = app.sid('user:' || t.who)
   and (case t.about when 'post' then o.post_id = app.sid('post:' || t.k) else o.record_id = app.sid('req:' || t.k) end)
  join public.app_user u on u.id = o.user_id;

-- Michael's reply became a post in the thread, written by email
insert into public.event_post (id, tenant_id, event_id, parent_id, author_id, body, channel, created_at, updated_at)
select app.sid('post:sma-4a'), i.tenant_id, i.record_id, app.sid('post:sma-4'), i.user_id, app.email_reply_text(i.body), 'email', i.created_at, i.created_at
  from public.email_message i
  join public.email_message o on o.id = i.in_reply_to
 where i.direction = 'inbound' and o.post_id = app.sid('post:sma-4');
update public.email_message set post_id = app.sid('post:sma-4a')
 where direction = 'inbound' and in_reply_to = (select id from public.email_message where post_id = app.sid('post:sma-4') and direction = 'outbound');
update public.notification set read_at = now() - interval '27 hours'
 where user_id = app.sid('user:michael') and kind = 'mention' and record_id = app.sid('event:sma-board');

-- Decisions on the decided requests, made through their approvals: Michael's on the Madrid
-- workshop by email, the rest in Event Center
select app.apply_task_decision(t.id, app.sid('user:' || d.who), d.decision,
         coalesce(app.email_reply_text(substring(e.body from '^\S+[.\s]*(.*)$')), d.note), d.via,
         coalesce(e.created_at, r.submitted_at + make_interval(hours => d.after_h)))
  from (values
    ('sma-board',       'michael', 'approved', 'app',   20, null),
    ('neuro-meet',      'michael', 'approved', 'app',   30, 'Approved. Book the venue through the Oslo office so it''s on their framework agreement.'),
    ('bioforum',        'paul',    'approved', 'app',   48, null),
    ('cardio-workshop', 'michael', 'approved', 'email', 0,  null),
    ('immuno-gala',     'michael', 'rejected', 'app',   26, 'A recognition dinner for prescribers isn''t something we can fund under the code. Happy to look at an educational format instead.')
  ) as d(k, who, decision, via, after_h, note)
  join public.event_request r on r.id = app.sid('req:' || d.k)
  join public.approval a on a.record_id = r.id and a.status = 'pending'
  join public.approval_task t on t.approval_id = a.id and t.status = 'pending'
  left join public.email_message e on d.via = 'email' and e.direction = 'inbound' and e.record_id = r.id and e.status = 'processed';

-- SMA Board's approval: Compliance (no manager for Paul) and Nordics Medical both approved
select app.apply_task_decision(t.id, app.sid('user:' || d.who), 'approved', d.note, 'app', a.submitted_at + make_interval(hours => d.after_h))
  from (values ('Manager approval', 'maria', 20, null),
               ('Medical review', 'sarah', 44, 'Registry figures checked against the published 2025 report. Fine to go ahead.')) d(step, who, after_h, note)
  join public.approval a on a.record_type = 'event' and a.record_id = app.sid('event:sma-board') and a.status = 'pending'
  join public.approval_task t on t.approval_id = a.id and t.step_name = d.step and t.status = 'pending'
 order by d.after_h;
update public.notification set read_at = created_at + interval '2 hours'
 where record_id = app.sid('event:sma-board') and kind = 'approved';
