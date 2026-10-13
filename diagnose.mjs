// Diagnostic for the research provider (v2).
// RESEARCH_PROVIDER=gemini: tests the official Google Generative Language API
//   (or the OpenAI-compatible proxy when GEMINI_BASE_URL is set).
// RESEARCH_PROVIDER=tavily (alias "groq"): tests the LLM + Tavily web search.
// Run: npm run diagnose
import 'dotenv/config';

const _raw = (process.env.RESEARCH_PROVIDER || 'gemini').toLowerCase();
const provider = _raw === 'tavily' || _raw === 'groq' ? 'tavily' : 'gemini';

if (provider === 'tavily') {
  const { checkLlmHealth, llmModel, llmEndpoint } = await import('./src/llm.js');
  const { hasTavilyKey, tavilySearch } = await import('./src/tavily.js');

  console.log('\n=== Indian TV Release Monitor v2 — Tavily+LLM diagnostics ===\n');
  console.log(`• LLM      : ${llmModel()} @ ${llmEndpoint()}`);
  console.log(`• Search   : Tavily (1 credit per test search)\n`);

  console.log('1) LLM key check (GET /models)…');
  const health = await checkLlmHealth();
  if (!health.ok) {
    console.log('   ❌', health.error);
    process.exit(0);
  }
  console.log('   ✔ LLM key is valid.');
  if (health.models?.length) {
    console.log('   Models served (first 10):', health.models.slice(0, 10).join(', '));
  }

  console.log('\n2) Tavily key check…');
  if (!hasTavilyKey()) {
    console.log('   ❌ TAVILY_API_KEY is missing or invalid. Get a free key at https://tavily.com');
    process.exit(0);
  }
  console.log('   ✔ Tavily key format looks good.');

  console.log('\n3) Test Tavily search (costs 1 free credit)…');
  try {
    const hits = await tavilySearch('new web series released India', { maxResults: 3 });
    console.log(`   ✔ Search works — got ${hits.length} results. First: ${hits[0]?.title?.slice(0, 60)}`);
    console.log('\n✅ Tavily+LLM provider is ready. Start the app with: npm start\n');
  } catch (e) {
    console.log('   ❌ Search failed:', e.message, '\n');
  }
  process.exit(0);
}

const key = (process.env.GEMINI_API_KEY || '').trim();
const proxyBase = (process.env.GEMINI_BASE_URL || '').replace(/\/+$/, '');
const model = process.env.GEMINI_MODEL || 'gemini-3.5-flash-lite';
const useProxy = Boolean(proxyBase);

console.log('\n=== Indian TV Release Monitor v2 — Gemini diagnostics ===\n');
console.log(`• Provider : ${useProxy ? 'openai-compatible proxy @ ' + proxyBase : 'official Google Generative Language API'}`);
console.log(`• Model    : ${model}`);
console.log(`• Key      : ${key ? key.slice(0, 6) + '…' + ` (${key.length} chars)` : '(missing)'}\n`);

if (!key) {
  console.log('❌ GEMINI_API_KEY is not set.');
  console.log('→ Get a free key at https://aistudio.google.com/apikey and add it to .env (local) or Vercel env vars.\n');
  process.exit(0);
}

// 1) Key / reachability check + list usable models.
console.log('1) Validating key & listing available models…');
try {
  const url = useProxy ? `${proxyBase}/models` : `https://generativelanguage.googleapis.com/v1beta/models?key=${encodeURIComponent(key)}`;
  const headers = useProxy ? { Authorization: `Bearer ${key}` } : {};
  const r = await fetch(url, { headers });
  if (!r.ok) {
    const t = (await r.text()).slice(0, 300);
    console.log(`   ❌ HTTP ${r.status}: ${t}`);
    if (r.status === 400 || r.status === 403) console.log('   → The API key looks invalid. Double-check GEMINI_API_KEY.');
    process.exit(0);
  }
  console.log('   ✔ Key is valid and the API is reachable.');
  if (!useProxy) {
    try {
      const body = await r.json();
      const names = (body.models || [])
        .map((m) => String(m.name || '').replace(/^models\//, ''))
        .filter(Boolean);
      if (names.length) {
        console.log('   Models your key can use:');
        for (const n of names) console.log(`     - ${n}${n === model ? '  ← current GEMINI_MODEL' : ''}`);
        if (!names.includes(model)) {
          console.log(`   ⚠ "${model}" is not in this list — set GEMINI_MODEL to one of the above.`);
        }
      }
    } catch { /* listing is best-effort */ }
  }
} catch (e) {
  console.log('   ❌ Cannot reach the API:', e.cause?.code || e.message);
  process.exit(0);
}

// 2) Real generation call (tiny, cheap).
console.log(`\n2) Test generation with "${model}"…`);
try {
  let text;
  if (useProxy) {
    const r = await fetch(`${proxyBase}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
      body: JSON.stringify({ model, messages: [{ role: 'user', content: 'Reply with the single word OK.' }], temperature: 0.2 })
    });
    if (!r.ok) throw new Error(`HTTP ${r.status}: ${(await r.text()).slice(0, 200)}`);
    text = (await r.json())?.choices?.[0]?.message?.content;
  } else {
    const r = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(key)}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ role: 'user', parts: [{ text: 'Reply with the single word OK.' }] }],
          generationConfig: { temperature: 0.2, maxOutputTokens: 16 },
          tools: [{ google_search: {} }]
        })
      }
    );
    if (!r.ok) throw new Error(`HTTP ${r.status}: ${(await r.text()).slice(0, 300)}`);
    const body = await r.json();
    text = (body?.candidates?.[0]?.content?.parts || []).map((p) => p.text || '').join('').trim();
  }
  if (!text) throw new Error('empty response');
  console.log('   ✔ Generation succeeded. Model replied:', JSON.stringify(text.slice(0, 80)));
  console.log('\n✅ Gemini connection works. Start the app with: npm start\n');
} catch (e) {
  console.log('   ❌ Generation failed:', e.message);
  console.log('   → If the model name is wrong, run diagnose again and pick a model from the list in step 1.\n');
}
