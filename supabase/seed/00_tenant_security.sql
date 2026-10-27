-- =====================================================================
-- Demo seed 00 — tenant, profiles, permissions, groups
-- Deterministic IDs: app.sid('<key>') = md5(key)::uuid, so every seed
-- object has a stable, guessable ID across resets.
-- =====================================================================

create or replace function app.sid(p_key text) returns uuid
language sql immutable as $$ select md5(p_key)::uuid $$;
comment on function app.sid(text) is 'Deterministic UUID from a key — used by demo seeds and scripts.';

insert into public.tenant (id, name, slug, brand_name, brand_color)
values (app.sid('tenant:alera'), 'Alera Pharma', 'alera', 'Alera Pharma', '#b42318');

insert into public.profile (id, tenant_id, name, description, is_admin, can_access_admin) values
  (app.sid('profile:admin'),       app.sid('tenant:alera'), 'System Admin',      'Full access, manages configuration and users', true,  true),
  (app.sid('profile:bizadmin'),    app.sid('tenant:alera'), 'Business Admin',    'Maintains products, therapeutic areas and users; reads everything', false, true),
  (app.sid('profile:coordinator'), app.sid('tenant:alera'), 'Event Coordinator', 'Runs strategic events end to end', false, false),
  (app.sid('profile:collaborator'),app.sid('tenant:alera'), 'Collaborator',      'Contributes to events: medical, compliance, requesters', false, false),
  (app.sid('profile:agent'),       app.sid('tenant:alera'), 'Agent',             'AI agents acting for a named human; narrow write access', false, false);

-- Object permissions -------------------------------------------------
with objects(obj) as (values
  ('event_type'),('therapeutic_area'),('product'),('specialty'),('crm_connection'),
  ('hco'),('hcp'),('fmv_rate'),
  ('event_request'),('event'),('event_product'),('event_team_member'),('event_session'),
  ('event_expert'),('event_session_speaker'),('event_attendee'),('event_contracting_org'),
  ('content'),('event_content'),('contract'),
  ('event_expert_contract'),('event_attendee_contract'),('org_contract'),
  ('event_post'),('event_post_reaction'),('event_task'),
  ('approval_process'),('approval_process_step'),('approval'),('approval_action'),
  ('user_group'),('user_group_member'),('audit_log'),('custom_field'),('custom_field_layout'),
  ('event_type_country'),('app_user_country')
),
config(obj) as (values ('event_type'),('therapeutic_area'),('product'),('specialty'),('crm_connection'),
                       ('approval_process'),('approval_process_step'),('user_group'),('user_group_member'),
                       ('custom_field'),('custom_field_layout'),
                       ('event_type_country'),('app_user_country'))
-- Event Coordinator: full CRUD on operational data, read-only on configuration
insert into public.permission (tenant_id, profile_id, object_name, can_read, can_create, can_edit, can_delete, view_all)
select app.sid('tenant:alera'), app.sid('profile:coordinator'), o.obj,
       true,
       o.obj not in (select obj from config) and o.obj <> 'audit_log',
       o.obj not in (select obj from config) and o.obj <> 'audit_log',
       o.obj not in (select obj from config) and o.obj <> 'audit_log',
       true
  from objects o;

-- Collaborator: read everything; contribute to the team board, tasks, content, attendees, requests
insert into public.permission (tenant_id, profile_id, object_name, can_read, can_create, can_edit, can_delete)
select app.sid('tenant:alera'), app.sid('profile:collaborator'), o.obj, true,
       o.obj in ('event_post','event_post_reaction','event_task','content','event_content','event_request','event_attendee'),
       o.obj in ('event_post','event_task','content','event_content','event_request','event_attendee'),
       o.obj in ('event_post_reaction')
  from (values
    ('event_type'),('therapeutic_area'),('product'),('specialty'),('crm_connection'),
    ('hco'),('hcp'),('fmv_rate'),('event_request'),('event'),('event_product'),('event_team_member'),
    ('event_session'),('event_expert'),('event_session_speaker'),('event_attendee'),('event_contracting_org'),
    ('content'),('event_content'),('contract'),('event_expert_contract'),('event_attendee_contract'),('org_contract'),
    ('event_post'),('event_post_reaction'),('event_task'),('approval'),('approval_action'),('audit_log'),
    ('custom_field'),('custom_field_layout'),
    ('event_type_country'),('app_user_country')
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
    ('event_type_country')
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
        ('content'),('event_content'),('contract'),('event_post'),('event_task'),('approval'),('approval_action'),
        ('audit_log'),('custom_field'),('custom_field_layout'),
        ('event_type_country'),('app_user'),('app_user_country')
      ) as v(obj)
  ) as o(obj, w);

insert into public.user_group (id, tenant_id, name, description) values
  (app.sid('group:hq-events'), app.sid('tenant:alera'), 'HQ Events',      'Global strategic events team'),
  (app.sid('group:medical'),   app.sid('tenant:alera'), 'Medical Affairs','Medical leads and reviewers');
