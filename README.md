# Indian TV Release Monitor — v2

One button. Two lists: **Newly Released** and **Upcoming** TV shows & web series across
JioHotstar, ZEE5, SonyLIV and Sun NXT — read **directly from the platforms'
official pages** (no Google, no news sites, no LLM). **Tavily Extract** renders
the official category/channel pages daily; anything appearing for the first
time counts as newly released. With a **daily auto-check** and **Telegram
alerts** (with official show links) when a new show appears. Deployable to
**Vercel** in minutes.

## How it works

```
Every day (09:00 PKT cron, or the Check Updates button):

  23 official pages (src/sources.js: StarPlus, Colors, Star Vijay,
  ZEE5 languages, Sony SAB, Sun Bangla, …)
        │  Tavily Extract (renders JS, returns markdown + links)
        ▼
  parse show titles + official page links   ← no LLM, zero token usage
        │  compare with yesterday's snapshot (Vercel KV / local file)
        ▼
  first-time titles → "Newly Released" + Telegram alert with official link
```

- **Single source of truth:** only the platforms' own pages. A title the page
  lists is confirmed by definition — no guessing premiere dates from news.
- **"Newly Released"** = first seen on an official page within the last
  `RELEASE_LOOKBACK_DAYS` (default **15** — daily checks make longer windows
  unnecessary).
- **Free tier math:** ~23 pages/day at advanced extract depth ≈ 300
  Tavily credits/month (limit: 1,000). No other API costs at all.
- **First run is a silent baseline:** the whole catalogue is recorded without
  Telegram spam; from the second run on, only genuinely new titles alert.
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
# edit .env: at minimum set TAVILY_API_KEY
npm start
# open http://localhost:3000
```

Test the research keys separately:

```bash
npm run diagnose
```

## 1) Tavily key (the only research key needed)

1. Go to **https://tavily.com** → sign up → dashboard **API Keys** → copy
   (starts with `tvly-`). Free: 1,000 credits/month, no card.
2. Set `TAVILY_API_KEY=<tvly-...>` in `.env` (local) or Vercel env vars.
3. Test one source page: `npm run diagnose` (tests all: `node diagnose.mjs --all`).

## 2) Telegram (recommended)

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
   - `TAVILY_API_KEY` — your Tavily key (free at tavily.com)
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
        ┌──────────────────────────────────┐
        ▼                                  ▼
  For each platform (in parallel):   Tavily Extract renders
  its official source pages          the JS-heavy pages,
  (src/sources.js)                   returns markdown + links
        │                                  │
        └───────────┬──────────────────────┘
                    ▼
        parse titles + official links (no LLM)
                    │
                    ▼
        diff vs yesterday's snapshot → new titles alert
                    ▼
        merge/clean/de-dupe → Vercel KV (or data/shows.json locally)
                    │
                    ▼
        new releases → Telegram Bot API → your phone 📲
```

## Configuration

| Variable | Required | Default | Purpose |
|---|---|---|---|
| `TAVILY_API_KEY` | yes | — | Free key at tavily.com (1,000 credits/mo) |
| `TAVILY_EXTRACT_DEPTH` | no | `advanced` | `advanced` (JS-heavy pages) or `basic` (half credits) |
| `RELEASE_LOOKBACK_DAYS` | no | `15` | "Newly Released" = first seen within this many days |
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
src/research.js      Per-platform research: official pages via Tavily Extract (parallel)
src/extract.js       Tavily Extract client + show-title/link parser (no LLM)
src/sources.js       The 23 official platform pages (the single source of truth)
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
