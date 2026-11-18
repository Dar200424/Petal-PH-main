-- ============================================================
-- Petal-PH — Unsend fix
-- -----------------------------------------------------------
-- public.unsend_message() previously deleted from storage.objects
-- directly. Supabase blocks direct writes to storage tables
-- ("Direct deletion from storage tables is not allowed. Use the
-- Storage API instead."), so unsending an image/voice message failed.
--
-- This migration rewrites the function with the SAME signature,
-- security definer, search_path and permission rules, but removes
-- the storage.objects delete. The actual file deletion is now done
-- client-side via sb.storage.from('chat-media').remove([path]).
--
-- The two check constraints are relaxed so a soft-deleted row
-- (deleted_at set, body = '', attachment_path = null) is valid.
-- Idempotent: wrapped in begin/commit, drop constraint if exists.
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
    raise exception 'Message not found.';
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
  set deleted_at = now(), body = '', pinned_at = null, pinned_by = null, attachment_path = null
  where id = p_message_id;
end;
$$;

revoke all on function public.unsend_message(uuid) from public;
grant execute on function public.unsend_message(uuid) to authenticated;

alter table public.messages drop constraint if exists messages_body_or_attachment_check;
alter table public.messages add constraint messages_body_or_attachment_check
  check (deleted_at is not null or body <> '' or attachment_path is not null);

alter table public.messages drop constraint if exists messages_kind_requires_attachment_check;
alter table public.messages add constraint messages_kind_requires_attachment_check
  check (deleted_at is not null or kind = 'text' or attachment_path is not null);

commit;