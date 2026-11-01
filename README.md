# Fun Fest Timesheet

Staff clock in and out on their phones. The app checks they're at the venue using GPS. Admins plan shifts, correct times, and download hours for payroll.

- **Staff app:** https://northrichmond-afk.github.io/funfest-timesheet/app/
- **Admin:** https://northrichmond-afk.github.io/funfest-timesheet/admin/ (sign in as northrichmond@funfestholidayclub.co.uk)

## What's in here

| Folder | What it is |
|---|---|
| `app/` | Staff phone app (installable PWA): Google sign-in, location notice, Start/End shift, My hours, request a change, works offline |
| `admin/` | Admin pages: Today, Rota, Timesheets, Requests, Reports, Staff, Venues, Settings |
| `shared/` | Supabase connection, hours calculation, styles |
| `supabase/schema.sql` | Database tables, security rules and functions, with the first admin seeded |
| `.github/workflows/pages.yml` | Runs tests and publishes the site to GitHub Pages on every push to `main` |
| `tests/` | Unit tests for the hours calculation (`npm test`) |

No build step: it's plain HTML and JavaScript.

---

## One-time setup (about 30 minutes)

### 1. Supabase (database and login)
1. Go to https://supabase.com → **Continue with GitHub** (as `northrichmond-afk`) → **New project**.
   Name it `funfest-timesheet`, choose region **London (eu-west-2)**, and set a strong database password (keep it safe).
2. Open **SQL Editor → New query**, paste all of `supabase/schema.sql`, and click **Run**.
3. Open **Project Settings → API** and copy the **Project URL** and the **anon public** key.
4. Put them in `shared/config.js`:
   ```js
   export const SUPABASE_URL = 'https://abcdefgh.supabase.co';
   export const SUPABASE_ANON_KEY = 'eyJhbGciOi...';
   ```
   The anon key is safe to publish, because the database rules protect the data. **Never** put the `service_role` key anywhere in this repo.

### 2. Google sign-in
1. Signed in as **northrichmond@funfestholidayclub.co.uk**, go to https://console.cloud.google.com and create a project called **Fun Fest Timesheet**.
2. **APIs & Services → OAuth consent screen**: choose **External**, app name *Fun Fest Timesheet*, support email northrichmond@…, scopes **email** and **profile** only. Then **Publish app**, so any staff Google account can sign in. No Google review is needed for these scopes.
3. **Credentials → Create credentials → OAuth client ID → Web application**:
   - Authorised JavaScript origins: `https://northrichmond-afk.github.io`
   - Authorised redirect URIs: `https://<your-project-ref>.supabase.co/auth/v1/callback` (Supabase shows the exact URL under Authentication → Providers → Google)
4. Copy the **Client ID** and **Client secret** into Supabase **Authentication → Providers → Google**, turn it on, and save.
5. In Supabase **Authentication → URL Configuration**:
   - Site URL: `https://northrichmond-afk.github.io/funfest-timesheet/app/`
   - Redirect URLs: add `https://northrichmond-afk.github.io/funfest-timesheet/**`

### 3. GitHub Pages
1. Push this code to `northrichmond-afk/funfest-timesheet` (branch `main`).
2. In the repo, go to **Settings → Pages → Build and deployment → Source: GitHub Actions**.
3. The **Actions** tab shows the deploy running; after a minute or so the site is live.

### 4. First use
1. Open the **Admin** link and sign in with Google as northrichmond@funfestholidayclub.co.uk.
2. **Venues → Add venue**: stand at the entrance and tap *Use my location*, or paste coordinates from Google Maps. 150 m radius is a good start.
3. **Staff → Add**: use each person's **Google account email**, then send the invite (email, WhatsApp, or copy).
4. **Rota**: set expected start and end times (the *Fill Mon–Fri* template and *Copy last week* buttons save time).
5. Test with your own phone before the pilot.

---

## How it works

- **Login:** Google sign-in. Only emails added on the Staff page can get in; anyone else sees "You're not registered". Marking someone as *Left* blocks them immediately.
- **Start shift:** the phone sends its GPS position. The database finds the nearest venue and only accepts the start if they're within its radius.
- **End shift:** always accepted, but if they're outside the radius (or the end was submitted late because there was no signal) the entry is **flagged** for review.
- **Offline:** if there's no signal, the tap is saved on the phone with its real time and sent automatically later. Entries more than 5 minutes late are flagged.
- **Edits:** staff can't change times. They send a *Request change*, which the admin approves or rejects. Admin edits need a reason and are kept in the **History** (audit trail). Everything goes through database functions, so there's no way around the audit.
- **Hours:** actual end − start − unpaid break (from the rota). Settings control rounding, whether early arrival is paid, and the late grace period.
- **Pay periods:** after payroll, lock the period on the Reports page. Times and rota in that period can't be changed until it's unlocked in Settings.
- **Location data:** captured only at the moment someone taps Start or End.

## Housekeeping

- **Delete old GPS positions** (keeps hours, removes exact coordinates over 3 months old). Run monthly in the SQL Editor, or schedule it with Supabase's `pg_cron`:
  ```sql
  update time_entries set start_lat=null, start_lng=null, end_lat=null, end_lng=null
  where actual_start < now() - interval '3 months' and start_lat is not null;
  ```
- **Forgotten clock-outs:** these show as "On shift" on the Today page and as exceptions in Reports. Use *End / edit* to close them.

## Local development
```bash
npm run serve        # http://localhost:8080/app/  (add http://localhost:8080/** to Supabase redirect URLs)
npm test             # hours calculation tests
```
