# Shared Cashflow

A small web app for Eric & Laura to **view and edit a shared daily cashflow
projection** from any device. It's seeded from the **March 2026** tab of the
household Google Sheet and then maintained inside the app (the sheet is only the
starting point — edits live in this app, not the sheet).

Both people hit the same server, so edits made by one show up for the other
within a few seconds.

## What you can do

- **Daily view** — every day shows start balance, money in, money out, and end
  balance, projected forward from your recurring items. Defaults to today.
- **Match your bank** — click any day's **start** or **end** balance and type the
  real number. That "anchors" the balance for that day and re-bases the
  projection from there. The dot (●) marks an anchored day; clear the box to
  remove it. This is how you keep the projection honest against your actual
  account.
- **Recurring items** — add/edit income and expenses with four schedules:
  - **Monthly** on a day of the month (e.g. Mortgage on the 15th)
  - **Weekly** on a day of the week (e.g. a weekly paycheck)
  - **Every 2 weeks** anchored to a known date (e.g. Eric's biweekly pay)
  - **Ongoing** — a monthly total spread evenly across each day (e.g. groceries)
- **Overrides** — when an item's next value differs from usual, override the
  **next X instances** without changing the recurring default. Enter one amount
  for all of them, or a comma-separated list to set each instance
  (e.g. `1200, 1100, 1300`).
- **One-off entries** — expand a day (the `›` button) to add a one-time
  miscellaneous income or expense for just that day.

## Run it

```bash
npm install
CASHFLOW_PASSWORD='pick-a-shared-secret' npm start
# open http://localhost:3000
```

On first run it creates `data/store.json` from the seed. That JSON file is the
database — back it up and it persists across restarts.

### Deploying so you can both reach it

Host it anywhere that runs Node (Render, Railway, Fly.io, a small VPS):

- Start command: `npm start`
- Set the env var `CASHFLOW_PASSWORD` to a shared password (without it the app
  warns and runs unprotected — only do that locally).
- Optionally set `PORT`.
- **Persist `data/store.json`** — mount a volume or disk at the `data/`
  directory so your numbers survive restarts/redeploys. On a platform with an
  ephemeral filesystem and no volume, edits would be lost on redeploy.

### Re-seed from the sheet

`npm run seed` rewrites `data/store.json` back to the March 2026 starting data.
This **discards** in-app edits, so only use it to start over.

## How the numbers work

The projection runs day by day. Each day's end balance = start + income −
expenses. A known (anchored) balance overrides the running value for that day
and everything after recomputes from it. Ongoing items contribute
`monthlyTotal / daysInThatMonth` each day. Overrides consume the next matching
occurrences of an item on or after their start date.

## Tech

- `server.js` — Express API + static host. Shared state in `data/store.json`,
  saved atomically with optimistic-concurrency (version) checks so simultaneous
  edits don't clobber each other.
- `public/engine.js` — the projection engine (also usable in Node).
- `public/app.js` / `index.html` / `styles.css` — the mobile-friendly UI.
- `data/seed.js` — the March 2026 starting data.
