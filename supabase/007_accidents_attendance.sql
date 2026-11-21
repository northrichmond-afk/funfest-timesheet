-- Fun Fest Timesheet — migration 007: accident forms and the children's attendance register
-- Run once in Supabase: SQL Editor → New query → paste → Run. Safe to run again.
--
-- accident_reports: staff record an accident in the staff app; the parent signs on the club
--   device at collection (admin pages); the signed PDF is filed in iCloud › FunFest › Accidents.
-- attendance: arrival / departure times for children booked on the website (by club and date).

-- ── Accident reports ─────────────────────────────────────────
create table if not exists accident_reports (
  id uuid primary key default gen_random_uuid(),
  club text not null default 'northrichmond',          -- website club key (northrichmond, hounslow)
  site_id uuid references sites(id) on delete set null,
  child_name text not null,
  child_age_group text,
  occurred_at timestamptz not null,
  location text,                                        -- where it happened (e.g. playground)
  what_happened text not null,
  injury text,                                          -- injury / part of body
  first_aid text,                                       -- first aid / action taken
  treated_by text,
  witnesses text,
  parent_informed_how text,                             -- e.g. at collection, by phone
  reported_by uuid references staff(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  -- signing at collection
  parent_name text,
  parent_signature text,                                -- PNG data URL of the signature
  signed_at timestamptz,
  witnessed_by uuid references staff(id) on delete set null,   -- staff member present when the parent signed
  -- filing
  pdf_synced_at timestamptz,
  pdf_path text
);
create index if not exists accident_reports_day on accident_reports (occurred_at desc);
create index if not exists accident_reports_unsigned on accident_reports (occurred_at) where signed_at is null;

create or replace function accident_reports_guard() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if tg_op = 'INSERT' then
    new.reported_by := coalesce(new.reported_by, current_staff_id());
    if not is_admin() then
      new.reported_by := current_staff_id();
      new.parent_name := null; new.parent_signature := null; new.signed_at := null; new.witnessed_by := null;
      new.pdf_synced_at := null; new.pdf_path := null;
    end if;
  else
    if not is_admin() then
      -- staff may correct their own report only until it is signed, and can't sign it themselves
      if old.signed_at is not null then raise exception 'This accident form has been signed and can no longer be changed'; end if;
      new.reported_by := old.reported_by;
      new.parent_name := old.parent_name; new.parent_signature := old.parent_signature;
      new.signed_at := old.signed_at; new.witnessed_by := old.witnessed_by;
      new.pdf_synced_at := old.pdf_synced_at; new.pdf_path := old.pdf_path;
    end if;
    -- a signed form's details are fixed (admins can still file it)
    if old.signed_at is not null and (
         new.child_name is distinct from old.child_name or new.occurred_at is distinct from old.occurred_at
      or new.what_happened is distinct from old.what_happened or new.injury is distinct from old.injury
      or new.first_aid is distinct from old.first_aid) then
      raise exception 'This accident form has been signed and its details can no longer be changed';
    end if;
    if new.parent_signature is not null and old.signed_at is null then new.signed_at := now(); end if;
    new.updated_at := now();
  end if;
  return new;
end $$;

drop trigger if exists accident_reports_guard on accident_reports;
create trigger accident_reports_guard before insert or update on accident_reports
  for each row execute function accident_reports_guard();

alter table accident_reports enable row level security;
drop policy if exists accidents_read on accident_reports;
create policy accidents_read on accident_reports for select using (reported_by = current_staff_id() or is_admin());
drop policy if exists accidents_insert on accident_reports;
create policy accidents_insert on accident_reports for insert with check (current_staff_id() is not null);
drop policy if exists accidents_update on accident_reports;
create policy accidents_update on accident_reports for update
  using (is_admin() or (reported_by = current_staff_id() and signed_at is null))
  with check (is_admin() or reported_by = current_staff_id());
drop policy if exists accidents_delete on accident_reports;
create policy accidents_delete on accident_reports for delete
  using (is_admin() or (reported_by = current_staff_id() and signed_at is null));

-- ── Attendance register ──────────────────────────────────────
create table if not exists attendance (
  id uuid primary key default gen_random_uuid(),
  club text not null,                 -- website club key
  day date not null,
  child_key text not null,            -- booking system child id, or the child's name if there isn't one
  child_name text not null,
  order_numbers text,                 -- website order(s) the child is booked on that day
  arrived_at timestamptz,
  arrived_by uuid references staff(id) on delete set null,
  departed_at timestamptz,
  departed_by uuid references staff(id) on delete set null,
  collected_by text,                  -- who collected the child
  notes text,
  updated_at timestamptz not null default now(),
  unique (club, day, child_key)
);

create or replace function attendance_touch() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.arrived_at is distinct from (case when tg_op = 'UPDATE' then old.arrived_at end) then new.arrived_by := current_staff_id(); end if;
  if new.departed_at is distinct from (case when tg_op = 'UPDATE' then old.departed_at end) then new.departed_by := current_staff_id(); end if;
  if new.arrived_at is null then new.arrived_by := null; end if;
  if new.departed_at is null then new.departed_by := null; end if;
  new.updated_at := now();
  return new;
end $$;

drop trigger if exists attendance_touch on attendance;
create trigger attendance_touch before insert or update on attendance
  for each row execute function attendance_touch();

alter table attendance enable row level security;
drop policy if exists attendance_admin on attendance;
create policy attendance_admin on attendance for all using (is_admin()) with check (is_admin());
