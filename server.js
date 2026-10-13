// Local development server. On Vercel this file is NOT used — the api/*
// functions and the static public/ folder take over instead.
import 'dotenv/config';
import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { providerInfo } from './src/gemini.js';
import { buildConfig, configSummary, startLocalAutoCheck } from './src/scheduler.js';
import { migrateAndClean, ensureNotifiedBackfill } from './src/db.js';
import {
  handleMeta,
  handleShows,
  handleCheck,
  handleCronCheck,
  handleTelegramTest
} from './src/handlers.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.static(path.join(__dirname, 'public')));

app.get('/api/meta', (req, res) => handleMeta(req, res).catch((e) => res.status(500).json({ error: e.message })));
app.get('/api/shows', (req, res) => handleShows(req, res).catch((e) => res.status(500).json({ error: e.message })));
app.get('/api/check', (req, res) => handleCheck(req, res));
app.get('/api/cron/check', (req, res) => handleCronCheck(req, res));
app.get('/api/telegram/test', (req, res) => handleTelegramTest(req, res));

app.listen(PORT, async () => {
  const g = providerInfo();
  const c = configSummary();
  console.log(`Indian TV Release Monitor v2 running at http://localhost:${PORT}`);
  console.log(`Gemini: ${g.provider} (model: ${g.model})`);
  console.log(`Recency window: released ≤ ${c.lookbackDays}d ago, upcoming ≤ ${c.horizonDays}d ahead`);
  try {
    await ensureNotifiedBackfill();
    const summary = await migrateAndClean(buildConfig());
    if (summary.changed) {
      console.log(
        `Cleaned stored data: ${summary.before} → ${summary.after} records ` +
          `(${summary.removed} removed/merged).`
      );
    }
  } catch (err) {
    console.error('Startup data cleanup skipped:', err.message);
  }

  if (/^(1|true|yes)$/i.test(process.env.AUTO_CHECK || '')) {
    const hours = Number(process.env.AUTO_CHECK_INTERVAL_HOURS) || 24;
    startLocalAutoCheck({ intervalHours: hours });
  }
});
