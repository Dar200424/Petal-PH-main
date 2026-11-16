-- ============================================================
-- Petal-PH — Profile self-update guard (2026-11-16)
-- Run this ONCE in the Supabase SQL Editor on your existing database.
-- It is idempotent: safe to run multiple times.
-- Blocks non-admins from changing disabled / deleted_at, so a
-- customer cannot re-enable or restore their own account.
-- ============================================================

begin;

-- ─────────────────────────────────────────────────────────────
-- Profile self-update: block non-admins from changing
-- email, role, created_at, id, disabled, deleted_at
-- ─────────────────────────────────────────────────────────────
create or replace function public.profiles_update_guard()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if not public.is_admin() then
    if new.email <> old.email then
      raise exception 'You cannot change your email';
    end if;
    if new.role <> old.role then
      raise exception 'You cannot change your role';
    end if;
    if new.created_at <> old.created_at then
      raise exception 'You cannot change your registration date';
    end if;
    if new.id <> old.id then
      raise exception 'You cannot change your account id';
    end if;
    if new.disabled <> old.disabled then
      raise exception 'You cannot change account status';
    end if;
    if new.deleted_at is distinct from old.deleted_at then
      raise exception 'You cannot change account status';
    end if;
  end if;
  return new;
end;
$$;

drop trigger if exists profiles_update_guard on public.profiles;
create trigger profiles_update_guard
  before update on public.profiles
  for each row execute function public.profiles_update_guard();

commit;