-- =====================================================================
-- Demo seed 03 — requests, events and everything on them
-- All dates are relative to "today", so the demo never goes stale:
-- SMA Board is always 5 days out, Derm Roundtable always just happened.
-- =====================================================================

-- Local wall-clock time N days from today in an event's time zone
create or replace function app.seed_at(p_days int, p_hhmm text, p_tz text) returns timestamptz
language sql stable as $$ select ((current_date + p_days) + p_hhmm::time) at time zone p_tz $$;

-- ---------------------------------------------------------------------
-- Approval processes (configuration)
-- ---------------------------------------------------------------------
insert into public.approval_process (id, tenant_id, name, record_type) values
  (app.sid('ap:request-standard'), app.sid('tenant:alera'), 'Event request — standard', 'request');
insert into public.approval_process_step (id, tenant_id, process_id, sort, name, approver_user_id, approver_profile_id) values
  (app.sid('aps:request-1'), app.sid('tenant:alera'), app.sid('ap:request-standard'), 1, 'HQ Events review',   app.sid('user:paul'), null),
  (app.sid('aps:request-2'), app.sid('tenant:alera'), app.sid('ap:request-standard'), 2, 'Compliance sign-off', app.sid('user:alex'), null);

-- ---------------------------------------------------------------------
-- Events
-- ---------------------------------------------------------------------
insert into public.event (id, tenant_id, event_number, name, event_type_id, status, owner_id, therapeutic_area_id,
                          country_code, city, venue_name, venue_address, timezone, starts_at, ends_at,
                          expected_attendees, estimated_spend, currency, description, cancel_reason,
                          crm_connection_id, crm_external_id, created_at, created_by)
select app.sid('event:' || k), app.sid('tenant:alera'),
       'EV-' || extract(year from current_date) || '-' || num,
       nm, app.sid('etype:' || ty), st, app.sid('user:' || own), app.sid('ta:' || ta),
       c, city, venue, addr, tz,
       app.seed_at(d, t0, tz), app.seed_at(d, t0, tz) + make_interval(mins => dur),
       att, spend, 'EUR', descr, cancel,
       case when crm is not null then app.sid('crm:' || crm) end, crmid,
       now() - make_interval(days => created_ago), app.sid('user:' || own)
  from (values
    ('sma-board',      '0117', 'SMA Board',                  'advisory',  'contract',  'paul', 'neuro', 'DK','Copenhagen', 'Copenhagen Marriott Hotel', 'Kalvebod Brygge 5, 1560 Copenhagen', 'Europe/Copenhagen',  5, '18:30',  125,  14,   6400, 'Evening advisory board with Nordic SMA experts on treatment landscape and registry outcomes.', null, 'vault-nord', 'VN-EVT-20931', 38),
    ('neuro-meet',     '0121', 'Neurology Meet',             'seminar',   'review',    'lisa', 'neuro', 'NO','Oslo',       'The Thief Hotel',           'Landgangen 1, 0252 Oslo',            'Europe/Oslo',       19, '09:00',  240,  40,  18500, 'Regional neurology education seminar for Norwegian and Danish neurologists.', null, null, null, 21),
    ('bioforum',       '0109', 'BioForum ' || extract(year from current_date + 36), 'conference', 'draft', 'paul', 'rare', 'FI','Helsinki', 'Messukeskus Helsinki', 'Messuaukio 1, 00520 Helsinki', 'Europe/Helsinki', 36, '09:00', 1980, 600, 145000, 'Company satellite symposium and booth at BioForum, the Nordic rare disease congress. Speakers from Finland, Sweden and the US.', null, null, null, 52),
    ('sma-symposium',  '0124', 'SMA Symposium',              'symposium', 'draft',     'paul', 'neuro', 'SE','Stockholm',  'Stockholmsmässan',          'Mässvägen 1, 125 80 Älvsjö',         'Europe/Stockholm',  89, '13:00',  240, 120,  42000, 'Half-day scientific symposium on SMA standards of care.', null, null, null, 9),
    ('derm-roundtable','0098', 'Derm Roundtable',            'roundtable','execution', 'paul', 'derm',  'DE','Hamburg',    'Hotel Atlantic Hamburg',    'An der Alster 72-79, 20099 Hamburg', 'Europe/Berlin',     -6, '17:00',  150,  12,   5200, 'Expert roundtable on long-term management of moderate-to-severe psoriasis.', null, 'veeva-eu', 'VE-EVT-88120', 60),
    ('cardio-workshop','0122', 'Cardio Workshop',            'workshop',  'review',    'lisa', 'cardio','ES','Madrid',     'Hospital La Paz — Aula Magna','Paseo de la Castellana 261, Madrid','Europe/Madrid',     20, '10:00',  240,  30,   9800, 'Hands-on echocardiography workshop for cardiology fellows.', null, null, null, 14),
    ('haem-board',     '0081', 'Haematology Advisory Board', 'advisory',  'closed',    'paul', 'onc',   'GB','London',     'The Langham London',        '1C Portland Place, London W1B 1JA',  'Europe/London',    -40, '09:30',  360,  10,   7900, 'Advisory board on second-line treatment sequencing.', null, 'veeva-eu', 'VE-EVT-87011', 95),
    ('immuno-webinar', '0115', 'Immunology Webinar Series',  'seminar',   'cancelled', 'lisa', 'immuno','NL','Amsterdam',  'Virtual',                    null,                                 'Europe/Amsterdam',  30, '16:00',   90, 200,   3500, 'Three-part webinar series for immunologists.', 'Merged into the BioForum satellite programme.', null, null, 30)
  ) as t(k, num, nm, ty, st, own, ta, c, city, venue, addr, tz, d, t0, dur, att, spend, descr, cancel, crm, crmid, created_ago);

