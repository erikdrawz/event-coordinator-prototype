-- =====================================================================
-- Event Center — Contract templates are managed with the Content Library
-- They moved into Admin → Content Library, so the people who manage the Library (admin-area
-- profiles: System Admins and Business Admins) manage contract templates too: their versions
-- and the event types that use them. Everyone else keeps reading them.
-- =====================================================================
update public.permission pm
   set can_create = p.can_access_admin, can_edit = p.can_access_admin, can_delete = p.can_access_admin
  from public.profile p
 where p.id = pm.profile_id and p.can_access_admin
   and pm.object_name in ('contract_template', 'contract_template_version', 'event_type_contract_template');
