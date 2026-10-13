// Generic OpenAI-compatible LLM client.
//
// Any provider with an OpenAI-style /chat/completions endpoint works — just
// set LLM_BASE_URL / LLM_API_KEY / LLM_MODEL. Free options (limits checked
// Oct 2026):
//
//   Groq        https://api.groq.com/openai/v1          30 RPM, 1,000 req/day
//   OpenRouter  https://openrouter.ai/api/v1           20 RPM, 50 req/day (:free models)
//   NVIDIA NIM  https://integrate.api.nvidia.com/v1    40 RPM — NOT offered in
//               Pakistan/Bangladesh/Russia (needs phone verification in a
//               supported country), so it is documented but not recommended here.
//
// The LLM has NO built-in web search, so this client is always paired with
// Tavily (src/tavily.js): Tavily searches the live web, the LLM extracts the
// structured show records from the results.
//
// Backward compat: GROQ_API_KEY / GROQ_MODEL / GROQ_BASE_URL still work as
// fallbacks for LLM_API_KEY / LLM_MODEL / LLM_BASE_URL.

const KEY = (process.env.LLM_API_KEY || process.env.GROQ_API_KEY || '').trim();
const MODEL = process.env.LLM_MODEL || process.env.GROQ_MODEL || 'openai/gpt-oss-120b';
const BASE = (
  process.env.LLM_BASE_URL ||
  process.env.GROQ_BASE_URL ||
  'https://api.groq.com/openai/v1'
).replace(/\/+$/, '');

export function hasLlmKey() {
  return KEY.length > 20;
}

export function llmModel() {
  return MODEL;
}

export function llmEndpoint() {
  try {
    return new URL(BASE).hostname;
  } catch {
    return BASE;
  }
}

export function providerInfo() {
  return { provider: 'tavily+llm', llm: MODEL, llmEndpoint: llmEndpoint(), search: 'tavily' };
}

function withTimeout(ms) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  return { controller, done: () => clearTimeout(timer) };
}

// Health check: GET /models validates the key AND lets us confirm LLM_MODEL
// is served. Returns { ok, error, models } — never throws.
export async function checkLlmHealth({ timeoutMs = 12000 } = {}) {
  if (!hasLlmKey()) {
    return { ok: false, error: 'LLM_API_KEY is missing. Set it (e.g. a free Groq key from https://console.groq.com/keys)' };
  }
  const { controller, done } = withTimeout(timeoutMs);
  try {
    const res = await fetch(`${BASE}/models`, {
      headers: { Authorization: `Bearer ${KEY}` },
      signal: controller.signal
    });
    if (!res.ok) {
      const detail = (await res.text().catch(() => '')).replace(/\s+/g, ' ').slice(0, 200);
      if (res.status === 401) return { ok: false, error: `LLM key rejected (HTTP 401) at ${llmEndpoint()}. Check LLM_API_KEY. ${detail}` };
      return { ok: false, error: `LLM health check failed (HTTP ${res.status}) at ${llmEndpoint()}. ${detail}` };
    }
    const data = await res.json().catch(() => ({}));
    const models = (data.data || []).map((m) => m.id).filter(Boolean);
    if (models.length && !models.includes(MODEL)) {
      return { ok: false, error: `Model "${MODEL}" is not served at ${llmEndpoint()} for this key. Choices: ${models.slice(0, 8).join(', ')}` };
    }
    return { ok: true, models };
  } catch (err) {
    if (err?.name === 'AbortError') return { ok: false, error: 'LLM health check timed out' };
    return { ok: false, error: `LLM unreachable: ${err?.cause?.code || err?.message || err}` };
  } finally {
    done();
  }
}

async function with429Retry(fn, { retries = 2, baseDelayMs = 12000 } = {}) {
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      const is429 = /HTTP 429/.test(String(err?.message || ''));
      if (!is429 || attempt === retries) throw err;
      const waitMs = baseDelayMs * (attempt + 1);
      console.warn(`[llm] 429 rate limit — retrying in ${Math.round(waitMs / 1000)}s (attempt ${attempt + 2}/${retries + 1})`);
      await new Promise((r) => setTimeout(r, waitMs));
    }
  }
  throw lastErr;
}

// Chat completion. messages = OpenAI-style [{role, content}]. Returns text.
export async function callLlm(messages, { timeoutMs = 90000, maxTokens = 4096 } = {}) {
  if (!hasLlmKey()) {
    throw new Error('LLM_API_KEY is missing. Set it (e.g. a free Groq key from https://console.groq.com/keys)');
  }
  return with429Retry(async () => {
    const { controller, done } = withTimeout(timeoutMs);
    try {
      let res;
      try {
        res = await fetch(`${BASE}/chat/completions`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${KEY}`
          },
          signal: controller.signal,
          body: JSON.stringify({
            model: MODEL,
            messages,
            temperature: 0.2,
            max_tokens: maxTokens,
            response_format: { type: 'json_object' }
          })
        });
      } catch (err) {
        if (err?.name === 'AbortError') throw new Error('LLM request timed out');
        throw new Error(`LLM unreachable: ${err?.cause?.code || err?.message || err}`);
      }

      if (!res.ok) {
        const detail = (await res.text().catch(() => '')).replace(/\s+/g, ' ').slice(0, 300);
        if (res.status === 401) throw new Error(`LLM: invalid API key (HTTP 401). ${detail}`);
        if (res.status === 404) throw new Error(`LLM: model "${MODEL}" not found (HTTP 404). ${detail}`);
        if (res.status === 429) throw new Error(`LLM: rate limit hit (HTTP 429). ${detail}`);
        throw new Error(`LLM request failed (HTTP ${res.status}). ${detail}`);
      }

      const data = await res.json().catch(() => ({}));
      const text = data?.choices?.[0]?.message?.content;
      if (typeof text !== 'string' || !text.trim()) throw new Error('LLM returned empty content');
      return text.trim();
    } finally {
      done();
    }
  });
}
