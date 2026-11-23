import { checkEpisodes, getEpisodeDashboard } from './episodes.js';
// HTTP handlers shared by the local Express server (server.js) and the
// Vercel serverless functions (api/*).
//
// FRAMEWORK-AGNOSTIC: only standard http.ServerResponse methods are used
// (setHeader / statusCode / end) — no Express-only res.status().json().

import { hasTavilyKey } from './extract.js';
import { APP_VERSION } from './version.js';
import { getShows, getMeta } from './db.js';
import { runCheck, configSummary, researchProviderInfo } from './scheduler.js';
import { platformNames, channelNames, languageNames } from './platforms.js';
import { backend } from './store.js';
import {
  isTelegramConfigured,
  telegramStatus,
  sendTelegramMessage,
  buildTestMessage
} from './telegram.js';

function sendJson(res, status, obj) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.end(JSON.stringify(obj));
}

export async function handleEpisodes(_req, res) {
  try { sendJson(res,200,await getEpisodeDashboard()); }
  catch (err) { sendJson(res,503,{error:'Episode storage unavailable: '+err.message}); }
}

export async function handleMeta(_req, res) {
  const meta = await getMeta();
  sendJson(res, 200, {
    version: APP_VERSION,
    platforms: platformNames(),
    channels: channelNames(),
    languages: languageNames(),
    hasApiKey: hasTavilyKey(),
    research: researchProviderInfo(),
    storage: backend(),
    telegram: telegramStatus(),
    autoCheck: {
      // On Vercel the daily cron in vercel.json drives this; locally it's the
      // AUTO_CHECK env interval. The UI just reports the configured cadence.
      cronSchedule: '0 4 * * *',
      cronTimePKT: '09:00 PKT daily',
      localEnabled: /^(1|true|yes)$/i.test(process.env.AUTO_CHECK || '')
    },
    lastCheckAt: meta.lastCheckAt || null,
    ...configSummary()
  });
}

export async function handleShows(req, res) {
  const { platform, channel, language, q } = req.query || {};
  sendJson(res, 200, await getShows({ platform, channel, language, q }));
}

// Manual "Check Updates" — streams progress via Server-Sent Events.
export async function handleCheck(_req, res) {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders?.();

  const send = (event, data) => {
    try {
      res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    } catch { /* client went away */ }
  };

  try {
    const episodeTask = checkEpisodes().then((data) => ({ok:true,data})).catch((error) => ({ok:false,error:error.message}));
    const result = await runCheck({
      source: 'manual',
      onProgress: (message) => send('progress', { message })
    });

    for (const f of result.failed) {
      send('notice', {
        message: result.allFailed
          ? `${f.platform}: ${f.reason}`
          : `${f.platform} could not be checked (${f.reason}) — other platforms were used.`
      });
    }
    if (result.allFailed) {
      send('notice', {
        message: 'All platforms failed — check the TAVILY_API_KEY and the server console for details.'
      });
    }
    if (result.purged > 0) {
      send('notice', { message: `Cleaned up ${result.purged} invalid/junk record${result.purged > 1 ? 's' : ''} from the database.` });
    }
    if (result.telegram.sent > 0) {
      send('notice', { message: `Telegram notification sent (${result.telegram.sent} chat${result.telegram.sent > 1 ? 's' : ''}).` });
    } else if (result.newReleases.length > 0 && !isTelegramConfigured()) {
      send('notice', { message: `${result.newReleases.length} new release(s) found — Telegram is not configured, so no alert was sent.` });
    } else if (result.newReleases.length > 0 && !result.telegram.ok) {
      send('notice', { message: `New release(s) found but the Telegram alert failed: ${result.telegram.error || 'unknown error'}` });
    }

    const episode = await episodeTask;
    if (episode.ok) send('notice', { message: 'SerialTvmaza checked: '+episode.data.scanned+' posts, '+episode.data.newEpisodes+' new, '+episode.data.alertedEpisodes+' notified'+(episode.data.initialized?' (first-run baseline saved)':'')+'.' });
    else send('notice', { message: 'SerialTvmaza check failed: '+episode.error });
    send('progress', { message: 'Done' });
    send('done', {
      released: result.released,
      upcoming: result.upcoming,
      found: result.found,
      newReleases: result.newReleases,
      failed: result.failed.map((f) => f.platform)
    });
  } catch (err) {
    send('error', { message: `Check failed: ${err.message}` });
  } finally {
    try { res.end(); } catch { /* ignore */ }
  }
}

// Vercel Cron endpoint: GET /api/cron/check — runs the daily auto-check and
// notifies on Telegram when new shows released. Protected by CRON_SECRET.
export async function handleCronCheck(req, res) {
  const secret = process.env.CRON_SECRET || '';
  if (secret) {
    const auth = req.headers?.authorization || '';
    if (auth !== `Bearer ${secret}`) {
      return sendJson(res, 401, { ok: false, error: 'Unauthorized' });
    }
  } else {
    console.warn('[cron] CRON_SECRET is not set — endpoint is unprotected');
  }

  // One Hobby-compatible daily cron checks BOTH sources, independently.
  const [ott, episodes] = await Promise.allSettled([
    runCheck({ source:'cron' }),
    checkEpisodes()
  ]);
  const response = {
    ok:ott.status === 'fulfilled' && episodes.status === 'fulfilled',
    ott:ott.status === 'fulfilled' ? {
      found:ott.value.found,
      newReleases:ott.value.newReleases,
      failed:ott.value.failed,
      telegram:ott.value.telegram
    } : {error:String(ott.reason?.message || ott.reason)},
    episodes:episodes.status === 'fulfilled' ? {
      scanned:episodes.value.scanned,
      newEpisodes:episodes.value.newEpisodes,
      alertedEpisodes:episodes.value.alertedEpisodes,
      sent:episodes.value.sent,
      initialized:episodes.value.initialized
    } : {error:String(episodes.reason?.message || episodes.reason)}
  };
  return sendJson(res,response.ok ? 200 : 500,response);
}

// Quick setup check: GET /api/telegram/test — sends a test message.
export async function handleTelegramTest(_req, res) {
  const result = await sendTelegramMessage(buildTestMessage());
  if (result.ok) {
    return sendJson(res, 200, { ok: true, sent: result.sent });
  }
  return sendJson(res, 400, { ok: false, error: result.error || 'Telegram send failed' });
}
