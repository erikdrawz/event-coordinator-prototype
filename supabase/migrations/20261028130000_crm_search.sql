-- =====================================================================
-- Event Coordinator — CRM search and import (mock CRMs, real interface)
-- crm_mock.* stands in for the customer's CRM instances (one set of rows per crm_connection).
-- It is not exposed through the API: clients go through two functions a real connector will
-- implement the same way:
--   crm_search_hcp(p)                 search one or all CRM connections
--   crm_import_hcp(connection, id)    copy a CRM HCP (and their organisation) into hcp / hco
-- Import is idempotent: the same CRM record is never copied twice, and an HCP already in EC
-- with the same OneKey ID (the same person in another CRM) is reused.
-- Connections with status 'error' don't answer, as a real CRM outage would look.
-- =====================================================================

create schema if not exists crm_mock;
comment on schema crm_mock is 'Mock CRM instances behind crm_search_hcp / crm_import_hcp. Not exposed through the API.';

create table crm_mock.hco (
  crm_connection_id  uuid not null references public.crm_connection(id) on delete cascade,
  external_id        text not null,
  name               text not null,
  hco_type           text,
  country_code       char(2),
  city               text,
  address            text,
  onekey_id          text,
  primary key (crm_connection_id, external_id)
);

create table crm_mock.hcp (
  crm_connection_id  uuid not null references public.crm_connection(id) on delete cascade,
  external_id        text not null,
  salutation         text,
  first_name         text not null,
  last_name          text not null,
  specialty          text,          -- name, matched to public.specialty on import
  country_code       char(2),
  city               text,
  postal_code        text,
  email              text,
  tier               text,
  hco_external_id    text,
  onekey_id          text,
  primary key (crm_connection_id, external_id),
  foreign key (crm_connection_id, hco_external_id) references crm_mock.hco (crm_connection_id, external_id)
);

-- One EC record per CRM record
create unique index hcp_crm_record_uq on public.hcp (crm_connection_id, crm_external_id) where crm_external_id is not null;
create unique index hco_crm_record_uq on public.hco (crm_connection_id, crm_external_id) where crm_external_id is not null;

-- ---------------------------------------------------------------------
-- crm_search_hcp(p): { q, crm_connection_id?, country_code?, specialty? }
-- q matches every word against the name, or a CRM ID / OneKey ID exactly.
-- Returns { connections: [{id, name, status: ok|unavailable, matches}], results: [...] };
-- each result says which connection it came from and, if the person is already in EC, hcp_id.
-- ---------------------------------------------------------------------
create or replace function public.crm_search_hcp(p jsonb) returns jsonb
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare
  tenant  uuid := app.current_tenant_id();
  q       text;
  conn    uuid;
  ctry    text;
  spec    text;
  bad     text;
  words   text[];
  out     jsonb;
begin
  if not app.has_perm('hcp', 'create') then
    raise exception 'You don''t have permission to search the CRM' using errcode = '42501';
  end if;
  if jsonb_typeof(p) is distinct from 'object' then raise exception 'Payload must be a JSON object' using errcode = '22023'; end if;
  select string_agg(k, ', ') into bad from jsonb_object_keys(p) k where k <> all(array['q','crm_connection_id','country_code','specialty']);
  if bad is not null then raise exception 'Unknown field(s): %', bad using errcode = '22023'; end if;

  q := nullif(trim(p ->> 'q'), '');
  conn := nullif(p ->> 'crm_connection_id', '')::uuid;
  ctry := nullif(p ->> 'country_code', '');
  spec := nullif(p ->> 'specialty', '');
  if q is null or length(q) < 2 then raise exception 'Enter at least two letters of a name, or a CRM ID' using errcode = '22023'; end if;
  words := array_remove(string_to_array(lower(q), ' '), '');

  with conns as (
    select c.id, c.name, c.status from public.crm_connection c
     where c.tenant_id = tenant and (conn is null or c.id = conn)
  ), hits as (
    select h.*, c.name as connection_name, o.name as organisation,
           (select e.id from public.hcp e
             where e.tenant_id = tenant
               and ((e.crm_connection_id = h.crm_connection_id and e.crm_external_id = h.external_id)
                    or (h.onekey_id is not null and e.onekey_id = h.onekey_id))
             order by (e.crm_connection_id = h.crm_connection_id) desc limit 1) as hcp_id
      from crm_mock.hcp h
      join conns c on c.id = h.crm_connection_id and c.status <> 'error'
      left join crm_mock.hco o on o.crm_connection_id = h.crm_connection_id and o.external_id = h.hco_external_id
     where (lower(h.external_id) = lower(q) or lower(coalesce(h.onekey_id, '')) = lower(q)
            or not exists (select 1 from unnest(words) w
                            where position(w in lower(concat_ws(' ', h.salutation, h.first_name, h.last_name))) = 0))
       and (ctry is null or h.country_code = ctry)
       and (spec is null or h.specialty = spec)
     order by h.last_name, h.first_name
     limit 50
  )
  select jsonb_build_object(
    'connections', coalesce((select jsonb_agg(jsonb_build_object(
        'id', c.id, 'name', c.name, 'status', case when c.status = 'error' then 'unavailable' else 'ok' end,
        'matches', (select count(*) from hits where hits.crm_connection_id = c.id)) order by c.name) from conns c), '[]'),
    'results', coalesce((select jsonb_agg(jsonb_build_object(
        'crm_connection_id', crm_connection_id, 'connection_name', connection_name, 'external_id', external_id,
        'display_name', trim(concat_ws(' ', salutation, first_name, last_name)), 'specialty', specialty,
        'country_code', country_code, 'city', city, 'postal_code', postal_code, 'organisation', organisation,
        'onekey_id', onekey_id, 'hcp_id', hcp_id) order by connection_name, last_name, first_name) from hits), '[]'))
    into out;
  return out;
