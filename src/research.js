// Core research step: fetch the official platform pages (src/sources.js),
// extract show titles + official links via Tavily Extract, and return raw
// candidate records.
//
// There is deliberately NO news/Google search and NO LLM in this pipeline —
// the official pages are the single source of truth, and "newly released"
// means "first seen on the official page".
//
// All platforms are researched IN PARALLEL (Promise.allSettled) with a
// per-platform timeout, so a full check fits inside Vercel's 60s limit.

import { PLATFORMS } from './platforms.js';
import { SOURCES } from './sources.js';
import { tavilyExtract, parseTitles, hasTavilyKey } from './extract.js';

const PLATFORM_TIMEOUT_MS = Number(process.env.PLATFORM_TIMEOUT_MS) || 50000;

async function researchPlatformSources(platform, timeoutMs) {
  // Skip sources whose URL isn't usable yet (pending research).
  const sources = (SOURCES[platform.name] || []).filter((s) => /^https?:\/\//i.test(s.url || ''));
  if (!sources.length) return [];

  const { results, failed } = await tavilyExtract(
    sources.map((s) => s.url),
    { timeoutMs }
  );

  const byUrl = new Map(sources.map((s) => [s.url, s]));
  // Tavily may normalize URLs (trailing slash etc.) — match loosely.
  const findSource = (url) => {
    if (byUrl.has(url)) return byUrl.get(url);
    const norm = String(url).replace(/\/+$/, '');
    for (const [k, v] of byUrl) {
      if (k.replace(/\/+$/, '') === norm) return v;
    }
    return null;
  };

  const candidates = [];
  const seen = new Set();
  for (const r of results) {
    const src = findSource(r.url);
    for (const t of parseTitles(r.raw_content, r.url)) {
      const key = t.title.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      candidates.push({
        show_name: t.title,
        platform: platform.name,
        language: src?.language || '',
        channel: src?.channel || '',
        source_name: src?.name || '',
        source_url: r.url,
        official_url: t.url || ''
      });
    }
  }

  if (!candidates.length && failed.length && results.length === 0) {
    throw new Error(`All ${sources.length} source pages failed to extract (${failed[0]?.error || 'unknown error'})`);
  }
  return candidates;
}

// Research a single platform with its own timeout. Never throws — returns
// { platform, ok, error, candidates }.
export async function researchPlatform(platform, timeoutMs = PLATFORM_TIMEOUT_MS) {
  const work = (async () => {
    const candidates = await researchPlatformSources(platform, timeoutMs);
    return { platform: platform.name, ok: true, candidates };
  })();

  const timeout = new Promise((_, reject) =>
    setTimeout(() => reject(new Error(`timed out after ${timeoutMs}ms`)), timeoutMs)
  );

  try {
    return await Promise.race([work, timeout]);
  } catch (err) {
    return { platform: platform.name, ok: false, error: err?.message || String(err), candidates: [] };
  }
}

// Research all platforms in parallel. onProgress(name) fires as each
// platform finishes. Returns { results, failed }.
export async function researchAll({ onProgress = () => {} } = {}) {
  if (!hasTavilyKey()) {
    throw new Error('TAVILY_API_KEY is missing — add it to run checks (free key at https://tavily.com)');
  }
  const settled = await Promise.allSettled(
    PLATFORMS.map(async (platform) => {
      const r = await researchPlatform(platform);
      onProgress(r.platform, r);
      return r;
    })
  );
  const results = settled.map((s, i) =>
    s.status === 'fulfilled'
      ? s.value
      : { platform: PLATFORMS[i].name, ok: false, error: s.reason?.message || String(s.reason), candidates: [] }
  );
  return {
    results,
    failed: results.filter((r) => !r.ok)
  };
}
