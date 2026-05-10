/**
 * backfill-titles.js
 *
 * Resolves page titles for library items whose title is a raw URL.
 * Run locally after downloading pkm-library-index.json from Google Drive.
 *
 * Usage:
 *   node backfill-titles.js pkm-library-index.json
 *   node backfill-titles.js --interactive pkm-library-index.json
 *
 * --interactive (-i): prompts for a manual title when automatic fetch fails.
 *
 * When done, re-upload the file to your Drive PKM root folder,
 * replacing the existing pkm-library-index.json.
 */

const fs       = require('fs');
const https    = require('https');
const http     = require('http');
const readline = require('readline');

function fetchTitle(url, redirects = 0) {
  if (redirects > 5) return Promise.resolve('');
  return new Promise(resolve => {
    const mod = url.startsWith('https') ? https : http;
    const req = mod.get(url, { headers: { 'User-Agent': 'Mozilla/5.0' }, timeout: 10000 }, res => {
      // Follow redirects, draining the redirect response so the socket is freed.
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        try {
          return resolve(fetchTitle(new URL(res.headers.location, url).href, redirects + 1));
        } catch (_) {
          return resolve('');
        }
      }

      let html = '';
      res.on('error', () => resolve(''));
      res.on('data', chunk => {
        // Stop accumulating past 50 KB but keep consuming — do NOT call req.destroy()
        // here because that emits an unhandled 'error' event on res, crashing the process.
        if (html.length < 50000) html += chunk;
      });
      res.on('end', () => {
        const m = html.match(/<title[^>]*>([^<]{1,300})<\/title>/i);
        resolve(m ? m[1].replace(/\s+/g, ' ').trim() : '');
      });
    });
    req.on('error', () => resolve(''));
    req.on('timeout', () => { req.destroy(); });
  });
}

async function main() {
  const args        = process.argv.slice(2);
  const interactive = args.includes('--interactive') || args.includes('-i');
  const filePath    = args.find(a => !a.startsWith('-'));

  if (!filePath) {
    console.error('Usage: node backfill-titles.js [--interactive] <path-to-pkm-library-index.json>');
    process.exit(1);
  }

  const rl  = interactive
    ? readline.createInterface({ input: process.stdin, output: process.stdout })
    : null;
  const ask = q => new Promise(resolve => rl.question(q, resolve));

  const index = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  const items = index.items || [];
  const toFix = items.filter(i => /^https?:\/\//.test(i.title));

  console.log(`${toFix.length} item(s) to resolve out of ${items.length} total\n`);
  if (toFix.length === 0) {
    console.log('Nothing to do.');
    if (rl) rl.close();
    return;
  }

  let resolved = 0;
  const removals = new Set();
  for (const item of toFix) {
    process.stdout.write(`  ${item.title.slice(0, 80)}…\n    → `);
    const title = await fetchTitle(item.url);
    if (title) {
      item.title = title;
      console.log(title.slice(0, 80));
      resolved++;
    } else if (interactive) {
      console.log('(could not fetch)');
      const input = (await ask('    Title, r=remove, or Enter to skip: ')).trim();
      if (input.toLowerCase() === 'r') {
        removals.add(item.id);
        console.log('    Removed.');
      } else if (input) {
        item.title = input;
        resolved++;
      }
    } else {
      console.log('(no title found, skipping)');
    }
    await new Promise(r => setTimeout(r, 300));
  }

  if (rl) rl.close();

  if (removals.size > 0) {
    index.items = index.items.filter(i => !removals.has(i.id));
  }

  fs.writeFileSync(filePath, JSON.stringify(index, null, 2));
  console.log(`\nResolved ${resolved} of ${toFix.length} title(s), removed ${removals.size}. Upload ${filePath} back to Drive.`);
}

main().catch(err => {
  console.error('\nFatal error:', err.message);
  process.exit(1);
});