insert into public.event_product (event_id, product_id, tenant_id) values
  (app.sid('event:sma-board'),      app.sid('product:telia'),    app.sid('tenant:alera')),
  (app.sid('event:sma-symposium'),  app.sid('product:telia'),    app.sid('tenant:alera')),
  (app.sid('event:bioforum'),       app.sid('product:raspinol'), app.sid('tenant:alera')),
  (app.sid('event:derm-roundtable'),app.sid('product:dermalux'), app.sid('tenant:alera')),
  (app.sid('event:haem-board'),     app.sid('product:oncavir'),  app.sid('tenant:alera'));

-- Team (owners are added automatically by trigger) ----------------------------
insert into public.event_team_member (tenant_id, event_id, user_id, team_role, role_label)
select app.sid('tenant:alera'), app.sid('event:' || e), app.sid('user:' || u), r, l
  from (values
    ('sma-board','sarah','medical','Medical lead'), ('sma-board','lisa','logistics','Logistics'),
    ('sma-board','michael','medical','Medical reviewer'),
    ('neuro-meet','paul','co_host','Co-host'), ('neuro-meet','sarah','medical','Medical lead'),
    ('bioforum','lisa','logistics','Logistics'), ('bioforum','emma','member','Brand lead'), ('bioforum','sarah','medical','Medical lead'),
    ('sma-symposium','sarah','medical','Medical lead'),
    ('derm-roundtable','lisa','logistics','Logistics'),
    ('cardio-workshop','emma','member','Brand lead'),
    ('haem-board','michael','medical','Medical lead')
  ) as t(e, u, r, l)
on conflict (event_id, user_id) do nothing;

-- ---------------------------------------------------------------------
-- Requests
-- ---------------------------------------------------------------------
insert into public.event_request (id, tenant_id, request_number, title, event_type_id, status, requested_by, coordinator_id,
                                  therapeutic_area_id, country_code, city, proposed_start, expected_attendees,
                                  estimated_spend, currency, rationale, submitted_at, event_id, created_at, created_by)
