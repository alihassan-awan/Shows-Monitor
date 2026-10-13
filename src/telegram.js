// Telegram notifications via the Bot API.
//
// Setup: talk to @BotFather -> /newbot -> token goes in TELEGRAM_BOT_TOKEN,
// your numeric chat id in TELEGRAM_CHAT_ID (comma-separated for several
// recipients). See README for the 2-minute setup.

const BOT_TOKEN = (process.env.TELEGRAM_BOT_TOKEN || '').trim();
const CHAT_IDS = (process.env.TELEGRAM_CHAT_ID || '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);
const NOTIFY_UPCOMING = /^(1|true|yes)$/i.test(process.env.TELEGRAM_NOTIFY_UPCOMING || '');

export function isTelegramConfigured() {
  return Boolean(BOT_TOKEN && CHAT_IDS.length);
}

export function telegramStatus() {
  return {
    configured: isTelegramConfigured(),
    recipients: CHAT_IDS.length,
    notifyUpcoming: NOTIFY_UPCOMING
  };
}

function esc(s) {
  return String(s || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function fmtDate(iso) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(iso || '')) return '';
  const d = new Date(iso + 'T00:00:00');
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
}

// Build the "new shows released" alert (HTML parse mode).
export function buildNewShowsMessage(releases, upcoming = []) {
  const lines = ['🎬 <b>Naye shows release ho gaye!</b>', ''];

  releases.forEach((r, i) => {
    const meta = [r.platform, r.language, r.content_type].filter(Boolean).join(' • ');
    const season = r.season ? ` (Season ${r.season})` : '';
    const date = fmtDate(r.release_date);
    lines.push(`${i + 1}. <b>${esc(r.show_name)}${esc(season)}</b>`);
    if (meta) lines.push(`   ${esc(meta)}`);
    if (date) lines.push(`   📅 Release: ${esc(date)}`);
    if (r.summary) lines.push(`   📝 ${esc(r.summary.slice(0, 160))}`);
    if (r.official_url) lines.push(`   🔗 <a href="${esc(r.official_url)}">Official page</a>`);
    lines.push('');
  });

  if (NOTIFY_UPCOMING && upcoming.length) {
    lines.push(`⏳ <b>${upcoming.length} naye upcoming show${upcoming.length > 1 ? 's' : ''} bhi mile:</b>`);
    for (const u of upcoming.slice(0, 10)) {
      const when = /^\d{4}-\d{2}-\d{2}$/.test(u.expected_release_date)
        ? ` — ${fmtDate(u.expected_release_date)}`
        : '';
      lines.push(`• <b>${esc(u.show_name)}</b> (${esc(u.platform)}${esc(when)})`);
    }
    if (upcoming.length > 10) lines.push(`…aur ${upcoming.length - 10} mazeed`);
    lines.push('');
  }

  lines.push('— <i>Indian TV Release Monitor • auto-check</i>');
  return lines.join('\n');
}

export function buildTestMessage() {
  return (
    '✅ <b>Telegram connected!</b>\n\n' +
    'Indian TV Release Monitor ab naye show releases par yahin notify karega.\n' +
    '— <i>test message, koi naya show nahi mila</i>'
  );
}

// Low-level send to every configured chat. Returns { ok, sent, failed, error }.
export async function sendTelegramMessage(html, { timeoutMs = 15000 } = {}) {
  if (!isTelegramConfigured()) {
    return { ok: false, sent: 0, failed: 0, error: 'Telegram is not configured (TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID missing)' };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let sent = 0;
  let failed = 0;
  let lastError = '';
  try {
    for (const chatId of CHAT_IDS) {
      try {
        const res = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          signal: controller.signal,
          body: JSON.stringify({
            chat_id: chatId,
            text: html,
            parse_mode: 'HTML',
            disable_web_page_preview: true
          })
        });
        if (!res.ok) {
          const detail = (await res.text().catch(() => '')).replace(/\s+/g, ' ').slice(0, 200);
          throw new Error(`Telegram HTTP ${res.status}: ${detail}`);
        }
        const body = await res.json().catch(() => ({}));
        if (!body.ok) throw new Error(`Telegram API error: ${body.description || 'unknown'}`);
        sent++;
      } catch (err) {
        failed++;
        lastError = err?.name === 'AbortError' ? 'Telegram request timed out' : String(err.message || err);
        console.error(`[telegram] send to ${chatId} failed:`, lastError);
      }
    }
  } finally {
    clearTimeout(timer);
  }

  return { ok: sent > 0, sent, failed, error: sent > 0 ? '' : lastError };
}

// Notify about newly released shows. Returns the send result (or a skip note).
export async function notifyNewReleases(releases, upcoming = []) {
  if (!releases.length) return { ok: true, sent: 0, skipped: 'no new releases' };
  if (!isTelegramConfigured()) return { ok: false, sent: 0, skipped: 'telegram not configured' };
  const msg = buildNewShowsMessage(releases, upcoming);
  return sendTelegramMessage(msg);
}
