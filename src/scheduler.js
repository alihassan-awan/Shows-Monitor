// Shared "check for updates" pipeline.
//
// Used by three entry points:
//   - the manual "Check Updates" button  (src/handlers.js -> /api/check, SSE)
//   - the Vercel Cron job                (api/cron/check.js, daily)
//   - the local auto-check interval      (server.js, AUTO_CHECK=true)
//
// Flow: health -> parallel research -> merge/clean -> upsert -> detect new
// releases -> notify on Telegram -> record run metadata.

import { hasTavilyKey } from './extract.js';
import { researchAll } from './research.js';
import { makeKey, isSameShow } from './merge.js';
import {
  upsertShows,
  loadShows,
  getShows,
  markNotified,
  getMeta,
  setMeta,
  migrateAndClean,
  ensureNotifiedBackfill
} from './db.js';
import { platformNames } from './platforms.js';
import { sourceCount } from './sources.js';
import { notifyNewReleases, isTelegramConfigured } from './telegram.js';

const PLATFORMS_COUNT = platformNames().length;
const LOOKBACK_DAYS = Number(process.env.RELEASE_LOOKBACK_DAYS) || 15;
const HORIZON_DAYS = Number(process.env.UPCOMING_HORIZON_DAYS) || 180;

export function buildConfig() {
  return { today: new Date(), lookbackDays: LOOKBACK_DAYS, horizonDays: HORIZON_DAYS };
}

export function configSummary() {
  return { lookbackDays: LOOKBACK_DAYS, horizonDays: HORIZON_DAYS, platforms: PLATFORMS_COUNT };
}

function shortReason(err = '') {
  return String(err).replace(/\s+/g, ' ').trim().slice(0, 200);
}

// Full pipeline. onProgress(msg) receives user-facing progress strings.
// Returns a result summary; never throws for platform-level failures, but
// throws when the run cannot proceed at all (e.g. no API key).
export async function runCheck({ onProgress = () => {}, source = 'manual' } = {}) {
  const health = await checkResearchHealth();
  if (!health.ok) {
    throw new Error(health.error);
  }

  const config = buildConfig();

  // One-time v1->v2 migration, then prune stale/out-of-window records.
  // (On Vercel there is no server startup, so this runs here instead.)
  await ensureNotifiedBackfill();
  await migrateAndClean(config);

  onProgress(`Checking ${sourceCount()} official pages`);

  const { results, failed } = await researchAll({
    onProgress: (name, r) => onProgress(`${r.ok ? 'Done' : 'Failed'}: ${name} (${r.candidates.length} titles)`)
  });

  // Flatten per-platform candidates, de-dupe by platform+title.
  const seen = new Set();
  const candidates = [];
  for (const r of results) {
    for (const c of r.candidates || []) {
      const k = `${c.platform}||${c.show_name.toLowerCase().trim()}`;
      if (seen.has(k)) continue;
      seen.add(k);
      candidates.push(c);
    }
  }

  onProgress('Comparing with previous check');
  const existing = await loadShows();
  const todayISO = new Date().toISOString().slice(0, 10);

  // Build store records. release_date = first-seen date: combineRecords keeps
  // the earliest date on re-sightings, so a re-seen title never looks "new".
  const records = candidates.map((c) => {
    const rec = {
      show_name: c.show_name,
      platform: c.platform,
      language: c.language || '',
      channel: c.channel || '',
      content_type: 'TV Show',
      section: 'released',
      status: 'Released',
      release_date: todayISO,
      confidence: 'Confirmed',
      date_confidence: 'Confirmed',
      official_url: c.official_url || '',
      source_urls: c.source_url ? [c.source_url] : [],
      source_name: c.source_name || '',
      summary: ''
    };
    rec.key = makeKey(rec);
    return rec;
  });

  // New = no matching record already stored (fuzzy title match included).
  const newRecords = records.filter((rec) => !existing.some((e) => isSameShow(e, rec)));

  onProgress('Saving results');
  await upsertShows(records);

  // First official-sources run establishes the baseline silently — otherwise
  // the whole catalogue would fire one Telegram alert per title.
  const meta = await getMeta();
  const isBaseline = !meta.officialBaselineAt;

  let telegram = { ok: true, sent: 0, skipped: 'no new releases' };
  let newReleases = [];
  if (isBaseline) {
    await markNotified(newRecords.map((r) => r.key));
    await setMeta({ officialBaselineAt: new Date().toISOString() });
    telegram.skipped = `baseline established (${records.length} titles tracked)`;
    console.log(`[check] baseline run: tracking ${records.length} titles, no alerts sent`);
  } else {
    newReleases = newRecords;
    if (newReleases.length && isTelegramConfigured()) {
      // Mark first so a retry/crash can't double-notify for the same shows.
      await markNotified(newReleases.map((r) => r.key));
      onProgress('Sending Telegram notification');
      telegram = await notifyNewReleases(newReleases, []);
      if (!telegram.ok && !telegram.skipped) {
        console.error('[check] telegram notify failed:', telegram.error);
      }
    }
  }

  const filtered = await getShows({});
  const allFailed = failed.length > 0 && failed.length === PLATFORMS_COUNT;

  const summary = {
    source,
    found: records.length,
    newReleases: newReleases.map((r) => ({ show_name: r.show_name, platform: r.platform })),
    releasedCount: filtered.released.length,
    upcomingCount: filtered.upcoming.length,
    failed: failed.map((f) => ({ platform: f.platform, reason: shortReason(f.error) })),
    allFailed,
    telegram: { sent: telegram.sent || 0, ok: telegram.ok, skipped: telegram.skipped || '', error: telegram.error || '' },
    at: new Date().toISOString()
  };
  await setMeta({ lastCheckAt: summary.at, lastCheckSummary: summary });

  return { ...summary, released: filtered.released, upcoming: filtered.upcoming };
}

// Local-dev auto-check: run once every N hours (Vercel uses the cron instead).
export function startLocalAutoCheck({ intervalHours = 24 } = {}) {
  const ms = Math.max(1, intervalHours) * 3600 * 1000;
  console.log(`[auto-check] enabled — running every ${intervalHours}h`);
  const tick = async () => {
    console.log('[auto-check] starting scheduled check…');
    try {
      const res = await runCheck({ source: 'auto', onProgress: (m) => console.log('[auto-check]', m) });
      console.log(
        `[auto-check] done: ${res.found} candidates, ${res.newReleases.length} new releases, ` +
          `telegram sent: ${res.telegram.sent}`
      );
    } catch (err) {
      console.error('[auto-check] failed:', err.message);
    }
  };
  // First run shortly after startup is noisy; start with the interval.
  const timer = setInterval(tick, ms);
  return () => clearInterval(timer);
}

// Research info for the UI.
export function researchProviderInfo() {
  return { provider: 'tavily-extract', detail: 'official platform pages only', sources: sourceCount() };
}

// Health check: only the Tavily key is needed (no LLM, no Google).
async function checkResearchHealth() {
  if (!hasTavilyKey()) {
    return { ok: false, error: 'TAVILY_API_KEY is missing or invalid. Get a free key at https://tavily.com' };
  }
  return { ok: true };
}
