-- ============================================================
-- Petal-PH — Map-based order tracking (2026-11-17)
-- Run this ONCE in the Supabase SQL Editor on your existing database.
-- It is idempotent: safe to run multiple times.
-- Adds optional delivery pins, courier live positions, and the
-- admin-only RPC that writes them.
-- ============================================================

begin;

-- ─────────────────────────────────────────────────────────────
-- 1. New columns on public.orders
-- ─────────────────────────────────────────────────────────────
alter table public.orders add column if not exists dest_lat double precision;
alter table public.orders add column if not exists dest_lng double precision;
alter table public.orders add column if not exists courier_lat double precision;
alter table public.orders add column if not exists courier_lng double precision;
alter table public.orders add column if not exists courier_updated_at timestamptz;

-- ─────────────────────────────────────────────────────────────
-- 2. Range checks (latitude -90..90, longitude -180..180)
-- ─────────────────────────────────────────────────────────────
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'orders_dest_lat_check' and conrelid = 'public.orders'::regclass) then
    alter table public.orders add constraint orders_dest_lat_check
      check (dest_lat is null or (dest_lat >= -90 and dest_lat <= 90));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'orders_dest_lng_check' and conrelid = 'public.orders'::regclass) then
    alter table public.orders add constraint orders_dest_lng_check
      check (dest_lng is null or (dest_lng >= -180 and dest_lng <= 180));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'orders_courier_lat_check' and conrelid = 'public.orders'::regclass) then
    alter table public.orders add constraint orders_courier_lat_check
      check (courier_lat is null or (courier_lat >= -90 and courier_lat <= 90));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'orders_courier_lng_check' and conrelid = 'public.orders'::regclass) then
    alter table public.orders add constraint orders_courier_lng_check
      check (courier_lng is null or (courier_lng >= -180 and courier_lng <= 180));
  end if;
end $$;

-- ─────────────────────────────────────────────────────────────
-- 3. place_order: optional destination pin
--    Replaces the previous 5-argument version. Callers that do
--    not pass coordinates keep working (both default to null).
-- ─────────────────────────────────────────────────────────────
drop function if exists public.place_order(uuid, integer, text, text, text);
drop function if exists public.place_order(uuid, integer, text, text, text, double precision, double precision);

create function public.place_order(
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

revoke all on function public.place_order(uuid, integer, text, text, text, double precision, double precision) from public;
grant execute on function public.place_order(uuid, integer, text, text, text, double precision, double precision) to authenticated;

-- ─────────────────────────────────────────────────────────────
-- 4. Admin-only courier position (only while out for delivery)
--    'In transit' is the delivery status the project already uses
--    for "out for delivery".
-- ─────────────────────────────────────────────────────────────
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

revoke all on function public.admin_set_courier_location(uuid, double precision, double precision) from public;
grant execute on function public.admin_set_courier_location(uuid, double precision, double precision) to authenticated;

-- ─────────────────────────────────────────────────────────────
-- 5. Clear the courier position once the order is no longer on
--    the road: Delivered, Completed, Cancelled or Rejected.
--    A trigger (not only the RPC) so direct admin edits to the
--    delivery status are covered too.
-- ─────────────────────────────────────────────────────────────
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

-- ─────────────────────────────────────────────────────────────
-- 6. Customers may never write the map columns directly.
--    Orders already have no customer update policy; this guard
--    makes the restriction explicit even if a policy is added
--    later. Admins and the RPCs above are unaffected.
-- ─────────────────────────────────────────────────────────────
create or replace function public.orders_guard_courier_columns()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if tg_op = 'UPDATE' and not public.is_admin() then
    -- the automatic clear on a terminal status is always allowed
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

commit;