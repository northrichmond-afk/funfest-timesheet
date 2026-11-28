-- Speed up the Payments page.
-- 1. Indexes on the date columns the page filters and sorts by.
create index if not exists recon_orders_created_idx on recon_orders (created_at, site, order_id);
create index if not exists pp_payments_created_idx on pp_payments (created_at, uuid);
create index if not exists pp_payouts_booked_idx on pp_payouts (booked_at, id);
create index if not exists bank_tx_date_idx on bank_tx (date, id);
-- 2. Check "is this an admin?" once per query, not once per row.
do $$ declare t text; begin
  foreach t in array array['recon_settings','recon_orders','pp_payments','pp_payouts','bank_tx','recon_overrides'] loop
    execute format('drop policy if exists %I on %I', t || '_admin', t);
    execute format('create policy %I on %I for all using ((select is_admin())) with check ((select is_admin()))', t || '_admin', t);
  end loop;
end $$;
analyze recon_orders; analyze pp_payments; analyze pp_payouts; analyze bank_tx;
