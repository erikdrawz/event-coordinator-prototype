-- =====================================================================
-- Event content and the Library
-- * The Library: pre-approved files kept in EC (content.is_library), managed in Admin by Admins and
--   Business Admins (object library_item). Each is linked to event types (event_type_content) and
--   optionally limited to countries, like contract templates; that decides which events can use it.
-- * Event content (usage 'presentation'): what gets presented. From the Library it's approved as it
--   is; a bespoke upload starts as Draft, is submitted for approval (Pending) and becomes Approved.
--   Submitting stands in for handing it to a document system such as Veeva Vault (a mock reference
--   for now, a configurable connection later). Status changes go through set_event_content_status().
-- * Event documents (usage 'document'): any other file for the event, with a category.
-- * Files live in the private `content` bucket: <event id>/… follows the event's access,
--   library/<tenant id>/… is readable by everyone in the tenant.
-- =====================================================================

-- Lookups --------------------------------------------------------------
create table public.content_status (code text primary key, label text not null, tone text not null, sort int not null);
insert into public.content_status (code, label, tone, sort) values
  ('draft', 'Draft', 'grey', 10), ('pending', 'Pending', 'yellow', 20), ('approved', 'Approved', 'green', 30);

create table public.document_category (code text primary key, label text not null, sort int not null);
insert into public.document_category (code, label, sort) values
  ('agenda', 'Agenda', 10), ('contract', 'Contract', 20), ('compliance', 'Compliance', 30), ('finance', 'Finance', 40), ('other', 'Other', 50);

