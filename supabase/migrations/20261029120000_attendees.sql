-- =====================================================================
-- Event Center — Attendees
-- * RSVP and CRM status become lookups (attendee_rsvp, attendee_crm_status), so clients read
--   labels and tones.
-- * A person attends an event once.
-- * A new HCP attendee gets their organisation (primary HCO) and, when the event uses them as an
--   expert, their role; an HCP who is a CRM account is reconciled with it straight away.
-- * add_event_attendees(event, people): adds many HCPs in one call, from EC or straight from a
--   CRM (copied into EC first, as crm_import_hcp does). People already attending are skipped.
-- =====================================================================

create table public.attendee_rsvp (
  code   text primary key,
  label  text not null,
  tone   text not null,
  sort   int  not null
);
insert into public.attendee_rsvp (code, label, tone, sort) values
  ('invited',   'Invited',   'yellow', 10),
  ('accepted',  'Accepted',  'green',  20),
  ('tentative', 'Tentative', 'blue',   30),
  ('declined',  'Declined',  'grey',   40);

create table public.attendee_crm_status (
  code   text primary key,
  label  text not null,
  tone   text not null,
  sort   int  not null
);
insert into public.attendee_crm_status (code, label, tone, sort) values
  ('pending',        'To reconcile',   'yellow', 10),
  ('reconciled',     'Reconciled',     'green',  20),
  ('not_found',      'Not found',      'red',    30),
  ('not_applicable', 'Not applicable', 'grey',   40);

do $$
declare t text;
begin
  foreach t in array array['attendee_rsvp', 'attendee_crm_status'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('create policy %I on public.%I for select to authenticated using (true)', t || '_read', t);
    execute format('revoke all on public.%I from anon', t);
    execute format('grant select on public.%I to authenticated', t);
  end loop;
end $$;
comment on table public.attendee_rsvp is 'Invitation answers: invited, accepted, tentative, declined.';
comment on table public.attendee_crm_status is 'Whether an attendee is matched to a CRM account: to reconcile, reconciled, not found, not applicable.';

alter table public.event_attendee
  drop constraint event_attendee_rsvp_check,
  drop constraint event_attendee_crm_status_check,
  add constraint event_attendee_rsvp_fkey foreign key (rsvp) references public.attendee_rsvp(code),
  add constraint event_attendee_crm_status_fkey foreign key (crm_status) references public.attendee_crm_status(code);
create unique index event_attendee_hcp_uq on public.event_attendee (event_id, hcp_id) where hcp_id is not null;
create unique index event_attendee_user_uq on public.event_attendee (event_id, user_id) where user_id is not null;

-- Defaults for a new attendee added by a user (seeds set their own)
create or replace function app.fill_attendee() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
declare h public.hcp;
begin
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
create trigger fill_attendee before insert on public.event_attendee
  for each row execute function app.fill_attendee();

-- ---------------------------------------------------------------------
-- add_event_attendees(event, people)
-- people: [{hcp_id} | {crm_connection_id, external_id}, …]
-- Returns {added, skipped, attendees: [ids of the new rows]}
-- ---------------------------------------------------------------------
create or replace function public.add_event_attendees(p_event_id uuid, p_people jsonb) returns jsonb
language plpgsql set search_path = public, pg_temp as $$
declare
  item    jsonb;
  hcp_ids uuid[] := '{}';
  h       public.hcp;
  added   uuid[];
begin
  if jsonb_typeof(p_people) is distinct from 'array' or jsonb_array_length(p_people) = 0 then
    raise exception 'Choose at least one person' using errcode = '22023';
  end if;
  if jsonb_array_length(p_people) > 500 then
    raise exception 'Add at most 500 people at a time' using errcode = '22023';
  end if;
  if not exists (select 1 from public.event where id = p_event_id) then
    raise exception 'Event not found' using errcode = 'P0002';
  end if;
  if not (app.has_perm('event_attendee', 'create') and app.can_edit_event(p_event_id)) then
    raise exception 'You can''t add attendees to this event' using errcode = '42501';
  end if;

  for item in select * from jsonb_array_elements(p_people) loop
    if item ? 'hcp_id' then
      hcp_ids := hcp_ids || (item ->> 'hcp_id')::uuid;
    elsif item ? 'crm_connection_id' and item ? 'external_id' then
      h := public.crm_import_hcp((item ->> 'crm_connection_id')::uuid, item ->> 'external_id');
      hcp_ids := hcp_ids || h.id;
    else
      raise exception 'Each person needs an hcp_id, or a crm_connection_id and external_id' using errcode = '22023';
    end if;
  end loop;

  if exists (select 1 from unnest(hcp_ids) i where not exists (select 1 from public.hcp where id = i)) then
    raise exception 'One of those HCPs doesn''t exist' using errcode = '22023';
  end if;

  with ins as (
    insert into public.event_attendee (event_id, attendee_kind, hcp_id)
    select p_event_id, 'hcp', i from (select distinct i from unnest(hcp_ids) i) d
    on conflict (event_id, hcp_id) where hcp_id is not null do nothing
    returning id
  )
  select coalesce(array_agg(id), '{}') into added from ins;

  return jsonb_build_object('added', cardinality(added),
                            'skipped', (select count(distinct i) from unnest(hcp_ids) i) - cardinality(added),
                            'attendees', to_jsonb(added));
end $$;
comment on function public.add_event_attendees(uuid, jsonb) is
  'Adds HCPs to an event''s attendees: [{hcp_id} | {crm_connection_id, external_id}]. CRM people are copied into EC first; people already attending are skipped. Returns {added, skipped, attendees}.';
grant execute on function public.add_event_attendees(uuid, jsonb) to authenticated;

grant execute on all functions in schema app to authenticated, service_role;