select app.sid('req:' || k), app.sid('tenant:alera'),
       'REQ-' || extract(year from current_date) || '-' || num, title, app.sid('etype:' || ty), st,
       app.sid('user:' || req), case when coord is not null then app.sid('user:' || coord) end,
       app.sid('ta:' || ta), c, city, current_date + start_in, att, spend, 'EUR', why,
       now() - make_interval(hours => sub_h), case when ev is not null then app.sid('event:' || ev) end,
       now() - make_interval(hours => sub_h + 20), app.sid('user:' || req)
  from (values
    -- linked to existing events
    ('sma-board',      '0051', 'SMA Board',                         'advisory',  'approved',     'sarah',  'paul', 'neuro', 'DK','Copenhagen',  5, 14,   6400, 'Advice on positioning of registry data ahead of the national guideline update.', 960, 'sma-board'),
    ('neuro-meet',     '0058', 'Neurology Meet Oslo',               'seminar',   'approved',     'ingrid', 'lisa', 'neuro', 'NO','Oslo',       19, 40,  18500, 'Regional education need identified by Norway medical.',                       500, 'neuro-meet'),
    ('bioforum',       '0044', 'BioForum satellite + booth',        'conference','approved',     'emma',   'paul', 'rare',  'FI','Helsinki',   36,600, 145000, 'Key rare-disease congress for the Nordics; satellite symposium slot offered.',   1250,'bioforum'),
    ('cardio-workshop','0060', 'Cardio Workshop Madrid',            'workshop',  'approved',     'carlos', 'lisa', 'cardio','ES','Madrid',     20, 30,   9800, 'Fellows asked for hands-on echo training.',                                     330, 'cardio-workshop'),
    -- waiting for Paul's approval
    ('onc-ab-q3',      '0071', 'Oncology Advisory Board Q3',        'advisory',  'under_review', 'michael','paul', 'onc',   'GB','London',     55, 10,   8200, 'Second-line sequencing questions from the global brand team.',                 2,   null),
    ('rare-vienna',    '0069', 'Rare Disease Symposium',            'symposium', 'under_review', 'emma',   'paul', 'rare',  'AT','Vienna',     70,150,  39000, 'Launch-readiness symposium for Raspinol in DACH.',                              26,  null),
    ('q4-planning',    '0067', 'Q4 Planning Meeting',               'internal',  'under_review', 'lisa',   'paul', 'neuro', 'GB','London',     24, 18,   2100, 'Internal planning for the Q4 strategic events calendar.',                       74,  null),
    -- unassigned: submitted, no coordinator yet
    ('neuro-berlin',   '0068', 'Neurology Expert Meeting Berlin',   'advisory',  'submitted',    'klaus',  null,   'neuro', 'DE','Berlin',     48, 12,   7600, 'German KOLs asked for an exchange on real-world SMA outcomes.',                 72,  null),
    ('resp-barcelona', '0066', 'Respiratory Conference Barcelona',  'conference','submitted',    'carlos', null,   'resp',  'ES','Barcelona',  64,350,  96000, 'Booth and satellite at the national pulmonology congress.',                     120, null),
    ('psych-oslo',     '0063', 'Psychiatry Seminar Oslo',           'seminar',   'submitted',    'ingrid', null,   'neuro', 'NO','Oslo',       41, 35,  11000, 'Education need from Norwegian psychiatrists.',                                  170, null),
    ('derm-milan',     '0062', 'Dermatology Expert Panel Milan',    'roundtable','submitted',    'michael',null,   'derm',  'IT','Milan',      58, 10,   6900, 'Follow-up to the Hamburg roundtable with Italian experts.',                     215, null),
    ('onc-dublin',     '0061', 'Oncology Nurse Education Dublin',   'seminar',   'submitted',    'emma',   null,   'onc',   'IE','Dublin',     77, 60,  14500, 'Nurse educators requested a regional session.',                                 290, null)
  ) as t(k, num, title, ty, st, req, coord, ta, c, city, start_in, att, spend, why, sub_h, ev);

update public.event e set request_id = r.id from public.event_request r where r.event_id = e.id;

-- Approvals: one completed (SMA Board), three waiting for Paul ----------------
insert into public.approval (id, tenant_id, process_id, record_type, record_id, status, current_step, submitted_by, submitted_at, decided_at)
select app.sid('appr:' || k), app.sid('tenant:alera'), app.sid('ap:request-standard'), 'request', app.sid('req:' || k),
       st, step, r.requested_by, r.submitted_at, case when st = 'approved' then r.submitted_at + interval '3 days' end
  from (values ('sma-board','approved',2), ('onc-ab-q3','pending',1), ('rare-vienna','pending',1), ('q4-planning','pending',1)) t(k, st, step)
  join public.event_request r on r.id = app.sid('req:' || k);

insert into public.approval_action (tenant_id, approval_id, step_id, step_name, approver_id, decision, comment, decided_at) values
  (app.sid('tenant:alera'), app.sid('appr:sma-board'), app.sid('aps:request-1'), 'HQ Events review',    app.sid('user:paul'), 'approved', 'Fits the Nordic SMA plan. Budget within range.', now() - interval '38 days'),
  (app.sid('tenant:alera'), app.sid('appr:sma-board'), app.sid('aps:request-2'), 'Compliance sign-off', app.sid('user:alex'), 'approved', null,                                               now() - interval '37 days'),
  (app.sid('tenant:alera'), app.sid('appr:onc-ab-q3'),   app.sid('aps:request-1'), 'HQ Events review', app.sid('user:paul'), null, null, null),
  (app.sid('tenant:alera'), app.sid('appr:rare-vienna'), app.sid('aps:request-1'), 'HQ Events review', app.sid('user:paul'), null, null, null),
  (app.sid('tenant:alera'), app.sid('appr:q4-planning'), app.sid('aps:request-1'), 'HQ Events review', app.sid('user:paul'), null, null, null);

