// Shared "check for updates" pipeline.
//
// Used by three entry points:
//   - the manual "Check Updates" button  (src/handlers.js -> /api/check, SSE)
//   - the Vercel Cron job                (api/cron/check.js, daily)
//   - the local auto-check interval      (server.js, AUTO_CHECK=true)
//
// Flow: health -> parallel research -> merge/clean -> upsert -> detect new
// releases -> notify on Telegram -> record run metadata.

import { checkHealth, providerInfo } from './gemini.js';
import { researchAll } from './research.js';
import { mergeCandidates } from './merge.js';
import {
  upsertShows,
  getShows,
  markNotified,
  setMeta,
  migrateAndClean,
  ensureNotifiedBackfill,
  pendingReleaseNotifications
} from './db.js';
import { platformNames } from './platforms.js';
import { notifyNewReleases, isTelegramConfigured } from './telegram.js';

const PLATFORMS_COUNT = platformNames().length;
const LOOKBACK_DAYS = Number(process.env.RELEASE_LOOKBACK_DAYS) || 30;
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
  const health = await checkHealth();
  if (!health.ok) {
    throw new Error(health.error);
  }

  const config = buildConfig();

  // One-time v1->v2 migration, then prune stale/out-of-window records.
  // (On Vercel there is no server startup, so this runs here instead.)
  await ensureNotifiedBackfill();
  await migrateAndClean(config);

  onProgress('Checking official sources');

  const { candidates, failed } = await researchAll(config, (message) => onProgress(message));

  onProgress('Cleaning results');
  const cleaned = mergeCandidates(candidates, config);
  await upsertShows(cleaned);

  // New releases discovered in THIS run = released + never notified.
  // (migrateAndClean backfills notified_at for pre-existing rows, so the
  // first Telegram-enabled run doesn't spam old shows.)
  const newReleases = await pendingReleaseNotifications();
  const newUpcoming = []; // reserved: upcoming alerts are opt-in via TELEGRAM_NOTIFY_UPCOMING

  let telegram = { ok: true, sent: 0, skipped: 'no new releases' };
  if (newReleases.length && isTelegramConfigured()) {
    // Mark first so a retry/crash can't double-notify for the same shows.
    await markNotified(newReleases.map((r) => r.key));
    onProgress('Sending Telegram notification');
    telegram = await notifyNewReleases(newReleases, newUpcoming);
    if (!telegram.ok && !telegram.skipped) {
      console.error('[check] telegram notify failed:', telegram.error);
    }
  }

  const filtered = await getShows({});
  const allFailed = failed.length > 0 && failed.length === PLATFORMS_COUNT;

  const summary = {
    source,
    found: cleaned.length,
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

export { providerInfo };
