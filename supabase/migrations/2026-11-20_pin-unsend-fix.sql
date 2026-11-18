-- ============================================================
-- Petal-PH — Pin + Unsend fix
-- -----------------------------------------------------------
-- BUG A: pin_message rejected pinning with "You can only pin
-- messages in your own conversation." In a 1:1 customer/admin
-- conversation BOTH sides must be able to pin ANY message of
-- that conversation (their own or the other person's). Rule:
--   - customer (not admin): may pin only in their own
--     conversation  (messages.user_id = auth.uid())
--   - admin (public.is_admin()): may pin in any conversation
-- BUG B: unsend_message deleted from storage.objects directly,
-- which Supabase blocks ("Direct deletion from storage tables
-- is not allowed. Use the Storage API instead."). The delete is
-- removed; the file is deleted client-side via the Storage API.
--
-- Same signatures, security definer, search_path and the same
-- app.petal.message_rpc mechanism used to pass messages_update_guard.
-- Idempotent: wrapped in begin/commit, create or replace.
-- Mirrored into supabase/schema.sql.
-- ============================================================

begin;

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

  update public.messages
  set deleted_at = now(),
      body = '',
      pinned_at = null,
      pinned_by = null,
      attachment_path = null
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

  -- BUG A fix: in a 1:1 customer/admin conversation BOTH sides may
  -- pin ANY message of that conversation.
  --   customer (not admin): only in their own conversation
  --   admin (public.is_admin()): any conversation
  if not public.is_admin() then
    if v_msg.user_id <> auth.uid() then
      raise exception 'You can only pin messages in your own conversation.';
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

commit;