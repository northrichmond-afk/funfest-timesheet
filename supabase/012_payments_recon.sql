-- Fun Fest Timesheet — migration 012: payment reconciliation (admin › Payments)
-- Run once in Supabase: SQL Editor → New query → paste → Run. Safe to run again.
--
-- WooCommerce orders (both club sites) are fetched by the database itself every morning
-- (pg_cron + http) and on request from the Payments page. PonchoPay payments/payouts and
-- HSBC bank transactions are saved by the Payments page. Everything is admin-only.

create extension if not exists http with schema extensions;
create extension if not exists pg_cron;

create table if not exists recon_settings (
  id int primary key default 1 check (id = 1),
  start_date date not null default '2026-01-01',
  grace_days int not null default 14,
  woo_synced_at timestamptz,
  pp_synced_at timestamptz,
  bank_synced_at timestamptz,
  woo_last_error text
);
insert into recon_settings (id) values (1) on conflict do nothing;

-- WordPress login for the daily sync. Nobody can read this table through the API:
-- it's written by recon_set_wp_login() and read only inside the sync functions.
create table if not exists recon_secrets (
  id int primary key default 1 check (id = 1),
  wp_user text,
  wp_pass text,
  updated_at timestamptz
);
alter table recon_secrets enable row level security;
revoke all on recon_secrets from anon, authenticated;

create table if not exists recon_orders (
  site text not null,                 -- northrichmond | hounslow
  order_id int not null,
  number text,
  status text,
  created_at timestamptz,
  total numeric(10,2),
  refunded numeric(10,2) default 0,
  payment_method text,
  payment_title text,
  parent text,
  email text,
  children text,
  synced_at timestamptz default now(),
  primary key (site, order_id)
);
create table if not exists pp_payments (
  uuid text primary key,
  reference text,
  site text,
  order_id int,
  email text,
  children text,
  amount numeric(10,2),
  created_at timestamptz,
  completed_at timestamptz,
  subsidies jsonb not null default '[]'::jsonb,
  synced_at timestamptz default now()
);
create index if not exists pp_payments_order on pp_payments (site, order_id);
create table if not exists pp_payouts (
  id text primary key,
  reference text,
  amount numeric(10,2),
  booked_at timestamptz,
  payment_ids text[] not null default '{}',
  synced_at timestamptz default now()
);
create table if not exists bank_tx (
  id text primary key,                -- date|amount|occurrence (same id from either HSBC CSV layout)
  date date not null,
  type text,
  description text,
  amount numeric(10,2) not null,      -- + paid in, − paid out
  source text,
  imported_at timestamptz default now()
);
create index if not exists bank_tx_date on bank_tx (date);
create table if not exists recon_overrides (
  site text not null,
  order_id int not null,
  status text not null default 'paid',
  note text,
  set_by uuid references staff(id) on delete set null,
  set_at timestamptz default now(),
  primary key (site, order_id)
);

do $$ declare t text; begin
  foreach t in array array['recon_settings','recon_orders','pp_payments','pp_payouts','bank_tx','recon_overrides'] loop
    execute format('alter table %I enable row level security', t);
    execute format('drop policy if exists %I on %I', t || '_admin', t);
    execute format('create policy %I on %I for all using (is_admin()) with check (is_admin())', t || '_admin', t);
  end loop;
end $$;

-- Save the WordPress login (Application Password) for the daily order sync
create or replace function recon_set_wp_login(p_user text, p_pass text) returns void
language plpgsql security definer set search_path = public as $$
begin
  if not is_admin() then raise exception 'Only admins can do this'; end if;
  insert into recon_secrets (id, wp_user, wp_pass, updated_at) values (1, nullif(trim(p_user), ''), nullif(trim(p_pass), ''), now())
  on conflict (id) do update set wp_user = excluded.wp_user, wp_pass = excluded.wp_pass, updated_at = now();
end $$;
revoke all on function recon_set_wp_login(text, text) from public, anon;
grant execute on function recon_set_wp_login(text, text) to authenticated;

create or replace function recon_wp_login_saved() returns boolean
language sql security definer set search_path = public as $$
  select is_admin() and exists (select 1 from recon_secrets where wp_user is not null and wp_pass is not null);
$$;
grant execute on function recon_wp_login_saved() to authenticated;

-- Fetch one page (100) of WooCommerce orders for one site and save them.
-- p_after: orders modified after this time (null = from the reconciliation start date).
-- Returns { saved, pages }.
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
      || '&_fields=id,number,status,date_created_gmt,total,payment_method,payment_method_title,billing,refunds,line_items';
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
    insert into recon_orders (site, order_id, number, status, created_at, total, refunded, payment_method, payment_title, parent, email, children, synced_at)
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
      now())
    on conflict (site, order_id) do update set
      number = excluded.number, status = excluded.status, created_at = excluded.created_at, total = excluded.total,
      refunded = excluded.refunded, payment_method = excluded.payment_method, payment_title = excluded.payment_title,
      parent = excluded.parent, email = excluded.email, children = excluded.children, synced_at = now();
    n := n + 1;
  end loop;
  return jsonb_build_object('saved', n, 'pages', pages);
end $$;
revoke all on function recon_sync_woo_page(text, int, timestamptz) from public, anon;
grant execute on function recon_sync_woo_page(text, int, timestamptz) to authenticated;

-- Every morning: orders changed since the last sync (or from the start date), both sites
create or replace function recon_sync_woo_all() returns jsonb
language plpgsql security definer set search_path = public, extensions as $$
declare
  site text; page int; r jsonb; total int := 0;
  since timestamptz := (select coalesce(woo_synced_at - interval '3 days', start_date::timestamptz) from recon_settings where id = 1);
  started timestamptz := now();
begin
  foreach site in array array['northrichmond', 'hounslow'] loop
    page := 1;
    loop
      r := recon_sync_woo_page(site, page, since);
      total := total + (r->>'saved')::int;
      exit when page >= (r->>'pages')::int or (r->>'saved')::int = 0;
      page := page + 1;
    end loop;
  end loop;
  update recon_settings set woo_synced_at = started, woo_last_error = null where id = 1;
  return jsonb_build_object('saved', total);
exception when others then
  update recon_settings set woo_last_error = sqlerrm where id = 1;
  raise;
end $$;
revoke all on function recon_sync_woo_all() from public, anon, authenticated;

do $$ begin
  perform cron.unschedule('ff-woo-orders-daily') where exists (select 1 from cron.job where jobname = 'ff-woo-orders-daily');
  perform cron.schedule('ff-woo-orders-daily', '17 5 * * *', 'select public.recon_sync_woo_all()');
end $$;
