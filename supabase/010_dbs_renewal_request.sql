-- Fun Fest Timesheet — migration 010: DBS Update Service renewal date + office request for it
-- Run once in Supabase: SQL Editor → New query → paste → Run. Safe to run again.
--
-- dbs_update_renewal_date: staff enter it themselves (My details › DBS); it's in their Update Service account.
-- dbs_renewal_requested_at: set by an admin from the staff sheet ("Request renewal date"); office-only.

alter table staff_profiles
  add column if not exists dbs_update_renewal_date date,
  add column if not exists dbs_renewal_requested_at timestamptz;

create or replace function staff_profiles_touch() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  office text[] := array[
    'folder_name','details_synced_at',
    'dbs_renewal_requested_at',
    'start_date','ref1_received','ref2_received','ref3_received','dbs_expiry_date','dbs_checked_on','right_to_work_checked_on','office_notes',
    'current_employer','current_job_title','current_salary','current_from','current_to','current_duties','consult_before_references',
    'previous_employment',
    'ref1_name','ref1_job_title','ref1_org','ref1_address','ref1_phone','ref1_email',
    'ref2_name','ref2_job_title','ref2_org','ref2_address','ref2_phone','ref2_email',
    'references_before_interview','has_convictions','conviction_details'];
begin
  if not is_admin() then
    -- staff can't set or change the office-only columns
    if tg_op = 'UPDATE' then
      new := jsonb_populate_record(new, (select jsonb_object_agg(k, v) from jsonb_each(to_jsonb(old)) e(k, v) where k = any(office)));
    else
      new := jsonb_populate_record(new, (select jsonb_object_agg(k, null) from unnest(office) k));
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
