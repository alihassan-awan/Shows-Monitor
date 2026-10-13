// Gemini client.
//
// DEFAULT: the official Google Generative Language API
//   https://generativelanguage.googleapis.com/v1beta
//   Needs a real Google AI Studio key in GEMINI_API_KEY.
//   Uses the `google_search` grounding tool so the model searches the live web.
//
// FALLBACK: if GEMINI_BASE_URL is set (e.g. a local gemini-web2api proxy),
//   requests go to {GEMINI_BASE_URL}/chat/completions in OpenAI-compatible
//   format, exactly like v1 did.

const MODEL = process.env.GEMINI_MODEL || 'gemini-2.5-flash';
const API_KEY = (process.env.GEMINI_API_KEY || '').trim();
const PROXY_BASE = (process.env.GEMINI_BASE_URL || '').replace(/\/+$/, '');

const GOOGLE_API = 'https://generativelanguage.googleapis.com/v1beta';
const useProxy = Boolean(PROXY_BASE);

// Steers the web-enabled model. The detailed per-platform instructions +
// strict JSON schema still come from the user prompt built in research.js.
const SYSTEM_PROMPT =
  'You are a meticulous research assistant with live internet access. ' +
  'ALWAYS search the live web before answering. Prioritise the official platform pages ' +
  '(JioHotstar/Hotstar, ZEE5, SonyLIV, Sun NXT) and recent reliable entertainment-trade sources. ' +
  'Only report genuinely NEW Indian TV shows / web series that are newly released or confirmed upcoming; ' +
  'exclude rumours, episode/written updates, and generic entertainment news. ' +
  'Return output strictly in the JSON format requested by the user, with no extra commentary.';

export function providerInfo() {
  return useProxy
    ? { provider: 'openai-compatible proxy', baseUrl: PROXY_BASE, model: MODEL }
    : { provider: 'google-generative-language', baseUrl: GOOGLE_API, model: MODEL };
}

// A real Google key looks like "AIza..." (39 chars). Anything else — empty,
// the old dummy "local-gemini", obvious placeholders — is not usable with the
// official API. (The proxy fallback accepts any non-empty key.)
export function hasApiKey() {
  if (!API_KEY) return false;
  if (useProxy) return true;
  if (/^(local-gemini|your[-_ ]?key|xxx+|test|dummy)$/i.test(API_KEY)) return false;
  return API_KEY.length >= 20;
}

function withTimeout(ms) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  return { controller, done: () => clearTimeout(timer) };
}

// Health check. Official API: GET /v1beta/models (validates the key).
// Proxy: GET {base}/models. Returns { ok, error } — never throws.
export async function checkHealth({ timeoutMs = 10000 } = {}) {
  if (!hasApiKey()) {
    return {
      ok: false,
      error: useProxy
        ? 'GEMINI_API_KEY is not set.'
        : 'GEMINI_API_KEY is not set. Get a free key at https://aistudio.google.com/apikey and add it as the GEMINI_API_KEY environment variable.'
    };
  }
  const url = useProxy
    ? `${PROXY_BASE}/models`
    : `${GOOGLE_API}/models?key=${encodeURIComponent(API_KEY)}`;
  const headers = useProxy ? { Authorization: `Bearer ${API_KEY}` } : {};
  const { controller, done } = withTimeout(timeoutMs);
  try {
    const res = await fetch(url, { headers, signal: controller.signal });
    if (!res.ok) {
      const detail = (await res.text().catch(() => '')).replace(/\s+/g, ' ').slice(0, 200);
      if (res.status === 400 || res.status === 403) {
        return { ok: false, error: `API key rejected (HTTP ${res.status}). Check GEMINI_API_KEY. ${detail}` };
      }
      return { ok: false, error: `Health check failed (HTTP ${res.status}). ${detail}` };
    }
    return { ok: true };
  } catch (err) {
    if (err?.name === 'AbortError') return { ok: false, error: 'Health check timed out' };
    const code = err?.cause?.code || err?.code;
    return { ok: false, error: code ? `Not reachable (${code})` : `Not reachable (${err?.message || err})` };
  } finally {
    done();
  }
}

// Send one research prompt. Returns the assistant text. Throws descriptive
// errors (never a blanket "API key not valid").
export async function callGemini(prompt, { timeoutMs = 120000 } = {}) {
  if (!hasApiKey()) {
    throw new Error(
      'GEMINI_API_KEY is missing or invalid. Get a free key at https://aistudio.google.com/apikey'
    );
  }
  return useProxy ? callViaProxy(prompt, timeoutMs) : callViaGoogle(prompt, timeoutMs);
}

