import { readJson, writeJson, backend } from './store.js';
import { sendTelegramMessage, isTelegramConfigured } from './telegram.js';

const SOURCE = 'https://serialtvmaza.sbs/';
const SEEN_KEY = 'episodes:seen:v1'; // Keep the previously deployed baseline.
const LATEST_KEY = 'episodes:latest:v1';

const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const decode = (s) => String(s).replace(/&#x([0-9a-f]+);/gi, (_,n) => String.fromCodePoint(parseInt(n,16)))
  .replace(/&#(\d+);/g, (_,n) => String.fromCodePoint(+n))
  .replace(/&amp;/g,'&').replace(/&quot;/g,'"').replace(/&#039;|&apos;/g,"'")
  .replace(/&nbsp;/g,' ').replace(/&ndash;/g,'–').replace(/&mdash;/g,'—');

export function extractEpisodes(html) {
  // Only links from Recent Posts. Category/sidebar links are not new episodes.
  const heading = /<h[1-4]\b[^>]*>[\s\S]{0,240}?Recent\s+Posts[\s\S]{0,240}?<\/h[1-4]>/i.exec(html);
  if (!heading) throw new Error('Recent Posts heading not found (website layout changed)');
  const tail = html.slice(heading.index + heading[0].length);
  const recent = tail.split(/Page\s*1\s*of|<nav\b[^>]*class=["'][^"']*pag|<footer\b|<\/main>/i)[0].slice(0,200000);
  const results = [];
  const links = /<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
  let m;
  while ((m = links.exec(recent))) {
    const title = decode(m[2].replace(/<[^>]+>/g,' ').replace(/\s+/g,' ').trim());
    if (!/\b(?:episode|ep\.?\s*\d+)\b/i.test(title)) continue;
    // Avoid promotional previews being mistaken for actual episode updates.
    if (/\b(precap|promo|trailer|teaser)\b/i.test(title)) continue;
    let url;
    try { url = new URL(decode(m[1]),SOURCE); } catch { continue; }
    if (!['serialtvmaza.sbs','www.serialtvmaza.sbs'].includes(url.hostname)) continue;
    url.hash = ''; url.search = '';
    url.pathname = url.pathname.replace(/\/+$/,'') + '/';
    if (!results.some((item) => item.url === url.href)) results.push({title,url:url.href});
  }
  if (!results.length) throw new Error('No episode post links found in Recent Posts; baseline preserved');
  return results;
}

export async function getEpisodeDashboard() {
  const latest = await readJson(LATEST_KEY, null);
  return latest || { source:SOURCE, lastCheckedAt:null, recent:[], scanned:0, newEpisodes:0, alertedEpisodes:0, error:null };
}

export async function checkEpisodes() {
  const start = new Date().toISOString();
  try {
    if (backend() !== 'kv' && process.env.VERCEL) throw new Error('Persistent Redis storage is required on Vercel');
    const response = await fetch(SOURCE, {
      headers:{ 'User-Agent':'Mozilla/5.0 (compatible; ShowsMonitor/2.1; +https://showsmonitor.vercel.app/)' },
      signal:AbortSignal.timeout(20000)
    });
    if (!response.ok) throw new Error('SerialTvmaza returned HTTP '+response.status);
    const items = extractEpisodes(await response.text());
    const old = await readJson(SEEN_KEY,null);
    if (old !== null && (!Array.isArray(old) || old.some((url) => typeof url !== 'string'))) {
      throw new Error('Saved episode baseline is invalid');
    }

    const known = new Set(old || []);
    const fresh = old === null ? [] : items.filter((item) => !known.has(item.url));
    let alertedEpisodes = 0;
    let messages = 0;

    if (old === null) {
      // First successful run is silent: existing posts are not new.
      await writeJson(SEEN_KEY,items.map((item) => item.url));
    } else if (fresh.length) {
      if (!isTelegramConfigured()) throw new Error('Telegram not configured; no new episodes were marked as notified');
      // Batching keeps a busy episode day inside Vercel Hobby function limits.
      const oldestFirst = [...fresh].reverse();
      for (let i=0;i<oldestFirst.length;i+=12) {
        const batch = oldestFirst.slice(i,i+12);
        const lines = ['📺 <b>New TV Episodes — SerialTvmaza</b>',''];
        for (const ep of batch) {
          lines.push('• <b>'+esc(ep.title)+'</b>');
          lines.push('  🔗 <a href="'+esc(ep.url)+'">Episode post</a>');
          lines.push('');
        }
        const sent = await sendTelegramMessage(lines.join('\n'));
        if (!sent.ok || sent.failed) throw new Error('Telegram delivery failed: '+(sent.error || 'partial failure'));
        for (const ep of batch) known.add(ep.url);
        await writeJson(SEEN_KEY,[...known].slice(-2500));
        alertedEpisodes += batch.length;
        messages += sent.sent;
      }
    }

    const result = {
      source:SOURCE,
      lastCheckedAt:new Date().toISOString(),
      lastAttemptAt:start,
      initialized:old === null,
      scanned:items.length,
      newEpisodes:fresh.length,
      alertedEpisodes,
      sent:messages,
      recent:items.slice(0,36),
      error:null
    };
    await writeJson(LATEST_KEY,result);
    console.log('[episodes] scanned='+items.length+' new='+fresh.length+' notified='+alertedEpisodes+' messages='+messages);
    return result;
  } catch (error) {
    console.error('[episodes] check failed:',error.message);
    try {
      const previous = await readJson(LATEST_KEY,{});
      await writeJson(LATEST_KEY,{...previous,source:SOURCE,lastAttemptAt:start,error:String(error.message).slice(0,200)});
    } catch (storageError) {
      console.error('[episodes] could not store failure:',storageError.message);
    }
    throw error;
  }
}
