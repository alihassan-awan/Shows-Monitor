// Cleaning, recency validation and STRONG de-duplication of show records.

const ALLOWED_CONFIDENCE = new Set(['Confirmed', 'Likely']);
const ALLOWED_STATUS = new Set(['Released', 'Upcoming', 'Date Announced', 'Date Not Confirmed']);
const ALLOWED_TYPE = new Set(['TV Show', 'Web Series', 'Original']);
const STOP = new Set(['the', 'a', 'an', 'of', 'show', 'season', 'part', 'chapter', 'new', 'ka', 'ki', 'ke']);

// ---- date helpers ------------------------------------------------------
export function isValidDate(v) {
  return typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) && !Number.isNaN(Date.parse(v));
}
export function startOfDay(d) {
  const x = new Date(d);
  x.setHours(0, 0, 0, 0);
  return x;
}
export function daysBetween(a, b) {
  return Math.round((startOfDay(a) - startOfDay(b)) / 86400000);
}

// ---- title canonicalization (used ONLY for comparison, never displayed) --
export function extractSeason(name = '') {
  const s = String(name).toLowerCase();
  let m = s.match(/\b(?:season|part|chapter|vol|volume)\s*\.?\s*(\d{1,3})\b/);
  if (m) return Number(m[1]);
  m = s.match(/\bs\s*(\d{1,2})\b/);
  if (m) return Number(m[1]);
  m = s.match(/\s(\d{1,3})\s*$/); // trailing number, e.g. "Bigg Boss 19"
  if (m) return Number(m[1]);
  return null;
}

export function canonicalTitle(name = '') {
  let s = String(name).toLowerCase();
  s = s.replace(/&/g, ' and ');
  s = s.replace(/\(.*?\)/g, ' '); // drop bracketed text
  s = s.replace(/\bwith\b[\s\S]*$/, ' '); // drop trailing "with <host names...>"
  s = s.replace(/\b(?:season|part|chapter|vol|volume)\s*\.?\s*\d{1,3}\b/g, ' ');
  s = s.replace(/\bs\d{1,2}\b/g, ' ');
  s = s.replace(/[^\p{L}\p{N}]+/gu, ' '); // strip punctuation across scripts
  s = s.replace(/\s+\d{1,3}\s*$/, ' '); // trailing standalone season number
  s = s.replace(/^\s*the\s+/, '');
  return s.replace(/\s+/g, ' ').trim();
}

function tokens(canon) {
  return canon.split(' ').filter((w) => w.length > 1 && !STOP.has(w));
}

// 0..1 similarity combining Jaccard and containment of token sets.
function similarity(a, b) {
  const A = new Set(tokens(a));
  const B = new Set(tokens(b));
  if (!A.size || !B.size) return a && a === b ? 1 : 0;
  let inter = 0;
  for (const t of A) if (B.has(t)) inter++;
  const jaccard = inter / (A.size + B.size - inter);
  const containment = inter / Math.min(A.size, B.size);
  return Math.max(jaccard, containment);
}

function hostOf(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return '';
  }
}

function sharedHost(a, b) {
  const hosts = new Set((a.source_urls || []).map((s) => hostOf(s.url)).filter(Boolean));
  if (a.official_url) hosts.add(hostOf(a.official_url));
  for (const s of b.source_urls || []) if (hosts.has(hostOf(s.url))) return true;
  return b.official_url && hosts.has(hostOf(b.official_url));
}

// ---- same-show decision using MULTIPLE signals -------------------------
export function isSameShow(a, b) {
  if (!a || !b) return false;
  if ((a.platform || '').toLowerCase() !== (b.platform || '').toLowerCase()) return false;

  const sa = a.season ?? null;
  const sb = b.season ?? null;
  if (sa != null && sb != null && sa !== sb) return false; // different seasons stay separate

  const la = (a.language || '').toLowerCase();
  const lb = (b.language || '').toLowerCase();
  if (la && lb && la !== lb) return false; // different-language versions stay separate

  const ca = canonicalTitle(a.show_name);
  const cb = canonicalTitle(b.show_name);
  if (!ca || !cb) return false;
  if (ca === cb) return true;

  const sim = similarity(ca, cb);
  if (sim >= 0.82) return true;
  if (sim >= 0.6) {
    const sameDate = a.release_date && a.release_date === b.release_date;
    if (sameDate || sharedHost(a, b)) return true;
  }
  return false;
}

