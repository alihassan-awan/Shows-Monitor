# Indian TV Release Monitor — v2

One button. Two lists: **Newly Released** and **Upcoming** TV shows & web series across
JioHotstar, ZEE5, SonyLIV and Sun NXT. Powered by the **official Google Gemini API**
(with live web grounding), with a **daily auto-check** and **Telegram alerts** when a
new show releases. Deployable to **Vercel** in minutes.

## What's new in v2

- **Two research providers** — `RESEARCH_PROVIDER=gemini` (default): official
  Google Gemini API with `google_search` grounding. `RESEARCH_PROVIDER=tavily`
  ("groq" bhi chalega): **Tavily** web search + **any OpenAI-compatible LLM**
  (Groq, OpenRouter, …) for extraction — just set `LLM_BASE_URL`/`LLM_API_KEY`/
  `LLM_MODEL`. Free tiers checked Oct 2026: Tavily 1,000 searches/month (~8 per
  daily check); Groq 30 req/min & 1,000 req/day; OpenRouter `:free` models
  20 req/min & 50 req/day. (NVIDIA NIM has 40 RPM but is **not offered in
  Pakistan**, so it's not recommended here.)
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

## 1) Research provider keys

**Option A — Tavily + free LLM (recommended, generous free limits):**

Web search **Tavily**, extraction **koi bhi OpenAI-compatible LLM**:

1. **Tavily:** go to **https://tavily.com** → sign up → dashboard **API Keys** →
   copy (starts with `tvly-`). Free: 1,000 searches/month, no card. (~8 used
   per daily check.)
2. **LLM key** — pick one (all free, no card):
   - **Groq** (easiest): **https://console.groq.com** → sign up → **API Keys** →
     Create → copy (starts with `gsk_`). Free: 30 req/min, 1,000 req/day.
     Prompts are *not* used for training.
   - **OpenRouter**: **https://openrouter.ai** → sign up → **Keys** → copy.
     Use a `:free` model (e.g. `nvidia/nemotron-3-super-120b-a12b:free`).
     Free: 20 req/min, 50 req/day.
   - ~~NVIDIA NIM~~ — 40 RPM sounds great, but it is **not offered in Pakistan**
     (phone verification in a supported country required). Skip it.
3. Set:
   ```
   RESEARCH_PROVIDER=tavily
   TAVILY_API_KEY=<tvly-...>
   LLM_BASE_URL=https://api.groq.com/openai/v1   # or OpenRouter's URL
   LLM_API_KEY=<key>
   LLM_MODEL=openai/gpt-oss-120b                # or a :free model id
   ```
   `npm run diagnose` lists the models your key can use.

**Option B — Google Gemini:**

1. Go to **https://aistudio.google.com/apikey** (sign in with Google).
2. Click **Create API key** → copy it.
3. Set:
   ```
   RESEARCH_PROVIDER=gemini   # (this is the default)
   GEMINI_API_KEY=<key>
   ```
   (`GEMINI_MODEL` defaults to `gemini-3.5-flash-lite`; the old
   `gemini-2.5-flash` was retired for new keys in Oct 2026.)

Locally: paste into `.env`. On Vercel: add as environment variables (see
deploy steps below). Test with `npm run diagnose`.

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
        ┌───────────┴───────────┐
        ▼                       ▼
  RESEARCH_PROVIDER=gemini  RESEARCH_PROVIDER=tavily
  Google Gemini API          Tavily web search
  (gemini-3.5-flash-lite    + any OpenAI-compatible LLM
   + google_search           (Groq / OpenRouter / …)
   grounding) searches       extraction
   recent news + official
   pages per platform
        │                       │
        └───────────┬───────────┘
                    ▼
        merge/clean/de-dupe → Vercel KV (or data/shows.json locally)
                    │
                    ▼
        new releases → Telegram Bot API → your phone 📲
```

## Configuration

| Variable | Required | Default | Purpose |
|---|---|---|---|
| `RESEARCH_PROVIDER` | no | `gemini` | `gemini`, or `tavily` (`groq` = alias) |
| `TAVILY_API_KEY` | for tavily | — | Free key at tavily.com (1,000 searches/mo) |
| `LLM_BASE_URL` | no | Groq URL | Any OpenAI-compatible endpoint |
| `LLM_API_KEY` | for tavily | — | Key for the LLM endpoint |
| `LLM_MODEL` | no | `openai/gpt-oss-120b` | Model id for the LLM endpoint |
| `GEMINI_API_KEY` | for gemini | — | Google AI Studio key |
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
src/research.js      Per-platform research (parallel) + provider branch
src/llm.js           Generic OpenAI-compatible LLM client (Groq/OpenRouter/…)
src/tavily.js        Tavily web-search client (free tier)
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
