# Shared Cashflow (Firebase)

A web app for Eric & Laura to **view and edit a shared daily cashflow
projection** from any device, with **live sync** and **Google sign-in**. It's
seeded from the **March 2026** tab of the household Google Sheet and then
maintained inside the app.

- **No server to run or pay for.** The app is static files hosted on Firebase
  Hosting; the shared data lives in Firebase Firestore (Google's realtime
  database). Easily within Firebase's free "Spark" plan for two people.
- **Live updates.** When one person edits, the other sees it within a second.
- **Locked to your two Google accounts.** Nobody else can open the data.

## What you can do

- **Daily view** — each day shows start balance, money in, money out, and end
  balance, projected forward. Defaults to today.
- **Match your bank** — click any day's **start** or **end** balance and type
  the real number. That "anchors" the balance (●) and re-bases the projection
  from there. Clear the box to remove it.
- **Recurring items** — income/expenses with four schedules: **Monthly** (day
  of month), **Weekly** (day of week), **Every 2 weeks** (anchored to a date),
  and **Ongoing** (a monthly total spread evenly across each day).
- **Overrides** — override the **next X instances** of an item when a value
  differs from usual, without changing the default. One amount for all, or a
  comma-separated list per instance (e.g. `1200, 1100, 1300`).
- **Edit a single day in place** — expand a day (`›`) and type a new amount on
  any income/expense line to change just that one occurrence; other days are
  untouched. A `↺` reverts it to the usual amount.
- **One-off entries** — expand a day (`›`) to add a one-time misc income/expense.

---

## One-time setup (all in a web browser — no terminal needed)

### 1. Create the Firebase project
1. Go to <https://console.firebase.google.com> and sign in with your Google
   account → **Add project** → name it (e.g. `our-cashflow`) → you can disable
   Google Analytics → **Create project**.

### 2. Turn on Google sign-in
1. Left menu → **Build → Authentication → Get started**.
2. **Sign-in method** tab → **Google** → enable → pick a support email → **Save**.

### 3. Create the database
1. Left menu → **Build → Firestore Database → Create database**.
2. Start in **production mode** → pick a location near you → **Enable**.

### 4. Lock it to your two accounts
1. Firestore Database → **Rules** tab.
2. Open `firestore.rules` from this repo, replace
   `REPLACE_WITH_WIFE_EMAIL@gmail.com` with your wife's real Google email,
   then paste the whole file into the editor → **Publish**.

### 5. Get your web config
1. Project **settings** (gear icon, top-left) → scroll to **Your apps** →
   click the **Web** icon (`</>`) → register an app (any nickname) → it shows a
   `firebaseConfig` block.
2. Copy those values into `public/firebase-config.js`, and put the same two
   emails in `ALLOWED_EMAILS` there. (These values are not secret.)

### 6. Set up auto-deploy from GitHub
1. Firebase project **settings → Service accounts → Generate new private key**
   → download the JSON file.
2. In GitHub: this repo → **Settings → Secrets and variables → Actions → New
   repository secret**. Name it **`FIREBASE_SERVICE_ACCOUNT`** and paste the
   entire JSON file contents as the value.
3. Replace `PASTE_PROJECT_ID` with your Firebase **Project ID** in two files:
   `.firebaserc` and `.github/workflows/firebase-hosting.yml`.

### 7. Deploy
Commit the edits from steps 5–6 to the **`main`** branch (editing files on
github.com and clicking "Commit changes" is fine). The included GitHub Action
builds and deploys automatically. When it finishes (green check under the
repo's **Actions** tab), your app is live at
`https://YOUR_PROJECT_ID.web.app`.

### 8. Authorize the live domain
1. Firebase **Authentication → Settings → Authorized domains → Add domain** →
   add `YOUR_PROJECT_ID.web.app` (the Firebase-provided ones are usually there
   already; add it if missing).
2. Open the URL on both your phones, **Sign in with Google**, and bookmark /
   add to home screen.

The first time it opens on the empty database, it writes the March 2026
starting data automatically. Then fix anything that's off in the **Recurring**
tab (e.g. Laura's PDA pay amount/day, which I estimated from the sheet) and set
today's **End balance** to your real bank balance.

---

## Running it on your computer (optional)
You don't need to, but to preview locally: `npm run dev` (serves `public/` via
`npx serve`). You still need the Firebase config filled in and the domain
`localhost` added under Authentication → Authorized domains.

## How the numbers work
The projection runs day by day: each day's end balance = start + income −
expenses. A known (anchored) balance overrides the running value for that day,
and everything after recomputes from it. Ongoing items contribute
`monthlyTotal / daysInThatMonth` each day. Overrides consume the next matching
occurrences of an item on or after their start date.

## Files
- `public/index.html`, `app.js`, `styles.css` — the UI (`app.js` talks to
  Firebase directly).
- `public/engine.js` — the projection engine.
- `public/seed.js` — March 2026 starting data (written once to Firestore).
- `public/firebase-config.js` — your project's web config + allowed emails.
- `firestore.rules` — access locked to your two emails.
- `firebase.json`, `.firebaserc`, `.github/workflows/firebase-hosting.yml` —
  hosting + auto-deploy config.
