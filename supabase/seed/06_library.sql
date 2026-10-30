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
