-- Fun Fest Timesheet — migration 014: give the saved WordPress login back to admins' browsers
-- Run once in Supabase: SQL Editor → New query → paste → Run. Safe to run again.
-- The admin pages keep a copy of the WordPress login in the browser (Invoices, Attending
-- children). When the browser clears it, they restore it from the copy saved for the daily
-- order fetch (migration 012). Admins only.
create or replace function recon_get_wp_login() returns jsonb
language plpgsql security definer set search_path = public as $$
declare s recon_secrets;
begin
  if not is_admin() then raise exception 'Only admins can do this'; end if;
  select * into s from recon_secrets where id = 1;
  if s.wp_user is null or s.wp_pass is null then return null; end if;
  return jsonb_build_object('user', s.wp_user, 'pass', s.wp_pass);
end $$;
revoke all on function recon_get_wp_login() from public, anon;
grant execute on function recon_get_wp_login() to authenticated;