-- ---------------------------------------------------------------------
-- Experts (honorarium grid) and agenda
-- ---------------------------------------------------------------------
insert into public.event_expert (id, tenant_id, event_id, hcp_id, role, eligibility, check_status, check_notes,
                                 fmv_rate_id, hourly_rate, currency, prep_hours, service_hours, travel_hours, created_at)
select app.sid('expert:' || e || ':' || h), app.sid('tenant:alera'), app.sid('event:' || e), app.sid('hcp:' || h),
       role, elig, chk, notes, app.sid('fmv:' || h || ':' || svc), rate, 'EUR', prep, svc_h, trav, now() - interval '20 days'
  from (values
    ('sma-board','muir','chair','eligible','pending', null, 'chair', 280, 1.0, 0.5, 0.0),
    ('sma-board','griffiths','speaker','eligible','passed', 'Within annual cap (2 of 6 engagements). FMV rate matches Tier 1 national.', 'speaker', 280, 1.5, 1.2, 1.0),
    ('sma-board','holm','advisor','ineligible','failed', 'Annual engagement cap reached for Denmark (6 of 6).', 'advisory', 250, 0, 0, 0),
    ('neuro-meet','solberg','speaker','eligible','pending', null, 'speaker', 240, 2.0, 1.0, 1.5),
    ('neuro-meet','lind','speaker','pending','pending', null, 'advisory', 250, 1.5, 1.0, 3.0),
    ('bioforum','eriksson','chair','eligible','passed', 'Cross-border engagement: SE → FI. Transparency reporting in SE.', 'chair', 320, 2.0, 1.5, 4.0),
    ('bioforum','vaaranen','speaker','eligible','pending', null, 'speaker', 320, 3.0, 1.0, 0.0),
    ('bioforum','huesh','speaker','pending','pending', 'US HCP: Sunshine Act reporting applies; travel from Boston.', 'speaker', 350, 3.0, 1.0, 10.0),
    ('derm-roundtable','vogel','chair','eligible','passed', null, 'chair', 290, 1.5, 2.5, 0.5),
    ('derm-roundtable','brandt','advisor','eligible','passed', null, 'advisory', 230, 1.0, 2.5, 0.5)
  ) as t(e, h, role, elig, chk, notes, svc, rate, prep, svc_h, trav);

insert into public.event_session (id, tenant_id, event_id, title, session_kind, starts_at, ends_at, sort)
select app.sid('session:' || e || ':' || n), app.sid('tenant:alera'), app.sid('event:' || e), title, kind,
       app.seed_at(d, s, tz), app.seed_at(d, f, tz), n
  from (values
    ('sma-board', 1, 'Welcome and housekeeping',                     'Housekeeping',      5, '18:30', '18:35', 'Europe/Copenhagen'),
    ('sma-board', 2, 'Chair introduction and objectives',            'Chair introduction',5, '18:35', '18:50', 'Europe/Copenhagen'),
    ('sma-board', 3, 'SMA treatment landscape',                      'Presentation',      5, '18:50', '19:20', 'Europe/Copenhagen'),
    ('sma-board', 4, 'Dinner served',                                'Break',             5, '19:20', '19:40', 'Europe/Copenhagen'),
    ('sma-board', 5, 'Real-world outcomes: regional registry data',  'Presentation',      5, '19:40', '20:10', 'Europe/Copenhagen'),
    ('sma-board', 6, 'Panel discussion and Q&A',                     'Panel / Q&A',       5, '20:10', '20:30', 'Europe/Copenhagen'),
    ('sma-board', 7, 'Summary and close',                            'Summary',           5, '20:30', '20:35', 'Europe/Copenhagen'),
    ('neuro-meet',1, 'Welcome',                                      'Housekeeping',     19, '09:00', '09:10', 'Europe/Oslo'),
    ('neuro-meet',2, 'Diagnosing SMA in adults',                     'Presentation',     19, '09:10', '10:00', 'Europe/Oslo'),
    ('neuro-meet',3, 'Case discussions',                             'Workshop',         19, '10:15', '11:30', 'Europe/Oslo'),
    ('neuro-meet',4, 'Close',                                        'Summary',          19, '11:30', '11:40', 'Europe/Oslo'),
    ('bioforum',  1, 'Satellite: Rare disease registries across the Nordics', 'Presentation', 36, '12:30', '13:15', 'Europe/Helsinki'),
    ('bioforum',  2, 'Satellite: Lessons from the US natural-history cohort', 'Presentation', 36, '13:15', '13:45', 'Europe/Helsinki'),
    ('bioforum',  3, 'Satellite: Panel and audience Q&A',            'Panel / Q&A',      36, '13:45', '14:15', 'Europe/Helsinki'),
    ('derm-roundtable',1,'Opening',                                  'Chair introduction',-6, '17:00', '17:15', 'Europe/Berlin'),
    ('derm-roundtable',2,'Long-term management cases',               'Discussion',       -6, '17:15', '19:00', 'Europe/Berlin'),
    ('derm-roundtable',3,'Wrap-up',                                  'Summary',          -6, '19:00', '19:30', 'Europe/Berlin')
  ) as t(e, n, title, kind, d, s, f, tz);

