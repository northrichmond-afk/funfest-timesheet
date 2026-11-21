-- Fun Fest Timesheet — migration 008: staff suitability (safeguarding) declarations
-- Run once in Supabase: SQL Editor → New query → paste → Run. Safe to run again.
--
-- Completed by every new member of staff when they start AND by all staff once a year.
-- Staff complete it in the staff app (Forms tab); an admin can also record one for a staff
-- member on the club device. Once submitted, staff can't change it; the manager/owner signs
-- it off and records any follow-on action in the admin pages (Forms tab).

create table if not exists suitability_declarations (
  id uuid primary key default gen_random_uuid(),
  staff_id uuid not null references staff(id) on delete cascade,
  answers jsonb not null default '{}'::jsonb,   -- question key → true (yes) / false (no)
  further_info text,                            -- details for any "yes" answer
  signed_name text not null,
  signature text,                               -- PNG data URL of the staff member's signature
  signed_at timestamptz not null default now(),
  completed_by text,                            -- who filled the form in (usually the staff member)
  entered_by uuid references staff(id) on delete set null,
  -- manager / owner sign-off
  manager_name text,
  manager_signature text,
  manager_signed_at timestamptz,
  follow_up_action text,
  action_date date,
  -- filing in iCloud (FunFest › Staff › <person>)
  pdf_synced_at timestamptz,
  pdf_path text,
  created_at timestamptz not null default now()
);
create index if not exists suitability_by_staff on suitability_declarations (staff_id, signed_at desc);

create or replace function suitability_guard() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if tg_op = 'INSERT' then
    new.entered_by := current_staff_id();
    if not is_admin() then
      new.staff_id := current_staff_id();
      new.signed_at := now();
      new.manager_name := null; new.manager_signature := null; new.manager_signed_at := null;
      new.follow_up_action := null; new.action_date := null;
      new.pdf_synced_at := null; new.pdf_path := null;
    end if;
  else
    -- the staff member's answers and signature are fixed once submitted
    if new.answers is distinct from old.answers or new.further_info is distinct from old.further_info
       or new.signed_name is distinct from old.signed_name or new.signature is distinct from old.signature
       or new.signed_at is distinct from old.signed_at or new.staff_id is distinct from old.staff_id then
      raise exception 'A submitted suitability declaration can''t be changed: ask the staff member to complete a new one';
    end if;
    if new.manager_signature is not null and old.manager_signature is null then new.manager_signed_at := now(); end if;
  end if;
  return new;
end $$;

drop trigger if exists suitability_guard on suitability_declarations;
create trigger suitability_guard before insert or update on suitability_declarations
  for each row execute function suitability_guard();

alter table suitability_declarations enable row level security;
drop policy if exists suitability_read on suitability_declarations;
create policy suitability_read on suitability_declarations for select using (staff_id = current_staff_id() or is_admin());
drop policy if exists suitability_insert on suitability_declarations;
create policy suitability_insert on suitability_declarations for insert
  with check (is_admin() or (current_staff_id() is not null and staff_id = current_staff_id()));
drop policy if exists suitability_update on suitability_declarations;
create policy suitability_update on suitability_declarations for update using (is_admin()) with check (is_admin());
drop policy if exists suitability_delete on suitability_declarations;
create policy suitability_delete on suitability_declarations for delete using (is_admin());
