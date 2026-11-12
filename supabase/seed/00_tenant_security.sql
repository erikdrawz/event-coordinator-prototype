-- =====================================================================
-- Demo seed 00 — tenant, profiles, permissions, groups
-- Deterministic IDs: app.sid('<key>') = md5(key)::uuid, so every seed
-- object has a stable, guessable ID across resets.
-- =====================================================================

create or replace function app.sid(p_key text) returns uuid
language sql immutable as $$ select md5(p_key)::uuid $$;
comment on function app.sid(text) is 'Deterministic UUID from a key — used by demo seeds and scripts.';

-- Demos switch between people, so the top bar shows whose rights are in play
insert into public.tenant (id, name, slug, brand_name, brand_color, show_profile_badge)
values (app.sid('tenant:alera'), 'Alera Pharma', 'alera', 'Alera Pharma', '#b42318', true);

insert into public.profile (id, tenant_id, name, description, is_admin, can_access_admin) values
  (app.sid('profile:admin'),       app.sid('tenant:alera'), 'System Admin',      'Full access, manages configuration and users', true,  true),
  (app.sid('profile:bizadmin'),    app.sid('tenant:alera'), 'Business Admin',    'Maintains products, therapeutic areas and users; reads everything', false, true),
  (app.sid('profile:coordinator'), app.sid('tenant:alera'), 'Event Coordinator', 'Runs strategic events end to end', false, false),
  (app.sid('profile:collaborator'),app.sid('tenant:alera'), 'Collaborator',      'Contributes to events: medical, compliance, requesters', false, false),
  (app.sid('profile:account-manager'), app.sid('tenant:alera'), 'Account Manager', 'Field reps who meet HCPs and create their own events', false, false),
  (app.sid('profile:agent'),       app.sid('tenant:alera'), 'Agent',             'AI agents acting for a named human; narrow write access', false, false),
  (app.sid('profile:email-agent'), app.sid('tenant:alera'), 'Email Agent',       'Delivers replies to Event Center emails, acting for the person who replied', false, false);

-- Object permissions -------------------------------------------------
with objects(obj) as (values
  ('event_type'),('therapeutic_area'),('product'),('specialty'),('crm_connection'),
  ('hco'),('hcp'),('fmv_rate'),
  ('event_request'),('event'),('event_product'),('event_team_member'),('event_session'),
  ('event_expert'),('event_session_speaker'),('event_attendee'),('event_contracting_org'),
  ('content'),('event_content'),('contract'),
  ('event_attendee_contract'),('org_contract'),
  ('event_post'),('event_post_reaction'),('event_task'),
  ('approval_process'),('approval_process_step'),
  ('user_group'),('user_group_member'),('audit_log'),('custom_field'),('custom_field_layout'),
  ('event_type_country'),('app_user_country'),('session_kind')
),
config(obj) as (values ('event_type'),('therapeutic_area'),('product'),('specialty'),('crm_connection'),
                       ('approval_process'),('approval_process_step'),('user_group'),('user_group_member'),
                       ('custom_field'),('custom_field_layout'),
                       ('event_type_country'),('app_user_country'),('session_kind'))
-- Event Coordinator: full CRUD on operational data, read-only on configuration; events through their team
insert into public.permission (tenant_id, profile_id, object_name, can_read, can_create, can_edit, can_delete, view_all)
select app.sid('tenant:alera'), app.sid('profile:coordinator'), o.obj,
       true,
       o.obj not in (select obj from config) and o.obj <> 'audit_log',
       o.obj not in (select obj from config) and o.obj <> 'audit_log',
       o.obj not in (select obj from config) and o.obj <> 'audit_log',
       o.obj = 'event_request'   -- home office sees every submitted request; events only through their team
  from objects o;

-- Account Manager: as an Event Coordinator, except experts (HCPs, organisations, FMV rates) are
-- read-only (they can still add them to events) and they see only their own requests (no view_all)
insert into public.permission (tenant_id, profile_id, object_name, can_read, can_create, can_edit, can_delete, view_all)
select tenant_id, app.sid('profile:account-manager'), object_name, can_read,
       can_create and object_name not in ('hco', 'hcp', 'fmv_rate'),
       can_edit   and object_name not in ('hco', 'hcp', 'fmv_rate'),
       can_delete and object_name not in ('hco', 'hcp', 'fmv_rate'),
       false
  from public.permission where profile_id = app.sid('profile:coordinator');

