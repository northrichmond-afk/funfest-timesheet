-- Fun Fest Timesheet — migration 013: parent signatures on the attendance register
-- Run once in Supabase: SQL Editor → New query → paste → Run. Safe to run again.
-- The parent (or whoever drops off / collects) signs on the club device at drop-off and collection.
alter table attendance
  add column if not exists dropped_off_by text,
  add column if not exists arrival_signature text,     -- PNG data URL
  add column if not exists departure_signature text;   -- PNG data URL
