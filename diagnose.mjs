// Diagnostic for the official-sources pipeline.
// Tests the Tavily key, extracts ONE source page, and shows parsed titles.
// Run: npm run diagnose            (tests the first JioHotstar source)
//      node diagnose.mjs --url <page-url>   (tests any single page)
//      node diagnose.mjs --all              (tests all sources, ~10 credits)
import 'dotenv/config';

import { hasTavilyKey, tavilyExtract, parseTitles } from './src/extract.js';
import { allSources } from './src/sources.js';

const args = process.argv.slice(2);
const onlyUrl = args[args.indexOf('--url') + 1];
const testAll = args.includes('--all');

console.log('\n=== Indian TV Release Monitor — official-sources diagnostics ===\n');

if (!hasTavilyKey()) {
  console.log('❌ TAVILY_API_KEY is missing or invalid. Get a free key at https://tavily.com\n');
  process.exit(0);
}
console.log('✔ Tavily key format looks good.\n');

let targets = allSources();
if (onlyUrl) {
  targets = [{ platform: 'manual', name: 'manual', url: onlyUrl, language: '', channel: '' }];
} else if (!testAll) {
  targets = [targets[0]];
}

for (const t of targets) {
  console.log(`• [${t.platform}] ${t.name}: ${t.url}`);
  const { results, failed } = await tavilyExtract([t.url], { timeoutMs: 45000 });
  if (!results.length) {
    console.log(`  ❌ extract failed: ${failed[0]?.error || 'unknown'}\n`);
    continue;
  }
  const titles = parseTitles(results[0].raw_content, t.url);
  console.log(`  ✔ extracted ${titles.length} titles${t.unverified ? '  (⚠ unverified URL — confirm this page lists shows)' : ''}`);
  for (const x of titles.slice(0, 10)) console.log(`    - ${x.title}`);
  if (titles.length > 10) console.log(`    …and ${titles.length - 10} more`);
  console.log('');
}

console.log('✅ Done. Start the app with: npm start\n');
