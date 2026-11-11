-- =====================================================================
-- Event Center — Editing posts
-- * Only the author edits a post, and only its text and mentions. Event and request editors used to
--   be able to change other people's posts; they still delete them, but nobody's words are changed
--   under their name.
-- * edited_at records when the text last changed (the UI shows "Edited"); the audit log keeps
--   earlier versions.
-- * Mentions on an edit: only people newly mentioned are notified and emailed
--   (app.notify_post_mentions, unchanged), so fixing a typo emails nobody.
-- =====================================================================

alter table public.event_post   add column edited_at timestamptz;
alter table public.request_post add column edited_at timestamptz;
comment on column public.event_post.edited_at is 'When the author last changed the text (null: never edited).';
comment on column public.request_post.edited_at is 'When the author last changed the text (null: never edited).';

drop policy event_post_update on public.event_post;
create policy event_post_update on public.event_post for update to authenticated
  using (tenant_id = app.current_tenant_id() and app.has_perm('event_post', 'edit') and app.can_view_event(event_id)
         and author_id = app.current_user_id())
  with check (tenant_id = app.current_tenant_id() and author_id = app.current_user_id());

drop policy request_post_update on public.request_post;
create policy request_post_update on public.request_post for update to authenticated
  using (tenant_id = app.current_tenant_id() and app.has_perm('request_post', 'edit') and app.can_view_request(request_id)
         and author_id = app.current_user_id())
  with check (tenant_id = app.current_tenant_id() and author_id = app.current_user_id());

-- Only the text and mentions change
revoke update on public.event_post, public.request_post from authenticated;
grant update (body, mentions) on public.event_post, public.request_post to authenticated;

-- A changed text is marked edited; an empty one is refused
create or replace function app.mark_post_edited() returns trigger
language plpgsql as $$
begin
  if new.body is distinct from old.body then
    if coalesce(btrim(new.body), '') = '' then
      raise exception 'A post needs some text; delete it instead' using errcode = '23514';
    end if;
    new.edited_at := now();
  end if;
  return new;
end $$;
create trigger event_post_edited before update on public.event_post for each row execute function app.mark_post_edited();
create trigger request_post_edited before update on public.request_post for each row execute function app.mark_post_edited();

-- Mentions added by an edit are notified and emailed as of the edit, not the post's original time
create or replace function app.notify_post_mentions() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_event boolean := tg_table_name = 'event_post';
  v_record uuid := (to_jsonb(new) ->> case when v_event then 'event_id' else 'request_id' end)::uuid;
  v_name text;
  v_author text;
  v_snippet text := regexp_replace(btrim(new.body), '\s+', ' ', 'g');
  -- A new post's time (seeds post in the past); an edit's mentions are new now
  v_at timestamptz := case when tg_op = 'INSERT' then new.created_at else now() end;
  m uuid;
begin
  if new.mentions = '{}' then return null; end if;
  if v_event then select e.name into v_name from public.event e where e.id = v_record;
  else select q.title into v_name from public.event_request q where q.id = v_record; end if;
  select u.display_name into v_author from public.app_user u where u.id = new.author_id;
  v_author := coalesce(v_author, 'Someone');
  if length(v_snippet) > 90 then v_snippet := left(v_snippet, 89) || '…'; end if;

  for m in select x from unnest(new.mentions) x
            where x <> new.author_id and (tg_op = 'INSERT' or not x = any(old.mentions)) loop
    insert into public.notification (tenant_id, user_id, kind, title, body, record_type, record_id, created_at)
    select u.tenant_id, u.id, 'mention', v_author, format('mentioned you in the %s discussion: “%s”', v_name, v_snippet),
           case when v_event then 'event' else 'request' end, v_record, v_at
      from public.app_user u where u.id = m;
    perform app.queue_email(m, 'mention', format('%s mentioned you on %s', v_author, v_name),
      concat_ws(E'\n',
        app.email_reply_line(), '',
        format('%s mentioned you in the %s discussion:', v_author, v_name), '',
        app.email_quote(new.body), '',
        'Reply to this email to answer in the discussion. Your reply is posted as you.',
        format('Open the %s discussion: %s', v_name, app.app_link(case when v_event then 'event' else 'request' end, v_record, new.id))),
      case when v_event then 'event' else 'request' end, v_record, new.id, v_at);
  end loop;
  return null;
end $$;
