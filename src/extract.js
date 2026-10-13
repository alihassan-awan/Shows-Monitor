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
  'watch trailer', 'add to watchlist', 'share', 'next', 'previous',
  // footer/nav junk observed in production extracts
  'blog', 'stories', 'preferences', 'do not sell or share my personal information',
  'fifa world cup schedule', 'popular live tv channels', 'popular web series',
  'zee news', 'zee tv hd',
  // country names (sports-schedule tiles, not shows)
  'france', 'spain', 'argentina', 'england', 'brazil', 'portugal',
  'germany', 'italy', 'netherlands', 'mexico',
  // social/app-badge icon alts
  'insta', 'instagram', 'twitter', 'facebook', 'google play', 'app store',
  // css/alt fragments seen on Sun NXT pages
  'logo', 'caret', 'search_hover', 'profile_hover', 'tvs',
  // sonyliv rail headings
  'shows on set', 'evergreen classics'
]);

// Category/collection tiles, not actual shows: "Hindi Webseries",
// "Deepika Padukone Movies", "Pakistani Serials", "Zee Bangla serials on ZEE5"
const CATEGORY_TAIL = /(movies?|web\s?series|tv\s?shows?|tv\s?serials?|serials?|drama\s?series|drama|shows)(\s+on\s+[a-z0-9]+)?$/i;
// Image alt-text leaking through as titles: "Image 2: Back", "Image 30: Google Play"
const IMAGE_ALT = /^(image|img|photo|pic|thumbnail)\s*\d*\s*[:\-–—]/i;
// Bare domains used as link text: "www.sonyliv.com"
const DOMAIN_TITLE = /^(www\.|https?:\/\/)|[.](com|in|net|org|tv)$/i;
// Movie detail pages — we only track TV shows / web series.
const MOVIE_URL = /\/(movies?|films?)\//i;

/**
 * Shared junk predicate: used by the live parser AND by the DB purge that
 * cleans records saved before these filters existed.
 */
export function isJunkCandidate(title, url) {
  let t = cleanText(title);
  if (!t || t.length < 2 || t.length > 120) return true;
  if (t.startsWith('!')) t = cleanText(t.slice(1)); // image-link markdown remnant
  t = cleanText(t.replace(/^[[#!]+\s*/, '')); // stray "[","#","!" prefixes
  if (!t || t.length < 2) return true;
  if (/^#+/.test(t)) return true;
  if (IMAGE_ALT.test(t)) return true;
  if (DOMAIN_TITLE.test(t)) return true;
  if (/\blogo$/i.test(t)) return true; // "Sun NXT Logo"
  if (/^[a-z]+(_[a-z0-9]+)+$/.test(t)) return true; // snake_case code fragments
  if (NAV_WORDS.has(t.toLowerCase())) return true;
  // underscore/space variants: "search_hover" vs "search hover"
  const low = t.toLowerCase();
  if (NAV_WORDS.has(low.replace(/_/g, ' '))) return true;
  if (NAV_WORDS.has(low.replace(/\s+/g, '_'))) return true;
  if (CATEGORY_TAIL.test(t)) return true;
  if (url && MOVIE_URL.test(url)) return true;
  return false;
}

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

  const md = markdown || '';

  const push = (rawTitle, rawHref) => {
    let title = cleanText(rawTitle);
    if (title.startsWith('!')) title = cleanText(title.slice(1));
    if (!title) return;
    if (/^[\d\s\-–—.,:;!?()'"“”‘’]+$/.test(title)) return;
    const url = resolveUrl(rawHref, pageUrl);
    if (!url) return;
    if (isJunkCandidate(title, url)) return;
    let host = '';
    try {
      host = new URL(url).hostname.replace(/^www\./, '');
    } catch { return; }
    if (pageHost && host !== pageHost) return; // ignore external/ads links
    if (JUNK_URL_RE.test(url)) return;

    const key = title.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ title, url });
  };

  // 1) Image-wrapped tiles: [![alt](img-url)](show-page-url) -> alt + show page.
  //    Must run BEFORE the plain-link pass, which would otherwise match the
  //    inner image link (and its alt text as the "title").
  const imgRe = /\[!\[([^\]]{0,200})\]\([^)]*\)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g;
  let m;
  while ((m = imgRe.exec(md)) !== null) push(m[1], m[2]);

  // 2) Plain links. Anything whose text starts with "!" is a bare image link
  //    (no usable title) — skip it.
  const re = /\[([^\]]{1,200})\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g;
  while ((m = re.exec(md)) !== null) {
    if (/^!/.test(m[1])) continue;
    push(m[1], m[2]);
  }
  return out;
}