-- Collaborator: read everything; contribute to the team board, tasks, content, attendees, requests
insert into public.permission (tenant_id, profile_id, object_name, can_read, can_create, can_edit, can_delete)
select app.sid('tenant:alera'), app.sid('profile:collaborator'), o.obj, true,
       o.obj in ('event_post','event_post_reaction','event_task','content','event_content','event_request','event_attendee'),
       o.obj in ('event_post','event_task','content','event_content','event_request','event_attendee'),
       o.obj in ('event_post_reaction','event_request')
  from (values
    ('event_type'),('therapeutic_area'),('product'),('specialty'),('crm_connection'),
    ('hco'),('hcp'),('fmv_rate'),('event_request'),('event'),('event_product'),('event_team_member'),
    ('event_session'),('event_expert'),('event_session_speaker'),('event_attendee'),('event_contracting_org'),
    ('content'),('event_content'),('contract'),('event_attendee_contract'),('org_contract'),
    ('event_post'),('event_post_reaction'),('event_task'),('audit_log'),
    ('custom_field'),('custom_field_layout'),
    ('event_type_country'),('app_user_country'),('session_kind')
  ) as o(obj);

-- Agent: read operational data; write only what agents are trusted to do
-- (expert checks, content/documents, posts). Everything audited with on-behalf-of.
insert into public.permission (tenant_id, profile_id, object_name, can_read, can_create, can_edit, can_delete)
select app.sid('tenant:alera'), app.sid('profile:agent'), o.obj, true,
       o.obj in ('content','event_content','event_post'),
       o.obj in ('event_expert','content','event_content'),
       false
  from (values
    ('event_type'),('hco'),('hcp'),('fmv_rate'),('event'),('event_team_member'),('event_session'),
    ('event_expert'),('event_session_speaker'),('event_attendee'),('content'),('event_content'),
    ('contract'),('event_post'),('event_task'),('custom_field'),('custom_field_layout'),
    ('event_type_country'),('session_kind')
  ) as o(obj);

-- Business Admin: reads everything; maintains products, therapeutic areas and users
-- (never System Admin accounts, enforced in RLS). Event types, their countries and
-- CRM connections stay with System Admin.
insert into public.permission (tenant_id, profile_id, object_name, can_read, can_create, can_edit, can_delete, view_all)
select app.sid('tenant:alera'), app.sid('profile:bizadmin'), o.obj, true, w, w, w, true
  from (
    select obj, obj in ('product','therapeutic_area','app_user','app_user_country') as w
      from (values
        ('event_type'),('therapeutic_area'),('product'),('specialty'),('crm_connection'),
        ('hco'),('hcp'),('fmv_rate'),('event_request'),('event'),('event_product'),('event_team_member'),
        ('event_session'),('event_expert'),('event_session_speaker'),('event_attendee'),('event_contracting_org'),
        ('content'),('event_content'),('contract'),('event_post'),('event_task'),
        ('audit_log'),('custom_field'),('custom_field_layout'),
        ('event_type_country'),('app_user'),('app_user_country'),('session_kind')
      ) as v(obj)
  ) as o(obj, w);

-- Groups: named sets of people. Access rules (02_reference_customers.sql) put some of them on
-- teams; approval processes use others. Members are added in 01_users.sql.
insert into public.user_group (id, tenant_id, name, description) values
  (app.sid('group:hq-events'),      app.sid('tenant:alera'), 'HQ Events',              'Global strategic events team'),
  (app.sid('group:south-europe'),   app.sid('tenant:alera'), 'Southern Europe Events', 'Runs events in Spain, Portugal and Italy'),
  (app.sid('group:uki-medical'),    app.sid('tenant:alera'), 'UKI Medical',            'Medical review for the UK and Ireland'),
  (app.sid('group:uki-marketing'),  app.sid('tenant:alera'), 'UKI Marketing',          'Marketing review for the UK and Ireland'),
  (app.sid('group:nordics-medical'),app.sid('tenant:alera'), 'Nordics Medical',        'Medical review for the Nordic countries'),
  (app.sid('group:dach-medical'),   app.sid('tenant:alera'), 'DACH Medical',           'Medical review for Germany, Austria and Switzerland'),
  (app.sid('group:compliance'),     app.sid('tenant:alera'), 'Compliance',             'Reviews expert tiering and anything outside the usual rules');

