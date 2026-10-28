-- =====================================================================
-- Demo seed 02 — tenant configuration, CRM connections, HCOs, HCPs, FMV
-- =====================================================================

insert into public.event_type (id, tenant_id, name, description, default_duration_minutes)
select app.sid('etype:' || k), app.sid('tenant:alera'), n, d, m
  from (values
    ('advisory',   'Advisory board',       'Small expert group advising on clinical or strategic questions', 150),
    ('conference', 'Conference',           'Company presence or satellite at a scientific congress',         480),
    ('symposium',  'Symposium',            'Company-organised scientific symposium',                         240),
    ('seminar',    'Seminar',              'Educational meeting for HCPs',                                   180),
    ('roundtable', 'Roundtable',           'Moderated expert discussion',                                    120),
    ('workshop',   'Workshop',             'Hands-on training session',                                      240),
    ('investigator','Investigator meeting','Clinical trial investigator meeting',                            480),
    ('internal',   'Internal meeting',     'Internal planning or training',                                  120)
  ) as t(k, n, d, m);

insert into public.therapeutic_area (id, tenant_id, name)
select app.sid('ta:' || k), app.sid('tenant:alera'), n
  from (values ('neuro','Neuroscience'), ('rare','Rare Diseases'), ('onc','Oncology'),
               ('resp','Respiratory'), ('derm','Dermatology'), ('cardio','Cardiology'), ('immuno','Immunology')) t(k, n);

insert into public.product (id, tenant_id, name, therapeutic_area_id)
select app.sid('product:' || k), app.sid('tenant:alera'), n, app.sid('ta:' || ta)
  from (values ('raspinol','Raspinol','rare'), ('telia','Telia','neuro'), ('oncavir','Oncavir','onc'),
               ('brevair','Brevair','resp'), ('dermalux','Dermalux','derm')) t(k, n, ta);

insert into public.specialty (id, tenant_id, name)
select app.sid('spec:' || k), app.sid('tenant:alera'), n
  from (values ('neuro','Neurology'), ('paed','Paediatrics'), ('onc','Oncology'), ('pulm','Pulmonology'),
               ('derm','Dermatology'), ('cardio','Cardiology'), ('genetics','Clinical Genetics'), ('psych','Psychiatry')) t(k, n);

insert into public.crm_connection (id, tenant_id, name, system, region, status, last_sync_at) values
  (app.sid('crm:veeva-eu'),  app.sid('tenant:alera'), 'Veeva CRM – EU',     'veeva_crm',      'EMEA', 'active', now() - interval '2 hours'),
  (app.sid('crm:vault-nord'),app.sid('tenant:alera'), 'Vault CRM – Nordics','vault_crm',      'EMEA', 'active', now() - interval '40 minutes'),
  (app.sid('crm:sfdc-us'),   app.sid('tenant:alera'), 'Salesforce – US',    'salesforce_lsc', 'NA',   'active', now() - interval '5 hours');

-- HCOs ---------------------------------------------------------------------
insert into public.hco (id, tenant_id, name, hco_type, country_code, city, address, crm_connection_id, crm_external_id, onekey_id)
select app.sid('hco:' || k), app.sid('tenant:alera'), n, ty, c, city, addr, app.sid('crm:' || crm), ext, ok
  from (values
    ('aarhus',     'Aarhus University Hospital',   'hospital', 'DK', 'Aarhus',     'Palle Juul-Jensens Blvd. 99', 'vault-nord', 'VN-ACC-100231', 'WDKH00012345'),
    ('rigs',       'Rigshospitalet',               'hospital', 'DK', 'Copenhagen', 'Blegdamsvej 9',               'vault-nord', 'VN-ACC-100118', 'WDKH00010001'),
    ('odense',     'Odense University Hospital',   'hospital', 'DK', 'Odense',     'J. B. Winsløws Vej 4',        'vault-nord', 'VN-ACC-100342', 'WDKH00013311'),
    ('aalborg',    'Aalborg University Hospital',  'hospital', 'DK', 'Aalborg',    'Hobrovej 18-22',              'vault-nord', 'VN-ACC-100377', 'WDKH00014020'),
    ('herlev',     'Herlev Hospital',              'hospital', 'DK', 'Herlev',     'Borgmester Ib Juuls Vej 1',   'vault-nord', 'VN-ACC-100410', 'WDKH00015502'),
    ('hus',        'Helsinki University Hospital', 'hospital', 'FI', 'Helsinki',   'Haartmaninkatu 4',            'vault-nord', 'VN-ACC-200017', 'WFIH00020017'),
    ('oslo',       'Oslo University Hospital',     'hospital', 'NO', 'Oslo',       'Sognsvannsveien 20',          'vault-nord', 'VN-ACC-300044', 'WNOH00030044'),
    ('karolinska', 'Karolinska University Hospital','hospital','SE', 'Stockholm',  'Eugeniavägen 3',              'vault-nord', 'VN-ACC-400009', 'WSEH00040009'),
    ('charite',    'Charité – Universitätsmedizin Berlin','university','DE','Berlin','Charitéplatz 1',            'veeva-eu',   'VE-ACC-500120', 'WDEH00050120'),
    ('uke',        'University Medical Center Hamburg-Eppendorf','hospital','DE','Hamburg','Martinistraße 52',    'veeva-eu',   'VE-ACC-500377', 'WDEH00050377'),
    ('mgh',        'Massachusetts General Hospital','hospital','US', 'Boston',     '55 Fruit St',                 'sfdc-us',    '001US0000MGH01', null),
    ('marriott-cph','Copenhagen Marriott Hotel',   'venue',    'DK', 'Copenhagen', 'Kalvebod Brygge 5',           null,         null,            null),
    ('dsn',        'Danish Neurological Society',  'society',  'DK', 'Copenhagen', 'Kristianiagade 12',           'vault-nord', 'VN-ACC-100999', null)
  ) as t(k, n, ty, c, city, addr, crm, ext, ok);

