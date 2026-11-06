-- Fun Fest Timesheet — database schema
-- Run this once in Supabase: Dashboard → SQL Editor → New query → paste → Run.
-- Safe to re-run: uses IF NOT EXISTS / CREATE OR REPLACE where possible.

create extension if not exists pgcrypto;

-- ─────────────────────────────────────────────────────────────
-- Tables
-- ─────────────────────────────────────────────────────────────

create table if not exists sites (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  address text,
  lat double precision not null,
  lng double precision not null,
  geofence_radius_m integer not null default 150 check (geofence_radius_m between 20 and 2000),
  active boolean not null default true,
  created_at timestamptz not null default now()
);

create table if not exists staff (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  email text not null,
  auth_user_id uuid unique,               -- Supabase auth user (Google identity), linked on first sign-in
  phone text,
  role text not null default 'staff' check (role in ('staff','admin')),
  default_site_id uuid references sites(id) on delete set null,
  hourly_rate numeric(8,2),
  status text not null default 'invited' check (status in ('invited','active','left')),
  consent_location_at timestamptz,
  last_login_at timestamptz,
  created_at timestamptz not null default now()
);
create unique index if not exists staff_email_lower on staff (lower(email));

create table if not exists planned_shifts (
  id uuid primary key default gen_random_uuid(),
  staff_id uuid not null references staff(id) on delete cascade,
  site_id uuid not null references sites(id) on delete cascade,
  shift_date date not null,
  expected_start time not null,
  expected_end time not null,
  unpaid_break_mins integer not null default 0 check (unpaid_break_mins >= 0),
  created_at timestamptz not null default now(),
  unique (staff_id, shift_date)
);

create table if not exists time_entries (
  id uuid primary key default gen_random_uuid(),
  staff_id uuid not null references staff(id) on delete cascade,
  site_id uuid references sites(id) on delete set null,
  planned_shift_id uuid references planned_shifts(id) on delete set null,
  actual_start timestamptz not null,
  actual_end timestamptz,
  start_lat double precision, start_lng double precision, start_accuracy double precision, start_distance_m double precision,
  end_lat double precision,   end_lng double precision,   end_accuracy double precision,   end_distance_m double precision,
  source text not null default 'app' check (source in ('app','auto','admin')),
  status text not null default 'open' check (status in ('open','closed','flagged','approved')),
  flag_reason text,
  created_at timestamptz not null default now(),
  check (actual_end is null or actual_end > actual_start)
);
create index if not exists time_entries_staff_start on time_entries (staff_id, actual_start);
-- at most one open shift per person
create unique index if not exists one_open_entry on time_entries (staff_id) where actual_end is null;

create table if not exists adjustments (
  id uuid primary key default gen_random_uuid(),
  time_entry_id uuid not null references time_entries(id) on delete cascade,
  field_changed text not null,
  old_value text,
  new_value text,
  reason text not null,
  changed_by uuid references staff(id),
  changed_at timestamptz not null default now()
);

create table if not exists correction_requests (
  id uuid primary key default gen_random_uuid(),
  time_entry_id uuid not null references time_entries(id) on delete cascade,
  staff_id uuid not null references staff(id) on delete cascade,
  requested_start timestamptz,
  requested_end timestamptz,
  note text not null,
  status text not null default 'pending' check (status in ('pending','approved','rejected')),
  resolved_by uuid references staff(id),
  resolved_at timestamptz,
  created_at timestamptz not null default now()
);

create table if not exists locked_periods (
  id uuid primary key default gen_random_uuid(),
  period_start date not null,
  period_end date not null check (period_end >= period_start),
  locked_by uuid references staff(id),
  locked_at timestamptz not null default now()
);

create table if not exists settings (
  id integer primary key default 1 check (id = 1),
  rounding_mins integer not null default 0 check (rounding_mins in (0,5,10,15,30)),
  count_early_arrival boolean not null default false,
  late_grace_mins integer not null default 5,
  timezone text not null default 'Europe/London'
);
insert into settings (id) values (1) on conflict do nothing;

-- ─────────────────────────────────────────────────────────────
-- Helper functions
-- ─────────────────────────────────────────────────────────────

-- The staff row for the signed-in Google user (null if not on the allow-list or has left)
create or replace function current_staff_id() returns uuid
language sql stable security definer set search_path = public as $$
  select id from staff
  where status <> 'left'
    and (auth_user_id = auth.uid()
         or (auth_user_id is null and lower(email) = lower(auth.jwt() ->> 'email')))
  limit 1
