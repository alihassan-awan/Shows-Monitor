// Frontend logic for the Indian TV Release Monitor (v2).
const $ = (id) => document.getElementById(id);
let state = { released: [], upcoming: [] };
let meta = { lookbackDays: 30, horizonDays: 180 };

// ---- Filters + status bootstrap ----------------------------------------
async function loadMeta() {
  meta = await fetch('/api/meta').then((r) => r.json());
  fill($('fPlatform'), meta.platforms);
  fill($('fChannel'), meta.channels);
  fill($('fLanguage'), meta.languages);
  renderStatus();
  $('footInfo').textContent =
    `Research: ${meta.research.sources || ''} official pages • Tavily Extract • ` +
    `Storage: ${meta.storage === 'kv' ? 'Vercel KV' : 'local file'} • ` +
    `Auto-check: ${meta.autoCheck.cronTimePKT}`;
}

function fill(select, items) {
  for (const item of items) {
    const opt = document.createElement('option');
    opt.value = item;
    opt.textContent = item;
    select.appendChild(opt);
  }
}

function renderStatus() {
  const bar = $('statusbar');
  const parts = [];

  if (!meta.hasApiKey) {
    parts.push('<span class="bad">⚠ TAVILY_API_KEY missing — add it to enable checks.</span>');
  }
  if (!meta.telegram.configured) {
    parts.push('<span class="warn">✈ Telegram not configured — no alerts will be sent.</span>');
  } else {
    parts.push(`<span class="ok">✈ Telegram alerts on (${meta.telegram.recipients} recipient${meta.telegram.recipients > 1 ? 's' : ''})</span>`);
  }
  if (meta.lastCheckAt) {
    parts.push(`<span>Last checked: ${fmtDateTime(meta.lastCheckAt)}</span>`);
  } else {
    parts.push('<span>Not checked yet — press Check Updates.</span>');
  }
  parts.push(`<span>Auto-check: ${meta.autoCheck.cronTimePKT}</span>`);

  bar.innerHTML = parts.join('');
  bar.hidden = false;
}

function fmtDateTime(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
}

// ---- Load stored shows (respecting filters) ----------------------------
async function loadShows() {
  const params = new URLSearchParams();
  if ($('fPlatform').value) params.set('platform', $('fPlatform').value);
  if ($('fChannel').value) params.set('channel', $('fChannel').value);
  if ($('fLanguage').value) params.set('language', $('fLanguage').value);
  if ($('fSearch').value.trim()) params.set('q', $('fSearch').value.trim());

  state = await fetch('/api/shows?' + params.toString()).then((r) => r.json());
  render();
}

// ---- Rendering ---------------------------------------------------------
function render() {
  renderSection('released', state.released);
  renderSection('upcoming', state.upcoming);
  $('releasedSubtitle').textContent = state.released.length
    ? `First seen on official pages in the last ${meta.lookbackDays || 15} days`
    : '';
  $('upcomingSubtitle').textContent = state.upcoming.length
    ? 'Earlier announcements (official pages only track released shows now)'
    : '';
}

function renderSection(kind, rows) {
  const grid = $(kind);
  grid.innerHTML = '';
  $(kind + 'Count').textContent = rows.length;
  $(kind + 'Empty').hidden = rows.length > 0;
  for (const row of rows) grid.appendChild(card(row, kind));
}

function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
}

// "2026-08-30" -> "Aug 30, 2026". Returns '' for invalid/missing dates.
function fmtDate(iso) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(iso || '')) return '';
  const d = new Date(iso + 'T00:00:00');
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

function dateLine(row, kind) {
  if (kind === 'released') {
    const d = fmtDate(row.release_date);
    return d ? 'First seen ' + d : 'First seen recently';
  }
  const d = fmtDate(row.expected_release_date);
  return d ? 'Expected ' + d : 'Date not confirmed';
}

