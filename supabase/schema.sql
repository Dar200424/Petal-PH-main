-- ============================================================
-- Petal-PH — Supabase schema
-- Paste this whole file into the Supabase SQL Editor and run it once.
-- ============================================================

-- 1. Tables ---------------------------------------------------

create table if not exists public.profiles (
  id uuid primary key references auth.users (id) on delete cascade,
  email text,
  nickname text,
  status text,
  anniversary date,
  phone text,
  location text,
  avatar text default '',
  role text not null default 'user' check (role in ('user', 'admin')),
  created_at timestamptz default now(),
  deleted_at timestamptz,
  disabled boolean not null default false
);

create table if not exists public.products (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  price numeric not null default 0,
  season text,
  stock integer not null default 0,
  image text,
  description text default '',
  available boolean not null default true,
  created_at timestamptz default now()
);

create table if not exists public.couriers (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  created_at timestamptz default now()
);

create table if not exists public.orders (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references public.profiles (id),
  user_email text,
  user_name text,
  product_id uuid,
  product_name text,
  season text,
  qty integer not null default 1,
  total numeric not null default 0,
  payment text,
  address text,
  notes text,
  status text default 'Pending',
  delivery_personnel text default '',
  delivery_fee numeric default 0,
  delivery_status text default 'Preparing',
  delivery_date date,
  dest_lat double precision,
  dest_lng double precision,
  courier_lat double precision,
  courier_lng double precision,
  courier_updated_at timestamptz,
  created_at timestamptz default now(),
  constraint orders_dest_lat_check check (dest_lat is null or (dest_lat >= -90 and dest_lat <= 90)),
  constraint orders_dest_lng_check check (dest_lng is null or (dest_lng >= -180 and dest_lng <= 180)),
  constraint orders_courier_lat_check check (courier_lat is null or (courier_lat >= -90 and courier_lat <= 90)),
  constraint orders_courier_lng_check check (courier_lng is null or (courier_lng >= -180 and courier_lng <= 180))
);

create table if not exists public.messages (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references public.profiles (id) on delete cascade,
  sender text not null check (sender in ('user', 'admin')),
  body text not null,
  kind text not null default 'text' check (kind in ('text','image','voice')),
  attachment_path text,
  attachment_mime text,
  duration_seconds integer,
  read_by_user boolean not null default false,
  read_by_admin boolean not null default false,
  deleted_at timestamptz,
  pinned_at timestamptz,
  pinned_by uuid references public.profiles(id),
  created_at timestamptz default now(),
  constraint messages_body_or_attachment_check check (deleted_at is not null or body <> '' or attachment_path is not null),
  constraint messages_kind_requires_attachment_check check (deleted_at is not null or kind = 'text' or attachment_path is not null)
);

-- message reactions (one emoji per person per message)
create table if not exists public.message_reactions (
  id uuid primary key default gen_random_uuid(),
  message_id uuid references public.messages(id) on delete cascade,
  user_id uuid references public.profiles(id) on delete cascade,
  emoji text not null,
  created_at timestamptz default now(),
constraint message_reactions_unique unique (message_id, user_id),
  constraint message_reactions_emoji_check check (emoji in ('👍','❤️','😂','😢','🙏'))
);

-- message_reactions RLS (mirrors supabase/migrations/2026-11-19_reactions-fix.sql)
alter table public.message_reactions enable row level security;

drop policy if exists "message reactions read own or admin" on public.message_reactions;
create policy "message reactions read own or admin" on public.message_reactions
  for select using (user_id = auth.uid() or public.is_admin());

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

drop policy if exists "message reactions update own" on public.message_reactions;
create policy "message reactions update own" on public.message_reactions
  for update using (user_id = auth.uid())
  with check (user_id = auth.uid());

drop policy if exists "message reactions delete own" on public.message_reactions;
create policy "message reactions delete own" on public.message_reactions
  for delete using (user_id = auth.uid());

-- private storage bucket for chat media (images and voice clips)
do $$
begin
  insert into storage.buckets (id, name, public)
  values ('chat-media', 'chat-media', false)
  on conflict (id) do nothing;
end $$;

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

