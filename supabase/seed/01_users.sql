-- =====================================================================
-- Demo seed 01 — users (humans + agents) and their logins
-- All demo logins share the password below. Change it for anything public.
-- =====================================================================

-- Login accounts (Supabase Auth). Agents get one too: they authenticate
-- like any client and are bound by the same row-level security.
with u(key, email) as (values
  ('paul',    'paul.taylor@alera.example'),
  ('sarah',   'sarah.mitchell@alera.example'),
  ('lisa',    'lisa.anderson@alera.example'),
  ('michael', 'michael.chen@alera.example'),
  ('emma',    'emma.thompson@alera.example'),
  ('carlos',  'carlos.rodriguez@alera.example'),
  ('klaus',   'klaus.weber@alera.example'),
  ('ingrid',  'ingrid.haugen@alera.example'),
  ('alex',    'alex.morgan@alera.example'),
  ('maria',   'maria.castillo@alera.example'),
  ('daniel',  'daniel.novak@alera.example'),
  ('agent-compliance', 'compliance-agent@agents.alera.example'),
  ('agent-invoice',    'invoice-agent@agents.alera.example')
),
ins as (
  insert into auth.users (instance_id, id, aud, role, email, encrypted_password, email_confirmed_at,
                          raw_app_meta_data, raw_user_meta_data, created_at, updated_at,
                          confirmation_token, recovery_token, email_change_token_new, email_change)
  select '00000000-0000-0000-0000-000000000000', app.sid('auth:' || key), 'authenticated', 'authenticated', email,
         extensions.crypt('EC-demo-2026!', extensions.gen_salt('bf')), now(),
         '{"provider":"email","providers":["email"]}'::jsonb, '{}'::jsonb, now(), now(), '', '', '', ''
    from u
  on conflict (id) do nothing
  returning id, email
)
insert into auth.identities (provider_id, user_id, identity_data, provider, last_sign_in_at, created_at, updated_at)
select ins.id::text, ins.id, jsonb_build_object('sub', ins.id::text, 'email', ins.email, 'email_verified', true),
       'email', now(), now(), now()
  from ins
on conflict do nothing;

-- People ------------------------------------------------------------------
insert into public.app_user (id, tenant_id, user_type, auth_user_id, first_name, last_name, display_name, email,
                             job_title, initials, avatar_color, profile_id) values
  (app.sid('user:paul'),    app.sid('tenant:alera'), 'human', app.sid('auth:paul'),    'Paul',    'Taylor',    'Paul Taylor',      'paul.taylor@alera.example',      'Senior Event Manager, HQ Events', 'PT', '#2d3b45', app.sid('profile:coordinator')),
  (app.sid('user:sarah'),   app.sid('tenant:alera'), 'human', app.sid('auth:sarah'),   'Sarah',   'Mitchell',  'Sarah Mitchell',   'sarah.mitchell@alera.example',   'Medical Lead, Neuroscience',      'SM', '#2f9e5f', app.sid('profile:collaborator')),
  (app.sid('user:lisa'),    app.sid('tenant:alera'), 'human', app.sid('auth:lisa'),    'Lisa',    'Anderson',  'Lisa Anderson',    'lisa.anderson@alera.example',    'Event Logistics Manager',         'LA', '#e8731a', app.sid('profile:coordinator')),
  (app.sid('user:michael'), app.sid('tenant:alera'), 'human', app.sid('auth:michael'), 'Michael', 'Chen',      'Michael Chen',     'michael.chen@alera.example',     'Medical Affairs Director',        'MC', '#1a9af0', app.sid('profile:collaborator')),
  (app.sid('user:emma'),    app.sid('tenant:alera'), 'human', app.sid('auth:emma'),    'Emma',    'Thompson',  'Emma Thompson',    'emma.thompson@alera.example',    'Brand Manager, Rare Disease',     'ET', '#7c5cbf', app.sid('profile:collaborator')),
  (app.sid('user:carlos'),  app.sid('tenant:alera'), 'human', app.sid('auth:carlos'),  'Carlos',  'Rodriguez', 'Carlos Rodriguez', 'carlos.rodriguez@alera.example', 'Medical Science Liaison, Spain',  'CR', '#12b1a4', app.sid('profile:collaborator')),
  (app.sid('user:klaus'),   app.sid('tenant:alera'), 'human', app.sid('auth:klaus'),   'Klaus',   'Weber',     'Klaus Weber',      'klaus.weber@alera.example',      'Medical Manager, Germany',        'KW', '#1a9af0', app.sid('profile:collaborator')),
  (app.sid('user:ingrid'),  app.sid('tenant:alera'), 'human', app.sid('auth:ingrid'),  'Ingrid',  'Haugen',    'Ingrid Haugen',    'ingrid.haugen@alera.example',    'Country Medical Lead, Norway',    'IH', '#c2410c', app.sid('profile:collaborator')),
  (app.sid('user:alex'),    app.sid('tenant:alera'), 'human', app.sid('auth:alex'),    'Alex',    'Morgan',    'Alex Morgan',      'alex.morgan@alera.example',       'EC System Administrator',         'AM', '#5c6670', app.sid('profile:admin')),
  (app.sid('user:maria'),   app.sid('tenant:alera'), 'human', app.sid('auth:maria'),   'Maria',   'Castillo',  'Maria Castillo',   'maria.castillo@alera.example',    'Business Systems Manager',        'MA', '#0f766e', app.sid('profile:bizadmin')),
  (app.sid('user:daniel'),  app.sid('tenant:alera'), 'human', app.sid('auth:daniel'),  'Daniel',  'Novak',     'Daniel Novak',     'daniel.novak@alera.example',      'Key Account Manager, Nordics',    'DN', '#b45309', app.sid('profile:account-manager'));

