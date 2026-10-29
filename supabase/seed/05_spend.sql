-- =====================================================================
-- Demo seed 05 — spend
-- * The demo invoices the Invoice Agent can "read" (files in apps/web/public/demo-invoices).
-- * Derm Roundtable (held, in execution): signed contracts for its two experts and its spend —
--   the meeting room, a dinner split across everyone who attended, Prof Vogel's hotel and
--   Dr Brandt's train. Together they make a complete ToV picture.
-- =====================================================================

insert into public.demo_invoice (file_pattern, vendor, invoice_number, invoice_date_offset, description, spend_type, amount, currency, recipient, guest_name, lines) values
  ('dinner',   'Restaurant Kokkeriet',      'KK-2026-0418', 0,  'Faculty dinner, 3 courses with wine pairing',            'meals',         1260.00, 'EUR', 'attended', null,
   '[{"desc":"Dinner menu, 3 courses","qty":12,"unit":85,"total":1020},{"desc":"Wine pairing","qty":12,"unit":20,"total":240}]'),
  ('hotel',    'Copenhagen Marriott Hotel', 'MCPH-55102',   1,  'Accommodation, 1 night (deluxe room, breakfast)',        'accommodation',  265.00, 'EUR', 'one', 'Muir',
   '[{"desc":"Deluxe room, 1 night","qty":1,"unit":239,"total":239},{"desc":"Breakfast","qty":1,"unit":26,"total":26}]'),
  ('av-rental','Nordic Stage AV',           'NSAV-2291',    2,  'AV rental: projector, screen, 4 wireless microphones',   'equipment',     1480.00, 'EUR', 'none', null,
   '[{"desc":"Projector and 120\" screen","qty":1,"unit":620,"total":620},{"desc":"Wireless microphone","qty":4,"unit":140,"total":560},{"desc":"Technician, 4 hours","qty":4,"unit":75,"total":300}]'),
  ('taxi',     'Taxa 4x35',                 'T-4471-0926',  0,  'Taxi, airport to venue',                                 'travel',          58.40, 'EUR', 'one', 'Griffiths',
   '[{"desc":"Airport transfer","qty":1,"unit":58.40,"total":58.40}]');

-- Derm Roundtable: Prof Vogel signed a Work Order under her MSA, Dr Brandt a Single-event Contract
insert into public.contract (id, tenant_id, contract_number, contract_type, status, title, event_expert_id, parent_contract_id,
                             start_date, end_date, template_version_id, clm_reference, sent_at, signed_at)
select app.sid('contract:derm-' || k), app.sid('tenant:alera'), prefix || '-' || extract(year from current_date) || '-' || num,
       ty, 'executed', title, app.sid('expert:derm-roundtable:' || k), parent,
       current_date - 6, current_date - 6, app.template_version_on(app.sid('tpl:' || tpl), current_date - 6), clm,
       now() - interval '24 days', now() - interval '20 days'
  from (values
    ('vogel',  'WO',  '0402', 'work_order',     'Work Order — Derm Roundtable',            app.sid('contract:msa-vogel'), 'wo',  'ICX-AG-30402'),
    ('brandt', 'SEC', '0403', 'event_contract', 'Single-event Contract — Derm Roundtable', null::uuid,                    'sec', 'ICX-AG-30403')
  ) as t(k, prefix, num, ty, title, parent, tpl, clm);
select app.render_contract(id) from public.contract where id in (app.sid('contract:derm-vogel'), app.sid('contract:derm-brandt'));
select app.sync_number_sequences();

-- Derm Roundtable spend, recorded by Lisa (the logistics organiser); the dinner was read by the Invoice Agent
insert into public.event_spend (id, tenant_id, event_id, spend_type, tov_category, spend_date, description, vendor, invoice_number,
                                amount, currency, source, drafted_by, created_by, created_at)
select app.sid('spend:derm:' || k), app.sid('tenant:alera'), app.sid('event:derm-roundtable'), ty, cat, current_date + d,
       descr, vendor, inv, amt, 'EUR', src, case when src = 'scan' then app.sid('user:agent-invoice') end, app.sid('user:lisa'), now() - interval '4 days'
  from (values
    ('room',   'venue',         'not_reportable',       -6, 'Meeting room Alster, half day with coffee service', 'Hotel Atlantic Hamburg', 'HA-2026-1187', 1850.00, 'manual'),
    ('dinner', 'meals',         'hospitality',          -6, 'Roundtable dinner, 3 courses',                     'Hotel Atlantic Hamburg', 'HA-2026-1188',  640.00, 'scan'),
    ('hotel',  'accommodation', 'travel_accommodation', -5, 'Accommodation, 1 night',                           'Hotel Atlantic Hamburg', 'HA-2026-1191',  245.00, 'manual'),
    ('train',  'travel',        'travel_accommodation', -6, 'Train, Berlin to Hamburg and back (2nd class)',    'Deutsche Bahn',          'DB-8841-2210',  129.90, 'manual')
  ) as t(k, ty, cat, d, descr, vendor, inv, amt, src);

select app.spread_spend(app.sid('spend:derm:dinner'),
  array[app.sid('att:derm-roundtable:vogel'), app.sid('att:derm-roundtable:brandt'), app.sid('att:derm-roundtable:paul')]);
select app.spread_spend(app.sid('spend:derm:hotel'), array[app.sid('att:derm-roundtable:vogel')]);
select app.spread_spend(app.sid('spend:derm:train'), array[app.sid('att:derm-roundtable:brandt')]);