$$;

create or replace function is_admin() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from staff where id = current_staff_id() and role = 'admin')
$$;

-- Great-circle distance in metres
create or replace function distance_m(lat1 double precision, lng1 double precision,
                                      lat2 double precision, lng2 double precision)
returns double precision language sql immutable as $$
  select 2 * 6371000 * asin(sqrt(
    power(sin(radians(lat2 - lat1) / 2), 2) +
    cos(radians(lat1)) * cos(radians(lat2)) * power(sin(radians(lng2 - lng1) / 2), 2)))
$$;

create or replace function is_locked(ts timestamptz) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from locked_periods
    where (ts at time zone (select timezone from settings where id = 1))::date
          between period_start and period_end)
$$;

-- ─────────────────────────────────────────────────────────────
-- RPCs used by the apps
-- ─────────────────────────────────────────────────────────────

-- Called after Google sign-in. Links the Google identity to the allow-listed staff row.
create or replace function register_login() returns json
language plpgsql security definer set search_path = public as $$
declare s staff;
begin
  select * into s from staff where id = current_staff_id();
  if s.id is null then
    return json_build_object('ok', false, 'error', 'not_registered');
  end if;
  update staff set auth_user_id = auth.uid(),
                   last_login_at = now(),
                   status = case when status = 'invited' then 'active' else status end
   where id = s.id
   returning * into s;
  return json_build_object('ok', true, 'staff', row_to_json(s));
end $$;

create or replace function give_location_consent() returns void
language sql security definer set search_path = public as $$
  update staff set consent_location_at = now() where id = current_staff_id();
$$;

-- Start a shift. Finds the nearest active site; rejects if outside its geofence.
-- p_client_time lets the offline queue submit the time the button was pressed (max 12h old).
create or replace function clock_in(p_lat double precision, p_lng double precision,
                                    p_accuracy double precision, p_client_time timestamptz default null)
returns json language plpgsql security definer set search_path = public as $$
declare
  me uuid := current_staff_id();
  st sites; d double precision; t timestamptz := now();
  tz text := (select timezone from settings where id = 1);
  ps uuid; e time_entries; flag text;
begin
  if me is null then return json_build_object('ok', false, 'error', 'not_registered'); end if;
  if (select consent_location_at from staff where id = me) is null then
    return json_build_object('ok', false, 'error', 'no_consent'); end if;
  if exists (select 1 from time_entries where staff_id = me and actual_end is null) then
    return json_build_object('ok', false, 'error', 'already_on_shift'); end if;

  if p_client_time is not null and p_client_time < now() and p_client_time > now() - interval '12 hours' then
    t := p_client_time;
    if now() - t > interval '5 minutes' then flag := 'Submitted offline'; end if;
  end if;

  select s.* into st
    from sites s where s.active order by distance_m(p_lat, p_lng, s.lat, s.lng) limit 1;
  if st.id is null then return json_build_object('ok', false, 'error', 'no_sites'); end if;
  d := distance_m(p_lat, p_lng, st.lat, st.lng);
  if d > st.geofence_radius_m then
    return json_build_object('ok', false, 'error', 'outside_geofence',
                             'site', st.name, 'distance_m', round(d));
  end if;

  select id into ps from planned_shifts
   where staff_id = me and shift_date = (t at time zone tz)::date;

  insert into time_entries (staff_id, site_id, planned_shift_id, actual_start,
                            start_lat, start_lng, start_accuracy, start_distance_m,
                            source, status, flag_reason)
  values (me, st.id, ps, t, p_lat, p_lng, p_accuracy, d, 'app',
          case when flag is null then 'open' else 'flagged' end, flag)
  returning * into e;
  return json_build_object('ok', true, 'entry', row_to_json(e), 'site', st.name);
end $$;

-- End the current shift. Allowed outside the geofence, but then flagged for admin review.
create or replace function clock_out(p_lat double precision, p_lng double precision,
                                     p_accuracy double precision, p_client_time timestamptz default null)
returns json language plpgsql security definer set search_path = public as $$
declare
  me uuid := current_staff_id();
  e time_entries; st sites; d double precision; t timestamptz := now(); flags text[] := '{}';
