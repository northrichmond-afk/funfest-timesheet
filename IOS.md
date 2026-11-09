# Fun Fest iPhone app

The iPhone app is the same staff app as the website, packaged as a native app with [Capacitor](https://capacitorjs.com). It's built on GitHub's Mac servers, so **you don't need a Mac**.

What's different in the app:
- Opens from its own **Fun Fest** icon, full screen, with no browser bars and no "Add to Home Screen" step
- Uses iPhone **native location**. Staff see the standard iOS prompt *"Allow Fun Fest to use your location?"*
- **Google sign-in** opens in a Safari sheet and returns to the app (Google blocks sign-in inside apps' web views)
- **Confirm-email and reset-password links** open the app directly
- Bundle ID: `uk.co.funfestholidayclub.timesheet`

The website version keeps working, for Android staff and anyone without the app.

---

## One-time setup

### 1. Apple Developer Program (£79/year)
Enrol at https://developer.apple.com/programs/enroll/
- **As an organisation (recommended):** shows "Vadivu Fun Fest Club Ltd" as the developer. Needs a free **D-U-N-S number** for the company (apply via Apple's lookup tool; it can take up to about 2 weeks) and a company website.
- **As an individual:** faster (about 1–2 days), but shows your personal name as the developer.

### 2. Create the app in App Store Connect
1. https://appstoreconnect.apple.com → **Apps → + → New App**
2. Platform **iOS**, Name **Fun Fest Timesheet** (must be unique on the App Store; add a word if it's taken), language English (UK)
3. Bundle ID: if `uk.co.funfestholidayclub.timesheet` isn't in the list, first register it at https://developer.apple.com/account/resources/identifiers → **+ → App IDs → App**, explicit Bundle ID `uk.co.funfestholidayclub.timesheet`
4. SKU: `funfest-timesheet`

### 3. API key so GitHub can build and upload
1. App Store Connect → **Users and Access → Integrations → App Store Connect API → Team Keys → +**
2. Name `GitHub`, access **Admin** (needed so it can create the signing certificate)
3. Download the `.p8` file (you can only download it once) and note the **Key ID** and **Issuer ID**
4. Your **Team ID**: https://developer.apple.com/account → Membership details

### 4. Add the secrets to GitHub
Repo → **Settings → Secrets and variables → Actions → New repository secret**:

| Name | Value |
|---|---|
| `APPLE_TEAM_ID` | Team ID (10 characters) |
| `ASC_KEY_ID` | Key ID |
| `ASC_ISSUER_ID` | Issuer ID |
| `ASC_KEY_P8_BASE64` | The .p8 file, base64-encoded. On a Mac: `base64 -i AuthKey_XXXX.p8 \| pbcopy`. On Windows PowerShell: `[Convert]::ToBase64String([IO.File]::ReadAllBytes("AuthKey_XXXX.p8")) \| Set-Clipboard` |

### 5. Let sign-in links open the app (Supabase)
**Authentication → URL Configuration → Redirect URLs → Add URL:**
```
uk.co.funfestholidayclub.timesheet://**
```

---

## Building a new version
1. GitHub → **Actions → iPhone app → Run workflow**. Or push a tag: `git tag ios-v1.0.1 && git push --tags`
2. About 15 minutes later, the build appears in **App Store Connect → TestFlight** (after Apple's processing).
3. Without the secrets, the workflow does a test build only, which is useful to check everything compiles.

Each run gets a new build number automatically. To change the version shown to users (1.0 → 1.1), change `MARKETING_VERSION` in `ios/App/App.xcodeproj/project.pbxproj`.

GitHub's Mac build minutes: free for public repos. For private repos, the free plan includes about 200 Mac minutes a month (around 10–12 builds).

---

## Getting it onto staff phones

| Route | Best for | Notes |
|---|---|---|
| **TestFlight** (start here) | Pilot and all staff | Staff install the free **TestFlight** app, then tap your invite link. Up to 10,000 testers. A **public link** works without collecting emails. Each build lasts 90 days, so re-run the build at least every 3 months. The first external build gets a light Apple review (usually within a day) |
| **App Store, unlisted** | Long term | Apple review; the app only appears via a direct link, not in search. Request unlisted distribution after the first approval |
| **App Store, public** | Not needed | Anyone could find it; Apple may question an app only your staff can use |

For Apple's review, give them a **demo login**: in the admin pages, add a staff member e.g. `appreview@funfestholidayclub.co.uk`, create a password for it, and add a test venue. Put the email and password in App Store Connect → **App Review Information**. Also add a **privacy policy URL** (required): a short page saying what the app collects (name, email, location at clock in/out, shift times), why, and how long it's kept.

---

## Developing locally (optional, needs a Mac with Xcode)
```bash
npm ci
npm run ios:sync      # copies app/ + shared/ into the iOS project
npx cap open ios      # opens Xcode, then press ▶ to run on a simulator or a connected iPhone
```