insert into public.event_session_speaker (tenant_id, event_id, session_id, event_expert_id, user_id, minutes, sort)
select app.sid('tenant:alera'), app.sid('event:' || e), app.sid('session:' || e || ':' || n),
       case when h is not null then app.sid('expert:' || e || ':' || h) end,
       case when u is not null then app.sid('user:' || u) end, m, srt
  from (values
    ('sma-board',1,null,'sarah',5,1), ('sma-board',2,'muir',null,15,1), ('sma-board',3,'griffiths',null,30,1),
    ('sma-board',5,'griffiths',null,30,1), ('sma-board',6,'muir',null,10,1), ('sma-board',6,'griffiths',null,10,2),
    ('sma-board',7,'muir',null,5,1),
    ('neuro-meet',2,'solberg',null,50,1), ('neuro-meet',3,'lind',null,75,1),
    ('bioforum',1,'vaaranen',null,45,1), ('bioforum',2,'huesh',null,30,1), ('bioforum',3,'eriksson',null,30,1),
    ('derm-roundtable',1,'vogel',null,15,1), ('derm-roundtable',2,'vogel',null,50,1), ('derm-roundtable',2,'brandt',null,55,2),
    ('derm-roundtable',3,'vogel',null,30,1)
  ) as t(e, n, h, u, m, srt);

-- ---------------------------------------------------------------------
-- Attendees
-- ---------------------------------------------------------------------
insert into public.event_attendee (id, tenant_id, event_id, attendee_kind, hcp_id, user_id, organisation, role_label, rsvp,
                                   attended, crm_status, crm_connection_id, crm_external_id)
select app.sid('att:' || e || ':' || coalesce(h, u)), app.sid('tenant:alera'), app.sid('event:' || e),
       case when h is not null then 'hcp' else 'user' end,
       case when h is not null then app.sid('hcp:' || h) end,
       case when u is not null then app.sid('user:' || u) end,
       org, role, rsvp, attended,
       case when u is not null then 'not_applicable' else crm end,
       case when h is not null and crm = 'reconciled' then (select p.crm_connection_id from public.hcp p where p.id = app.sid('hcp:' || h)) end,
       case when h is not null and crm = 'reconciled' then (select p.crm_external_id from public.hcp p where p.id = app.sid('hcp:' || h)) end
  from (values
    ('sma-board','muir',null,'Aarhus University Hospital','Chair','accepted',null,'reconciled'),
    ('sma-board','griffiths',null,'Rigshospitalet','Speaker','accepted',null,'reconciled'),
    ('sma-board','holm',null,'Odense University Hospital','Advisor','declined',null,'reconciled'),
    ('sma-board','lind',null,'Aalborg University Hospital','Advisor','accepted',null,'reconciled'),
    ('sma-board','sorensen',null,'Herlev Hospital','Advisor','invited',null,'pending'),
    ('sma-board',null,'sarah','Alera Pharma','Medical lead','accepted',null,null),
    ('sma-board',null,'paul','Alera Pharma','Organiser','accepted',null,null),
    ('neuro-meet','solberg',null,'Oslo University Hospital','Speaker','accepted',null,'reconciled'),
    ('neuro-meet','lind',null,'Aalborg University Hospital','Speaker','tentative',null,'reconciled'),
    ('neuro-meet',null,'lisa','Alera Pharma','Organiser','accepted',null,null),
    ('bioforum','eriksson',null,'Karolinska University Hospital','Chair','accepted',null,'reconciled'),
    ('bioforum','vaaranen',null,'Helsinki University Hospital','Speaker','accepted',null,'reconciled'),
    ('bioforum','huesh',null,'Massachusetts General Hospital','Speaker','invited',null,'pending'),
    ('derm-roundtable','vogel',null,'UKE Hamburg','Chair','accepted',true,'reconciled'),
    ('derm-roundtable','brandt',null,'UKE Hamburg','Advisor','accepted',true,'reconciled'),
    ('derm-roundtable',null,'paul','Alera Pharma','Organiser','accepted',true,null)
  ) as t(e, h, u, org, role, rsvp, attended, crm);

