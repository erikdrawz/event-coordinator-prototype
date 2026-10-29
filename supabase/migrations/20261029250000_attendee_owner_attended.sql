-- =====================================================================
-- Attendees: an Owner and Attended
-- * owner_id: the user responsible for the attendee — whoever added them (seeds and older rows: the
--   event's owner). Editors can hand it to another active user.
-- * attended: yes or no, no by default.
-- =====================================================================

alter table public.event_attendee add column owner_id uuid references public.app_user(id);
comment on column public.event_attendee.owner_id is 'Who is responsible for this attendee; defaults to the user who added them.';
create index event_attendee_owner_idx on public.event_attendee (owner_id);
update public.event_attendee a set owner_id = coalesce(a.created_by, e.owner_id)
  from public.event e where e.id = a.event_id and a.owner_id is null;

update public.event_attendee set attended = false where attended is null;
alter table public.event_attendee alter column attended set default false, alter column attended set not null;
comment on column public.event_attendee.attended is 'Whether they attended: yes or no (no by default).';

-- The owner defaults to whoever adds the attendee (the event's owner for seeds), then fills the rest
create or replace function app.fill_attendee() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
declare h public.hcp;
begin
  new.owner_id := coalesce(new.owner_id, app.access_user_id(), (select e.owner_id from public.event e where e.id = new.event_id));
  if app.current_user_id() is null then return new; end if;
  if new.attendee_kind = 'hcp' then
    select * into h from public.hcp where id = new.hcp_id and tenant_id = app.current_tenant_id();
    if not found then raise exception 'That HCP doesn''t exist' using errcode = '22023'; end if;
    if new.organisation is null then
      select o.name into new.organisation from public.hco o where o.id = h.primary_hco_id;
    end if;
    if new.role_label is null then
      select initcap(x.role) into new.role_label from public.event_expert x where x.event_id = new.event_id and x.hcp_id = new.hcp_id;
    end if;
    if new.crm_connection_id is null and h.crm_connection_id is not null then
      new.crm_connection_id := h.crm_connection_id;
      new.crm_external_id := h.crm_external_id;
      new.crm_status := 'reconciled';
    end if;
  elsif new.attendee_kind = 'user' then
    new.crm_status := 'not_applicable';
  end if;
  return new;
end $$;

-- An owner is an active person in the same tenant
create or replace function app.check_attendee_owner() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if new.owner_id is not null and not exists (
       select 1 from public.app_user u
        where u.id = new.owner_id and u.tenant_id = coalesce(new.tenant_id, app.current_tenant_id()) and u.status = 'active' and u.user_type = 'human') then
    raise exception 'The owner must be an active user' using errcode = '23503';
  end if;
  return new;
end $$;
create trigger check_attendee_owner before insert or update of owner_id on public.event_attendee
  for each row execute function app.check_attendee_owner();

grant execute on all functions in schema app to authenticated, service_role;
