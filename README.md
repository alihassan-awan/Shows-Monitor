# Indian TV Release Monitor — v2

One button. Two lists: **Newly Released** and **Upcoming** TV shows & web series across
JioHotstar, ZEE5, SonyLIV and Sun NXT. Powered by the **official Google Gemini API**
(with live web grounding), with a **daily auto-check** and **Telegram alerts** when a
new show releases. Deployable to **Vercel** in minutes.

## What's new in v2

- **Real Google Gemini integration** — official Generative Language API
  (`generativelanguage.googleapis.com`) with the `google_search` grounding tool.
  No more local proxy needed. (The old OpenAI-compatible proxy still works if you
  set `GEMINI_BASE_URL`.)
- **Daily auto-check** — Vercel Cron runs the full check every 24 hours
  (09:00 PKT). Locally, `AUTO_CHECK=true` does the same via an in-process timer.
- **Telegram notifications** — when the check finds newly released shows, you get
  an alert on Telegram with title, platform, release date and summary.
- **Parallel research** — all 4 platforms are checked concurrently with
  per-platform timeouts, so a full run fits Vercel's 60-second function limit.
- **Persistent storage on Vercel** — Vercel KV (Redis) in production, JSON files
  for local dev. Automatic, no code changes.
- **No duplicate alerts** — every record tracks `notified_at`; old shows already
  in the database are never re-announced.
- **Status bar in the UI** — last check time, Telegram state, API-key warnings.

## Quick start (local)

```bash
npm install
cp .env.example .env
# edit .env: at minimum set GEMINI_API_KEY
npm start
# open http://localhost:3000
```

Test the Gemini connection separately:

```bash
npm run diagnose
```

## 1) Google Gemini API key (required)

1. Go to **https://aistudio.google.com/apikey** (sign in with Google).
2. Click **Create API key** → copy it.
3. Locally: paste it as `GEMINI_API_KEY=` in `.env`.
   On Vercel: add it as an environment variable (see deploy steps below).

The free tier is more than enough for one check per day (4 grounded searches).

## 2) Telegram alerts (recommended, ~2 minutes)

1. On Telegram, talk to **@BotFather** → send `/newbot` → follow the prompts → copy the **bot token**.
2. Start a chat with your new bot (send it any message, e.g. "hi").
3. Open in a browser (replace `<TOKEN>`):
   `https://api.telegram.org/bot<TOKEN>/getUpdates`
   Find `"chat":{"id": 123456789 ...}` → that number is your `TELEGRAM_CHAT_ID`.
4. Set in `.env` / Vercel env vars:
   ```
   TELEGRAM_BOT_TOKEN=<token>
   TELEGRAM_CHAT_ID=<your numeric id>
   ```
5. Verify: open `http://localhost:3000/api/telegram/test` (or your Vercel URL +
   `/api/telegram/test`) — you should receive "✅ Telegram connected!".

Multiple recipients: comma-separate chat ids. To also get alerts for newly
discovered *upcoming* shows, set `TELEGRAM_NOTIFY_UPCOMING=true`.

## 3) Deploy to Vercel

**A. Push to GitHub** (or import the folder directly):

```bash
git init && git add . && git commit -m "shows monitor v2"
# create a repo on github.com and:
git remote add origin <your-repo-url> && git push -u origin main
```

**B. Import in Vercel**
1. Go to **vercel.com → Add New → Project → Import** your repo.
2. Framework preset: **Other**. No build command needed.
3. **Environment variables** — add at least:
   - `GEMINI_API_KEY` — your Google AI Studio key
   - `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID` — for alerts
   - `CRON_SECRET` — any long random string (protects the cron endpoint)
4. **Storage (for persistence!):** the app needs a Redis database.
   Vercel injects `KV_REST_API_URL` / `KV_REST_API_TOKEN` automatically when you
   connect one; a manual Upstash database's `UPSTASH_REDIS_REST_URL` /
   `UPSTASH_REDIS_REST_TOKEN` also work. Two ways:
   - **In Vercel:** project dashboard → **Storage** tab → **Create Database** →
     look for **Upstash Redis** (search "Upstash" if "Redis" finds nothing) →
     create and connect it to the project.
   - **Direct (if Vercel shows no Redis option):** sign up at **upstash.com** →
     Create Database → Redis (free tier, pick the closest region) → copy the
     **REST API** URL and token → add them in Vercel as environment variables
     named `KV_REST_API_URL` and `KV_REST_API_TOKEN`.
   *Without this, show data resets on every cold start.*