-- 2. Helper functions ----------------------------------------

create or replace function public.my_role()
returns text
language sql
security definer
stable
set search_path = public
as $$
  select role from public.profiles where id = auth.uid();
$$;

create or replace function public.is_admin()
returns boolean
language sql
security definer
stable
set search_path = public
as $$
  select exists (select 1 from public.profiles where id = auth.uid() and role = 'admin');
$$;

-- 3. Sign-up trigger: create the profile row ------------------

create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.profiles (id, email, nickname, status, anniversary, phone, location)
  values (
    new.id,
    new.email,
    coalesce(new.raw_user_meta_data ->> 'nickname', split_part(new.email, '@', 1)),
    new.raw_user_meta_data ->> 'status',
    nullif(new.raw_user_meta_data ->> 'anniversary', '')::date,
    new.raw_user_meta_data ->> 'phone',
    new.raw_user_meta_data ->> 'location'
  )
  on conflict (id) do nothing;
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- 4. Row Level Security --------------------------------------

alter table public.profiles enable row level security;
alter table public.products enable row level security;
alter table public.couriers enable row level security;
alter table public.orders enable row level security;
alter table public.messages enable row level security;

-- profiles: read/update own row (role cannot change), admin reads all and deletes
drop policy if exists "profiles read own or admin" on public.profiles;
drop policy if exists "profiles update own or admin" on public.profiles;
drop policy if exists "profiles delete admin" on public.profiles;
create policy "profiles read own or admin" on public.profiles
  for select using (id = auth.uid() or public.is_admin());
create policy "profiles update own or admin" on public.profiles
  for update using (id = auth.uid() or public.is_admin())
  with check ((id = auth.uid() and role = public.my_role()) or public.is_admin());
create policy "profiles delete admin" on public.profiles
  for delete using (public.is_admin());
-- Non-admins cannot change email, role, created_at, id, disabled, or deleted_at

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

-- products: everyone reads, only admin writes
drop policy if exists "products read all" on public.products;
drop policy if exists "products insert admin" on public.products;
drop policy if exists "products update admin" on public.products;
drop policy if exists "products delete admin" on public.products;
create policy "products read all" on public.products
  for select using (true);
create policy "products insert admin" on public.products
  for insert with check (public.is_admin());
create policy "products update admin" on public.products
  for update using (public.is_admin()) with check (public.is_admin());
create policy "products delete admin" on public.products
  for delete using (public.is_admin());

-- couriers: admin only
drop policy if exists "couriers read admin" on public.couriers;
drop policy if exists "couriers insert admin" on public.couriers;
drop policy if exists "couriers update admin" on public.couriers;
drop policy if exists "couriers delete admin" on public.couriers;
create policy "couriers read admin" on public.couriers
  for select using (public.is_admin());
create policy "couriers insert admin" on public.couriers
  for insert with check (public.is_admin());
create policy "couriers update admin" on public.couriers
  for update using (public.is_admin()) with check (public.is_admin());
create policy "couriers delete admin" on public.couriers
  for delete using (public.is_admin());

-- orders: read own (admin all), admin updates/deletes, no direct customer writes
drop policy if exists "orders read own or admin" on public.orders;
drop policy if exists "orders update admin" on public.orders;
drop policy if exists "orders delete admin" on public.orders;
create policy "orders read own or admin" on public.orders
  for select using (user_id = auth.uid() or public.is_admin());
create policy "orders update admin" on public.orders
  for update using (public.is_admin()) with check (public.is_admin());
create policy "orders delete admin" on public.orders
  for delete using (public.is_admin());

-- messages: own conversation read/insert, admin reads all, limited updates
drop policy if exists "messages read own or admin" on public.messages;
drop policy if exists "messages insert user or admin" on public.messages;
drop policy if exists "messages update own or admin" on public.messages;
drop policy if exists "messages delete admin" on public.messages;
create policy "messages read own or admin" on public.messages
  for select using (user_id = auth.uid() or public.is_admin());
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
create policy "messages update own or admin" on public.messages
  for update using (user_id = auth.uid() or public.is_admin())
  with check (user_id = auth.uid() or public.is_admin());