-- ---------------------------------------------------------------------
-- Content: decks and documents
-- ---------------------------------------------------------------------
insert into public.content (id, tenant_id, title, content_kind, file_name, mime_type, size_bytes, storage_path,
                            owner_user_id, author_hcp_id, created_at, updated_at)
select app.sid('content:' || k), app.sid('tenant:alera'), title, kind, fname, mime, size,
       'demo/' || fname, app.sid('user:' || own), case when hcp is not null then app.sid('hcp:' || hcp) end,
       now() - make_interval(days => age_d + 3), now() - make_interval(days => age_d)
  from (values
    ('sma-landscape',  'SMA treatment landscape',                         'presentation','SMA treatment landscape.pptx',                         'application/vnd.openxmlformats-officedocument.presentationml.presentation', 8421000, 'sarah','griffiths', 2),
    ('sma-registry',   'Regional registry outcomes',                      'presentation','Regional registry outcomes.pdf',                       'application/pdf',  2210000, 'sarah','griffiths', 1),
    ('sma-chair',      'Chair opening remarks',                           'presentation','Chair opening remarks.pptx',                           'application/vnd.openxmlformats-officedocument.presentationml.presentation', 1320000, 'sarah','muir', 5),
    ('sma-venue',      'Venue contract — Copenhagen Marriott (redlined)', 'contract',    'Venue contract - Copenhagen Marriott (redlined).pdf', 'application/pdf',   412000, 'lisa', null, 2),
    ('sma-agenda',     'Advisory board agenda v3',                        'document',    'Advisory board agenda v3.docx',                       'application/vnd.openxmlformats-officedocument.wordprocessingml.document', 64000, 'paul', null, 4),
    ('sma-agreements', 'HCP consulting agreements',                       'document',    'HCP consulting agreements.zip',                       'application/zip',  1830000, 'sarah', null, 8),
    ('sma-budget',     'Budget approval REQ-0051',                        'document',    'Budget approval REQ-0051.pdf',                        'application/pdf',   98000, 'michael', null, 16),
    ('tpl-csa',        'Consulting services agreement — template v4',     'template',    'CSA template v4.docx',                                'application/vnd.openxmlformats-officedocument.wordprocessingml.document', 88000, 'alex', null, 120),
    ('tpl-wo',         'Work order — template v2',                        'template',    'Work order template v2.docx',                         'application/vnd.openxmlformats-officedocument.wordprocessingml.document', 51000, 'alex', null, 120),
    ('bio-registries', 'Rare disease registries across the Nordics',      'presentation','Nordic registries - draft.pptx',                      'application/vnd.openxmlformats-officedocument.presentationml.presentation', 6100000, 'emma','vaaranen', 6)
  ) as t(k, title, kind, fname, mime, size, own, hcp, age_d);

insert into public.event_content (id, tenant_id, event_id, content_id, usage, category, session_id, review_status, created_at)
select app.sid('ec:' || e || ':' || c), app.sid('tenant:alera'), app.sid('event:' || e), app.sid('content:' || c), usage, cat,
       case when s is not null then app.sid('session:' || e || ':' || s) end, rs, now() - make_interval(days => age_d)
  from (values
    ('sma-board','sma-landscape','presentation','Presentation',3,'approved',2),
    ('sma-board','sma-registry','presentation','Presentation',5,'review',1),
    ('sma-board','sma-chair','presentation','Presentation',2,'rejected',5),
    ('sma-board','sma-venue','document','Contract',null,null,2),
    ('sma-board','sma-agenda','document','Agenda',null,null,4),
    ('sma-board','sma-agreements','document','Compliance',null,null,8),
    ('sma-board','sma-budget','document','Finance',null,null,16),
    ('bioforum','bio-registries','presentation','Presentation',1,'draft',6)
  ) as t(e, c, usage, cat, s, rs, age_d);

-- ---------------------------------------------------------------------
-- Contracting
-- ---------------------------------------------------------------------
insert into public.contract (id, tenant_id, contract_number, contract_type, status, counterparty_hcp_id, counterparty_hco_id,
                             parent_contract_id, start_date, end_date, template_content_id, document_content_id, clm_reference)
