-- =====================================================================
-- Demo seed 06 — the Library: pre-approved presentations
-- Files are served from apps/web/public/demo-content/ (storage_path demo/…).
-- =====================================================================
insert into public.content (id, tenant_id, title, description, content_kind, file_name, mime_type, size_bytes, storage_path,
                            owner_user_id, is_library, is_active, country_codes, created_at, updated_at)
select app.sid('library:' || k), app.sid('tenant:alera'), title, descr, 'presentation', fname,
       'application/vnd.openxmlformats-officedocument.presentationml.presentation', size, 'demo/' || fname,
       app.sid('user:maria'), true, active, ccs::char(2)[], now() - make_interval(days => age_d), now() - make_interval(days => age_d)
  from (values
    ('telia-moa',    'Telia: mechanism of action',            'Approved core deck for scientific sessions on Telia.',           'Telia mechanism of action.pptx',       31000, true,  null,                  120),
    ('sma-overview', 'SMA disease overview',                  'Disease background for mixed audiences.',                        'SMA disease overview.pptx',            31000, true,  null,                  90),
    ('compliance',   'Working with Alera: HCP briefing',      'Compliance briefing for every external expert meeting.',         'Working with Alera HCP briefing.pptx', 30000, true,  null,                  60),
    ('telia-nordic', 'Telia: Nordic registry data',           'Registry outcomes approved for use in the Nordics.',             'Telia Nordic registry data.pptx',      31000, true,  '{DK,SE,NO,FI}',       45),
    ('dermalux-de',  'Dermalux: Überblick für Fachkreise',    'German-language deck, approved for Germany only.',               'Dermalux Ueberblick.pptx',             30000, true,  '{DE}',                30),
    ('dermalux-old', 'Dermalux launch deck 2025',             'Replaced; kept for events that already used it.',                'Dermalux launch deck 2025.pptx',       30000, false, null,                  400)
  ) as t(k, title, descr, fname, size, active, ccs, age_d);

insert into public.event_type_content (tenant_id, event_type_id, content_id)
select app.sid('tenant:alera'), app.sid('etype:' || ty), app.sid('library:' || k)
  from (values
    ('telia-moa','advisory'), ('telia-moa','symposium'), ('telia-moa','seminar'),
    ('sma-overview','advisory'), ('sma-overview','symposium'), ('sma-overview','seminar'), ('sma-overview','conference'),
    ('compliance','advisory'), ('compliance','conference'), ('compliance','symposium'), ('compliance','seminar'), ('compliance','roundtable'), ('compliance','workshop'),
    ('telia-nordic','advisory'), ('telia-nordic','symposium'),
    ('dermalux-de','roundtable'), ('dermalux-de','advisory'),
    ('dermalux-old','roundtable')
  ) as t(k, ty);

-- SMA Board already uses one
insert into public.event_content (id, tenant_id, event_id, content_id, usage, review_status, description, created_at)
values (app.sid('ec:sma-board:library:compliance'), app.sid('tenant:alera'), app.sid('event:sma-board'), app.sid('library:compliance'),
        'presentation', 'approved', 'Opens the meeting; Sarah Mitchell', now() - interval '3 days');

-- Agenda templates: approved fillable PDFs (fictional), each field mapped to event data.
-- The Nordic one only allows its approved session titles; the UK one lets any title through.
insert into public.content (id, tenant_id, title, description, content_kind, file_name, mime_type, size_bytes, storage_path,
                            owner_user_id, is_library, is_active, country_codes, template_fields, created_at, updated_at)
select app.sid('library:' || k), app.sid('tenant:alera'), title, descr, 'template', fname, 'application/pdf', size, 'demo/' || fname,
       app.sid('user:maria'), true, true, ccs::char(2)[],
       jsonb_build_object(
         'Meeting title', jsonb_build_object('source', 'event.name'),
         'Date', jsonb_build_object('source', 'event.date'),
         'Time', jsonb_build_object('source', 'event.time'),
         'Venue', jsonb_build_object('source', 'event.venue'),
         'Venue address', jsonb_build_object('source', 'event.address'),
         'Chair', jsonb_build_object('source', 'chair.name'),
         'Contact name', jsonb_build_object('source', 'contact.name'),
         'Contact email', jsonb_build_object('source', 'contact.email'),
         'Contact number', jsonb_build_object('source', 'ask', 'label', 'Contact number'))
       || (select jsonb_object_agg(f || ' ' || r, jsonb_build_object('source', s, 'row', r))
             from generate_series(1, rows) r,
                  (values ('Time', 'session.time'), ('Session', 'session.title'), ('Speaker', 'session.speakers')) m(f, s)),
       now() - make_interval(days => age_d), now() - make_interval(days => age_d)
  from (values
    ('agenda-nordic', 'Advisory board invitation (Nordics)', 'Approved invitation and agenda for Telia advisory boards. Session titles from the approved list only.',
     'Alera advisory board invitation Nordics.pdf', 29829, '{DK,SE,NO,FI}', 8, 20),
    ('agenda-uk',     'Meeting invitation (UK)',             'Approved promotional meeting invitation for UK healthcare professionals.',
     'Alera meeting invitation UK.pdf',             26634, '{GB}',          7, 40)
  ) as t(k, title, descr, fname, size, ccs, rows, age_d);

insert into public.event_type_content (tenant_id, event_type_id, content_id)
select app.sid('tenant:alera'), app.sid('etype:' || ty), app.sid('library:' || k)
  from (values ('agenda-nordic','advisory'), ('agenda-uk','seminar'), ('agenda-uk','symposium'), ('agenda-uk','advisory')) as t(k, ty);
