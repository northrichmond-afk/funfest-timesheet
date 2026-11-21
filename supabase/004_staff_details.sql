-- Fun Fest Timesheet — migration 004: staff details + certificate uploads
-- Run once in Supabase: SQL Editor → New query → paste → Run. Safe to run again.
--
-- • staff_profiles: one row per staff member, the details from the Fun Fest application
--   form plus DBS certificate and Update Service numbers. Staff edit their own; admins all.
-- • staff_documents: certificates and other files staff upload from the app. The files
--   themselves live in the private Storage bucket "staff-docs" under <staff id>/…
--   The admin pages copy them into iCloud Drive › FunFest › Staff › <name> and mark them synced.

-- ── Details ──────────────────────────────────────────────────
create table if not exists staff_profiles (
  staff_id uuid primary key references staff(id) on delete cascade,
  -- Personal details
  full_name text,
  address text,
  personal_email text,
  phone text,
  ni_number text,
  email_ok boolean,
  -- Current / most recent employment
  current_employer text,
  current_job_title text,
  current_salary text,
  current_from text,
  current_to text,
  current_duties text,
  consult_before_references boolean,
  -- History, qualifications, training (free text, as on the paper form)
  previous_employment text,
  qualifications text,
  training text,
  -- Referees
  ref1_name text, ref1_job_title text, ref1_org text, ref1_address text, ref1_phone text, ref1_email text,
  ref2_name text, ref2_job_title text, ref2_org text, ref2_address text, ref2_phone text, ref2_email text,
  -- References and safeguarding
  references_before_interview boolean,
  has_convictions boolean,
  conviction_details text,
  -- DBS
  dbs_certificate_number text,
  dbs_issue_date date,
  dbs_update_service boolean,
  dbs_update_service_number text,
  -- Declaration
  declaration_agreed boolean not null default false,
  signature_name text,
  declared_at timestamptz,
  -- Admin only
  folder_name text,                 -- iCloud folder under FunFest/Staff (defaults to the staff name)
  details_synced_at timestamptz,    -- when "Staff details - <name>.pdf" was last written to iCloud
  updated_at timestamptz not null default now(),
  updated_by uuid references staff(id) on delete set null
);

create or replace function staff_profiles_touch() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if not is_admin() then
    -- staff can't change the admin-only columns or anyone else's row
    if tg_op = 'UPDATE' then
      new.folder_name := old.folder_name;
      new.details_synced_at := old.details_synced_at;
    else
      new.folder_name := null;
      new.details_synced_at := null;
    end if;
  end if;
  -- Only a change to the details themselves counts as an update (not the admin's sync stamp)
  if tg_op = 'INSERT' or (to_jsonb(new) - '{details_synced_at,folder_name,updated_at,updated_by,declared_at}'::text[])
                      is distinct from (to_jsonb(old) - '{details_synced_at,folder_name,updated_at,updated_by,declared_at}'::text[]) then
    new.updated_at := now();
    new.updated_by := current_staff_id();
    if new.declaration_agreed and (tg_op = 'INSERT' or not old.declaration_agreed or new.signature_name is distinct from old.signature_name) then
      new.declared_at := now();
    end if;
  else
    new.updated_at := old.updated_at;
    new.updated_by := old.updated_by;
  end if;
  if not new.declaration_agreed then new.declared_at := null; end if;
  return new;
end $$;

drop trigger if exists staff_profiles_touch on staff_profiles;
create trigger staff_profiles_touch before insert or update on staff_profiles
  for each row execute function staff_profiles_touch();

alter table staff_profiles enable row level security;
drop policy if exists profiles_read on staff_profiles;
create policy profiles_read on staff_profiles for select using (staff_id = current_staff_id() or is_admin());
drop policy if exists profiles_insert on staff_profiles;
create policy profiles_insert on staff_profiles for insert with check (staff_id = current_staff_id() or is_admin());
drop policy if exists profiles_update on staff_profiles;
create policy profiles_update on staff_profiles for update
  using (staff_id = current_staff_id() or is_admin()) with check (staff_id = current_staff_id() or is_admin());
drop policy if exists profiles_delete on staff_profiles;
create policy profiles_delete on staff_profiles for delete using (is_admin());

-- ── Documents ────────────────────────────────────────────────
create table if not exists staff_documents (
  id uuid primary key default gen_random_uuid(),
  staff_id uuid not null references staff(id) on delete cascade,
  kind text not null,               -- e.g. 'DBS certificate', 'Paediatric first aid'
  file_name text not null,          -- original file name from the phone
  storage_path text not null unique,
  size_bytes bigint,
  mime_type text,
  uploaded_at timestamptz not null default now(),
  uploaded_by uuid references staff(id) on delete set null,
  synced_at timestamptz,            -- copied into iCloud by the admin pages
  synced_path text                  -- e.g. 'Alice Sweeney/DBS certificate - Alice Sweeney (2026-11-21).pdf'
);
create index if not exists staff_documents_staff on staff_documents (staff_id, uploaded_at desc);
create index if not exists staff_documents_unsynced on staff_documents (uploaded_at) where synced_at is null;

create or replace function staff_documents_guard() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if tg_op = 'INSERT' then
    new.uploaded_by := current_staff_id();
    new.uploaded_at := now();
    if not is_admin() then new.synced_at := null; new.synced_path := null; end if;
    -- the file must be in the uploader's own folder (admins may upload for anyone)
    if split_part(new.storage_path, '/', 1) <> new.staff_id::text then
      raise exception 'File path must start with the staff id';
    end if;
  end if;
  return new;
end $$;

drop trigger if exists staff_documents_guard on staff_documents;
create trigger staff_documents_guard before insert on staff_documents
  for each row execute function staff_documents_guard();

alter table staff_documents enable row level security;
drop policy if exists docs_read on staff_documents;
create policy docs_read on staff_documents for select using (staff_id = current_staff_id() or is_admin());
drop policy if exists docs_insert on staff_documents;
create policy docs_insert on staff_documents for insert with check (staff_id = current_staff_id() or is_admin());
drop policy if exists docs_update on staff_documents;
create policy docs_update on staff_documents for update using (is_admin()) with check (is_admin());
-- staff can remove their own upload until the office has copied it; admins any time
drop policy if exists docs_delete on staff_documents;
create policy docs_delete on staff_documents for delete
  using (is_admin() or (staff_id = current_staff_id() and synced_at is null));

-- ── Storage bucket (private) ─────────────────────────────────
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('staff-docs', 'staff-docs', false, 15728640,
        array['application/pdf','image/jpeg','image/png','image/heic','image/heif','image/webp',
              'application/msword','application/vnd.openxmlformats-officedocument.wordprocessingml.document'])
on conflict (id) do update set public = false, file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;

drop policy if exists staff_docs_read on storage.objects;
create policy staff_docs_read on storage.objects for select
  using (bucket_id = 'staff-docs' and ((storage.foldername(name))[1] = current_staff_id()::text or is_admin()));
drop policy if exists staff_docs_insert on storage.objects;
create policy staff_docs_insert on storage.objects for insert
  with check (bucket_id = 'staff-docs' and ((storage.foldername(name))[1] = current_staff_id()::text or is_admin()));
drop policy if exists staff_docs_delete on storage.objects;
create policy staff_docs_delete on storage.objects for delete
  using (bucket_id = 'staff-docs' and (is_admin() or ((storage.foldername(name))[1] = current_staff_id()::text
    and exists (select 1 from staff_documents d where d.storage_path = name and d.synced_at is null))));
