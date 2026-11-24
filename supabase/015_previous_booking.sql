-- Fun Fest Timesheet — migration 015: changed bookings keep their payment
-- Run once in Supabase: SQL Editor → New query → paste → Run. Safe to run again.
--
-- When a parent changes a booking, the website cancels the old order and creates a new one with
-- meta "previous_booking" = the old order's "booking_id". The payment (e.g. a PonchoPay payment)
-- stays on the old order, so the Payments page carries it across to the new one.
alter table recon_orders
  add column if not exists booking_id text,
  add column if not exists previous_booking text;

-- Fetch one page of orders (as in 012) + booking_id / previous_booking
create or replace function recon_sync_woo_page(p_site text, p_page int, p_after timestamptz default null)
returns jsonb language plpgsql security definer set search_path = public, extensions as $$
declare
  sec recon_secrets;
  base text;
  url text;
  resp record;
  body jsonb;
  pages int := 1;
  n int := 0;
  o jsonb;
  since timestamptz;
begin
  if not (is_admin() or session_user in ('postgres', 'supabase_admin')) then raise exception 'Only admins can do this'; end if;   -- admins, or the daily pg_cron job
  select * into sec from recon_secrets where id = 1;
  if sec.wp_user is null or sec.wp_pass is null then raise exception 'Save the WordPress login on the Payments page first'; end if;
  base := case p_site when 'northrichmond' then 'https://fun-fest.co.uk/northrichmond' when 'hounslow' then 'https://fun-fest.co.uk/hounslow' end;
  if base is null then raise exception 'Unknown site %', p_site; end if;
  since := coalesce(p_after, (select start_date from recon_settings where id = 1)::timestamptz);
  url := base || '/wp-json/wc/v3/orders?per_page=100&page=' || p_page || '&orderby=id&order=asc'
      || '&modified_after=' || urlencode(to_char(since at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS'))
      || '&_fields=id,number,status,date_created_gmt,total,payment_method,payment_method_title,billing,refunds,line_items,meta_data';
  perform http_set_curlopt('CURLOPT_TIMEOUT_MS', '25000');
  select * into resp from http((
    'GET', url,
    array[http_header('Authorization', 'Basic ' || replace(encode(convert_to(sec.wp_user || ':' || sec.wp_pass, 'UTF8'), 'base64'), E'\n', ''))],
    null, null)::http_request);
  if resp.status <> 200 then
    raise exception 'WooCommerce (%) answered %: %', p_site, resp.status, left(coalesce(resp.content, ''), 200);
  end if;
  select coalesce((select h.value::int from unnest(resp.headers) h where lower(h.field) = 'x-wp-totalpages' limit 1), 1) into pages;
  body := resp.content::jsonb;
  for o in select * from jsonb_array_elements(body) loop
    insert into recon_orders (site, order_id, number, status, created_at, total, refunded, payment_method, payment_title, parent, email, children, booking_id, previous_booking, synced_at)
    values (
      p_site, (o->>'id')::int, o->>'number', o->>'status',
      nullif(o->>'date_created_gmt', '')::timestamp at time zone 'UTC',
      nullif(o->>'total', '')::numeric,
      coalesce((select sum(abs((r->>'total')::numeric)) from jsonb_array_elements(coalesce(o->'refunds', '[]')) r), 0),
      o->>'payment_method', o->>'payment_method_title',
      nullif(trim(coalesce(o->'billing'->>'first_name', '') || ' ' || coalesce(o->'billing'->>'last_name', '')), ''),
      nullif(o->'billing'->>'email', ''),
      (select string_agg(distinct m->>'value', ', ') from jsonb_array_elements(coalesce(o->'line_items', '[]')) li,
              jsonb_array_elements(coalesce(li->'meta_data', '[]')) m where lower(m->>'key') = 'child'),
      (select nullif(m->>'value', '') from jsonb_array_elements(coalesce(o->'meta_data', '[]')) m where m->>'key' = 'booking_id' limit 1),
      (select nullif(m->>'value', '') from jsonb_array_elements(coalesce(o->'meta_data', '[]')) m where m->>'key' = 'previous_booking' limit 1),
      now())
    on conflict (site, order_id) do update set
      number = excluded.number, status = excluded.status, created_at = excluded.created_at, total = excluded.total,
      refunded = excluded.refunded, payment_method = excluded.payment_method, payment_title = excluded.payment_title,
      parent = excluded.parent, email = excluded.email, children = excluded.children,
      booking_id = excluded.booking_id, previous_booking = excluded.previous_booking, synced_at = now();
    n := n + 1;
  end loop;
  return jsonb_build_object('saved', n, 'pages', pages);
end $$;
revoke all on function recon_sync_woo_page(text, int, timestamptz) from public, anon;
grant execute on function recon_sync_woo_page(text, int, timestamptz) to authenticated;
