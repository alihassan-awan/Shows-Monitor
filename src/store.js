// Storage backend abstraction.
//
// On Vercel: uses Vercel KV (Upstash Redis) via its REST API — the filesystem
// is ephemeral on serverless, so JSON files would lose data between runs.
// Connect a KV database in the Vercel dashboard (Storage tab) and it injects
// KV_REST_API_URL + KV_REST_API_TOKEN automatically.
//
// Locally (no KV env vars): falls back to JSON files in ./data, exactly like v1.
//
// Keys: "shows:records" (array), "shows:meta" (object).

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, '..', 'data');
const DB_FILE = path.join(DATA_DIR, 'shows.json');
const BACKUP_FILE = path.join(DATA_DIR, 'shows.backup.json');

// Vercel KV injects KV_REST_API_URL / KV_REST_API_TOKEN automatically.
// The Upstash Marketplace integration (or a manual upstash.com database)
// uses UPSTASH_REDIS_REST_URL / UPSTASH_REDIS_REST_TOKEN — same REST API,
// so both namings are accepted.
const KV_URL = (
  process.env.KV_REST_API_URL ||
  process.env.UPSTASH_REDIS_REST_URL ||
  ''
).replace(/\/+$/, '');
const KV_TOKEN = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN || '';

export function backend() {
  return KV_URL && KV_TOKEN ? 'kv' : 'file';
}

// ---- Vercel KV via REST (no extra dependency) ---------------------------
async function kvFetch(command, ...args) {
  const res = await fetch(`${KV_URL}/${command}/${args.map(encodeURIComponent).join('/')}`, {
    headers: { Authorization: `Bearer ${KV_TOKEN}` }
  });
  if (!res.ok) {
    const t = (await res.text().catch(() => '')).slice(0, 200);
    throw new Error(`KV ${command} failed (HTTP ${res.status}): ${t}`);
  }
  return res.json();
}

async function kvGetRaw(key) {
  const data = await kvFetch('get', key);
  return data?.result ?? null; // stored as JSON string, or null
}

// ---- file backend --------------------------------------------------------
function ensureDir() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
}

// ---- public API ----------------------------------------------------------
export async function readJson(key, fallback) {
  if (backend() === 'kv') {
    try {
      const raw = await kvGetRaw(key);
      if (raw == null) return fallback;
      const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
      return parsed ?? fallback;
    } catch (err) {
      console.error(`[store] KV read "${key}" failed, using fallback:`, err.message);
      return fallback;
    }
  }
  ensureDir();
  try {
    if (!fs.existsSync(DB_FILE) && key === 'shows:records') {
      fs.writeFileSync(DB_FILE, '[]', 'utf8');
      return fallback;
    }
    const file = key === 'shows:meta' ? path.join(DATA_DIR, 'meta.json') : DB_FILE;
    if (!fs.existsSync(file)) return fallback;
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    return parsed ?? fallback;
  } catch (err) {
    console.error(`[store] file read "${key}" failed:`, err.message);
    return fallback;
  }
}

export async function writeJson(key, value) {
  if (backend() === 'kv') {
    await kvFetch('set', key, JSON.stringify(value));
    return;
  }
  ensureDir();
  const file = key === 'shows:meta' ? path.join(DATA_DIR, 'meta.json') : DB_FILE;
  fs.writeFileSync(file, JSON.stringify(value, null, 2), 'utf8');
}

export async function writeBackup(value) {
  if (backend() === 'kv') {
    await kvFetch('set', 'shows:backup', JSON.stringify(value));
    return;
  }
  ensureDir();
  fs.writeFileSync(BACKUP_FILE, JSON.stringify(value, null, 2), 'utf8');
}
