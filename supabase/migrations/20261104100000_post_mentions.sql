-- =====================================================================
-- Event Coordinator — @mentions on team boards
-- A post (event or request board) lists the people it mentions. They must be on the record's team,
-- since only the team can read the board, and each one gets a "mention" notification that opens
-- the board. Mentioning yourself is allowed but doesn't notify you. Editing a post notifies only
-- the people newly mentioned.
-- =====================================================================

alter table public.event_post   add column mentions uuid[] not null default '{}';
alter table public.request_post add column mentions uuid[] not null default '{}';
comment on column public.event_post.mentions   is 'People the post @mentions (app_user ids); each is on the event team and is notified.';
comment on column public.request_post.mentions is 'People the post @mentions (app_user ids); each is on the request team and is notified.';

-- Shared by both boards: <kind>_post is keyed by <kind>_id, with <kind>_team_member as its team
create or replace function app.check_post_mentions() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  -- Through jsonb: a record can't name a column its table doesn't have, even in a branch not taken
  v_record uuid := (to_jsonb(new) ->> case tg_table_name when 'event_post' then 'event_id' else 'request_id' end)::uuid;
  v_off text;
begin
  new.mentions := coalesce((select array_agg(distinct m) from unnest(new.mentions) m where m is not null), '{}');
  select string_agg(coalesce(u.display_name, 'Someone'), ', ') into v_off
    from unnest(new.mentions) m
    left join public.app_user u on u.id = m
   where not exists (
     select 1 from public.event_team_member t where tg_table_name = 'event_post' and t.event_id = v_record and t.user_id = m
     union all
     select 1 from public.request_team_member t where tg_table_name = 'request_post' and t.request_id = v_record and t.user_id = m);
  if v_off is not null then
    raise exception '% isn''t on the team, so they can''t read this board. Add them to the team first.', v_off
      using errcode = '23514';
  end if;
  return new;
end $$;

create or replace function app.notify_post_mentions() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_event boolean := tg_table_name = 'event_post';
  v_record uuid := (to_jsonb(new) ->> case when v_event then 'event_id' else 'request_id' end)::uuid;
  v_name text;
  v_author text;
  v_snippet text := regexp_replace(btrim(new.body), '\s+', ' ', 'g');
begin
  if new.mentions = '{}' then return null; end if;
  if v_event then select e.name into v_name from public.event e where e.id = v_record;
  else select q.title into v_name from public.event_request q where q.id = v_record; end if;
  select u.display_name into v_author from public.app_user u where u.id = new.author_id;
  if length(v_snippet) > 90 then v_snippet := left(v_snippet, 89) || '…'; end if;

  insert into public.notification (tenant_id, user_id, kind, title, body, record_type, record_id, created_at)
  select u.tenant_id, u.id, 'mention', coalesce(v_author, 'Someone'),
         format('mentioned you in the %s discussion: “%s”', v_name, v_snippet),
         case when v_event then 'event' else 'request' end, v_record, new.created_at
    from unnest(new.mentions) m
    join public.app_user u on u.id = m
   where m <> new.author_id
     and (tg_op = 'INSERT' or not m = any(old.mentions));
  return null;
end $$;

create trigger event_post_mentions_check before insert or update of mentions on public.event_post
  for each row execute function app.check_post_mentions();
create trigger event_post_mentions_notify after insert or update of mentions on public.event_post
  for each row execute function app.notify_post_mentions();
create trigger request_post_mentions_check before insert or update of mentions on public.request_post
  for each row execute function app.check_post_mentions();
create trigger request_post_mentions_notify after insert or update of mentions on public.request_post
  for each row execute function app.notify_post_mentions();