select app.sid('contract:' || k), app.sid('tenant:alera'),
       prefix || '-' || extract(year from current_date) || '-' || num, ty, st,
       case when hcp is not null then app.sid('hcp:' || hcp) end, case when hco is not null then app.sid('hco:' || hco) end,
       null, date_trunc('year', current_date)::date, (date_trunc('year', current_date) + interval '1 year - 1 day')::date,
       case when tpl is not null then app.sid('content:' || tpl) end, case when doc is not null then app.sid('content:' || doc) end, clm
  from (values
    ('csa-muir',      'CSA', '114', 'service_agreement', 'executed', 'muir',      null,           'tpl-csa', null,        'ICX-AG-20114'),
    ('csa-griffiths', 'CSA', '109', 'service_agreement', 'executed', 'griffiths', null,           'tpl-csa', null,        'ICX-AG-20109'),
    ('csa-eriksson',  'CSA', '087', 'service_agreement', 'executed', 'eriksson',  null,           'tpl-csa', null,        'ICX-AG-20087'),
    ('csa-vaaranen',  'CSA', '131', 'service_agreement', 'sent',     'vaaranen',  null,           'tpl-csa', null,        'ICX-AG-20131'),
    ('venue-sma',     'VEN', '031', 'venue',             'sent',     null,        'marriott-cph', null,      'sma-venue', null)
  ) as t(k, prefix, num, ty, st, hcp, hco, tpl, doc, clm);

-- Work orders under the umbrella agreements, one per event engagement
insert into public.contract (id, tenant_id, contract_number, contract_type, status, counterparty_hcp_id, parent_contract_id,
                             start_date, end_date, template_content_id, clm_reference)
select app.sid('contract:wo-' || k), app.sid('tenant:alera'), 'WO-' || extract(year from current_date) || '-' || num,
       'work_order', st, app.sid('hcp:' || hcp), app.sid('contract:csa-' || hcp), current_date + 5, current_date + 5,
       app.sid('content:tpl-wo'), clm
  from (values ('muir','0451','draft','muir',null), ('griffiths','0448','sent','griffiths','ICX-WO-30448')) t(k, num, st, hcp, clm);

insert into public.event_expert_contract (event_expert_id, contract_id, tenant_id, event_id) values
  (app.sid('expert:sma-board:muir'),      app.sid('contract:csa-muir'),      app.sid('tenant:alera'), app.sid('event:sma-board')),
  (app.sid('expert:sma-board:muir'),      app.sid('contract:wo-muir'),       app.sid('tenant:alera'), app.sid('event:sma-board')),
  (app.sid('expert:sma-board:griffiths'), app.sid('contract:csa-griffiths'), app.sid('tenant:alera'), app.sid('event:sma-board')),
  (app.sid('expert:sma-board:griffiths'), app.sid('contract:wo-griffiths'),  app.sid('tenant:alera'), app.sid('event:sma-board')),
  (app.sid('expert:bioforum:eriksson'),   app.sid('contract:csa-eriksson'),  app.sid('tenant:alera'), app.sid('event:bioforum')),
  (app.sid('expert:bioforum:vaaranen'),   app.sid('contract:csa-vaaranen'),  app.sid('tenant:alera'), app.sid('event:bioforum'));

insert into public.event_contracting_org (id, tenant_id, event_id, hco_id, purpose) values
  (app.sid('eco:sma-board:marriott'), app.sid('tenant:alera'), app.sid('event:sma-board'), app.sid('hco:marriott-cph'), 'venue');
insert into public.org_contract (event_contracting_org_id, contract_id, tenant_id, event_id) values
  (app.sid('eco:sma-board:marriott'), app.sid('contract:venue-sma'), app.sid('tenant:alera'), app.sid('event:sma-board'));

-- ---------------------------------------------------------------------
-- Team board: posts, replies, reactions, tasks
-- ---------------------------------------------------------------------
insert into public.event_post (id, tenant_id, event_id, parent_id, author_id, body, created_at, updated_at)
select app.sid('post:' || k), app.sid('tenant:alera'), app.sid('event:' || e),
       case when parent is not null then app.sid('post:' || parent) end, app.sid('user:' || a), body,
       now() - make_interval(hours => h), now() - make_interval(hours => h)
  from (values
    ('sma-1',  'sma-board', null,   'sarah',   'Legal returned the venue contract redlines — only the cancellation clause changed, should be quick to sign. Paul, can you countersign in the next couple of days?', 26),
    ('sma-1a', 'sma-board', 'sma-1','paul',    'On it — will sign once Lisa confirms the deposit schedule.', 25),
    ('sma-2',  'sma-board', null,   'lisa',    'Marriott confirmed the three-course menu for 14. Two vegetarian, one gluten-free noted.', 53),
    ('sma-3',  'sma-board', null,   'michael', 'Richard''s second deck quotes unpublished registry figures. Flagging for Medical review before approval.', 76),
    ('sma-3a', 'sma-board', 'sma-3','sarah',   'Agreed — I''ve set it to Review in Content and asked Richard for the source.', 75),
    ('bio-1',  'bioforum',  null,   'sarah',   '@Paul Taylor the congress confirmed our satellite slot — 12:30 on day one. Can we lock the speaker line-up this week?', 3),
    ('derm-1', 'derm-roundtable', null, 'lisa','All invoices from Hotel Atlantic are in. Closeout report is the last open item.', 100)
  ) as t(k, e, parent, a, body, h);