update public.hco set source = 'manual' where crm_connection_id is null;

-- HCPs ---------------------------------------------------------------------
insert into public.hcp (id, tenant_id, salutation, first_name, last_name, specialty_id, primary_hco_id, country_code, city,
                        email, tier, crm_connection_id, crm_external_id, onekey_id)
select app.sid('hcp:' || k), app.sid('tenant:alera'), sal, fn, ln, app.sid('spec:' || sp), app.sid('hco:' || hco), c, city,
       lower(fn) || '.' || lower(replace(ln,'ø','o')) || '@' || dom, tier, app.sid('crm:' || crm), ext, ok
  from (values
    ('muir',      'Dr',   'Alison',  'Muir',      'neuro',    'aarhus',     'DK','Aarhus',     'auh.example',      'Tier 1','vault-nord','VN-HCP-771201','WDKM00700001'),
    ('griffiths', 'Dr',   'Richard', 'Griffiths', 'neuro',    'rigs',       'DK','Copenhagen', 'rh.example',       'Tier 1','vault-nord','VN-HCP-771244','WDKM00700002'),
    ('holm',      'Dr',   'Mette',   'Holm',      'paed',     'odense',     'DK','Odense',     'ouh.example',      'Tier 2','vault-nord','VN-HCP-771390','WDKM00700003'),
    ('lind',      'Dr',   'Jonas',   'Lind',      'neuro',    'aalborg',    'DK','Aalborg',    'aauh.example',     'Tier 2','vault-nord','VN-HCP-771455','WDKM00700004'),
    ('sorensen',  'Dr',   'Eva',     'Sørensen',  'neuro',    'herlev',     'DK','Herlev',     'herlev.example',   'Tier 3','vault-nord','VN-HCP-771502','WDKM00700005'),
    ('vaaranen',  'Prof', 'Anni',    'Vaaranen',  'genetics', 'hus',        'FI','Helsinki',   'hus.example',      'Tier 1','vault-nord','VN-HCP-880017','WFIM00800001'),
    ('huesh',     'Dr',   'Todd',    'Huesh',     'neuro',    'mgh',        'US','Boston',     'mgh.example',      'Tier 1','sfdc-us',   '003US00TH0001', null),
    ('solberg',   'Dr',   'Ingrid',  'Solberg',   'neuro',    'oslo',       'NO','Oslo',       'ous.example',      'Tier 2','vault-nord','VN-HCP-990044','WNOM00900001'),
    ('eriksson',  'Prof', 'Lars',    'Eriksson',  'genetics', 'karolinska', 'SE','Stockholm',  'karolinska.example','Tier 1','vault-nord','VN-HCP-660009','WSEM00600001'),
    ('novak',     'Dr',   'Klara',   'Novak',     'neuro',    'charite',    'DE','Berlin',     'charite.example',  'Tier 2','veeva-eu',  'VE-HCP-550120','WDEM00500001'),
    ('brandt',    'Dr',   'Henrik',  'Brandt',    'derm',     'uke',        'DE','Hamburg',    'uke.example',      'Tier 2','veeva-eu',  'VE-HCP-550377','WDEM00500002'),
    ('vogel',     'Prof', 'Julia',   'Vogel',     'derm',     'uke',        'DE','Hamburg',    'uke.example',      'Tier 1','veeva-eu',  'VE-HCP-550401','WDEM00500003'),
    ('haugland',  'Dr',   'Erik',    'Haugland',  'psych',    'oslo',       'NO','Oslo',       'ous.example',      'Tier 3','vault-nord','VN-HCP-990071','WNOM00900002'),
    ('rantanen',  'Dr',   'Mikko',   'Rantanen',   'pulm',     'hus',        'FI','Helsinki',   'hus.example',      'Tier 2','vault-nord','VN-HCP-880057','WFIM00800003'),
    ('weiss',     'Prof', 'Andreas', 'Weiss',     'onc',      'charite',    'DE','Berlin',     'charite.example',  'Tier 1','veeva-eu',  'VE-HCP-550512','WDEM00500004'),
    ('larsen',    'Dr',   'Camilla', 'Larsen',    'cardio',   'rigs',       'DK','Copenhagen', 'rh.example',       'Tier 3','vault-nord','VN-HCP-771688','WDKM00700007'),
    ('okafor',    'Dr',   'Grace',   'Okafor',    'onc',      'mgh',        'US','Boston',     'mgh.example',      'Tier 2','sfdc-us',   '003US00GO0002', null)
  ) as t(k, sal, fn, ln, sp, hco, c, city, dom, tier, crm, ext, ok);