create policy "messages delete admin" on public.messages
  for delete using (public.is_admin());

-- customers may only flip read_by_user on their own messages;
-- protected columns (body/sender/user_id/kind/attachment_*) may only
-- be changed through the unsend_message / pin_message security-definer RPCs.
create or replace function public.messages_update_guard()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  -- RPC-driven mutations set this flag for the whole transaction.
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
-- 4.5. Message upgrade RPCs (security definer)
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

-- 5. Order functions (security definer) ----------------------

create or replace function public.place_order(
  p_product_id uuid,
  p_qty integer,
  p_payment text,
  p_address text,
  p_notes text default '',
  p_dest_lat double precision default null,
  p_dest_lng double precision default null
)
returns public.orders
language plpgsql
security definer
set search_path = public
as $$
declare
  v_product public.products;
  v_profile public.profiles;
  v_order public.orders;
begin
  if auth.uid() is null then
    raise exception 'Not signed in';
  end if;

  select * into v_profile from public.profiles where id = auth.uid();
  if v_profile.id is null then
    raise exception 'Profile not found';
  end if;
  if v_profile.deleted_at is not null or v_profile.disabled then
    raise exception 'Account disabled';
  end if;

  if p_qty is null or p_qty < 1 then
    raise exception 'Invalid quantity';
  end if;

  if p_address is null or length(btrim(p_address)) = 0 then
    raise exception 'Delivery address is required';
  end if;
  if length(p_address) > 300 then
    raise exception 'Delivery address must be 300 characters or fewer';
  end if;
  if p_notes is not null and length(p_notes) > 500 then
    raise exception 'Delivery notes must be 500 characters or fewer';
  end if;
  if p_payment not in ('Cash on Delivery', 'GCash', 'Maya', 'Bank Transfer (BDO/BPI/Metrobank)') then
    raise exception 'Invalid payment method';
  end if;

  if p_dest_lat is not null and (p_dest_lat < -90 or p_dest_lat > 90) then
    raise exception 'Invalid latitude';
  end if;
  if p_dest_lng is not null and (p_dest_lng < -180 or p_dest_lng > 180) then
    raise exception 'Invalid longitude';
  end if;
  if (p_dest_lat is null) <> (p_dest_lng is null) then
    raise exception 'Both latitude and longitude are required';
  end if;

  select * into v_product from public.products where id = p_product_id for update;
  if v_product.id is null then
    raise exception 'Product not found';
  end if;
  if not v_product.available then
    raise exception 'Product is not available';
  end if;
  if v_product.stock < p_qty then
    raise exception 'Not enough stock';
  end if;

  update public.products set stock = stock - p_qty where id = p_product_id;

  insert into public.orders (
    user_id, user_email, user_name, product_id, product_name, season,
    qty, total, payment, address, notes, status, delivery_status,
    dest_lat, dest_lng
  ) values (
    auth.uid(), v_profile.email, v_profile.nickname, v_product.id, v_product.name, v_product.season,
    p_qty, v_product.price * p_qty, p_payment, btrim(p_address), coalesce(p_notes, ''),
    'Pending', 'Preparing',
    p_dest_lat, p_dest_lng
  )
  returning * into v_order;

  return v_order;
end;
$$;

create or replace function public.set_order_status(p_order_id uuid, p_status text)
returns public.orders
language plpgsql
security definer
set search_path = public
as $$
declare
  v_order public.orders;
begin
  if not public.is_admin() then
    raise exception 'Admin only';
  end if;
  if p_status not in ('Pending', 'Accepted', 'Rejected', 'Completed', 'Cancelled') then
    raise exception 'Invalid status';
  end if;

  select * into v_order from public.orders where id = p_order_id for update;
  if v_order.id is null then
    raise exception 'Order not found';
  end if;

  if v_order.status in ('Rejected', 'Cancelled', 'Completed') then
    raise exception 'Order is already in a terminal state (%)', v_order.status;
  end if;

  if v_order.status = 'Pending' and p_status not in ('Accepted', 'Rejected', 'Cancelled') then
    raise exception 'Invalid transition: Pending -> %', p_status;
  elsif v_order.status = 'Accepted' and p_status not in ('Completed', 'Cancelled') then
    raise exception 'Invalid transition: Accepted -> %', p_status;
  end if;

  if p_status in ('Rejected', 'Cancelled') and v_order.status in ('Pending', 'Accepted') then
    update public.products set stock = stock + v_order.qty where id = v_order.product_id;
  end if;

  update public.orders set status = p_status where id = p_order_id
  returning * into v_order;

  return v_order;
