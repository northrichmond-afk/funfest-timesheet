-- Fun Fest Timesheet — migration 002: email + password sign-in
-- Run once in Supabase: SQL Editor → New query → paste → Run.
-- Then switch the hook on: Authentication → Hooks → "Before User Created" → Postgres → public.hook_before_user_created

-- Only emails on the staff list (and not marked as left) can create a login,
-- whether by password sign-up or a first Google sign-in.
create or replace function public.hook_before_user_created(event jsonb)
returns jsonb language plpgsql security definer set search_path = public as $$
declare em text := lower(coalesce(event -> 'user' ->> 'email', ''));
begin
  if em <> '' and exists (select 1 from staff where lower(email) = em and status <> 'left') then
    return '{}'::jsonb;
  end if;
  return jsonb_build_object('error', jsonb_build_object(
    'http_code', 403,
    'message', 'This email is not on the Fun Fest staff list. Ask your manager to add it.'));
end $$;

revoke execute on function public.hook_before_user_created(jsonb) from public;
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    revoke execute on function public.hook_before_user_created(jsonb) from anon, authenticated;
  end if;
  if exists (select 1 from pg_roles where rolname = 'supabase_auth_admin') then
    grant execute on function public.hook_before_user_created(jsonb) to supabase_auth_admin;
  end if;
end $$;