5. Deploy.

**C. Cron** — `vercel.json` already schedules `/api/cron/check` daily at
`0 4 * * *` (04:00 UTC = **09:00 PKT**). Vercel picks it up automatically on
deploy (check the project's **Crons** tab). Note: Hobby plan allows
once-per-day crons — exactly our cadence.

**D. Verify** — open `https://<your-app>.vercel.app/api/telegram/test`
(you should get the Telegram test message), then press **Check Updates** in the UI.

To change the daily time, edit the `schedule` in `vercel.json`
(cron format, UTC).

## How it works

```
Browser → Vercel (static UI + /api/* functions)
            ├─ /api/check        → manual check (SSE progress)
            ├─ /api/cron/check   → daily cron (Bearer CRON_SECRET), Telegram alerts
            ├─ /api/shows        → stored shows (filters)
            ├─ /api/meta         → config + status
            └─ /api/telegram/test → setup verification
                    │
                    ▼
        Google Gemini API (gemini-2.5-flash + google_search grounding)
        searches recent news + official pages per platform
                    │
                    ▼
        merge/clean/de-dupe → Vercel KV (or data/shows.json locally)
                    │
                    ▼
        new releases → Telegram Bot API → your phone 📲
```

## Configuration

| Variable | Required | Default | Purpose |
|---|---|---|---|
| `GEMINI_API_KEY` | yes | — | Google AI Studio key |
| `GEMINI_MODEL` | no | `gemini-3.5-flash-lite` | Must support `google_search` grounding (`gemini-2.5-flash` was retired for new keys) |
| `GEMINI_BASE_URL` | no | — | OpenAI-compatible proxy URL (legacy v1 mode) |
| `TELEGRAM_BOT_TOKEN` | for alerts | — | BotFather token |
| `TELEGRAM_CHAT_ID` | for alerts | — | Your numeric chat id (comma-separated ok) |
| `TELEGRAM_NOTIFY_UPCOMING` | no | `false` | Also alert on new upcoming shows |
| `CRON_SECRET` | Vercel | — | Protects `/api/cron/check` |
| `RELEASE_LOOKBACK_DAYS` | no | `30` | "Newly Released" window |
| `UPCOMING_HORIZON_DAYS` | no | `180` | Upcoming horizon |
| `AUTO_CHECK` / `AUTO_CHECK_INTERVAL_HOURS` | no | `false` / `24` | Local auto-check timer |
| `PORT` | no | `3000` | Local server port |

## Files

```
server.js            Local dev server (Express)
api/                 Vercel serverless functions (meta, shows, check, cron/check, telegram/test)
src/gemini.js        Gemini client: official API + proxy fallback
src/research.js      Parallel per-platform research prompts
src/merge.js         Normalize, de-duplicate, validate, classify
src/store.js         Storage backend: Vercel KV <-> local JSON files
src/db.js            Record store (async) + run metadata
src/scheduler.js     Shared check pipeline (manual / cron / local auto)
src/telegram.js      Telegram Bot API alerts
src/platforms.js     Platform/channel config
src/handlers.js      HTTP handlers shared by Express + Vercel
public/              Single-page UI (status bar, filters, cards, sources modal)
vercel.json          Cron schedule + function timeouts
diagnose.mjs         Connection diagnostic (npm run diagnose)
```

## Notes & limits

- Vercel Hobby functions max out at 60s — research runs all platforms in
  parallel with 50s per-platform timeouts, and partial results are kept.
- The model is instructed to return only evidence-backed shows; 3 correct shows
  beat 20 questionable ones. Rumours are dropped by `merge.js` validation.
- Old records are backfilled as "already notified" on first run, so enabling
  Telegram later won't spam you with the existing catalogue.
