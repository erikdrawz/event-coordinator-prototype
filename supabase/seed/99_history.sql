-- =====================================================================
-- Demo seed 99 — curated history
-- Seeding itself generates audit rows with no actor; replace them with a
-- believable trail, including an agent acting on behalf of a human.
-- =====================================================================

truncate public.audit_log;

insert into public.audit_log (tenant_id, table_name, record_id, event_id, action, actor_user_id, on_behalf_of_user_id, changed, at)
select app.sid('tenant:alera'), tbl, app.sid(rec), app.sid('event:sma-board'), act, app.sid('user:' || actor),
       case when obo is not null then app.sid('user:' || obo) end, chg::jsonb, now() - make_interval(hours => h)
  from (values
    ('event',        'event:sma-board',            'insert', 'paul',             null,   '{"name":"SMA Board","status":"draft"}', 38*24),
    ('event',        'event:sma-board',            'update', 'paul',             null,   '{"status":{"from":"draft","to":"review"}}', 30*24),
    ('event_expert', 'expert:sma-board:griffiths', 'insert', 'paul',             null,   '{"role":"speaker"}', 20*24),
    ('event_expert', 'expert:sma-board:muir',      'insert', 'paul',             null,   '{"role":"chair"}', 20*24),
    ('event_expert', 'expert:sma-board:holm',      'insert', 'paul',             null,   '{"role":"advisor"}', 20*24),
    ('event_expert', 'expert:sma-board:holm',      'update', 'agent-compliance', 'paul', '{"eligibility":{"from":"pending","to":"ineligible"},"check_status":{"from":"pending","to":"failed"},"check_notes":{"from":null,"to":"Annual engagement cap reached for Denmark (6 of 6)."}}', 3*24),
    ('event_expert', 'expert:sma-board:griffiths', 'update', 'agent-compliance', 'paul', '{"check_status":{"from":"pending","to":"passed"},"check_notes":{"from":null,"to":"Within annual cap (2 of 6 engagements). FMV rate matches Tier 1 national."}}', 2*24),
    ('event',        'event:sma-board',            'update', 'paul',             null,   '{"status":{"from":"review","to":"contract"}}', 24),
    ('event_content','ec:sma-board:sma-registry',       'update', 'sarah',            null,   '{"review_status":{"from":"draft","to":"review"}}', 75)
  ) as t(tbl, rec, act, actor, obo, chg, h);

drop function if exists app.seed_at(int, text, text);
