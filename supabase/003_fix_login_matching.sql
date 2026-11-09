-- Fun Fest Timesheet — migration 003: make "who is signed in" unambiguous
-- Run once in Supabase: SQL Editor → New query → paste → Run.
--
-- Before: if a login was linked to one staff record but its email matched another,
-- the database could pick either (so a staff login could appear as Admin).
-- Now: the staff record whose email matches the login always wins, and a login
-- can only ever be linked to one staff record.

create or replace function current_staff_id() returns uuid
language sql stable security definer set search_path = public as $$
  select id from staff
  where status <> 'left'
    and (auth_user_id = auth.uid()
         or (auth_user_id is null and lower(email) = lower(auth.jwt() ->> 'email')))
  order by (lower(email) = lower(coalesce(auth.jwt() ->> 'email', ''))) desc,
           (auth_user_id is not distinct from auth.uid()) desc
  limit 1
$$;

create or replace function register_login() returns json
language plpgsql security definer set search_path = public as $$
declare s staff;
begin
  select * into s from staff where id = current_staff_id();
  if s.id is null then
    return json_build_object('ok', false, 'error', 'not_registered');
  end if;
  -- unlink this login from any other staff record first (one login = one person)
  update staff set auth_user_id = null where auth_user_id = auth.uid() and id <> s.id;
  update staff set auth_user_id = auth.uid(),
                   last_login_at = now(),
                   status = case when status = 'invited' then 'active' else status end
   where id = s.id
   returning * into s;
  return json_build_object('ok', true, 'staff', row_to_json(s));
end $$;

-- Repair existing data: unlink any staff record whose linked login has a different email
update staff s set auth_user_id = null
from auth.users u
where u.id = s.auth_user_id and lower(u.email) <> lower(s.email);

-- Show who is linked to what (check the Results panel)
select s.name, s.email as staff_email, s.role, s.status, u.email as linked_login_email
from staff s left join auth.users u on u.id = s.auth_user_id
order by s.role, s.name;