end $$;
comment on function public.crm_search_hcp(jsonb) is
  'Searches the CRM connections for HCPs: {q, crm_connection_id?, country_code?, specialty?}. Results name their connection; hcp_id is set when the person is already in EC.';

-- ---------------------------------------------------------------------
-- crm_import_hcp(connection, external id): the EC HCP for a CRM record, created if needed
-- ---------------------------------------------------------------------
create or replace function public.crm_import_hcp(p_crm_connection_id uuid, p_external_id text) returns public.hcp
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  tenant  uuid := app.current_tenant_id();
  c       public.crm_connection;
  src     crm_mock.hcp;
  org     crm_mock.hco;
  h       public.hcp;
  hco_id  uuid;
begin
  if not app.has_perm('hcp', 'create') then
    raise exception 'You don''t have permission to add HCPs from the CRM' using errcode = '42501';
  end if;
  select * into c from public.crm_connection where id = p_crm_connection_id and tenant_id = tenant;
  if not found then raise exception 'CRM connection not found' using errcode = 'P0002'; end if;
  if c.status = 'error' then raise exception '% isn''t responding right now. Try again later.', c.name using errcode = 'P0001'; end if;
  select * into src from crm_mock.hcp where crm_connection_id = c.id and external_id = p_external_id;
  if not found then raise exception 'No HCP % in %', p_external_id, c.name using errcode = 'P0002'; end if;

  -- Already in EC: this CRM record, or the same person (OneKey ID) from another CRM
  select * into h from public.hcp where tenant_id = tenant and crm_connection_id = c.id and crm_external_id = src.external_id;
  if found then return h; end if;
  if src.onekey_id is not null then
    select * into h from public.hcp where tenant_id = tenant and onekey_id = src.onekey_id limit 1;
    if found then return h; end if;
  end if;

  -- Their organisation, found or copied the same way
  if src.hco_external_id is not null then
    select id into hco_id from public.hco where tenant_id = tenant and crm_connection_id = c.id and crm_external_id = src.hco_external_id;
    if hco_id is null then
      select * into org from crm_mock.hco where crm_connection_id = c.id and external_id = src.hco_external_id;
      if org.onekey_id is not null then
        select id into hco_id from public.hco where tenant_id = tenant and onekey_id = org.onekey_id limit 1;
      end if;
      if hco_id is null then
        insert into public.hco (tenant_id, name, hco_type, country_code, city, address, source, crm_connection_id, crm_external_id, onekey_id)
        values (tenant, org.name, org.hco_type, org.country_code, org.city, org.address, 'crm', c.id, org.external_id, org.onekey_id)
        returning id into hco_id;
      end if;
    end if;
  end if;

  insert into public.hcp (tenant_id, salutation, first_name, last_name, specialty_id, primary_hco_id, country_code, city,
                          email, tier, source, crm_connection_id, crm_external_id, onekey_id)
  values (tenant, src.salutation, src.first_name, src.last_name,
          (select id from public.specialty where tenant_id = tenant and name = src.specialty),
          hco_id, src.country_code, src.city, src.email, src.tier, 'crm', c.id, src.external_id, src.onekey_id)
  returning * into h;
  return h;
end $$;
comment on function public.crm_import_hcp(uuid, text) is
  'Returns the EC HCP for a CRM record, copying it (and its organisation) from the CRM if needed. Reuses an HCP with the same OneKey ID.';

grant execute on function public.crm_search_hcp(jsonb) to authenticated;
grant execute on function public.crm_import_hcp(uuid, text) to authenticated;
