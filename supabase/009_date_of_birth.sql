-- Fun Fest Timesheet — migration 009: staff date of birth
-- Run once in Supabase: SQL Editor → New query → paste → Run. Safe to run again.
-- Staff enter it themselves under My details; the office needs it (with the certificate number
-- and surname) for DBS Update Service status checks. Visible only to the staff member and admins
-- (existing staff_profiles row-level security).
alter table staff_profiles add column if not exists date_of_birth date;