async function callViaGoogle(prompt, timeoutMs) {
  const { controller, done } = withTimeout(timeoutMs);
  try {
    let res;
    try {
      res = await fetch(
        `${GOOGLE_API}/models/${encodeURIComponent(MODEL)}:generateContent?key=${encodeURIComponent(API_KEY)}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          signal: controller.signal,
          body: JSON.stringify({
            systemInstruction: { parts: [{ text: SYSTEM_PROMPT }] },
            contents: [{ role: 'user', parts: [{ text: prompt }] }],
            generationConfig: {
              temperature: 0.2,
              responseMimeType: 'application/json',
              maxOutputTokens: 8192
            },
            // Live web grounding — the official, reliable replacement for
            // relying on the model's implicit web access.
            tools: [{ google_search: {} }]
          })
        }
      );
    } catch (err) {
      throw new Error(describeNetworkError(err, 'Google Gemini API'));
    }

    if (!res.ok) {
      const detail = (await res.text().catch(() => '')).replace(/\s+/g, ' ').slice(0, 300);
      throw new Error(mapGoogleHttpError(res.status, detail));
    }

    let data;
    try {
      data = await res.json();
    } catch {
      throw new Error('Invalid response: Gemini API did not return JSON');
    }

    const blocked = data?.promptFeedback?.blockReason;
    if (blocked) throw new Error(`Request blocked by Gemini safety filters (${blocked})`);

    const parts = data?.candidates?.[0]?.content?.parts || [];
    const text = parts
      .map((p) => (typeof p?.text === 'string' ? p.text : ''))
      .join('')
      .trim();
    const finish = data?.candidates?.[0]?.finishReason;
    if (!text) {
      throw new Error(
        finish && finish !== 'STOP'
          ? `Gemini returned no text (finishReason: ${finish})`
          : 'Gemini returned empty content'
      );
    }
    return text;
  } finally {
    done();
  }
}

async function callViaProxy(prompt, timeoutMs) {
  const { controller, done } = withTimeout(timeoutMs);
  try {
    let res;
    try {
      res = await fetch(`${PROXY_BASE}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${API_KEY}`
        },
        signal: controller.signal,
        body: JSON.stringify({
          model: MODEL,
          messages: [
            { role: 'system', content: SYSTEM_PROMPT },
            { role: 'user', content: prompt }
          ],
          temperature: 0.2
        })
      });
    } catch (err) {
      throw new Error(describeNetworkError(err, 'Gemini proxy'));
    }

    if (!res.ok) {
      const detail = (await res.text().catch(() => '')).replace(/\s+/g, ' ').slice(0, 300);
      throw new Error(mapHttpError(res.status, detail));
    }

    let data;
    try {
      data = await res.json();
    } catch {
      throw new Error('Invalid response: proxy did not return JSON');
    }

    const content = data?.choices?.[0]?.message?.content;
    if (typeof content !== 'string' || !content.trim()) {
      throw new Error('Gemini returned empty content');
    }
    return content.trim();
  } finally {
    done();
  }
}

function describeNetworkError(err, who) {
  if (err?.name === 'AbortError') return `Request timeout: ${who} did not respond in time`;
  const code = err?.cause?.code || err?.code;
  if (['ECONNREFUSED', 'ECONNRESET', 'ENOTFOUND', 'EAI_AGAIN'].includes(code)) {
    return `${who} unavailable (${code}) — check your network / proxy`;
  }
  return `${who} unavailable: ${err?.message || err}`;
}

function mapGoogleHttpError(status, detail) {
  if (status === 400) return `Bad request (HTTP 400): ${detail}`;
  if (status === 403) return `API key or permission issue (HTTP 403): ${detail}`;
  if (status === 404) return `Model "${MODEL}" not found (HTTP 404) — try GEMINI_MODEL=gemini-2.5-flash. ${detail}`;
  if (status === 429) return `Quota/rate limit hit (HTTP 429) — wait a bit and retry. ${detail}`;
  if (status >= 500) return `Google API error (HTTP ${status}) — retry shortly. ${detail}`;
  return `HTTP ${status}: ${detail}`;
}

function mapHttpError(status, detail) {
  if (status === 401) return `Unauthorized (HTTP 401) from proxy: ${detail}`;
  if (status === 400) return `Bad request (HTTP 400): ${detail}`;
  if (status === 404) return `Model unavailable (HTTP 404): ${detail}`;
  if (status === 500) return `Proxy error (HTTP 500): ${detail}`;
  return `HTTP ${status}: ${detail}`;
}

// Robustly pull a JSON array out of a model response that may be raw JSON,
// wrapped in ```json fences, or accompanied by a little surrounding text.
export function extractJsonArray(text) {
  if (!text) return [];

  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fenced ? fenced[1] : text;

  const direct = tryParse(candidate);
  if (Array.isArray(direct)) return direct;

  const start = candidate.indexOf('[');
  const end = candidate.lastIndexOf(']');
  if (start !== -1 && end > start) {
    const arr = tryParse(candidate.slice(start, end + 1));
    if (Array.isArray(arr)) return arr;
  }
  return [];
}

function tryParse(str) {
  try {
    return JSON.parse(str.trim());
  } catch {
    return null;
  }
}

export { MODEL };