end;
$$;

create or replace function public.cancel_my_order(p_order_id uuid)
returns public.orders
language plpgsql
security definer
set search_path = public
as $$
declare
  v_order public.orders;
begin
  if auth.uid() is null then
    raise exception 'Not signed in';
  end if;

  select * into v_order from public.orders
  where id = p_order_id and user_id = auth.uid() for update;
  if v_order.id is null then
    raise exception 'Order not found';
  end if;
  if v_order.status <> 'Pending' then
    raise exception 'Only pending orders can be cancelled';
  end if;

  update public.products set stock = stock + v_order.qty where id = v_order.product_id;
  update public.orders set status = 'Cancelled' where id = p_order_id
  returning * into v_order;

  return v_order;
end;
$$;

create or replace function public.admin_set_courier_location(
  p_order_id uuid,
  p_lat double precision,
  p_lng double precision
)
returns public.orders
language plpgsql
security definer
set search_path = public
as $$
declare
  v_order public.orders;
begin
  if not public.is_admin() then
    raise exception 'Admin only';
  end if;

  if p_lat is null or p_lng is null
     or p_lat < -90 or p_lat > 90
     or p_lng < -180 or p_lng > 180 then
    raise exception 'Invalid coordinates';
  end if;

  select * into v_order from public.orders where id = p_order_id for update;
  if v_order.id is null then
    raise exception 'Order not found';
  end if;

  if v_order.delivery_status <> 'In transit' then
    raise exception 'Location can only be shared while the order is out for delivery';
  end if;

  update public.orders
     set courier_lat = p_lat,
         courier_lng = p_lng,
         courier_updated_at = now()
   where id = p_order_id
  returning * into v_order;

  return v_order;
end;
$$;

-- Clear the courier position once the order is Delivered, Completed,
-- Cancelled or Rejected.
create or replace function public.orders_clear_courier_location()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.delivery_status = 'Delivered'
     or new.status in ('Completed', 'Cancelled', 'Rejected') then
    new.courier_lat := null;
    new.courier_lng := null;
    new.courier_updated_at := null;
  end if;
  return new;
end;
$$;

drop trigger if exists orders_clear_courier_location on public.orders;
create trigger orders_clear_courier_location
  before insert or update on public.orders
  for each row execute function public.orders_clear_courier_location();

-- Customers may never write the map columns directly (defense in depth).
create or replace function public.orders_guard_courier_columns()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if tg_op = 'UPDATE' and not public.is_admin() then
    if new.status in ('Completed', 'Cancelled', 'Rejected') or new.delivery_status = 'Delivered' then
      return new;
    end if;
    if new.dest_lat is distinct from old.dest_lat
       or new.dest_lng is distinct from old.dest_lng
       or new.courier_lat is distinct from old.courier_lat
       or new.courier_lng is distinct from old.courier_lng
       or new.courier_updated_at is distinct from old.courier_updated_at then
      raise exception 'You cannot change map location columns';
    end if;
  end if;
  return new;
end;
$$;

drop trigger if exists orders_guard_courier_columns on public.orders;
create trigger orders_guard_courier_columns
  before update on public.orders
  for each row execute function public.orders_guard_courier_columns();

revoke all on function public.place_order(uuid, integer, text, text, text, double precision, double precision) from public;
revoke all on function public.set_order_status(uuid, text) from public;
revoke all on function public.cancel_my_order(uuid) from public;
revoke all on function public.admin_set_courier_location(uuid, double precision, double precision) from public;
grant execute on function public.place_order(uuid, integer, text, text, text, double precision, double precision) to authenticated;
grant execute on function public.set_order_status(uuid, text) to authenticated;
grant execute on function public.cancel_my_order(uuid) to authenticated;
grant execute on function public.admin_set_courier_location(uuid, double precision, double precision) to authenticated;

