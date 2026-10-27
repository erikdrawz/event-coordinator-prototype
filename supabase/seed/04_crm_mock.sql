-- =====================================================================
-- Demo data: what the customer's CRMs hold (crm_mock), searched by crm_search_hcp().
-- Every CRM-sourced HCP/HCO already in EC is mirrored into its own CRM, plus people who
-- are only in the CRMs. A few names repeat across CRMs on purpose:
--   - Dr Jonas Lind is also in Veeva CRM – EU, with the same OneKey ID as his EC record
--   - two different Dr Anna Bergs (Sweden, Germany) in two CRMs
-- "lind" finds people in all three CRMs.
-- =====================================================================

-- Organisations already in EC
insert into crm_mock.hco (crm_connection_id, external_id, name, hco_type, country_code, city, address, onekey_id)
select crm_connection_id, crm_external_id, name, hco_type, country_code, city, address, onekey_id
  from public.hco where crm_external_id is not null;

-- Organisations only in the CRMs
insert into crm_mock.hco (crm_connection_id, external_id, name, hco_type, country_code, city, address, onekey_id)
select app.sid('crm:' || crm), ext, n, ty, c, city, addr, ok
  from (values
    ('vault-nord', 'VN-ACC-400120', 'Uppsala University Hospital',       'hospital', 'SE', 'Uppsala',    'Akademiska sjukhuset',        'WSEH00040120'),
    ('vault-nord', 'VN-ACC-400210', 'Sahlgrenska University Hospital',   'hospital', 'SE', 'Gothenburg', 'Blå stråket 5',               'WSEH00040210'),
    ('vault-nord', 'VN-ACC-200044', 'Tampere University Hospital',       'hospital', 'FI', 'Tampere',    'Elämänaukio 2',               'WFIH00020044'),
    ('vault-nord', 'VN-ACC-300102', 'Haukeland University Hospital',     'hospital', 'NO', 'Bergen',     'Haukelandsveien 22',          'WNOH00030102'),
    ('veeva-eu',   'VE-ACC-500510', 'LMU Klinikum',                      'hospital', 'DE', 'Munich',     'Marchioninistraße 15',        'WDEH00050510'),
    ('veeva-eu',   'VE-ACC-600101', 'Pitié-Salpêtrière Hospital',        'hospital', 'FR', 'Paris',      '47-83 Boulevard de l''Hôpital','WFRH00060101'),
    ('veeva-eu',   'VE-ACC-600144', 'Necker-Enfants Malades Hospital',   'hospital', 'FR', 'Paris',      '149 Rue de Sèvres',           'WFRH00060144'),
    ('veeva-eu',   'VE-ACC-700021', 'La Paz University Hospital',        'hospital', 'ES', 'Madrid',     'Paseo de la Castellana 261',  'WESH00070021'),
    ('veeva-eu',   'VE-ACC-700088', 'Vall d''Hebron University Hospital','hospital', 'ES', 'Barcelona',  'Passeig de la Vall d''Hebron 119','WESH00070088'),
    ('veeva-eu',   'VE-ACC-800012', 'Policlinico di Milano',             'hospital', 'IT', 'Milan',      'Via Francesco Sforza 35',     'WITH00080012'),
    ('veeva-eu',   'VE-ACC-800077', 'Policlinico Gemelli',               'hospital', 'IT', 'Rome',       'Largo Agostino Gemelli 8',    'WITH00080077'),
    ('veeva-eu',   'VE-ACC-900015', 'Amsterdam UMC',                     'hospital', 'NL', 'Amsterdam',  'Meibergdreef 9',              'WNLH00090015'),
    ('veeva-eu',   'VE-ACC-910003', 'National Hospital for Neurology and Neurosurgery', 'hospital', 'GB', 'London', 'Queen Square', 'WGBH00091003'),
    ('veeva-eu',   'VE-ACC-500901', 'Aalborg University Hospital',       'hospital', 'DK', 'Aalborg',    'Hobrovej 18-22',              'WDKH00014020'),
    ('sfdc-us',    '001US0000JHH01','Johns Hopkins Hospital',            'hospital', 'US', 'Baltimore',  '1800 Orleans St',             null),
    ('sfdc-us',    '001US0000CHP01','Children''s Hospital of Philadelphia','hospital','US', 'Philadelphia','3401 Civic Center Blvd',    null),
    ('sfdc-us',    '001US0000MAY01','Mayo Clinic',                       'hospital', 'US', 'Rochester',  '200 First St SW',             null),
    ('sfdc-us',    '001US0000CCF01','Cleveland Clinic',                  'hospital', 'US', 'Cleveland',  '9500 Euclid Ave',             null)
  ) as t(crm, ext, n, ty, c, city, addr, ok);

