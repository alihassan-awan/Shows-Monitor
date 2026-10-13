// Core research step: for each platform, ask Gemini (with live web search) to
// find newly released and upcoming shows, then return raw candidate records.
//
// v2 change: all platforms are researched IN PARALLEL (Promise.all) with a
// per-platform timeout, so a full check fits inside Vercel's 60s function
// limit. A slow/failed platform no longer blocks the others.

import { PLATFORMS } from './platforms.js';
import { callGemini, extractJsonArray } from './gemini.js';

const PLATFORM_TIMEOUT_MS = Number(process.env.PLATFORM_TIMEOUT_MS) || 50000;

function fmt(d) {
  return new Date(d).toISOString().slice(0, 10);
}

function buildPrompt(platform, { today, lookbackDays = 30, horizonDays = 180 }) {
  const releasedSince = new Date(today);
  releasedSince.setDate(releasedSince.getDate() - lookbackDays);
  const upcomingUntil = new Date(today);
  upcomingUntil.setDate(upcomingUntil.getDate() + horizonDays);

  const channelLines = platform.channels
    .map((c) => `- ${c.name} (${c.language}) — ${c.url}`)
    .join('\n');

  return `You are a meticulous research assistant for Indian television and OTT content.
Today's date is ${fmt(today)}. Use ONLY this date as "today" — never assume any other current date.

Use live web search (recent trade news and the official platform pages below) to find genuinely NEW shows for the platform "${platform.name}".

Return two kinds of items:
1) NEWLY RELEASED: shows/web series whose ACTUAL PREMIERE (first episode / season premiere) happened on or after ${fmt(releasedSince)} (within the last ${lookbackDays} days).
2) UPCOMING: not-yet-premiered shows with credible confirmation, expected on or before ${fmt(upcomingUntil)} (next ${horizonDays} days), OR confirmed shows whose exact date is not yet announced.

Channels for this platform:
${channelLines}

CRITICAL ACCURACY RULES:
- An article's PUBLISH date is NOT the show's release date. Find the real premiere date.
- DO NOT report: individual new episodes, finales, promos, trailers, teasers, reruns, re-uploads,
  old shows/films newly added to the catalogue, dubbed versions of older shows added later,
  cast/casting announcements for already-released shows, or recent articles that merely discuss old shows.
- A NEW SEASON of an existing show IS allowed (set "season"), but only its own genuine premiere counts.
- If you cannot find reliable evidence of the premiere/announcement, OMIT the item. Returning 3 correct
  shows is far better than 20 questionable ones. Never fabricate a candidate to fill a platform.

For every qualifying show output an object with EXACTLY these keys:
{
  "title": string,
  "platform": "${platform.name}",
  "channel": one channel name from the list above (best match) or "",
  "language": string,
  "type": "TV Show" | "Web Series" | "Original",
  "season": integer or null,
  "status": "released" | "upcoming",
  "releaseDate": "YYYY-MM-DD" or null,
  "dateConfidence": "confirmed" | "likely" | "unknown",
  "description": one concise line,
  "officialUrl": string or "",
  "sources": [ { "url": string, "title": string, "sourceType": "official" | "reliable_media" | "other" } ],
  "evidence": {
    "actualPremiereEvidence": "for released items: quote/summary proving the real premiere date",
    "announcementEvidence": "for upcoming items: quote/summary proving the show is confirmed"
  }
}

FIELD RULES:
- status "released": the show ALREADY premiered. Put the true premiere date in releaseDate (YYYY-MM-DD).
  Fill actualPremiereEvidence. If you only have the announcement (not the premiere), it is NOT "released".
- status "upcoming": not yet premiered. If an official future date exists, put it in releaseDate; otherwise
  releaseDate = null. Fill announcementEvidence.
- dateConfidence: "confirmed" = official page or multiple credible sources agree on the date;
  "likely" = one credible source; "unknown" = confirmed show but date not established.
- Merge multiple articles about the SAME show into ONE object, listing all under "sources".
- Prefer official platform pages and reputable entertainment-trade outlets as sources.

Return ONLY a JSON array of these objects. No prose, no markdown outside the array. If nothing qualifies, return [].`;
}