do $$
declare t text;
begin
  foreach t in array array['content_status', 'document_category'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('create policy %I on public.%I for select to authenticated using (true)', t || '_read', t);
    execute format('revoke all on public.%I from anon', t);
    execute format('grant select on public.%I to authenticated', t);
  end loop;
end $$;
comment on table public.content_status is 'Approval of event content: draft, pending, approved.';
comment on table public.document_category is 'What an event document is: agenda, contract, compliance, finance, other.';

-- Library items --------------------------------------------------------
alter table public.content
  add column description   text,
  add column is_library    boolean not null default false,
  add column is_active     boolean not null default true,
  add column country_codes char(2)[];
comment on column public.content.is_library is 'A pre-approved item in the Library, as opposed to a file uploaded for one event.';
comment on column public.content.country_codes is 'Library items: only in these countries; null = every country.';

create table public.event_type_content (
  event_type_id  uuid not null references public.event_type(id) on delete cascade,
  content_id     uuid not null references public.content(id) on delete cascade,
  tenant_id      uuid not null references public.tenant(id),
  created_at     timestamptz not null default now(),
  created_by     uuid references public.app_user(id),
  primary key (event_type_id, content_id)
);
comment on table public.event_type_content is 'Which Library items events of a type can use.';
create index event_type_content_content_idx on public.event_type_content (content_id);
select app.secure_table('event_type_content');

-- Only whoever manages the Library writes Library items
drop policy content_insert on public.content;
drop policy content_update on public.content;
drop policy content_delete on public.content;
create policy content_insert on public.content for insert to authenticated
  with check (coalesce(tenant_id, app.current_tenant_id()) = app.current_tenant_id()
              and app.has_perm(case when is_library then 'library_item' else 'content' end, 'create'));
create policy content_update on public.content for update to authenticated
  using (tenant_id = app.current_tenant_id() and app.has_perm(case when is_library then 'library_item' else 'content' end, 'edit'))
  with check (tenant_id = app.current_tenant_id() and app.has_perm(case when is_library then 'library_item' else 'content' end, 'edit'));
create policy content_delete on public.content for delete to authenticated
  using (tenant_id = app.current_tenant_id() and app.has_perm(case when is_library then 'library_item' else 'content' end, 'delete'));

create or replace function app.check_library_item() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
declare bad text;
begin
  if tg_op = 'DELETE' then
    if old.is_library and exists (select 1 from public.event_content ec where ec.content_id = old.id) then
      raise exception 'This item is used on events. Make it inactive instead.' using errcode = '23503';
    end if;
    return old;
  end if;
  if new.country_codes = '{}' then new.country_codes := null; end if;
  select string_agg(c, ', ') into bad from unnest(new.country_codes) c where c not in (select code from public.country);
  if bad is not null then raise exception 'Unknown countries: %', bad using errcode = '22023'; end if;
  return new;
end $$;
create trigger check_library_item before insert or update or delete on public.content
  for each row execute function app.check_library_item();

create or replace function app.check_event_type_content() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if not exists (select 1 from public.content c where c.id = new.content_id and c.is_library) then
    raise exception 'Only Library items are linked to event types' using errcode = '22023';
  end if;
  return new;
end $$;
create trigger check_event_type_content before insert or update on public.event_type_content
  for each row execute function app.check_event_type_content();

-- Whether an event can use a Library item: active, linked to its type, and meant for its country
create or replace function app.library_available(p_content_id uuid, p_event_id uuid) returns boolean
language sql stable security definer set search_path = public, pg_temp as $$
  select exists (
    select 1 from public.content c
      join public.event e on e.id = p_event_id and e.tenant_id = c.tenant_id
      join public.event_type_content l on l.content_id = c.id and l.event_type_id = e.event_type_id
     where c.id = p_content_id and c.is_library and c.is_active
       and (c.country_codes is null or e.country_code = any(c.country_codes)))
$$;

create or replace function public.event_library_options(p_event_id uuid) returns setof public.content
language sql stable security definer set search_path = public, pg_temp as $$
  select c.* from public.content c
   where app.can_view_event(p_event_id) and app.library_available(c.id, p_event_id)
   order by c.title
$$;
comment on function public.event_library_options(uuid) is 'The Library items an event could use, by its event type and country.';

-- Event content --------------------------------------------------------
alter table public.event_content drop constraint event_content_review_status_check;
update public.event_content set review_status = case review_status when 'review' then 'pending' when 'rejected' then 'draft' else review_status end;
update public.event_content set category = case when usage = 'document' then lower(category) end;
alter table public.event_content
  add column description    text,
  add column dms_reference  text,
  add column submitted_at   timestamptz,
  add column submitted_by   uuid references public.app_user(id),
  add column decided_at     timestamptz,
  add column decided_by     uuid references public.app_user(id),
  add constraint event_content_review_status_fkey foreign key (review_status) references public.content_status(code),
  add constraint event_content_category_fkey foreign key (category) references public.document_category(code);
comment on column public.event_content.description is 'Who it belongs to, or any note for this event.';
comment on column public.event_content.dms_reference is 'Its reference in the document system it was submitted to (mock for now).';

-- New content: from the Library it's approved if the event can use it; a bespoke upload starts as a
-- draft. After that the approval fields change only through set_event_content_status().
create or replace function app.check_event_content() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  c public.content;
  changing boolean := coalesce(current_setting('app.content_status_change', true), '') = 'on';
begin
  if app.current_user_id() is null then return new; end if;
  select * into c from public.content where id = new.content_id;
  if tg_op = 'INSERT' then
    if c.is_library then
      if not app.library_available(c.id, new.event_id) then
        raise exception 'This Library item isn''t available for this event' using errcode = '22023';
      end if;
      new.usage := 'presentation';
      new.review_status := 'approved';
    else
      new.review_status := case when new.usage = 'presentation' then 'draft' end;
    end if;
    new.dms_reference := null; new.submitted_at := null; new.submitted_by := null; new.decided_at := null; new.decided_by := null;
  elsif not changing and (new.review_status, new.dms_reference, new.content_id, new.usage, new.event_id)
        is distinct from (old.review_status, old.dms_reference, old.content_id, old.usage, old.event_id) then
    raise exception 'Use the content''s actions to change its status' using errcode = '42501';
  end if;
  return new;
end $$;
create trigger check_event_content before insert or update on public.event_content
  for each row execute function app.check_event_content();

-- A bespoke file goes when it's no longer on the event; Library items stay in the Library
create or replace function app.drop_event_file() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  delete from public.content c
   where c.id = old.content_id and not c.is_library
     and not exists (select 1 from public.event_content ec where ec.content_id = c.id)
     and not exists (select 1 from public.contract k where k.document_content_id = c.id);
  return null;
end $$;
create trigger drop_event_file after delete on public.event_content
  for each row execute function app.drop_event_file();

-- A file uploaded to the event's folder, with its content record and link in one step
create or replace function public.add_event_file(p_event_id uuid, p_usage text, p_title text, p_description text, p_category text,
                                                 p_file_name text, p_mime_type text, p_size_bytes bigint, p_storage_path text) returns uuid
language plpgsql set search_path = public, pg_temp as $$
declare cid uuid; ecid uuid;
begin
  if p_usage not in ('presentation', 'document') then raise exception 'Unknown usage' using errcode = '22023'; end if;
  if nullif(trim(p_title), '') is null then raise exception 'Give it a title' using errcode = '22023'; end if;
  if app.event_id_of_path(p_storage_path) is distinct from p_event_id then
    raise exception 'That file isn''t in this event''s folder' using errcode = '22023';
  end if;
  if not (app.has_perm('event_content', 'create') and app.can_edit_event(p_event_id)) then
    raise exception 'You can''t add files to this event' using errcode = '42501';
  end if;
  insert into public.content (title, content_kind, file_name, mime_type, size_bytes, storage_path, owner_user_id)
  values (trim(p_title), p_usage, p_file_name, p_mime_type, p_size_bytes, p_storage_path, app.access_user_id())
  returning id into cid;
  insert into public.event_content (event_id, content_id, usage, description, category)
  values (p_event_id, cid, p_usage, nullif(trim(p_description), ''), case when p_usage = 'document' then coalesce(p_category, 'other') end)
  returning id into ecid;
  return ecid;
end $$;

-- The simple approval of bespoke content: Draft → Pending → Approved, and Pending back to Draft
create or replace function public.set_event_content_status(p_id uuid, p_status text) returns public.event_content
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  r public.event_content;
  c public.content;
  me uuid := app.access_user_id();
begin
  select * into r from public.event_content where id = p_id for update;
  if not found or not app.can_view_event(r.event_id) then raise exception 'Content not found' using errcode = 'P0002'; end if;
  if not (app.has_perm('event_content', 'edit') and app.can_edit_event(r.event_id)) then
    raise exception 'You can''t change this event''s content' using errcode = '42501';
  end if;
  select * into c from public.content where id = r.content_id;
  if c.is_library then raise exception 'Library items are approved already' using errcode = '22023'; end if;
  if r.usage <> 'presentation' then raise exception 'Only content goes through approval' using errcode = '22023'; end if;
  if (r.review_status, p_status) not in (('draft', 'pending'), ('pending', 'approved'), ('pending', 'draft')) then
    raise exception 'Content that is % can''t become %', r.review_status, p_status using errcode = '22023';
  end if;
  perform set_config('app.content_status_change', 'on', true);
  update public.event_content set review_status = p_status,
         dms_reference = case p_status when 'pending' then 'VV-' || to_char(now(), 'YY') || '-' || lpad((floor(random() * 100000))::int::text, 5, '0')
                                       when 'draft' then null else dms_reference end,
         submitted_at = case p_status when 'pending' then now() when 'draft' then null else submitted_at end,
         submitted_by = case p_status when 'pending' then me when 'draft' then null else submitted_by end,
         decided_at = case when p_status = 'approved' then now() end,
         decided_by = case when p_status = 'approved' then me end
   where id = p_id returning * into r;
  perform set_config('app.content_status_change', 'off', true);
  return r;
end $$;

-- Files ----------------------------------------------------------------
insert into storage.buckets (id, name, public, file_size_limit)
values ('content', 'content', false, 52428800)
on conflict (id) do nothing;

create or replace function app.is_my_library_path(p_name text) returns boolean
language sql stable as $$
  select split_part(p_name, '/', 1) = 'library' and split_part(p_name, '/', 2) = app.current_tenant_id()::text
$$;
drop policy if exists content_files_read on storage.objects;
drop policy if exists content_files_insert on storage.objects;
drop policy if exists content_files_delete on storage.objects;
create policy content_files_read on storage.objects for select to authenticated
  using (bucket_id = 'content' and (app.is_my_library_path(name) or app.can_view_event(app.event_id_of_path(name))));
create policy content_files_insert on storage.objects for insert to authenticated
  with check (bucket_id = 'content' and (
    (app.is_my_library_path(name) and app.has_perm('library_item', 'create'))
    or (app.has_perm('event_content', 'create') and app.can_edit_event(app.event_id_of_path(name)))));
create policy content_files_delete on storage.objects for delete to authenticated
  using (bucket_id = 'content' and (
    (app.is_my_library_path(name) and app.has_perm('library_item', 'delete'))
    or app.can_edit_event(app.event_id_of_path(name))));

-- Permissions: everyone reads what event types they read; admin-area profiles manage the Library
insert into public.permission (tenant_id, profile_id, object_name, can_read, can_create, can_edit, can_delete, view_all, modify_all)
select x.tenant_id, x.profile_id, o, x.can_read, p.can_access_admin, p.can_access_admin, p.can_access_admin, false, false
  from public.permission x
  join public.profile p on p.id = x.profile_id
 cross join unnest(array['library_item', 'event_type_content']) o
 where x.object_name = 'event_type';

grant execute on all functions in schema app to authenticated, service_role;
grant execute on function public.event_library_options(uuid) to authenticated;
grant execute on function public.add_event_file(uuid, text, text, text, text, text, text, bigint, text) to authenticated;
grant execute on function public.set_event_content_status(uuid, text) to authenticated;