-- 6. Grants ---------------------------------------------------

grant usage on schema public to anon, authenticated;
grant select on public.products to anon, authenticated;
grant select, insert, update, delete on public.profiles to authenticated;
grant select, insert, update, delete on public.orders to authenticated;
grant select, insert, update, delete on public.messages to authenticated;
grant select, insert, update, delete on public.message_reactions to authenticated;
grant select, insert, update, delete on public.couriers to authenticated;

-- 8. Best-sellers function (security definer, for all authenticated users)

create or replace function public.best_sellers(p_period text)
returns table(product_name text, units bigint)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_start timestamptz;
begin
  if p_period = 'daily' then
    v_start := date_trunc('day', now());
  elsif p_period = 'weekly' then
    v_start := date_trunc('day', now() - interval '6 days');
  elsif p_period = 'monthly' then
    v_start := date_trunc('month', now());
  elsif p_period = 'yearly' then
    v_start := date_trunc('year', now());
  else
    raise exception 'Invalid period: %', p_period;
  end if;

  return query
    select o.product_name, sum(o.qty)::bigint as units
    from public.orders o
    where o.status not in ('Rejected', 'Cancelled')
      and o.created_at >= v_start
    group by o.product_name
    order by units desc
    limit 5;
end;
$$;

revoke all on function public.best_sellers(text) from public;
grant execute on function public.best_sellers(text) to authenticated;

-- 9. Seed data -----------------------------------------------

do $$
begin
  if (select count(*) from public.products) = 0 then
    insert into public.products (name, price, season, stock, image, description) values
      ('White Tulips', 499, 'Spring', 12, 'White Tulips.jpg', 'Fresh white tulips for gentle spring moments.'),
      ('White Lisianthus', 549, 'Spring', 10, 'White Lisianthus.jpg', 'Elegant lisianthus with soft ruffled petals.'),
      ('Pink Garden Roses', 599, 'Spring', 9, 'Pink Garden Roses.jpg', 'Romantic garden roses in soft pink.'),
      ('Oriental Lily Buds', 525, 'Spring', 11, 'Oriental Lily Buds.jpg', 'Fragrant oriental lilies ready to bloom.'),
      ('Sunflower', 399, 'Summer', 15, 'Sunflower.jpg', 'Bright sunflowers to light up summer days.'),
      ('White Gerbera Daisy', 379, 'Summer', 14, 'White Gerbera Daisy.jpg', 'Cheerful daisies with clean white petals.'),
      ('White Ping Pong Mum', 429, 'Summer', 8, 'White Ping Pong Mum.jpg', 'Playful round blooms for summer decor.'),
      ('Pink Chrysanthemums', 450, 'Autumn', 10, 'Pink Chrysanthemums.jpg', 'Warm pink mums for cozy autumn vibes.'),
      ('White Carnations', 389, 'Autumn', 13, 'White carnations.jpg', 'Classic carnations with lasting beauty.'),
      ('Green Carnations', 469, 'Autumn', 7, 'Green Carnations.jpg', 'Unique green carnations for standout gifts.'),
      ('Carnations', 350, 'Winter', 16, 'Carnations.jpg', 'Soft ruffled carnations for winter warmth.'),
      ('Rose Flower', 599, 'Winter', 8, 'Rose Flower.jpg', 'Timeless roses for heartfelt celebrations.'),
      ('Pink Phalaenopsis Orchid', 899, 'Winter', 6, 'Pink Phalaenopsis Orchid.jpg', 'Elegant orchid for special occasions.'),
      ('Peonies', 649, 'All Season', 9, 'Peonies.jpg', 'Lush peonies loved in every season.'),
      ('Preserved Rose', 750, 'All Season', 12, 'Preserved Rose.jpg', 'Long-lasting preserved rose keepsake.');
  end if;

  if (select count(*) from public.couriers) = 0 then
    insert into public.couriers (name) values
      ('Jun Marquez'),
      ('Ana Reyes'),
      ('Carlo Dizon'),
      ('Rosa Lim');
  end if;
end $$;

-- Done. Continue with README-SETUP.md.