-- HCPs already in EC, as their CRM holds them
insert into crm_mock.hcp (crm_connection_id, external_id, salutation, first_name, last_name, specialty, country_code, city,
                          email, tier, hco_external_id, onekey_id)
select h.crm_connection_id, h.crm_external_id, h.salutation, h.first_name, h.last_name, s.name, h.country_code, h.city,
       h.email, h.tier, o.crm_external_id, h.onekey_id
  from public.hcp h
  left join public.specialty s on s.id = h.specialty_id
  left join public.hco o on o.id = h.primary_hco_id and o.crm_connection_id = h.crm_connection_id
 where h.crm_external_id is not null;

-- HCPs only in the CRMs
insert into crm_mock.hcp (crm_connection_id, external_id, salutation, first_name, last_name, specialty, country_code, city,
                          postal_code, email, tier, hco_external_id, onekey_id)
select app.sid('crm:' || crm), ext, sal, fn, ln, sp, c, city, pc,
       lower(translate(fn, 'æøåäöüéíóúñ', 'aoaaoueioun')) || '.' || lower(translate(replace(ln, ' ', ''), 'æøåäöüéíóúñ''', 'aoaaoueioun')) || '@' || dom,
       tier, hco, ok
  from (values
    -- Vault CRM – Nordics
    ('vault-nord','VN-HCP-772190','Dr',  'Karin',   'Lindgren',   'Neurology',         'SE','Uppsala',    '751 85',  'akademiska.example', 'Tier 2','VN-ACC-400120','WSEM00600120'),
    ('vault-nord','VN-HCP-772214','Dr',  'Anna',    'Berg',       'Neurology',         'SE','Gothenburg', '413 45',  'sahlgrenska.example','Tier 2','VN-ACC-400210','WSEM00600210'),
    ('vault-nord','VN-HCP-772233','Prof','Erik',    'Johansson',  'Neurology',         'SE','Stockholm',  '171 76',  'karolinska.example', 'Tier 1','VN-ACC-400009','WSEM00600211'),
    ('vault-nord','VN-HCP-772251','Dr',  'Maja',    'Lindholm',   'Psychiatry',        'SE','Stockholm',  '171 76',  'karolinska.example', 'Tier 3','VN-ACC-400009','WSEM00600212'),
    ('vault-nord','VN-HCP-771610','Dr',  'Mikkel',  'Dahl',       'Paediatrics',       'DK','Aarhus',     '8200',    'auh.example',        'Tier 2','VN-ACC-100231','WDKM00700021'),
    ('vault-nord','VN-HCP-771633','Dr',  'Sofie',   'Kjær',       'Neurology',         'DK','Copenhagen', '2100',    'rh.example',         'Tier 2','VN-ACC-100118','WDKM00700022'),
    ('vault-nord','VN-HCP-771658','Prof','Henrik',  'Lund',       'Neurology',         'DK','Odense',     '5000',    'ouh.example',        'Tier 1','VN-ACC-100342','WDKM00700023'),
    ('vault-nord','VN-HCP-771672','Dr',  'Freja',   'Madsen',     'Clinical Genetics', 'DK','Copenhagen', '2100',    'rh.example',         'Tier 3','VN-ACC-100118','WDKM00700024'),
    ('vault-nord','VN-HCP-771699','Dr',  'Peter',   'Lindberg',   'Cardiology',        'DK','Aalborg',    '9000',    'aauh.example',       'Tier 3','VN-ACC-100377','WDKM00700025'),
    ('vault-nord','VN-HCP-880120','Dr',  'Elina',   'Virtanen',   'Neurology',         'FI','Helsinki',   '00290',   'hus.example',        'Tier 2','VN-ACC-200017','WFIM00800012'),
    ('vault-nord','VN-HCP-880133','Dr',  'Mikko',   'Laine',      'Paediatrics',       'FI','Helsinki',   '00290',   'hus.example',        'Tier 3','VN-ACC-200017','WFIM00800013'),
    ('vault-nord','VN-HCP-880147','Dr',  'Aino',    'Korhonen',   'Clinical Genetics', 'FI','Tampere',    '33520',   'tays.example',       'Tier 2','VN-ACC-200044','WFIM00800014'),
    ('vault-nord','VN-HCP-990112','Dr',  'Ole',     'Hansen',     'Neurology',         'NO','Oslo',       '0372',    'ous.example',        'Tier 2','VN-ACC-300044','WNOM00900012'),
    ('vault-nord','VN-HCP-990125','Dr',  'Kari',    'Nilsen',     'Paediatrics',       'NO','Bergen',     '5021',    'helse-bergen.example','Tier 3','VN-ACC-300102','WNOM00900013'),
    -- Veeva CRM – EU (Dr Jonas Lind again: same person as in EC, same OneKey ID)
    ('veeva-eu',  'VE-HCP-551902','Dr',  'Jonas',   'Lind',       'Neurology',         'DK','Aalborg',    '9000',    'aauh.example',       'Tier 2','VE-ACC-500901','WDKM00700004'),
    ('veeva-eu',  'VE-HCP-552010','Dr',  'Anna',    'Berg',       'Dermatology',       'DE','Munich',     '80336',   'lmu.example',        'Tier 2','VE-ACC-500510','WDEM00500021'),
    ('veeva-eu',  'VE-HCP-552033','Prof','Markus',  'Lindner',    'Cardiology',        'DE','Munich',     '80336',   'lmu.example',        'Tier 1','VE-ACC-500510','WDEM00500022'),
    ('veeva-eu',  'VE-HCP-550188','Dr',  'Sabine',  'Krüger',     'Neurology',         'DE','Berlin',     '10117',   'charite.example',    'Tier 2','VE-ACC-500120','WDEM00500023'),
    ('veeva-eu',  'VE-HCP-550392','Dr',  'Thomas',  'Weber',      'Oncology',          'DE','Hamburg',    '20246',   'uke.example',        'Tier 2','VE-ACC-500377','WDEM00500024'),
    ('veeva-eu',  'VE-HCP-560101','Dr',  'Claire',  'Dubois',     'Neurology',         'FR','Paris',      '75013',   'aphp.example',       'Tier 1','VE-ACC-600101','WFRM00600031'),
    ('veeva-eu',  'VE-HCP-560144','Prof','Antoine', 'Moreau',     'Paediatrics',       'FR','Paris',      '75015',   'aphp.example',       'Tier 1','VE-ACC-600144','WFRM00600032'),
    ('veeva-eu',  'VE-HCP-570021','Dr',  'Lucía',   'Fernández',  'Neurology',         'ES','Madrid',     '28046',   'lapaz.example',      'Tier 2','VE-ACC-700021','WESM00700041'),
    ('veeva-eu',  'VE-HCP-570088','Dr',  'Javier',  'Ruiz',       'Pulmonology',       'ES','Barcelona',  '08035',   'vallhebron.example', 'Tier 2','VE-ACC-700088','WESM00700042'),
    ('veeva-eu',  'VE-HCP-580012','Dr',  'Giulia',  'Romano',     'Neurology',         'IT','Milan',      '20122',   'policlinico.example','Tier 2','VE-ACC-800012','WITM00800051'),
    ('veeva-eu',  'VE-HCP-580077','Dr',  'Marco',   'Bianchi',    'Oncology',          'IT','Rome',       '00168',   'gemelli.example',    'Tier 2','VE-ACC-800077','WITM00800052'),
    ('veeva-eu',  'VE-HCP-590015','Dr',  'Sanne',   'de Vries',   'Neurology',         'NL','Amsterdam',  '1105 AZ', 'amsterdamumc.example','Tier 2','VE-ACC-900015','WNLM00900061'),
    ('veeva-eu',  'VE-HCP-591003','Dr',  'Emily',   'Clarke',     'Neurology',         'GB','London',     'WC1N 3BG','uclh.example',       'Tier 1','VE-ACC-910003','WGBM00910071'),
    ('veeva-eu',  'VE-HCP-591017','Dr',  'James',   'Whitfield',  'Paediatrics',       'GB','London',     'WC1N 3BG','uclh.example',       'Tier 2','VE-ACC-910003','WGBM00910072'),
    -- Salesforce – US (no OneKey IDs)
    ('sfdc-us',   '003US00RK0002','Dr',  'Rachel',  'Kim',        'Neurology',         'US','Boston',     '02114',   'mgh.example',        'Tier 2','001US0000MGH01', null),
    ('sfdc-us',   '003US00DC0003','Dr',  'David',   'Chen',       'Neurology',         'US','Boston',     '02114',   'mgh.example',        'Tier 2','001US0000MGH01', null),
    ('sfdc-us',   '003US00ML0004','Dr',  'Michael', 'Lindsay',    'Pulmonology',       'US','Baltimore',  '21287',   'jhmi.example',       'Tier 1','001US0000JHH01', null),
    ('sfdc-us',   '003US00LM0005','Dr',  'Laura',   'Martinez',   'Paediatrics',       'US','Philadelphia','19104',  'chop.example',       'Tier 2','001US0000CHP01', null),
    ('sfdc-us',   '003US00RH0006','Prof','Robert',  'Hayes',      'Clinical Genetics', 'US','Rochester',  '55905',   'mayo.example',       'Tier 1','001US0000MAY01', null),
    ('sfdc-us',   '003US00KO0007','Dr',  'Kevin',   'O''Brien',   'Cardiology',        'US','Cleveland',  '44195',   'ccf.example',        'Tier 2','001US0000CCF01', null)
  ) as t(crm, ext, sal, fn, ln, sp, c, city, pc, dom, tier, hco, ok);