-- Home countries, and the countries coordinators may create events in
update public.app_user u set country_code = c.code
  from (values ('paul','DK'), ('sarah','DK'), ('lisa','ES'), ('michael','GB'), ('emma','FI'), ('carlos','ES'),
               ('klaus','DE'), ('ingrid','NO'), ('alex','GB'), ('maria','NL'), ('daniel','DK')) as c(k, code)
 where u.id = app.sid('user:' || c.k);

insert into public.app_user_country (user_id, country_code, tenant_id)
select app.sid('user:' || k), code, app.sid('tenant:alera')
  from (values
    ('paul','DK'), ('paul','SE'), ('paul','NO'), ('paul','FI'), ('paul','DE'), ('paul','GB'), ('paul','FR'), ('paul','NL'),
    ('lisa','ES'), ('lisa','PT'), ('lisa','IT'), ('lisa','FR'), ('lisa','NO'), ('lisa','NL'),
    ('daniel','DK'), ('daniel','SE')
  ) as t(k, code);

-- Agents --------------------------------------------------------------------
insert into public.app_user (id, tenant_id, user_type, auth_user_id, display_name, email, job_title, initials,
                             avatar_color, profile_id, owner_user_id, agent_purpose) values
  (app.sid('user:agent-compliance'), app.sid('tenant:alera'), 'agent', app.sid('auth:agent-compliance'),
   'Compliance Agent', 'compliance-agent@agents.alera.example', 'AI agent', 'CA', '#5c6670',
   app.sid('profile:agent'), app.sid('user:paul'),
   'Checks HCP engagements against the plain-English compliance rules and records the outcome with its reasoning.'),
  (app.sid('user:agent-invoice'), app.sid('tenant:alera'), 'agent', app.sid('auth:agent-invoice'),
   'Invoice Agent', 'invoice-agent@agents.alera.example', 'AI agent', 'IA', '#5c6670',
   app.sid('profile:agent'), app.sid('user:lisa'),
   'Reads uploaded invoices and proposes expense lines for a human to confirm.');

insert into public.user_group_member (group_id, user_id, tenant_id) values
  (app.sid('group:hq-events'), app.sid('user:paul'),    app.sid('tenant:alera')),
  (app.sid('group:hq-events'), app.sid('user:lisa'),    app.sid('tenant:alera')),
  (app.sid('group:medical'),   app.sid('user:sarah'),   app.sid('tenant:alera')),
  (app.sid('group:medical'),   app.sid('user:michael'), app.sid('tenant:alera'));
