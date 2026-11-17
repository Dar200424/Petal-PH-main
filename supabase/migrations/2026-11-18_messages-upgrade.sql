-- ============================================================
-- Petal-PH — Messages Upgrade Migration (2026-11-18)
-- Run this ONCE in the Supabase SQL Editor.
-- Idempotent: safe to run multiple times. Wrapped in one transaction.
-- ============================================================

begin;

-- ─────────────────────────────────────────────────────────────
-- 1. New columns on public.messages
-- ─────────────────────────────────────────────────────────────
do $$
begin
  if not exists (select 1 from information_schema.columns where table_schema='public' and table_name='messages' and column_name='kind') then
    alter table public.messages add column kind text not null default 'text';
  end if;
  if not exists (select 1 from information_schema.columns where table_schema='public' and table_name='messages' and column_name='attachment_path') then
    alter table public.messages add column attachment_path text;
  end if;
  if not exists (select 1 from information_schema.columns where table_schema='public' and table_name='messages' and column_name='attachment_mime') then
    alter table public.messages add column attachment_mime text;
  end if;
  if not exists (select 1 from information_schema.columns where table_schema='public' and table_name='messages' and column_name='duration_seconds') then
    alter table public.messages add column duration_seconds integer;
  end if;
  if not exists (select 1 from information_schema.columns where table_schema='public' and table_name='messages' and column_name='deleted_at') then
    alter table public.messages add column deleted_at timestamptz;
  end if;
  if not exists (select 1 from information_schema.columns where table_schema='public' and table_name='messages' and column_name='pinned_at') then
    alter table public.messages add column pinned_at timestamptz;
  end if;
  if not exists (select 1 from information_schema.columns where table_schema='public' and table_name='messages' and column_name='pinned_by') then
    alter table public.messages add column pinned_by uuid references public.profiles(id);
  end if;
end $$;

-- body stays NOT NULL but may be '' for image/voice.
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'messages_body_or_attachment_check' and conrelid = 'public.messages'::regclass) then
    alter table public.messages
      add constraint messages_body_or_attachment_check
      check (length(btrim(body)) > 0 or attachment_path is not null);
  end if;
  if not exists (select 1 from pg_constraint where conname = 'messages_kind_requires_attachment_check' and conrelid = 'public.messages'::regclass) then
    alter table public.messages
      add constraint messages_kind_requires_attachment_check
      check (kind = 'text' or attachment_path is not null);
  end if;
  if not exists (select 1 from pg_constraint where conname = 'messages_kind_check' and conrelid = 'public.messages'::regclass) then
    alter table public.messages
      add constraint messages_kind_check check (kind in ('text','image','voice'));
  end if;
end $$;

-- ─────────────────────────────────────────────────────────────
-- 2. Storage: private bucket `chat-media` + policies
-- ─────────────────────────────────────────────────────────────
do $$
begin
  insert into storage.buckets (id, name, public)
  values ('chat-media', 'chat-media', false)
  on conflict (id) do nothing;
end $$;

-- drop + recreate policies so the migration is re-runnable
drop policy if exists "chat media select own or admin" on storage.objects;
create policy "chat media select own or admin" on storage.objects
  for select using (
    bucket_id = 'chat-media' and
    (owner = auth.uid() or public.is_admin())
  );

drop policy if exists "chat media insert own or admin" on storage.objects;
create policy "chat media insert own or admin" on storage.objects
  for insert with check (
    bucket_id = 'chat-media' and (
      (owner = auth.uid() and name like auth.uid() || '/%') or public.is_admin()
    )
  );

drop policy if exists "chat media delete own or admin" on storage.objects;
create policy "chat media delete own or admin" on storage.objects
  for delete using (
    bucket_id = 'chat-media' and
    (owner = auth.uid() or public.is_admin())
  );

-- ─────────────────────────────────────────────────────────────
-- 3. message_reactions table + RLS
-- ─────────────────────────────────────────────────────────────
create table if not exists public.message_reactions (
  id uuid primary key default gen_random_uuid(),
  message_id uuid references public.messages(id) on delete cascade,
  user_id uuid references public.profiles(id) on delete cascade,
  emoji text not null,
  created_at timestamptz default now(),
  constraint message_reactions_unique unique (message_id, user_id),
  constraint message_reactions_emoji_check check (emoji in ('👍','❤️','😂','😮','😢','🙏'))
);

alter table public.message_reactions enable row level security;

drop policy if exists "message reactions read own or admin" on public.message_reactions;
create policy "message reactions read own or admin" on public.message_reactions
  for select using (
    exists (
      select 1 from public.messages m
      where m.id = message_reactions.message_id
        and (m.user_id = auth.uid() or public.is_admin())
    )
  );

drop policy if exists "message reactions insert own" on public.message_reactions;
create policy "message reactions insert own" on public.message_reactions
  for insert with check (user_id = auth.uid());

drop policy if exists "message reactions update own" on public.message_reactions;
create policy "message reactions update own" on public.message_reactions
  for update using (user_id = auth.uid())
  with check (user_id = auth.uid());

drop policy if exists "message reactions delete own" on public.message_reactions;
create policy "message reactions delete own" on public.message_reactions
  for delete using (user_id = auth.uid());