begin
  if me is null then return json_build_object('ok', false, 'error', 'not_registered'); end if;
  select * into e from time_entries where staff_id = me and actual_end is null;
  if e.id is null then return json_build_object('ok', false, 'error', 'not_on_shift'); end if;

  if p_client_time is not null and p_client_time < now() and p_client_time > e.actual_start then
    t := p_client_time;
    if now() - t > interval '5 minutes' then flags := flags || 'Submitted offline'; end if;
  end if;

  select * into st from sites where id = e.site_id;
  if st.id is not null and p_lat is not null then
    d := distance_m(p_lat, p_lng, st.lat, st.lng);
    if d > st.geofence_radius_m then
      flags := flags || format('Ended %s m from site', round(d));
    end if;
  else
    flags := flags || 'No location at end';
  end if;
  if e.flag_reason is not null then flags := e.flag_reason || flags; end if;

  update time_entries set actual_end = t, end_lat = p_lat, end_lng = p_lng,
         end_accuracy = p_accuracy, end_distance_m = d,
         status = case when array_length(flags, 1) > 0 then 'flagged' else 'closed' end,
         flag_reason = nullif(array_to_string(flags, '; '), '')
   where id = e.id returning * into e;
  return json_build_object('ok', true, 'entry', row_to_json(e));
end $$;

-- Admin: change actual start/end. Reason mandatory; every change goes in the audit trail.
create or replace function admin_update_entry(p_entry uuid, p_start timestamptz, p_end timestamptz, p_reason text)
returns json language plpgsql security definer set search_path = public as $$
declare e time_entries; me uuid := current_staff_id();
begin
  if not is_admin() then raise exception 'Admins only'; end if;
  if coalesce(trim(p_reason), '') = '' then raise exception 'A reason is required'; end if;
  select * into e from time_entries where id = p_entry;
  if e.id is null then raise exception 'Entry not found'; end if;
  if is_locked(e.actual_start) or is_locked(p_start) then raise exception 'This pay period is locked'; end if;
  if p_end is not null and p_end <= p_start then raise exception 'End must be after start'; end if;

  if e.actual_start is distinct from p_start then
    insert into adjustments (time_entry_id, field_changed, old_value, new_value, reason, changed_by)
    values (e.id, 'actual_start', e.actual_start::text, p_start::text, p_reason, me);
  end if;
  if e.actual_end is distinct from p_end then
    insert into adjustments (time_entry_id, field_changed, old_value, new_value, reason, changed_by)
    values (e.id, 'actual_end', e.actual_end::text, p_end::text, p_reason, me);
  end if;
  update time_entries set actual_start = p_start, actual_end = p_end,
         status = case when p_end is null then 'open' else 'approved' end
   where id = e.id returning * into e;
  return row_to_json(e);
end $$;

create or replace function admin_add_entry(p_staff uuid, p_site uuid, p_start timestamptz, p_end timestamptz, p_reason text)
returns json language plpgsql security definer set search_path = public as $$
declare e time_entries; tz text := (select timezone from settings where id = 1);
begin
  if not is_admin() then raise exception 'Admins only'; end if;
  if coalesce(trim(p_reason), '') = '' then raise exception 'A reason is required'; end if;
  if is_locked(p_start) then raise exception 'This pay period is locked'; end if;
  if p_end <= p_start then raise exception 'End must be after start'; end if;
  insert into time_entries (staff_id, site_id, planned_shift_id, actual_start, actual_end, source, status, flag_reason)
  values (p_staff, p_site,
          (select id from planned_shifts where staff_id = p_staff and shift_date = (p_start at time zone tz)::date),
          p_start, p_end, 'admin', 'approved', 'Manual entry')
  returning * into e;
  insert into adjustments (time_entry_id, field_changed, old_value, new_value, reason, changed_by)
  values (e.id, 'created', null, p_start::text || ' → ' || p_end::text, p_reason, current_staff_id());
  return row_to_json(e);
end $$;

create or replace function admin_set_status(p_entry uuid, p_status text, p_reason text default 'Reviewed')
returns void language plpgsql security definer set search_path = public as $$
declare e time_entries;
begin
  if not is_admin() then raise exception 'Admins only'; end if;
  select * into e from time_entries where id = p_entry;
  if is_locked(e.actual_start) then raise exception 'This pay period is locked'; end if;
  if e.actual_end is null and p_status <> 'open' then raise exception 'Shift has not ended'; end if;
  insert into adjustments (time_entry_id, field_changed, old_value, new_value, reason, changed_by)
  values (e.id, 'status', e.status, p_status, p_reason, current_staff_id());
  update time_entries set status = p_status where id = p_entry;