// ---- source / evidence cleaning ---------------------------------------
function cleanSources(list) {
  if (!Array.isArray(list)) return [];
  const seen = new Set();
  const out = [];
  for (const s of list) {
    const url = s && typeof s === 'object' ? String(s.url || '').trim() : String(s || '').trim();
    if (!url || !/^https?:\/\//i.test(url) || seen.has(url)) continue;
    seen.add(url);
    const type = ['official', 'reliable_media', 'other'].includes(s.sourceType) ? s.sourceType : 'other';
    out.push({
      name: (s.name || s.title || hostOf(url) || 'source').toString().slice(0, 90),
      title: (s.title || '').toString().slice(0, 140),
      date: isValidDate(s.date) ? s.date : '',
      sourceType: type,
      url
    });
  }
  return out;
}

function cleanEvidence(e) {
  if (!e || typeof e !== 'object') return { actualPremiereEvidence: '', announcementEvidence: '' };
  return {
    actualPremiereEvidence: String(e.actualPremiereEvidence || '').slice(0, 400),
    announcementEvidence: String(e.announcementEvidence || '').slice(0, 400)
  };
}

// ---- normalize one candidate/stored record; null if it must be dropped --
function sanitize(c) {
  if (!c || !c.show_name) return null;
  const confidence = ALLOWED_CONFIDENCE.has(c.confidence) ? c.confidence : null;
  if (!confidence) return null; // drops rumours / unknown confidence

  let status = ALLOWED_STATUS.has(c.status) ? c.status : 'Date Not Confirmed';
  const content_type = ALLOWED_TYPE.has(c.content_type) ? c.content_type : 'TV Show';
  const release_date = isValidDate(c.release_date) ? c.release_date : '';
  let expected = c.expected_release_date;
  if (!isValidDate(expected)) expected = expected === 'Date Not Confirmed' ? 'Date Not Confirmed' : '';

  const section = status === 'Released' && release_date ? 'released' : 'upcoming';
  if (section === 'upcoming' && status === 'Released') status = 'Date Not Confirmed';

  const season = c.season != null && !Number.isNaN(Number(c.season)) ? Number(c.season) : extractSeason(c.show_name);
  const date_confidence = ['confirmed', 'likely', 'unknown'].includes(c.date_confidence) ? c.date_confidence : 'unknown';

  return {
    show_name: String(c.show_name).trim().slice(0, 160),
    platform: String(c.platform || '').trim(),
    channel: String(c.channel || '').trim(),
    language: String(c.language || '').trim(),
    content_type,
    status,
    release_date,
    expected_release_date: expected,
    summary: String(c.summary || c.short_summary || '').trim().slice(0, 400),
    confidence,
    date_confidence,
    official_url: /^https?:\/\//i.test(c.official_url || '') ? c.official_url.trim() : '',
    source_name: String(c.source_name || '').trim().slice(0, 80),
    source_urls: cleanSources(c.source_urls),
    evidence: cleanEvidence(c.evidence),
    season,
    section
  };
}

function hasOfficialSource(rec) {
  return Boolean(rec.official_url) || (rec.source_urls || []).some((s) => s.sourceType === 'official');
}

// Server-side recency/quality gate. Returns true if the record may be shown.
export function validate(rec, { today, lookbackDays, horizonDays }) {
  const t = startOfDay(today);
  if (rec.section === 'released') {
    if (!isValidDate(rec.release_date)) return false; // must have a real premiere date
    const d = startOfDay(new Date(rec.release_date));
    if (d > t) return false; // can't be "released" in the future
    if (daysBetween(t, d) > lookbackDays) return false; // older than the window
    return true;
  }
  // upcoming
  if (isValidDate(rec.expected_release_date)) {
    const d = startOfDay(new Date(rec.expected_release_date));
    if (d < t) return false; // stale — expected date already passed
    if (daysBetween(d, t) > horizonDays && !(rec.confidence === 'Confirmed' && hasOfficialSource(rec))) return false;
    return true;
  }
  // no concrete date → require strong verification of the show's existence
  return (
    rec.confidence === 'Confirmed' ||
    hasOfficialSource(rec) ||
    (Boolean(rec.evidence?.announcementEvidence) &&
      (rec.source_urls || []).some((s) => s.sourceType === 'official' || s.sourceType === 'reliable_media'))
  );
}

// ---- merging two records that represent the same show ------------------
const CONFIDENCE_RANK = { Confirmed: 2, Likely: 1 };
const DATECONF_RANK = { confirmed: 3, likely: 2, unknown: 1 };

function pickTitle(a, b) {
  // Keep the most complete title (more words, then longer string).
  const wa = (a || '').trim().split(/\s+/).length;
  const wb = (b || '').trim().split(/\s+/).length;
  if (wb > wa) return b;
  if (wa > wb) return a;
  return (b || '').length > (a || '').length ? b : a || b;
}

function mergeSourceLists(a = [], b = []) {
  const seen = new Set();
  const out = [];
  for (const s of [...a, ...b]) {
    if (!s || !s.url || seen.has(s.url)) continue;
    seen.add(s.url);
    out.push(s);
  }
  return out;
}

function earliest(a, b) {
  if (!a) return b;
  if (!b) return a;
  return a < b ? a : b;
}
function latest(a, b) {
  if (!a) return b;
  if (!b) return a;
  return a > b ? a : b;
}

// Combine two same-show records into one best record.
export function combineRecords(a, b) {
  const out = { ...a };
  out.show_name = pickTitle(a.show_name, b.show_name);
  out.season = a.season ?? b.season ?? null;
  out.confidence = (CONFIDENCE_RANK[b.confidence] || 0) > (CONFIDENCE_RANK[a.confidence] || 0) ? b.confidence : a.confidence;
  out.date_confidence =
    (DATECONF_RANK[b.date_confidence] || 0) > (DATECONF_RANK[a.date_confidence] || 0) ? b.date_confidence : a.date_confidence;

  out.channel = a.channel || b.channel || '';
  out.language = a.language || b.language || '';
  out.source_name = a.source_name || b.source_name || '';
  out.content_type = a.content_type || b.content_type || 'TV Show';
  out.official_url = a.official_url || b.official_url || '';
  out.summary = (b.summary || '').length > (a.summary || '').length ? b.summary : a.summary || b.summary || '';
  out.source_urls = mergeSourceLists(a.source_urls, b.source_urls);
  out.evidence = {
    actualPremiereEvidence: a.evidence?.actualPremiereEvidence || b.evidence?.actualPremiereEvidence || '',
    announcementEvidence: a.evidence?.announcementEvidence || b.evidence?.announcementEvidence || ''
  };

  // Dates: a confirmed premiere wins the "released" section.
  const aRel = a.section === 'released' && a.release_date;
  const bRel = b.section === 'released' && b.release_date;
  if (aRel || bRel) {
    out.section = 'released';
    out.status = 'Released';
    out.release_date = earliest(a.release_date || '', b.release_date || '') || a.release_date || b.release_date;
  } else {
    out.release_date = a.release_date || b.release_date || '';
    // prefer a concrete expected date over "Date Not Confirmed"
    const ax = isValidDate(a.expected_release_date) ? a.expected_release_date : '';
    const bx = isValidDate(b.expected_release_date) ? b.expected_release_date : '';
    out.expected_release_date = earliest(ax, bx) || ax || bx || a.expected_release_date || b.expected_release_date;
  }

  if (a.first_detected_at || b.first_detected_at) out.first_detected_at = earliest(a.first_detected_at, b.first_detected_at);
  if (a.last_verified_at || b.last_verified_at) out.last_verified_at = latest(a.last_verified_at, b.last_verified_at);
  out.key = makeKey(out);
  return out;
}

export function makeKey(rec) {
  return `${canonicalTitle(rec.show_name)}|${(rec.platform || '').toLowerCase()}|${rec.season ?? ''}`;
}

// Re-normalize an already-stored record (keeps timestamps/key). Null if invalid.
export function normalizeRecord(rec) {
  const clean = sanitize(rec);
  if (!clean) return null;
  clean.first_detected_at = rec.first_detected_at;
  clean.last_verified_at = rec.last_verified_at;
  clean.key = makeKey(clean);
  return clean;
}

// De-duplicate a list of already-sanitized records in place.
export function dedupeList(records) {
  const out = [];
  for (const r of records) {
    const idx = out.findIndex((e) => isSameShow(e, r));
    if (idx >= 0) out[idx] = combineRecords(out[idx], r);
    else out.push(r);
  }
  return out;
}

// Sanitize + validate + de-duplicate raw candidates into clean records.
export function mergeCandidates(candidates, config) {
  const out = [];
  for (const raw of candidates) {
    const rec = sanitize(raw);
    if (!rec) continue;
    if (config && !validate(rec, config)) continue;
    rec.key = makeKey(rec);
    const idx = out.findIndex((e) => isSameShow(e, rec));
    if (idx >= 0) out[idx] = combineRecords(out[idx], rec);
    else out.push(rec);
  }
  return out;
}

// ---- JSON extraction ---------------------------------------------------
// Robustly pull a JSON array out of a model response that may be raw JSON,
// wrapped in ```json fences, or accompanied by a little surrounding text.
export function extractJsonArray(text) {
  if (!text) return [];

  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fenced ? fenced[1] : text;

  const direct = tryParseJson(candidate);
  if (Array.isArray(direct)) return direct;

  const start = candidate.indexOf('[');
  const end = candidate.lastIndexOf(']');
  if (start !== -1 && end > start) {
    const arr = tryParseJson(candidate.slice(start, end + 1));
    if (Array.isArray(arr)) return arr;
  }
  return [];
}

function tryParseJson(str) {
  try {
    return JSON.parse(str.trim());
  } catch {
    return null;
  }
}