insert into public.event_post_reaction (post_id, user_id, emoji, tenant_id, event_id)
select app.sid('post:' || p), app.sid('user:' || u), em, app.sid('tenant:alera'), app.sid('event:' || e)
  from (values
    ('sma-1','paul','👍','sma-board'), ('sma-1','lisa','👍','sma-board'), ('sma-1','michael','👀','sma-board'),
    ('sma-2','paul','🎉','sma-board'), ('sma-2','sarah','🎉','sma-board'), ('sma-2','michael','🎉','sma-board'),
    ('sma-3','paul','👍','sma-board'), ('sma-3','sarah','⚠️','sma-board'), ('sma-3','lisa','⚠️','sma-board')
  ) as t(p, u, em, e);

insert into public.event_task (id, tenant_id, event_id, title, assignee_id, due_date, done_at, source_post_id, created_at)
select app.sid('task:' || k), app.sid('tenant:alera'), app.sid('event:' || e), title, app.sid('user:' || a), current_date + due,
       case when done then now() - interval '1 day' end, case when src is not null then app.sid('post:' || src) end,
       now() - interval '4 days'
  from (values
    ('sma-sign',     'sma-board',      'Countersign Marriott venue contract',          'paul',  2,  false, 'sma-1'),
    ('sma-registry', 'sma-board',      'Get registry data sources from Dr Griffiths',  'sarah', -2, false, 'sma-3'),
    ('sma-dietary',  'sma-board',      'Confirm dietary requirements with Dr Lind',    'lisa',  3,  false, null),
    ('sma-train',    'sma-board',      'Book Dr Griffiths'' return train',             'lisa',  4,  false, null),
    ('sma-menu',     'sma-board',      'Confirm menu and headcount with Marriott',     'lisa',  -3, true,  'sma-2'),
    ('derm-close',   'derm-roundtable','Submit closeout report',                       'paul',  -4, false, null),
    ('bio-lineup',   'bioforum',       'Lock satellite speaker line-up',               'paul',  6,  false, 'bio-1'),
    ('neuro-agenda', 'neuro-meet',     'Review co-host agenda draft',                  'paul',  7,  false, null)
  ) as t(k, e, title, a, due, done, src);

-- ---------------------------------------------------------------------
-- Notifications for the demo lead (Paul)
-- ---------------------------------------------------------------------
insert into public.notification (tenant_id, user_id, kind, title, body, record_type, record_id, read_at, created_at) values
  (app.sid('tenant:alera'), app.sid('user:paul'), 'approval_required', 'Oncology Advisory Board Q3', 'submitted for your approval by Michael Chen', 'request', app.sid('req:onc-ab-q3'), null, now() - interval '2 hours'),
  (app.sid('tenant:alera'), app.sid('user:paul'), 'mention',           'Sarah Mitchell',             'mentioned you in the BioForum discussion',     'event',   app.sid('event:bioforum'), null, now() - interval '3 hours'),
  (app.sid('tenant:alera'), app.sid('user:paul'), 'new_request',       'Respiratory Conference Barcelona', 'is waiting for an owner',            'request', app.sid('req:resp-barcelona'), null, now() - interval '5 hours'),
  (app.sid('tenant:alera'), app.sid('user:paul'), 'approved',          'SMA Board',                  'moved to Contract — approvals complete',       'event',   app.sid('event:sma-board'), now() - interval '20 hours', now() - interval '1 day'),
  (app.sid('tenant:alera'), app.sid('user:paul'), 'task_assigned',     'Countersign Marriott venue contract', 'assigned to you on SMA Board',        'event',   app.sid('event:sma-board'), now() - interval '1 day', now() - interval '25 hours');

update public.app_user set last_login_at = now() - interval '1 day' where user_type = 'human';