end $$;

create or replace function admin_resolve_request(p_request uuid, p_approve boolean)
returns void language plpgsql security definer set search_path = public as $$
declare r correction_requests; e time_entries;
begin
  if not is_admin() then raise exception 'Admins only'; end if;
  select * into r from correction_requests where id = p_request and status = 'pending';
  if r.id is null then raise exception 'Request not found'; end if;
  if p_approve then
    select * into e from time_entries where id = r.time_entry_id;
    perform admin_update_entry(e.id, coalesce(r.requested_start, e.actual_start),
                               coalesce(r.requested_end, e.actual_end), 'Staff request: ' || r.note);
  end if;
  update correction_requests set status = case when p_approve then 'approved' else 'rejected' end,
         resolved_by = current_staff_id(), resolved_at = now() where id = r.id;
end $$;

-- ─────────────────────────────────────────────────────────────
-- Row-level security: staff see only their own data; admins see everything.
-- Time entries can only be written through the functions above (so edits are always audited).
-- ─────────────────────────────────────────────────────────────

alter table sites enable row level security;
alter table staff enable row level security;
alter table planned_shifts enable row level security;
alter table time_entries enable row level security;
alter table adjustments enable row level security;
alter table correction_requests enable row level security;
alter table locked_periods enable row level security;
alter table settings enable row level security;

drop policy if exists sites_read on sites;
create policy sites_read on sites for select using (current_staff_id() is not null);
drop policy if exists sites_admin on sites;
create policy sites_admin on sites for all using (is_admin()) with check (is_admin());

drop policy if exists staff_read on staff;
create policy staff_read on staff for select using (id = current_staff_id() or is_admin());
drop policy if exists staff_admin on staff;
create policy staff_admin on staff for all using (is_admin()) with check (is_admin());

drop policy if exists shifts_read on planned_shifts;
create policy shifts_read on planned_shifts for select using (staff_id = current_staff_id() or is_admin());
drop policy if exists shifts_admin on planned_shifts;
create policy shifts_admin on planned_shifts for all using (is_admin()) with check (is_admin());

drop policy if exists entries_read on time_entries;
create policy entries_read on time_entries for select using (staff_id = current_staff_id() or is_admin());

drop policy if exists adj_read on adjustments;
create policy adj_read on adjustments for select using (is_admin());

drop policy if exists req_read on correction_requests;
create policy req_read on correction_requests for select using (staff_id = current_staff_id() or is_admin());
drop policy if exists req_insert on correction_requests;
create policy req_insert on correction_requests for insert
  with check (staff_id = current_staff_id()
              and exists (select 1 from time_entries t where t.id = time_entry_id and t.staff_id = current_staff_id()));

drop policy if exists locks_read on locked_periods;
create policy locks_read on locked_periods for select using (current_staff_id() is not null);
drop policy if exists locks_admin on locked_periods;
create policy locks_admin on locked_periods for all using (is_admin()) with check (is_admin());

drop policy if exists settings_read on settings;
create policy settings_read on settings for select using (current_staff_id() is not null);
drop policy if exists settings_admin on settings;
create policy settings_admin on settings for update using (is_admin()) with check (is_admin());

-- Planned shifts in a locked period can't be changed
create or replace function guard_locked_shift() returns trigger
language plpgsql security definer set search_path = public as $$
declare d date := coalesce(new.shift_date, old.shift_date);
begin
  if exists (select 1 from locked_periods where d between period_start and period_end) then
    raise exception 'This pay period is locked';
  end if;
  return coalesce(new, old);
end $$;
drop trigger if exists planned_shifts_lock on planned_shifts;
create trigger planned_shifts_lock before insert or update or delete on planned_shifts
  for each row execute function guard_locked_shift();

-- ─────────────────────────────────────────────────────────────
-- Seed: first admin
-- ─────────────────────────────────────────────────────────────
insert into staff (name, email, role, status)
values ('North Richmond Admin', 'northrichmond@funfestholidayclub.co.uk', 'admin', 'active')
on conflict ((lower(email))) do update set role = 'admin';

-- ─────────────────────────────────────────────────────────────
-- Email + password sign-in (see 002_password_login.sql)
-- ─────────────────────────────────────────────────────────────
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