function card(row, kind) {
  const c = el('div', 'card');
  c.appendChild(el('h3', null, row.show_name));

  // Single metadata line: Platform • Language • Type
  const parts = [row.platform, row.language, row.content_type].filter(Boolean);
  if (parts.length) c.appendChild(el('div', 'meta-line', parts.join(' • ')));

  if (row.summary) c.appendChild(el('p', 'summary', row.summary));

  c.appendChild(el('div', 'date-line', dateLine(row, kind)));

  // Badges only for meaningful status.
  const badges = el('div', 'badges');
  if (row.confidence === 'Confirmed') badges.appendChild(el('span', 'badge confirmed', 'Confirmed'));
  else if (row.confidence === 'Likely') badges.appendChild(el('span', 'badge likely', 'Likely'));
  if (row.content_type === 'Original') badges.appendChild(el('span', 'badge original', 'Original'));
  if (badges.childElementCount) c.appendChild(badges);

  // Where it was spotted (official source page).
  if (row.source_name) {
    c.appendChild(el('div', 'src-line', 'via ' + row.source_name));
  }

  const actions = el('div', 'card-actions');
  if (row.official_url) {
    const a = el('a', 'btn-sm primary', 'Official page ↗');
    a.href = row.official_url;
    a.target = '_blank';
    a.rel = 'noopener';
    actions.appendChild(a);
  }
  const srcUrls = (row.source_urls || []).map((s) => (typeof s === 'string' ? s : s.url)).filter(Boolean);
  if (srcUrls.length === 1) {
    // Single official source page — link directly, no modal needed.
    const a = el('a', 'btn-sm', 'Source page ↗');
    a.href = srcUrls[0];
    a.target = '_blank';
    a.rel = 'noopener';
    actions.appendChild(a);
  } else if (srcUrls.length > 1) {
    const b = el('button', 'btn-sm', `Sources (${srcUrls.length})`);
    b.onclick = () => openSources(row);
    actions.appendChild(b);
  }
  if (actions.childElementCount) c.appendChild(actions);
  return c;
}

// ---- Sources modal -----------------------------------------------------
function openSources(row) {
  $('modalTitle').textContent = 'Source page — ' + row.show_name;
  const list = $('modalList');
  list.innerHTML = '';
  for (const s of row.source_urls || []) {
    const url = typeof s === 'string' ? s : s.url;
    const li = el('li');
    const a = el('a', null, url);
    a.href = url;
    a.target = '_blank';
    a.rel = 'noopener';
    li.appendChild(a);
    list.appendChild(li);
  }
  $('modal').hidden = false;
}

// ---- Check Updates (SSE) ----------------------------------------------
function checkUpdates() {
  const btn = $('checkBtn');
  btn.disabled = true;
  const prog = $('progress');
  prog.hidden = false;
  $('notices').innerHTML = '';
  setProgress('Starting…');

  const es = new EventSource('/api/check');
  let finished = false;

  es.addEventListener('progress', (e) => setProgress(JSON.parse(e.data).message));
  es.addEventListener('notice', (e) => addNotice(JSON.parse(e.data).message, false));
  es.addEventListener('error', (e) => {
    if (finished) return; // native close after we're done — not a real error
    // A server-sent error event carries data; a transport failure does not.
    const msg = e.data ? JSON.parse(e.data).message : 'Connection lost. Is the server running?';
    finished = true;
    addNotice(msg, true);
    finish(es, btn);
  });
  es.addEventListener('done', async (e) => {
    finished = true;
    es.close(); // close synchronously so the native error is suppressed
    const data = JSON.parse(e.data);
    setProgress('Done');
    await loadShows();
    await refreshMeta();
    if (data.newReleases && data.newReleases.length) {
      addNotice(`🎬 ${data.newReleases.length} new release(s): ` + data.newReleases.map((r) => r.show_name).join(', '), false);
    } else if (data.found === 0 && state.released.length === 0 && state.upcoming.length === 0) {
      addNotice('No confirmed new or upcoming shows found.', false);
    }
    finish(es, btn);
  });
}

async function refreshMeta() {
  try {
    meta = await fetch('/api/meta').then((r) => r.json());
    renderStatus();
  } catch { /* non-fatal */ }
}

function finish(es, btn) {
  es.close();
  btn.disabled = false;
  setTimeout(() => { $('progress').hidden = true; }, 2500);
}

function setProgress(msg) {
  $('progress').innerHTML = '<span class="dot"></span>' + msg;
}

function addNotice(msg, isError) {
  const n = el('div', 'notice' + (isError ? ' err' : ''), msg);
  $('notices').appendChild(n);
}

// ---- Wire up -----------------------------------------------------------
$('checkBtn').addEventListener('click', checkUpdates);
$('modalClose').addEventListener('click', () => ($('modal').hidden = true));
$('modal').addEventListener('click', (e) => { if (e.target.id === 'modal') $('modal').hidden = true; });
for (const id of ['fPlatform', 'fChannel', 'fLanguage']) $(id).addEventListener('change', loadShows);
$('fSearch').addEventListener('input', () => { clearTimeout(window.__t); window.__t = setTimeout(loadShows, 250); });

loadMeta().then(loadShows);
