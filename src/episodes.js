import { readJson, writeJson, backend } from './store.js';
import { sendTelegramMessage, isTelegramConfigured } from './telegram.js';

const SOURCE = 'https://serialtvmaza.sbs/';
const KEY = 'episodes:seen:v1';
const esc = (s) => String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
const decode = (s) => s.replace(/&#(\d+);/g,(_,n)=>String.fromCodePoint(+n)).replace(/&amp;/g,'&').replace(/&quot;/g,'"').replace(/&#039;|&apos;/g,"'").replace(/&nbsp;/g,' ');

export function extractEpisodes(html) {
  const section = html.split(/<h2[^>]*>\s*Recent Posts\s*<\/h2>/i)[1];
  if (!section) throw new Error('Recent Posts section not found: source layout may have changed');
  const recent = section.split(/Page\s*1\s*of|class=["'][^"']*pagination/i)[0].slice(0,150000);
  const results = [];
  const re = /<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
  let m;
  while ((m = re.exec(recent))) {
    const title = decode(m[2].replace(/<[^>]+>/g,'').trim().replace(/\s+/g,' '));
    if (!/\b(?:episode|ep\s*\d+)\b/i.test(title) || !/\b20\d{2}\b/.test(title)) continue;
    let url;
    try { url = new URL(m[1], SOURCE); } catch { continue; }
    if (!['serialtvmaza.sbs','www.serialtvmaza.sbs'].includes(url.hostname)) continue;
    url.hash = ''; url.search = ''; url.pathname = url.pathname.replace(/\/$/,'') + '/';
    if (!results.some(x=>x.url===url.href)) results.push({title,url:url.href});
  }
  if (!results.length) throw new Error('No episode links found; refusing to overwrite saved state');
  return results;
}

export async function checkEpisodes() {
  if (backend() !== 'kv' && process.env.VERCEL) throw new Error('Persistent KV/Upstash storage is required on Vercel');
  const response = await fetch(SOURCE,{headers:{'User-Agent':'Mozilla/5.0 (compatible; EpisodeMonitor/1.0)'},signal:AbortSignal.timeout(20000)});
  if (!response.ok) throw new Error(`Source returned HTTP ${response.status}`);
  const items = extractEpisodes(await response.text());
  const old = await readJson(KEY,null);
  if (old === null) {
    await writeJson(KEY,items.map(x=>x.url));
    return {initialized:true,scanned:items.length,newEpisodes:0,sent:0};
  }
  if (!Array.isArray(old)) throw new Error('Invalid episode state');
  const known = new Set(old);
  const fresh = items.filter(x=>!known.has(x.url));
  if (!fresh.length) return {initialized:false,scanned:items.length,newEpisodes:0,sent:0};
  if (!isTelegramConfigured()) throw new Error('Telegram credentials missing; new episodes not marked as sent');
  let sent = 0;
  // One alert per episode; persist after every successful alert so a partial failure can retry.
  for (const ep of [...fresh].reverse()) {
    const message = `📺 <b>New TV Episode</b>\n\n<b>${esc(ep.title)}</b>\n🔗 <a href="${esc(ep.url)}">View episode post</a>\n\n<i>SerialTvmaza • automatic update</i>`;
    const result = await sendTelegramMessage(message);
    if (!result.ok || result.failed) throw new Error(`Telegram delivery failed after ${sent} episodes: ${result.error || 'partial failure'}`);
    known.add(ep.url);
    await writeJson(KEY,[...known].slice(-2500));
    sent++;
  }
  return {initialized:false,scanned:items.length,newEpisodes:fresh.length,sent};
}
