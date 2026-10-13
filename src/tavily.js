// Tavily web-search client (https://tavily.com).
// Free Researcher tier: 1,000 credits/month, no card. Basic search = 1 credit.
// We use topic:"news" + time_range:"month" so results stay fresh — this is the
// "live web" half of the Groq provider (Groq models have no built-in search).

const KEY = (process.env.TAVILY_API_KEY || '').trim();
const BASE = (process.env.TAVILY_BASE_URL || 'https://api.tavily.com').replace(/\/+$/, '');

export function hasTavilyKey() {
  return KEY.startsWith('tvly-') && KEY.length > 20;
}

function withTimeout(ms) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  return { controller, done: () => clearTimeout(timer) };
}

// Run one web search. Returns [{ title, url, content, publishedDate }].
// Throws descriptive errors.
export async function tavilySearch(query, { maxResults = 8, timeoutMs = 25000 } = {}) {
  if (!hasTavilyKey()) {
    throw new Error('TAVILY_API_KEY is missing or invalid. Get a free key at https://tavily.com');
  }
  const { controller, done } = withTimeout(timeoutMs);
  try {
    let res;
    try {
      res = await fetch(`${BASE}/search`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        signal: controller.signal,
        body: JSON.stringify({
          api_key: KEY,
          query,
          topic: 'news',
          time_range: 'month',
          search_depth: 'basic', // 1 credit per search
          max_results: maxResults,
          include_answer: false,
          include_raw_content: false
        })
      });
    } catch (err) {
      if (err?.name === 'AbortError') throw new Error('Tavily search timed out');
      throw new Error(`Tavily unreachable: ${err?.cause?.code || err?.message || err}`);
    }

    if (!res.ok) {
      const detail = (await res.text().catch(() => '')).replace(/\s+/g, ' ').slice(0, 250);
      if (res.status === 401) throw new Error(`Tavily: invalid API key (HTTP 401). ${detail}`);
      if (res.status === 429) throw new Error(`Tavily: rate/credit limit hit (HTTP 429) — free tier is 1,000 credits/month. ${detail}`);
      throw new Error(`Tavily search failed (HTTP ${res.status}). ${detail}`);
    }

    const data = await res.json().catch(() => ({}));
    const results = Array.isArray(data.results) ? data.results : [];
    return results
      .filter((r) => r && r.url)
      .map((r) => ({
        title: String(r.title || '').slice(0, 160),
        url: String(r.url || ''),
        content: String(r.content || '').slice(0, 600),
        publishedDate: String(r.published_date || '')
      }));
  } finally {
    done();
  }
}