-- Eligibility: who may be engaged (new experts start in review)
update public.hcp h set eligibility = e.elig, eligibility_note = e.note
  from (values
    ('muir','eligible',null), ('griffiths','eligible',null), ('sorensen','eligible',null), ('vaaranen','eligible',null),
    ('solberg','eligible',null), ('eriksson','eligible',null), ('novak','eligible',null), ('brandt','eligible',null),
    ('vogel','eligible',null), ('haugland','eligible',null), ('weiss','eligible',null), ('okafor','eligible',null),
    ('holm','ineligible','Annual engagement cap reached for Denmark (6 of 6). Eligible again from 1 January.'),
    ('larsen','ineligible','Debarment screening returned a possible name match. Compliance is confirming identity.'),
    ('lind','pending','Conflict-of-interest declaration requested; not yet returned.'),
    ('huesh','pending','Awaiting Open Payments (Sunshine Act) attestation for cross-border engagements.'),
    ('rantanen','pending','New expert: qualification and FMV assessment in progress.')
  ) as e(k, elig, note)
 where h.id = app.sid('hcp:' || e.k);

-- FMV rates (EUR / hour): the current record (valid two years), and the previous one for some
insert into public.fmv_rate (id, tenant_id, hcp_id, rate, min_rate, max_rate, currency, effective_date, expiration_date)
select app.sid('fmv:' || k || ':' || p), app.sid('tenant:alera'), app.sid('hcp:' || k), rate,
       round(rate * 0.8 / 10) * 10, round(rate * 1.2 / 10) * 10, 'EUR',
       current_date - 210 - 730 * p, current_date - 210 - 730 * p + 729
  from (values
    ('muir',0,280), ('griffiths',0,280), ('holm',0,250), ('lind',0,250), ('sorensen',0,210), ('vaaranen',0,320),
    ('huesh',0,350), ('solberg',0,240), ('eriksson',0,320), ('novak',0,240), ('brandt',0,230), ('vogel',0,290),
    ('haugland',0,200), ('weiss',0,330), ('larsen',0,190), ('okafor',0,260),
    -- previous periods
    ('muir',1,260), ('griffiths',1,250), ('eriksson',1,300), ('vogel',1,270), ('holm',1,230)
  ) as t(k, p, rate);

-- Event type configuration -----------------------------------------------------
-- Countries each event type is available in
insert into public.event_type_country (event_type_id, country_code, tenant_id)
select app.sid('etype:' || t.k), c.code, app.sid('tenant:alera')
  from (values ('advisory'), ('conference'), ('symposium'), ('seminar'), ('roundtable'), ('workshop'), ('internal')) as t(k)
 cross join (values ('AT'),('BE'),('CH'),('DE'),('DK'),('ES'),('FI'),('FR'),('GB'),('IE'),('IT'),('NL'),('NO'),('PL'),('PT'),('SE')) as c(code)
union all
select app.sid('etype:conference'), 'US', app.sid('tenant:alera')
union all
select app.sid('etype:investigator'), c.code, app.sid('tenant:alera') from (values ('GB'), ('DE'), ('US')) as c(code);

-- Kinds of agenda item
insert into public.session_kind (tenant_id, name, sort)
select app.sid('tenant:alera'), n, srt
  from (values ('Housekeeping', 10), ('Chair introduction', 20), ('Presentation', 30), ('Panel / Q&A', 40), ('Discussion', 50),
               ('Workshop', 60), ('Break', 70), ('Meal', 80), ('Networking', 90), ('Summary', 100)) as t(n, srt);
