-- ============================================================
-- Petal-PH — Reactions fix
-- -----------------------------------------------------------
-- message_reactions was created in 2026-11-18_messages-upgrade.sql
-- but that migration only ran on the live DB; schema.sql (the
-- canonical single-file schema) never enabled RLS or created
-- policies for the table. On the live admin Messages page the
-- chat-ui calls reactToMessage -> upsert(...), which needs
-- INSERT + UPDATE. With no RLS at all the request is rejected
-- by Supabase (403 / "new row violates row-level security
-- policy"), and reactToMessage swallowed the error, so the UI
-- failed silently.
--
-- This migration is idempotent: drop policy if exists, create
-- policy. Mirrored into supabase/schema.sql.
-- ============================================================

alter table public.message_reactions enable row level security;

-- read: own row OR admin
drop policy if exists "message reactions read own or admin" on public.message_reactions;
create policy "message reactions read own or admin" on public.message_reactions
  for select using (user_id = auth.uid() or public.is_admin());

-- insert: only your own row, and the message must belong to you
drop policy if exists "message reactions insert own" on public.message_reactions;
create policy "message reactions insert own" on public.message_reactions
  for insert with check (
    user_id = auth.uid()
    and exists (
      select 1 from public.messages m
      where m.id = message_reactions.message_id
        and m.user_id = auth.uid()
    )
  );

-- update: only your own row (needed because reactToMessage uses
-- upsert, which issues UPDATE on conflict)
drop policy if exists "message reactions update own" on public.message_reactions;
create policy "message reactions update own" on public.message_reactions
  for update using (user_id = auth.uid())
  with check (user_id = auth.uid());

-- delete: only your own row (toggle-off reaction)
drop policy if exists "message reactions delete own" on public.message_reactions;
create policy "message reactions delete own" on public.message_reactions
  for delete using (user_id = auth.uid());