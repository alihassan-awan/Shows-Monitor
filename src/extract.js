// Tavily Extract client + show-title parser.
//
// The app reads ONLY official platform pages (src/sources.js). Tavily's
// /extract endpoint renders the JavaScript-heavy pages and returns markdown;
// this module pulls show titles + their official page links out of it.
//
// No LLM is used anywhere — zero token usage by design.

const KEY = (process.env.TAVILY_API_KEY || '').trim();
const DEPTH = (process.env.TAVILY_EXTRACT_DEPTH || 'advanced').toLowerCase() === 'basic' ? 'basic' : 'advanced';
const API = (process.env.TAVILY_BASE_URL || 'https://api.tavily.com/extract').replace(/\/+$/, '');

export function hasTavilyKey() {
  return KEY.length > 20;
}

function withTimeout(ms) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  return { controller, done: () => clearTimeout(timer) };
}

// Extract content for up to 20 URLs in one call.
// Returns { results: [{url, raw_content}], failed: [{url, error}] } — never throws.
export async function tavilyExtract(urls, { timeoutMs = 45000 } = {}) {
  if (!hasTavilyKey()) {
    return { results: [], failed: urls.map((url) => ({ url, error: 'TAVILY_API_KEY is missing' })) };
  }
  const { controller, done } = withTimeout(timeoutMs);
  try {
    let res;
    try {
      res = await fetch(API, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${KEY}` },
        signal: controller.signal,
        body: JSON.stringify({
          urls,
          extract_depth: DEPTH,
          format: 'markdown',
          timeout: Math.min(60, Math.max(10, Math.round(timeoutMs / 1000) - 5))
        })
      });
    } catch (err) {
      if (err?.name === 'AbortError') {
        return { results: [], failed: urls.map((url) => ({ url, error: 'extract timed out' })) };
      }
      return { results: [], failed: urls.map((url) => ({ url, error: `unreachable: ${err?.cause?.code || err?.message || err}` })) };
    }
    if (!res.ok) {
      const detail = (await res.text().catch(() => '')).replace(/\s+/g, ' ').slice(0, 200);
      return { results: [], failed: urls.map((url) => ({ url, error: `HTTP ${res.status}: ${detail}` })) };
    }
    const data = await res.json().catch(() => ({}));
    const results = (data.results || [])
      .filter((r) => r && r.url && typeof r.raw_content === 'string')
      .map((r) => ({ url: r.url, raw_content: r.raw_content }));
    const failed = (data.failed_results || []).map((f) => ({ url: f.url, error: f.error || 'extract failed' }));
    // Anything not in results/failed is treated as failed (empty content).
    const seen = new Set([...results.map((r) => r.url), ...failed.map((f) => f.url)]);
    for (const url of urls) {
      if (!seen.has(url)) failed.push({ url, error: 'no content returned' });
    }
    return { results, failed };
  } finally {
    done();
  }
}

// ---- Title parsing -------------------------------------------------------
// Category pages are grids of linked tiles: [Show Name](https://...show-url).
// We collect those links, drop navigation/chrome links, and de-dupe.

const NAV_WORDS = new Set([
  'home', 'search', 'login', 'log in', 'sign in', 'sign up', 'register',
  'subscribe', 'download', 'download app', 'get the app', 'help', 'support',
  'contact', 'contact us', 'about', 'about us', 'terms', 'privacy',
  'privacy policy', 'cookie', 'cookies', 'settings', 'profile', 'my account',
  'watchlist', 'my list', 'more', 'view all', 'see all', 'show all',
  'movies', 'tv shows', 'web series', 'originals', 'live tv', 'sports',
  'news', 'kids', 'premium', 'offers', 'faq', 'sitemap', 'feedback',
  'language', 'languages', 'channels', 'shows', 'episodes', 'clips',
  'trailers', 'coming soon', 'trending', 'popular', 'new', 'a-z',
  'skip to content', 'back to top', 'close', 'menu', 'play', 'watch now',
  'watch trailer', 'add to watchlist', 'share', 'next', 'previous'
]);

const JUNK_URL_RE = /(login|signin|sign-in|signup|sign-up|register|subscribe|subscription|help|support|terms|privacy|about|contact|download|faq|cookie|feedback|sitemap)/i;

function cleanText(t) {
  return String(t || '').replace(/\s+/g, ' ').trim();
}

function resolveUrl(href, pageUrl) {
  try {
    const u = new URL(href, pageUrl);
    if (!['http:', 'https:'].includes(u.protocol)) return '';
    u.hash = '';
    return u.toString();
  } catch {
    return '';
  }
}

// Parse markdown -> [{ title, url }]. Same-host content links only.
export function parseTitles(markdown, pageUrl) {
  const out = [];
  const seen = new Set();
  let pageHost = '';
  try {
    pageHost = new URL(pageUrl).hostname.replace(/^www\./, '');
  } catch { /* ignore */ }

  const re = /\[([^\]]{1,200})\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g;
  let m;
  while ((m = re.exec(markdown || '')) !== null) {
    const title = cleanText(m[1]);
    if (title.length < 2 || title.length > 120) continue;
    if (/^[\d\s\-–—.,:;!?()'"“”‘’]+$/.test(title)) continue;
    if (NAV_WORDS.has(title.toLowerCase())) continue;
    // Skip image-only tiles and alt-text noise.
    if (/^!/.test(m[0])) continue;

    const url = resolveUrl(m[2], pageUrl);
    if (!url) continue;
    let host = '';
    try {
      host = new URL(url).hostname.replace(/^www\./, '');
    } catch { continue; }
    if (pageHost && host !== pageHost) continue; // ignore external/ads links
    if (JUNK_URL_RE.test(url)) continue;

    const key = title.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ title, url });
  }
  return out;
}