-- Request team and board: the same rights as the event team and board, except that a requester
-- (Collaborator) manages the team of their own requests
insert into public.permission (tenant_id, profile_id, object_name, can_read, can_create, can_edit, can_delete, view_all, modify_all)
select tenant_id, profile_id, 'request_' || substr(object_name, 7), can_read, can_create, can_edit, can_delete, view_all, modify_all
  from public.permission
 where object_name in ('event_team_member', 'event_post', 'event_post_reaction');
update public.permission set can_create = true, can_edit = true, can_delete = true
 where object_name = 'request_team_member' and profile_id = app.sid('profile:collaborator');

-- Spend and who received it: the same rights as attendees
insert into public.permission (tenant_id, profile_id, object_name, can_read, can_create, can_edit, can_delete, view_all, modify_all)
select tenant_id, profile_id, o, can_read, can_create, can_edit, can_delete, view_all, modify_all
  from public.permission, unnest(array['event_spend', 'event_spend_attribution']) o
 where object_name = 'event_attendee';

-- Contract templates live in the Content Library: everyone reads what they read of event types;
-- admin-area profiles (System and Business Admins) manage them
insert into public.permission (tenant_id, profile_id, object_name, can_read, can_create, can_edit, can_delete, view_all, modify_all)
select x.tenant_id, x.profile_id, o, x.can_read, p.can_access_admin, p.can_access_admin, p.can_access_admin, x.view_all, x.modify_all
  from public.permission x
  join public.profile p on p.id = x.profile_id
 cross join unnest(array['contract_template', 'contract_template_version', 'event_type_contract_template']) o
 where x.object_name = 'event_type';

-- The Library: everyone reads what they read of event types; admin-area profiles manage it
insert into public.permission (tenant_id, profile_id, object_name, can_read, can_create, can_edit, can_delete, view_all, modify_all)
select x.tenant_id, x.profile_id, o, x.can_read, p.can_access_admin, p.can_access_admin, p.can_access_admin, false, false
  from public.permission x
  join public.profile p on p.id = x.profile_id
 cross join unnest(array['library_item', 'event_type_content']) o
 where x.object_name = 'event_type';

-- Emails: everyone reads their own (a policy, not a permission); Business Admins read them all;
-- the Email Agent may deliver replies (receive_email) and nothing else
insert into public.permission (tenant_id, profile_id, object_name, can_read, can_create, can_edit, can_delete, view_all, modify_all) values
  (app.sid('tenant:alera'), app.sid('profile:bizadmin'),    'email_message', true, false, false, false, true, false),
  (app.sid('tenant:alera'), app.sid('profile:email-agent'), 'email_message', true, true,  false, false, false, false);

-- Groups and access rules: everyone who works on events reads them (to see who's on a team and
-- why); Business Admins manage them with users. Groups on teams go with the team.
insert into public.permission (tenant_id, profile_id, object_name, can_read)
select p.tenant_id, p.id, o, true
  from public.profile p
 cross join unnest(array['user_group', 'user_group_member', 'access_rule']) o
 where exists (select 1 from public.permission x where x.profile_id = p.id and x.object_name = 'event' and x.can_read)
on conflict (profile_id, object_name) do nothing;
update public.permission set can_create = true, can_edit = true, can_delete = true
 where profile_id = app.sid('profile:bizadmin') and object_name in ('user_group', 'user_group_member', 'access_rule');
insert into public.permission (tenant_id, profile_id, object_name, can_read, can_create, can_edit, can_delete, view_all, modify_all)
select tenant_id, profile_id, n.target, can_read, can_create, can_edit, can_delete, view_all, modify_all
  from public.permission x
  join (values ('event_team_member', 'event_team_group'), ('request_team_member', 'request_team_group')) n(source, target)
    on n.source = x.object_name;

-- Approval processes: everyone who works on events reads them; Business Admins manage them
insert into public.permission (tenant_id, profile_id, object_name, can_read)
select p.tenant_id, p.id, o, true
  from public.profile p
 cross join unnest(array['approval_process', 'approval_process_step']) o
 where exists (select 1 from public.permission x where x.profile_id = p.id and x.object_name = 'event' and x.can_read)
on conflict (profile_id, object_name) do update set can_read = true;
update public.permission set can_create = true, can_edit = true, can_delete = true
 where profile_id = app.sid('profile:bizadmin') and object_name in ('approval_process', 'approval_process_step');
