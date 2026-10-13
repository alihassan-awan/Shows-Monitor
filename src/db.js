// Show-record store. Same cleaning/de-dupe logic as v1 (src/merge.js), but all
// I/O is async and goes through src/store.js — Vercel KV in production,
// JSON files for local dev.
//
// Record shape is unchanged from v1, plus:
//   notified_at — ISO timestamp when a Telegram alert was sent for this show
//                 (null/undefined = not yet notified)

import { isSameShow, combineRecords, normalizeRecord, dedupeList, validate } from './merge.js';
import { readJson, writeJson, writeBackup } from './store.js';

const RECORDS_KEY = 'shows:records';
const META_KEY = 'shows:meta';

export async function loadShows() {
  const arr = await readJson(RECORDS_KEY, []);
  return Array.isArray(arr) ? arr : [];
}

async function saveShows(rows) {
  await writeJson(RECORDS_KEY, rows);
}

// Insert or update cleaned records. De-duplicates against EXISTING stored rows
// (cross-run) via isSameShow, preserving first_detected_at and refreshing
// last_verified_at. Returns all rows.
export async function upsertShows(records) {
  const all = await loadShows();
  const now = new Date().toISOString();

  for (const rec of records) {
    const incoming = { ...rec, last_verified_at: now };
    const idx = all.findIndex((e) => e.key === rec.key || isSameShow(e, rec));
    if (idx >= 0) {
      const merged = combineRecords(all[idx], incoming);
      merged.first_detected_at = all[idx].first_detected_at || now;
      merged.last_verified_at = now;
      // keep any existing notification state
      if (all[idx].notified_at && !merged.notified_at) merged.notified_at = all[idx].notified_at;
      all[idx] = merged;
    } else {
      all.push({ ...incoming, first_detected_at: now, last_verified_at: now });
    }
  }

  await saveShows(all);
  return all;
}

// Mark records as notified (Telegram alert sent). `keys` = record.key values.
export async function markNotified(keys) {
  if (!keys?.length) return;
  const all = await loadShows();
  const set = new Set(keys);
  const now = new Date().toISOString();
  let changed = false;
  for (const r of all) {
    if (set.has(r.key) && !r.notified_at) {
      r.notified_at = now;
      changed = true;
    }
  }
  if (changed) await saveShows(all);
}

// Newly-released shows that have never been notified about.
export async function pendingReleaseNotifications() {
  const all = await loadShows();
  return all.filter((r) => r.section === 'released' && !r.notified_at);
}

// One-time migration guard: marks everything already stored as "seen" for
// notifications, so the first Telegram-enabled run doesn't re-alert on old
// shows. Runs ONCE (guarded by meta.v2migrated) — pending notifications from
// later runs survive restarts.
export async function ensureNotifiedBackfill() {
  const meta = await getMeta();
  if (meta.v2migrated) return;
  const all = await loadShows();
  if (all.length && all.every((r) => !r.notified_at)) {
    const now = new Date().toISOString();
    for (const r of all) r.notified_at = now;
    await saveShows(all);
    console.log(`[db] one-time migration: marked ${all.length} existing records as notified`);
  }
  await setMeta({ v2migrated: true });
}

// One-time / startup migration: normalize stored records, drop invalid or
// out-of-window ones, and merge duplicates. Writes a backup ONLY when something
// actually changes. Preserves legitimate upcoming shows. Returns a summary.
//
// NOTE: does NOT touch notified_at — that is handled once by
// ensureNotifiedBackfill(). Safe to run on every check (including Vercel,
// where there is no server startup).
export async function migrateAndClean(config) {
  const original = await loadShows();
  if (!original.length) return { changed: false, before: 0, after: 0, removed: 0 };

  const normalized = original.map(normalizeRecord).filter(Boolean);
  const validated = config ? normalized.filter((r) => validate(r, config)) : normalized;
  const cleaned = dedupeList(validated);

  const changed = JSON.stringify(cleaned) !== JSON.stringify(original);
  if (changed) {
    await writeBackup(original);
    await saveShows(cleaned);
  }

  return { changed, before: original.length, after: cleaned.length, removed: original.length - cleaned.length };
}

const CONF_RANK = { Confirmed: 2, Likely: 1 };

// Read stored shows with optional filters, split into the two UI sections.
export async function getShows({ platform, channel, language, q } = {}) {
  let rows = await loadShows();

  if (platform) rows = rows.filter((r) => r.platform === platform);
  if (channel) rows = rows.filter((r) => r.channel === channel);
  if (language) rows = rows.filter((r) => (r.language || '').toLowerCase() === language.toLowerCase());
  if (q) {
    const needle = q.toLowerCase();
    rows = rows.filter((r) => (r.show_name || '').toLowerCase().includes(needle));
  }

  const released = rows.filter((r) => r.section === 'released');
  const upcoming = rows.filter((r) => r.section !== 'released');

  // Newly Released: newest premiere first; ties broken by Confirmed over Likely.
  released.sort((a, b) => {
    const d = (b.release_date || '').localeCompare(a.release_date || '');
    if (d !== 0) return d;
    return (CONF_RANK[b.confidence] || 0) - (CONF_RANK[a.confidence] || 0);
  });

  // Upcoming: dated soonest-first, undated last; ties broken by Confirmed over Likely.
  upcoming.sort((a, b) => {
    const da = a.expected_release_date && /^\d{4}-\d{2}-\d{2}$/.test(a.expected_release_date) ? a.expected_release_date : '';
    const db = b.expected_release_date && /^\d{4}-\d{2}-\d{2}$/.test(b.expected_release_date) ? b.expected_release_date : '';
    if (da && db && da !== db) return da.localeCompare(db);
    if (da && !db) return -1;
    if (!da && db) return 1;
    return (CONF_RANK[b.confidence] || 0) - (CONF_RANK[a.confidence] || 0);
  });

  return { released, upcoming };
}

// ---- run metadata (last check time etc.) ---------------------------------
export async function getMeta() {
  return readJson(META_KEY, {});
}

export async function setMeta(patch) {
  const meta = await getMeta();
  const next = { ...meta, ...patch };
  await writeJson(META_KEY, next);
  return next;
}
