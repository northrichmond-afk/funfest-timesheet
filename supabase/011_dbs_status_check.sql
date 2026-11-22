-- Fun Fest Timesheet — migration 011: automatic DBS Update Service status checks
-- Run once in Supabase: SQL Editor → New query → paste → Run. Safe to run again.
--
-- Admins run a status check from the staff sheet or Reports › Critical info. The database calls the
-- DBS Update Service status check web service (https://secure.crbonline.gov.uk/crsc/api/status/…),
-- using the certificate number, date of birth and surname held for the person, and records the
-- result. The DBS service does not return the subscription renewal date. The admin must confirm
-- they have the person's consent; every check is visible to the person in their Update Service account.

create extension if not exists http with schema extensions;

alter table staff_profiles
  add column if not exists dbs_status text,               -- BLANK_NO_NEW_INFO | NON_BLANK_NO_NEW_INFO | NEW_INFO | NO_MATCH | ERROR
  add column if not exists dbs_status_checked_at timestamptz,
  add column if not exists dbs_status_detail text;

create table if not exists dbs_status_checks (
  id uuid primary key default gen_random_uuid(),
  staff_id uuid not null references staff(id) on delete cascade,
  checked_at timestamptz not null default now(),
  checked_by uuid references staff(id) on delete set null,
  certificate_number text,
  organisation text,
  checker_name text,
  result_type text,
  status text,
  forename text,
  surname text,
  print_date date,
  http_status int,
  detail text
);
create index if not exists dbs_status_checks_by_staff on dbs_status_checks (staff_id, checked_at desc);
alter table dbs_status_checks enable row level security;
drop policy if exists dbs_status_checks_admin on dbs_status_checks;
create policy dbs_status_checks_admin on dbs_status_checks for select using (is_admin());

-- p_surname: surname as on the certificate (defaults to the last word of their name)
create or replace function dbs_status_check(p_staff uuid, p_organisation text, p_checker_forename text, p_checker_surname text,
                                            p_consent boolean, p_surname text default null)
returns jsonb language plpgsql security definer set search_path = public, extensions as $$
declare
  p staff_profiles;
  s staff;
  cert text; sur text; url text;
  v_http int; v_content text; doc xml;
  v_type text; v_status text; v_fore text; v_sur text; v_print text;
  out_status text; detail text;
begin
  if not is_admin() then raise exception 'Only admins can run DBS status checks'; end if;
  if p_consent is not true then raise exception 'Confirm you have the person''s consent to check their DBS status'; end if;
  if coalesce(trim(p_organisation), '') = '' or coalesce(trim(p_checker_forename), '') = '' or coalesce(trim(p_checker_surname), '') = '' then
    raise exception 'Organisation name and your forename and surname are needed for a DBS status check';
  end if;
  select * into s from staff where id = p_staff;
  select * into p from staff_profiles where staff_id = p_staff;
  if s.id is null then raise exception 'Staff member not found'; end if;
  cert := regexp_replace(coalesce(p.dbs_certificate_number, ''), '\D', '', 'g');
  if cert !~ '^\d{12}$' then raise exception '%: no 12-digit DBS certificate number on file', s.name; end if;
  if p.date_of_birth is null then raise exception '%: no date of birth on file (they can add it under My details)', s.name; end if;
  sur := coalesce(nullif(trim(p_surname), ''), regexp_replace(trim(coalesce(nullif(p.full_name, ''), s.name)), '^.*\s', ''));

  url := 'https://secure.crbonline.gov.uk/crsc/api/status/' || cert
      || '?dateOfBirth=' || urlencode(to_char(p.date_of_birth, 'DD/MM/YYYY'))
      || '&surname=' || urlencode(upper(sur))
      || '&hasAgreedTermsAndConditions=true'
      || '&organisationName=' || urlencode(trim(p_organisation))
      || '&employeeSurname=' || urlencode(trim(p_checker_surname))
      || '&employeeForename=' || urlencode(trim(p_checker_forename));

  begin
    perform http_set_curlopt('CURLOPT_TIMEOUT_MS', '20000');
    select r.status, r.content into v_http, v_content from http_get(url) r;
  exception when others then
    detail := 'Could not reach the DBS service: ' || sqlerrm;
  end;

  if v_http is not null then
    begin
      doc := xmlparse(document v_content);
      v_type   := (xpath('//statusCheckResultType/text()', doc))[1]::text;
      v_status := (xpath('//status/text()', doc))[1]::text;
      v_fore   := (xpath('//forename/text()', doc))[1]::text;
      v_sur    := (xpath('//surname/text()', doc))[1]::text;
      v_print  := (xpath('//printDate/text()', doc))[1]::text;
    exception when others then
      detail := 'Unexpected reply from the DBS service (HTTP ' || v_http || '): ' || left(coalesce(v_content, ''), 200);
    end;
  end if;

  out_status := case
    when v_type = 'SUCCESS' and v_status in ('BLANK_NO_NEW_INFO', 'NON_BLANK_NO_NEW_INFO', 'NEW_INFO') then v_status
    when v_type is not null then 'NO_MATCH'
    else 'ERROR' end;
  if out_status = 'NO_MATCH' then
    detail := 'No match (' || coalesce(v_status, v_type) || '): not on the Update Service, subscription lapsed, or the certificate number, date of birth or surname ('
              || sur || ') don''t match the certificate';
  end if;

  insert into dbs_status_checks (staff_id, checked_by, certificate_number, organisation, checker_name, result_type, status,
                                 forename, surname, print_date, http_status, detail)
  values (p_staff, current_staff_id(), cert, trim(p_organisation), trim(p_checker_forename) || ' ' || trim(p_checker_surname),
          v_type, out_status, v_fore, v_sur, case when v_print ~ '^\d{4}-\d\d-\d\d$' then v_print::date end, v_http, detail);

  update staff_profiles set dbs_status = out_status, dbs_status_checked_at = now(), dbs_status_detail = detail,
         dbs_checked_on = case when out_status in ('BLANK_NO_NEW_INFO', 'NON_BLANK_NO_NEW_INFO') then current_date else dbs_checked_on end
   where staff_id = p_staff;

  return jsonb_build_object('status', out_status, 'result_type', v_type, 'detail', detail, 'surname', sur,
                            'print_date', v_print, 'checked_at', now());
end $$;
revoke all on function dbs_status_check(uuid, text, text, text, boolean, text) from public, anon;
grant execute on function dbs_status_check(uuid, text, text, text, boolean, text) to authenticated;

create or replace function staff_profiles_touch() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  office text[] := array[
    'folder_name','details_synced_at',
    'dbs_renewal_requested_at','dbs_status','dbs_status_checked_at','dbs_status_detail',
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
  if tg_op = 'INSERT' or (to_jsonb(new) - '{details_synced_at,folder_name,updated_at,updated_by,declared_at,dbs_status,dbs_status_checked_at,dbs_status_detail,dbs_checked_on}'::text[])
                      is distinct from (to_jsonb(old) - '{details_synced_at,folder_name,updated_at,updated_by,declared_at,dbs_status,dbs_status_checked_at,dbs_status_detail,dbs_checked_on}'::text[]) then
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