grant select, insert, update, delete on public.message_reactions to authenticated;

-- ─────────────────────────────────────────────────────────────
-- 4. Security-definer RPCs (set search_path = public)
--    They set app.petal.message_rpc for the transaction so the
--    update guard lets them mutate protected columns.
-- ─────────────────────────────────────────────────────────────

create or replace function public.unsend_message(p_message_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_msg public.messages;
begin
  perform set_config('app.petal.message_rpc', 'true', true);

  select * into v_msg from public.messages where id = p_message_id;
  if v_msg.id is null then
    raise exception 'Message not found';
  end if;

  if v_msg.sender = 'user' then
    if v_msg.user_id <> auth.uid() then
      raise exception 'You can only unsend your own messages.';
    end if;
  elsif v_msg.sender = 'admin' then
    if not public.is_admin() then
      raise exception 'Admin only.';
    end if;
  end if;

  if v_msg.attachment_path is not null then
    delete from storage.objects
    where bucket_id = 'chat-media' and name = v_msg.attachment_path;
  end if;

  update public.messages
  set deleted_at = now(),
      body = '',
      pinned_at = null,
      pinned_by = null
  where id = p_message_id;
end;
$$;

create or replace function public.pin_message(p_message_id uuid, p_pinned boolean)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_msg public.messages;
  v_pin_count integer;
begin
  perform set_config('app.petal.message_rpc', 'true', true);

  select * into v_msg from public.messages where id = p_message_id;
  if v_msg.id is null then
    raise exception 'Message not found.';
  end if;

  if v_msg.deleted_at is not null then
    raise exception 'Cannot pin an unsent message.';
  end if;

  if v_msg.sender = 'user' then
    if v_msg.user_id <> auth.uid() then
      raise exception 'You can only pin messages in your own conversation.';
    end if;
  elsif v_msg.sender = 'admin' then
    if not public.is_admin() then
      raise exception 'Admin only.';
    end if;
  end if;

  if p_pinned then
    select count(*) into v_pin_count
    from public.messages
    where user_id = v_msg.user_id and pinned_at is not null;
    if v_pin_count >= 3 then
      raise exception 'Maximum of 3 pinned messages per conversation.';
    end if;
  end if;

  update public.messages
  set pinned_at = case when p_pinned then now() else null end,
      pinned_by = case when p_pinned then auth.uid() else null end
  where id = p_message_id;
end;
$$;

revoke all on function public.unsend_message(uuid) from public;
revoke all on function public.pin_message(uuid, boolean) from public;
grant execute on function public.unsend_message(uuid) to authenticated;
grant execute on function public.pin_message(uuid, boolean) to authenticated;

-- ─────────────────────────────────────────────────────────────
-- 5. Insert policy: attachment_path must start with '<user_id>/'
-- ─────────────────────────────────────────────────────────────
drop policy if exists "messages insert user or admin" on public.messages;
create policy "messages insert user or admin" on public.messages
  for insert with check (
    (
      sender = 'user'
      and user_id = auth.uid()
      and read_by_user = true
      and read_by_admin = false
      and (attachment_path is null or attachment_path like (user_id::text || '/%'))
    )
    or (
      sender = 'admin'
      and public.is_admin()
      and read_by_admin = true
      and read_by_user = false
      and (attachment_path is null or attachment_path like (user_id::text || '/%'))
    )
  );

-- ─────────────────────────────────────────────────────────────
-- 6. Update guard: RPCs allowed, direct client edits of protected
--    columns (body/sender/user_id/kind/attachment_*) still blocked
--    for non-admins.
-- ─────────────────────────────────────────────────────────────
create or replace function public.messages_update_guard()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  -- RPC-driven mutations (unsend_message, pin_message) set this flag
  -- for the whole transaction, so they can mutate protected columns.
  if current_setting('app.petal.message_rpc', true) = 'true' then
    return new;
  end if;

  if not public.is_admin() then
    if new.sender <> old.sender or new.body <> old.body or new.user_id <> old.user_id then
      raise exception 'You can only update read_by_user on your own messages.';
    end if;
    if new.kind is distinct from old.kind then
      raise exception 'You cannot change the message kind.';
    end if;
    if new.attachment_path is distinct from old.attachment_path
       or new.attachment_mime is distinct from old.attachment_mime
       or new.duration_seconds is distinct from old.duration_seconds then
      raise exception 'You cannot change attachment columns.';
    end if;
    if new.read_by_admin <> old.read_by_admin then
      raise exception 'You cannot change read_by_admin.';
    end if;
    if new.read_by_user <> old.read_by_user and new.user_id <> auth.uid() then
      raise exception 'You can only update read_by_user on your own messages.';
    end if;
  end if;
  return new;
end;
$$;

drop trigger if exists messages_update_guard on public.messages;
create trigger messages_update_guard
  before update on public.messages
  for each row execute function public.messages_update_guard();

-- ─────────────────────────────────────────────────────────────
-- 7. Grants
-- ─────────────────────────────────────────────────────────────
grant select, insert, update, delete on public.messages to authenticated;

commit;

-- Done. Messages upgrade applied.
