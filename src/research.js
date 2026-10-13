// Core research step: for each platform, ask Gemini (with live web search) to
// find newly released and upcoming shows, then return raw candidate records.
//
// v2 change: all platforms are researched IN PARALLEL (Promise.all) with a
// per-platform timeout, so a full check fits inside Vercel's 60s function
// limit. A slow/failed platform no longer blocks the others.

import { PLATFORMS } from './platforms.js';
import { callGemini, extractJsonArray } from './gemini.js';
import { callLlm } from './llm.js';
import { tavilySearch, hasTavilyKey } from './tavily.js';

// Research provider: "gemini" (model searches the live web itself) or
// "tavily" (Tavily searches the web, any OpenAI-compatible LLM extracts the
// structured records). "groq" is kept as an alias of "tavily".
const _raw = (process.env.RESEARCH_PROVIDER || 'gemini').toLowerCase();
export const RESEARCH_PROVIDER = _raw === 'tavily' || _raw === 'groq' ? 'tavily' : 'gemini';

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

// ---- Tavily + LLM path ------------------------------------------------
// The LLM has no web access: Tavily does 2 targeted news searches per
// platform, and the LLM extracts the structured records from those results.
// The SAME JSON schema + mapCandidate() are reused, so downstream code is
// provider-agnostic.

const LLM_SYSTEM =
  'You are a precise information-extraction assistant. You are given WEB SEARCH RESULTS ' +
  'below. Extract ONLY shows that are explicitly supported by those results. ' +
  'NEVER use your own training knowledge — if the results do not mention a show, it does not exist ' +
  'for this task. Prefer official platform announcements and reputable entertainment-trade outlets. ' +
  'Return output strictly in the JSON format requested, with no extra commentary.';

function monthYear(d) {
  return new Date(d).toLocaleDateString('en-US', { month: 'long', year: 'numeric' });
}

function buildSearchContext(results) {
  return results
    .map((r, i) => {
      const date = r.publishedDate ? ` (${r.publishedDate.slice(0, 10)})` : '';
      return `[${i + 1}] ${r.title}${date}\n    ${r.url}\n    ${r.content}`;
    })
    .join('\n\n');
}

function buildLlmPrompt(platform, config, context) {
  return (
    `Use ONLY the web search results below as evidence. Do NOT use your training knowledge. ` +
    `A show qualifies ONLY if at least one result below supports it.\n\n` +
    `WEB SEARCH RESULTS:\n${context}\n\n` +
    `---\n\n` +
    buildPrompt(platform, config) +
    `\n\nFor "sources", use the URLs of the results above that support each show.`
  );
}

async function researchPlatformTavily(platform, config) {
  if (!hasTavilyKey()) {
    throw new Error('TAVILY_API_KEY is missing — set it to use the tavily provider (free key at https://tavily.com)');
  }
  const queries = [
    `new TV shows web series released ${platform.name} ${monthYear(config.today)}`,
    `upcoming TV shows web series announced ${platform.name} 2026`
  ];
  const all = [];
  for (const q of queries) {
    const hits = await tavilySearch(q, { maxResults: 8 });
    all.push(...hits);
  }
  // De-dupe by URL, keep order.
  const seen = new Set();
  const results = all.filter((r) => (seen.has(r.url) ? false : (seen.add(r.url), true)));
  if (!results.length) {
    throw new Error('Tavily returned no results for this platform');
  }
  const text = await callLlm([
    { role: 'system', content: LLM_SYSTEM },
    { role: 'user', content: buildLlmPrompt(platform, config, buildSearchContext(results)) }
  ]);
  const rows = extractJsonArray(text);
  if (rows.length === 0 && !/\[\s*\]/.test(text)) {
    throw new Error(`JSON parsing failed — no JSON array in response: "${text.slice(0, 120)}"`);
  }
  return rows.map((r) => mapCandidate(r, platform.name)).filter(Boolean);
}

// Research a single platform with its own timeout. Never throws — returns
// { platform, ok, error, candidates }.
export async function researchPlatform(platform, config, timeoutMs = PLATFORM_TIMEOUT_MS) {
  const work = (async () => {
    const candidates =
      RESEARCH_PROVIDER === 'tavily'
        ? await researchPlatformTavily(platform, config)
        : await (async () => {
            const text = await callGemini(buildPrompt(platform, config), { timeoutMs });
            const rows = extractJsonArray(text);
            // Distinguish "genuinely no shows" (model returned []) from a real parse
            // failure (model returned prose / malformed output we could not parse).
            if (rows.length === 0 && !/\[\s*\]/.test(text)) {
              throw new Error(`JSON parsing failed — no JSON array in response: "${text.slice(0, 120)}"`);
            }
            return rows.map((r) => mapCandidate(r, platform.name)).filter(Boolean);
          })();
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
//
// Starts are staggered ~3s apart so the burst doesn't trip the free tier's
// per-minute rate limit; each call also retries on HTTP 429 (see gemini.js).
export async function researchAll(config, onProgress = () => {}) {
  const jobs = PLATFORMS.map((platform, i) =>
    new Promise((r) => setTimeout(r, i * 3000))
      .then(() => researchPlatform(platform, config))
      .then((res) => {
        onProgress(res.ok ? `Done: ${res.platform}` : `${res.platform} failed`);
        return res;
      })
  );

  const results = await Promise.all(jobs);
  const candidates = results.flatMap((r) => r.candidates);
  const failed = results.filter((r) => !r.ok).map((r) => ({ platform: r.platform, error: r.error }));

  return { candidates, failed };
}