// Convert the model's evidence schema into the internal record shape that
// src/merge.js#sanitize expects. Returns null for clearly unusable rows.
export function mapCandidate(r, platformName) {
  if (!r || typeof r !== 'object') return null;
  const title = String(r.title || r.show_name || '').trim();
  if (!title) return null;

  const rawStatus = String(r.status || '').toLowerCase();
  const releaseDate = /^\d{4}-\d{2}-\d{2}$/.test(r.releaseDate || '') ? r.releaseDate : '';
  const dateConfidence = ['confirmed', 'likely', 'unknown'].includes((r.dateConfidence || '').toLowerCase())
    ? r.dateConfidence.toLowerCase()
    : 'unknown';

  const sources = Array.isArray(r.sources) ? r.sources : [];
  const hasOfficial = Boolean(r.officialUrl) || sources.some((s) => s && s.sourceType === 'official');

  // Internal "confidence" (Confirmed | Likely) is derived from date confidence + source quality.
  const confidence = dateConfidence === 'confirmed' || hasOfficial ? 'Confirmed' : 'Likely';

  let status;
  let release_date = '';
  let expected_release_date = '';
  if (rawStatus === 'released') {
    status = 'Released';
    release_date = releaseDate;
  } else {
    // upcoming
    if (releaseDate) {
      status = 'Date Announced';
      expected_release_date = releaseDate;
    } else {
      status = 'Date Not Confirmed';
      expected_release_date = 'Date Not Confirmed';
    }
  }

  return {
    show_name: title,
    platform: r.platform || platformName,
    channel: String(r.channel || '').trim(),
    language: String(r.language || '').trim(),
    content_type: r.type || r.content_type || 'TV Show',
    status,
    release_date,
    expected_release_date,
    short_summary: String(r.description || r.short_summary || '').trim(),
    confidence,
    date_confidence: dateConfidence,
    official_url: r.officialUrl || r.official_url || '',
    season: r.season != null && !Number.isNaN(Number(r.season)) ? Number(r.season) : null,
    source_urls: sources
      .filter((s) => s && s.url)
      .map((s) => ({ name: s.title || '', title: s.title || '', date: '', sourceType: s.sourceType || 'other', url: s.url })),
    evidence: {
      actualPremiereEvidence: String(r.evidence?.actualPremiereEvidence || '').trim(),
      announcementEvidence: String(r.evidence?.announcementEvidence || '').trim()
    }
  };
}

function timeoutError(platformName, ms) {
  const err = new Error(`Timed out after ${Math.round(ms / 1000)}s — platform skipped, others continued`);
  err.platform = platformName;
  return err;
}

// Research a single platform with its own timeout. Never throws — returns
// { platform, ok, error, candidates }.
export async function researchPlatform(platform, config, timeoutMs = PLATFORM_TIMEOUT_MS) {
  const work = (async () => {
    const text = await callGemini(buildPrompt(platform, config), { timeoutMs });
    const rows = extractJsonArray(text);
    // Distinguish "genuinely no shows" (model returned []) from a real parse
    // failure (model returned prose / malformed output we could not parse).
    if (rows.length === 0 && !/\[\s*\]/.test(text)) {
      throw new Error(`JSON parsing failed — no JSON array in response: "${text.slice(0, 120)}"`);
    }
    const candidates = rows.map((r) => mapCandidate(r, platform.name)).filter(Boolean);
    return { platform: platform.name, ok: true, candidates };
  })();

  const timer = new Promise((_, reject) =>
    setTimeout(() => reject(timeoutError(platform.name, timeoutMs)), timeoutMs)
  );

  try {
    return await Promise.race([work, timer]);
  } catch (err) {
    return { platform: platform.name, ok: false, error: err.message, candidates: [] };
  }
}

// Research every platform IN PARALLEL. onProgress(msg) is called with
// user-facing strings as each platform finishes.
export async function researchAll(config, onProgress = () => {}) {
  const jobs = PLATFORMS.map((platform) =>
    researchPlatform(platform, config).then((res) => {
      onProgress(res.ok ? `Done: ${res.platform}` : `${res.platform} failed`);
      return res;
    })
  );

  const results = await Promise.all(jobs);
  const candidates = results.flatMap((r) => r.candidates);
  const failed = results.filter((r) => !r.ok).map((r) => ({ platform: r.platform, error: r.error }));

  return { candidates, failed };
}
