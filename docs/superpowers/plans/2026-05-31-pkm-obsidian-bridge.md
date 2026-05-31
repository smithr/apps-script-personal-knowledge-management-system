# PKM → Obsidian Bridge Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Bridge the existing Google Apps Script PKM pipeline to a claude-obsidian Obsidian vault by implementing `RawStore.js` (writes approved items as markdown to Drive), a one-time backfill script for existing library items, and deprecating the now-redundant wiki/synthesis triggers.

**Architecture:** `WebApp.js:handleSaveConfirm` already calls `writeRawItem(item, summary, selectedTags)` at line 1093 — `RawStore.js` just needs to exist. It fetches full content per source type (YouTube transcript via `ytInitialPlayerResponse`, Gmail via stored summary, Tasks via URL fetch) then writes a frontmatter markdown file to Drive `/PKM/raw/`. Google Drive for Desktop (Windows) syncs that folder into the Obsidian vault's `.raw/` directory. A separate Python backfill script converts the existing `pkm-library-index.json` items directly into vault `.raw/` files. Two unused trigger wrappers (`runWeeklySynthesis`, `runWeeklyWiki`) are removed from `Code.js`.

**Tech Stack:** Google Apps Script (existing), DriveApp, UrlFetchApp, Python 3.11+, trafilatura, clasp

---

## File Structure

```
RawStore.js                          ← NEW: Drive write + per-source content capture
Code.js                              ← MODIFY: remove runWeeklySynthesis + runWeeklyWiki
backfill/
  backfill.py                        ← NEW: one-time library-index → .raw/ converter
  requirements.txt                   ← NEW: trafilatura only
```

---

## Task 1: RawStore.js — Core Drive write and YouTube transcript

**Files:**
- Create: `RawStore.js`

The `writeRawItem(item, summary, selectedTags)` function is the only public entry point. The `item` object is a Sheets row with fields `itemId`, `title`, `url`, `sourceType`, `dateAdded`, `tags` (comma-separated string), `summaryJson`. The `summary` object is the parsed Gemini JSON with `shortSummary`, `fullSummary`, `tags`. `selectedTags` is a string array of the user's confirmed tag choices.

The raw folder is found-or-created as the `raw` subfolder of `DRIVE_ROOT_FOLDER_ID`. Writes are idempotent: if the filename already exists in the folder, the write is skipped.

- [ ] **Step 1: Create `RawStore.js` with the Drive write skeleton**

```javascript
// RawStore.js
// Writes approved PKM items as markdown to Drive /PKM/raw/ for Obsidian ingest.

function writeRawItem(item, summary, selectedTags) {
  try {
    const folder   = _rawGetOrCreateFolder();
    const slug     = _rawSlugify(item.title || '');
    const filename = `${item.itemId}-${slug}.md`;

    const existing = folder.getFilesByName(filename);
    if (existing.hasNext()) {
      Logger.log(`RawStore: ${filename} already exists — skipping`);
      return;
    }

    const body    = _rawFetchContent(item, summary);
    const content = _rawBuildMarkdown(item, summary, selectedTags, body);
    folder.createFile(filename, content, MimeType.PLAIN_TEXT);
    Logger.log(`RawStore: wrote ${filename} (${content.length} chars)`);
  } catch (e) {
    Logger.log(`RawStore: failed for item ${item.itemId} — ${e.message}`);
    // Do not rethrow: raw store failure must not break the save confirmation page
  }
}

function _rawGetOrCreateFolder() {
  const rootId = PropertiesService.getScriptProperties().getProperty('DRIVE_ROOT_FOLDER_ID');
  const root   = DriveApp.getFolderById(rootId);
  const iter   = root.getFoldersByName('raw');
  return iter.hasNext() ? iter.next() : root.createFolder('raw');
}

function _rawSlugify(text) {
  return String(text)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .substring(0, 60);
}

function _rawBuildMarkdown(item, summary, selectedTags, body) {
  const tags         = JSON.stringify(selectedTags || []);
  const shortSummary = JSON.stringify((summary && summary.shortSummary) || '');
  return [
    '---',
    `id: ${item.itemId}`,
    `title: ${JSON.stringify(item.title || '')}`,
    `url: ${item.url || ''}`,
    `date: ${item.dateAdded || new Date().toISOString()}`,
    `sourceType: ${item.sourceType || ''}`,
    `tags: ${tags}`,
    `shortSummary: ${shortSummary}`,
    '---',
    '',
    body || '',
  ].join('\n').trim();
}

function _rawFetchContent(item, summary) {
  const fallback    = (summary && summary.shortSummary) || '';
  const sourceType  = (item.sourceType || '').toLowerCase();

  if (sourceType === 'youtube') {
    return _rawYouTubeTranscript(item.url) || fallback;
  }
  if (sourceType === 'gmail') {
    // fullSummary is the best content available without re-fetching the thread
    return (summary && summary.fullSummary) || fallback;
  }
  if (sourceType === 'tasks' || sourceType === 'capture') {
    if (item.url && item.url.startsWith('http') && !item.url.includes('mail.google.com')) {
      return _rawFetchUrlText(item.url) || (summary && summary.fullSummary) || fallback;
    }
    return (summary && summary.fullSummary) || fallback;
  }
  return fallback;
}
```

- [ ] **Step 2: Add the YouTube transcript extractor**

Append to `RawStore.js`:

```javascript
function _rawYouTubeTranscript(videoUrl) {
  try {
    const videoId = _rawExtractVideoId(videoUrl);
    if (!videoId) return null;

    const pageResp = UrlFetchApp.fetch(
      `https://www.youtube.com/watch?v=${videoId}`,
      { muteHttpExceptions: true, headers: { 'Accept-Language': 'en-US,en;q=0.9' } }
    );
    if (pageResp.getResponseCode() !== 200) return null;

    const html       = pageResp.getContentText();
    const startMarker = 'ytInitialPlayerResponse=';
    const startIdx   = html.indexOf(startMarker);
    if (startIdx === -1) return null;

    // Walk braces to find the end of the JSON object (more reliable than regex on large pages)
    const jsonStr = html.substring(startIdx + startMarker.length, startIdx + startMarker.length + 600000);
    let depth = 0;
    let endIdx = 0;
    for (let i = 0; i < jsonStr.length; i++) {
      if      (jsonStr[i] === '{') depth++;
      else if (jsonStr[i] === '}') { depth--; if (depth === 0) { endIdx = i + 1; break; } }
    }
    if (!endIdx) return null;

    let playerResponse;
    try { playerResponse = JSON.parse(jsonStr.substring(0, endIdx)); }
    catch (_) { return null; }

    const captionTracks = (
      playerResponse
      && playerResponse.captions
      && playerResponse.captions.playerCaptionsTracklistRenderer
      && playerResponse.captions.playerCaptionsTracklistRenderer.captionTracks
    );
    if (!captionTracks || captionTracks.length === 0) return null;

    // Prefer English; fall back to first available track
    const track = captionTracks.find(t =>
      t.languageCode === 'en'
      || (t.name && t.name.simpleText && t.name.simpleText.includes('English'))
    ) || captionTracks[0];

    if (!track.baseUrl) return null;

    const captionResp = UrlFetchApp.fetch(track.baseUrl, { muteHttpExceptions: true });
    if (captionResp.getResponseCode() !== 200) return null;

    const xml   = captionResp.getContentText();
    const lines = [];
    let   m;
    const re = /<text[^>]*>([\s\S]*?)<\/text>/g;
    while ((m = re.exec(xml)) !== null) {
      const line = m[1]
        .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"').replace(/&#39;/g, "'")
        .replace(/<[^>]+>/g, '').trim();
      if (line) lines.push(line);
    }
    return lines.join(' ').substring(0, 100000) || null;
  } catch (e) {
    Logger.log(`RawStore: YouTube transcript failed for ${videoUrl}: ${e.message}`);
    return null;
  }
}

function _rawExtractVideoId(url) {
  const m = (url || '').match(/[?&]v=([^&]+)/);
  return m ? m[1] : null;
}

function _rawFetchUrlText(url) {
  try {
    const resp = UrlFetchApp.fetch(url, { muteHttpExceptions: true, followRedirects: true });
    if (resp.getResponseCode() !== 200) return null;
    return stripHtml(resp.getContentText()).substring(0, 100000) || null;
  } catch (e) {
    Logger.log(`RawStore: URL fetch failed for ${url}: ${e.message}`);
    return null;
  }
}
```

- [ ] **Step 3: Add manual test helpers**

Append to `RawStore.js`:

```javascript
// ─── Manual test helpers — run from Apps Script editor, then delete test files ──

function testRawStore_YouTube() {
  // Replace with a real video from your playlist that has captions
  const item = {
    itemId:     'test-yt-001',
    title:      'Test YouTube Video',
    url:        'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
    sourceType: 'YouTube',
    dateAdded:  new Date().toISOString(),
  };
  const summary = { shortSummary: 'Fallback summary', fullSummary: 'Full fallback' };
  writeRawItem(item, summary, ['test']);
  Logger.log('Check Drive PKM/raw/ for test-yt-001-*.md — should contain transcript text, not just the fallback');
}

function testRawStore_Gmail() {
  const item = {
    itemId:     'test-gmail-001',
    title:      'Test Gmail Thread',
    url:        'https://mail.google.com/mail/u/0/#inbox/abc123',
    sourceType: 'Gmail',
    dateAdded:  new Date().toISOString(),
  };
  const summary = { shortSummary: 'Gmail short summary', fullSummary: 'Gmail full summary body used as content.' };
  writeRawItem(item, summary, ['test']);
  Logger.log('Check Drive PKM/raw/ for test-gmail-001-*.md — body should be the fullSummary text');
}

function testRawStore_Task() {
  const item = {
    itemId:     'test-task-001',
    title:      'Test Task with URL',
    url:        'https://example.com',
    sourceType: 'Tasks',
    dateAdded:  new Date().toISOString(),
  };
  const summary = { shortSummary: 'Task short summary', fullSummary: 'Task full summary' };
  writeRawItem(item, summary, ['test']);
  Logger.log('Check Drive PKM/raw/ for test-task-001-*.md');
}

function cleanupTestRawFiles() {
  const folder = _rawGetOrCreateFolder();
  const files  = folder.getFiles();
  while (files.hasNext()) {
    const f = files.next();
    if (f.getName().startsWith('test-')) {
      f.setTrashed(true);
      Logger.log(`Cleaned up: ${f.getName()}`);
    }
  }
}
```

- [ ] **Step 4: Push to Apps Script**

```bash
clasp push
```

Expected: `Pushed N files.` with no errors.

- [ ] **Step 5: Run YouTube test in editor**

In the Apps Script editor: select `testRawStore_YouTube` → Run.

Expected output in Execution log:
```
RawStore: wrote test-yt-001-test-youtube-video.md (NNNN chars)
Check Drive PKM/raw/ for test-yt-001-*.md — should contain transcript text, not just the fallback
```

Open Drive → your PKM root folder → `raw/`. Open the file. The body should contain transcript text (many sentences), not just the `shortSummary` fallback string.

If the body contains only the fallback, the transcript fetch failed silently — check the Execution log for `RawStore: YouTube transcript failed` to diagnose.

- [ ] **Step 6: Run Gmail and Task tests**

In the editor: run `testRawStore_Gmail`, then `testRawStore_Task`.

Expected: both files appear in Drive `PKM/raw/`. Open each and verify the frontmatter fields (`id`, `title`, `url`, `date`, `sourceType`, `tags`, `shortSummary`) are all populated and the body is non-empty.

- [ ] **Step 7: Run cleanup, then commit**

In the editor: run `cleanupTestRawFiles`. Confirm the three test files are removed from Drive.

```bash
git add RawStore.js
git commit -m "feat(RawStore): write approved items as markdown to Drive /PKM/raw/"
```

---

## Task 2: End-to-end live save test

**Files:**
- No changes — verifies WebApp.js:1093 wires through correctly to RawStore.js

- [ ] **Step 1: Find a pending item in your Sheets Inbox**

Open your PKM spreadsheet → Inbox tab. Note the `itemId` of any Pending row.

- [ ] **Step 2: Trigger a save via the web app**

Open `WEBAPP_URL?id=<itemId>&action=save`, select a tag, click Save.

- [ ] **Step 3: Verify the raw file was written**

Open Drive → PKM root → `raw/`. A file named `<itemId>-<slug>.md` should have appeared.

Open it and confirm:
- Frontmatter has `id`, `title`, `url`, `date`, `sourceType`, `tags`, `shortSummary`
- Body is populated (not empty, unless it's a Gmail item with no fullSummary)
- YouTube items have transcript text

Expected in Execution log (Apps Script editor → Executions):
```
RawStore: wrote <itemId>-<slug>.md (NNNN chars)
```

If you see `RawStore: failed for item <id>` instead, open the execution record and read the error message.

---

## Task 3: Deprecate wiki and synthesis triggers

**Files:**
- Modify: `Code.js` (remove lines 52–75)
- Modify: `Wiki.js` (add deprecation header)
- Modify: `Synthesis.js` (add deprecation header)

- [ ] **Step 1: Remove trigger wrappers from `Code.js`**

Delete these two functions from `Code.js` (lines 52–75):

```javascript
// DELETE THIS ENTIRE BLOCK:
/**
 * Weekly synthesis trigger (once per week, Sunday evening).
 * ...
 */
function runWeeklySynthesis() {
  try {
    runWeeklySynthesisInternal();
  } catch (e) {
    Logger.log(`Weekly synthesis error: ${e.message}`);
  }
}

/**
 * Weekly wiki rebuild trigger (once per week, Sunday night).
 * ...
 */
function runWeeklyWiki() {
  try {
    buildWiki();
  } catch (e) {
    Logger.log(`Weekly wiki error: ${e.message}`);
  }
}
```

- [ ] **Step 2: Add deprecation notice to the top of `Wiki.js`**

Open `Wiki.js`. Insert at the very top of the file (before the first line):

```javascript
// DEPRECATED: replaced by claude-obsidian /wiki-ingest skill.
// Triggers removed. File kept for reference; delete once the Obsidian vault is stable.
```

- [ ] **Step 3: Add deprecation notice to the top of `Synthesis.js`**

Open `Synthesis.js`. Insert at the very top of the file:

```javascript
// DEPRECATED: replaced by claude-obsidian /wiki-query and /autoresearch skills.
// Triggers removed. File kept for reference; delete once the Obsidian vault is stable.
```

- [ ] **Step 4: Remove the trigger registrations in the Apps Script editor**

In the Apps Script editor: click the clock icon (Triggers) in the left sidebar.

Delete any existing time-based triggers for:
- `runWeeklySynthesis`
- `runWeeklyWiki`
- `sendWeeklyDigest` (in Digest.js — no longer needed)

Leave all other triggers intact (`runFrequentPipeline`, `runHourlyPipeline`, `sendDigest`).

- [ ] **Step 5: Push and commit**

```bash
clasp push
git add Code.js Wiki.js Synthesis.js
git commit -m "deprecate: remove wiki/synthesis triggers, replaced by claude-obsidian"
```

---

## Task 4: Backfill script

**Files:**
- Create: `backfill/requirements.txt`
- Create: `backfill/backfill.py`

The backfill script reads `pkm-library-index.json` and writes one markdown file per item into the vault's `.raw/` directory. YouTube and Gmail items fall back to `shortSummary` (trafilatura cannot handle them). Web/task URLs are fetched via trafilatura. Existing files are skipped (idempotent).

The `pkm-library-index.json` format uses `id` (UUID), `title`, `url`, `date`, `sourceType`, `shortSummary`, `tags` (array).

- [ ] **Step 1: Create `backfill/requirements.txt`**

```
trafilatura==1.12.0
```

- [ ] **Step 2: Install**

```bash
pip install -r backfill/requirements.txt
```

Expected: `Successfully installed trafilatura-1.12.0` (or already satisfied).

- [ ] **Step 3: Create `backfill/backfill.py`**

```python
#!/usr/bin/env python3
"""
One-time backfill: converts pkm-library-index.json into .raw/ markdown files
for the Obsidian vault's claude-obsidian ingest directory.

Usage:
  python backfill/backfill.py <path-to-pkm-library-index.json> <path-to-vault/.raw>

Example (WSL2 → Windows vault):
  python backfill/backfill.py pkm-library-index.json \
    "/mnt/c/Users/rsmith/Documents/Obsidian/vault/.raw"
"""
import json
import re
import sys
import time
from pathlib import Path

import trafilatura


def slugify(text: str) -> str:
    return re.sub(r'[^a-z0-9]+', '-', str(text).lower()).strip('-')[:60]


def fetch_content(url: str, source_type: str, short_summary: str) -> str:
    source_lower = source_type.lower()

    # YouTube and Gmail: cannot re-fetch — use stored summary
    if source_lower in ('youtube', 'gmail'):
        return short_summary

    if not url or not url.startswith('http'):
        return short_summary

    try:
        downloaded = trafilatura.fetch_url(url)
        if downloaded:
            text = trafilatura.extract(downloaded)
            if text:
                return text[:100000]
    except Exception as e:
        print(f"    trafilatura failed: {e}")

    return short_summary


def build_markdown(item: dict, body: str) -> str:
    tags          = json.dumps(item.get('tags', []))
    short_summary = json.dumps(item.get('shortSummary', ''))
    return '\n'.join([
        '---',
        f"id: {item['id']}",
        f"title: {json.dumps(item.get('title', ''))}",
        f"url: {item.get('url', '')}",
        f"date: {item.get('date', '')}",
        f"sourceType: {item.get('sourceType', '')}",
        f"tags: {tags}",
        f"shortSummary: {short_summary}",
        '---',
        '',
        body,
    ]).strip()


def run_backfill(library_path: Path, raw_dir: Path, delay: float = 1.0) -> None:
    data  = json.loads(library_path.read_text(encoding='utf-8'))
    items = data.get('items', [])
    print(f"Backfill: {len(items)} items → {raw_dir}")
    raw_dir.mkdir(parents=True, exist_ok=True)

    written = skipped = failed = 0

    for i, item in enumerate(items):
        item_id  = item.get('id', f'item-{i}')
        title    = item.get('title', '')
        filename = f"{item_id}-{slugify(title)}.md"
        dest     = raw_dir / filename

        if dest.exists():
            print(f"  [{i+1}/{len(items)}] skip (exists): {filename}")
            skipped += 1
            continue

        print(f"  [{i+1}/{len(items)}] {title[:70]}")

        try:
            body    = fetch_content(item.get('url', ''), item.get('sourceType', ''), item.get('shortSummary', ''))
            content = build_markdown(item, body)
            dest.write_text(content, encoding='utf-8')
            written += 1
            print(f"    wrote {filename} ({len(content)} chars)")
        except Exception as e:
            print(f"    ERROR: {e}")
            failed += 1

        if delay:
            time.sleep(delay)

    print(f"\nDone: {written} written, {skipped} skipped, {failed} failed")


if __name__ == '__main__':
    if len(sys.argv) < 3:
        print(__doc__)
        sys.exit(1)

    library_path = Path(sys.argv[1])
    raw_dir      = Path(sys.argv[2])

    if not library_path.exists():
        print(f"Error: {library_path} not found")
        sys.exit(1)

    run_backfill(library_path, raw_dir)
```

- [ ] **Step 4: Dry-run against a temp directory to verify file format**

```bash
mkdir -p /tmp/pkm-raw-test
python backfill/backfill.py pkm-library-index.json /tmp/pkm-raw-test
```

Expected output (abbreviated):
```
Backfill: N items → /tmp/pkm-raw-test
  [1/N] Just build the tools yourself
    wrote 9a7e250d-...-just-build-the-tools-yourself.md (NNN chars)
  [2/N] What Are Agent Skills Really About?
    wrote d0ac292f-...-what-are-agent-skills-really-about.md (NNN chars)
  ...
Done: N written, 0 skipped, 0 failed
```

- [ ] **Step 5: Spot-check two output files**

```bash
head -15 /tmp/pkm-raw-test/9a7e250d-*.md
```

Expected: frontmatter block with all fields populated, body is the `shortSummary` for Gmail items.

```bash
head -15 /tmp/pkm-raw-test/d0ac292f-*.md
```

Expected: YouTube item has `sourceType: YouTube` and body is the `shortSummary` (not empty).

Pick any Tasks or Capture item and open it — body should have fetched text rather than just the short summary (if trafilatura could reach the URL).

- [ ] **Step 6: Commit**

```bash
git add backfill/
git commit -m "feat(backfill): one-time script to populate vault .raw/ from library index"
```

---

## Task 5: Run the live backfill into your Obsidian vault

This task runs once. The vault's `.raw/` directory must exist before running.

- [ ] **Step 1: Create the `.raw/` directory in your Obsidian vault if it doesn't exist**

In Windows Explorer (or WSL2): create a folder named `.raw` inside your Obsidian vault root.

WSL2 path will be something like: `/mnt/c/Users/rsmith/Documents/Obsidian/<vault-name>/.raw`

- [ ] **Step 2: Run the backfill**

Replace the vault path with your actual path:

```bash
python backfill/backfill.py pkm-library-index.json \
  "/mnt/c/Users/rsmith/Documents/Obsidian/<vault-name>/.raw"
```

Expected: all N items written. Failed items (paywalled or dead URLs) will show `ERROR` — that's acceptable, they'll have the `shortSummary` as their body.

- [ ] **Step 3: Verify file count in the vault**

```bash
ls "/mnt/c/Users/rsmith/Documents/Obsidian/<vault-name>/.raw" | wc -l
```

Expected: same count as items in `pkm-library-index.json`.

---

## Task 6: Setup — Drive for Desktop sync and claude-obsidian

These are configuration steps, not code changes.

- [ ] **Step 1: Install Google Drive for Desktop on Windows (if not already installed)**

Download from: `drive.google.com/drive/download`

Sign in with the same Google account that owns your Apps Script project.

- [ ] **Step 2: Find the Drive /PKM/raw/ folder path on Windows**

After Drive for Desktop syncs, the PKM root folder will appear in Windows Explorer under `Google Drive > My Drive`. Navigate to your PKM root folder → `raw/`.

Note the full Windows path (e.g., `C:\Users\rsmith\Google Drive\My Drive\PKM\raw`).

- [ ] **Step 3: Create a junction (symlink) from vault `.raw/` to the Drive-synced folder**

Open an elevated PowerShell prompt on Windows. Replace paths with your actual paths:

```powershell
# Remove the empty .raw dir you created in Task 5 Step 1 first, then:
cmd /c mklink /J "C:\Users\rsmith\Documents\Obsidian\<vault-name>\.raw" "C:\Users\rsmith\Google Drive\My Drive\PKM\raw"
```

After this, vault `.raw/` and Drive `PKM/raw/` are the same folder. Files written by Apps Script appear in the vault immediately after Drive for Desktop syncs them (typically within seconds to a minute).

Alternative if junction fails: skip the junction and just point claude-obsidian's `.raw/` config at the Drive-synced folder path directly (check claude-obsidian's `bin/setup-vault.sh` for the configuration key).

- [ ] **Step 4: Install and configure claude-obsidian**

Follow the claude-obsidian installation instructions from the plugin marketplace or its README:
- Install the superpowers plugin via `superpowers install claude-obsidian` (or the equivalent marketplace step)
- Run `bin/setup-vault.sh` and point it at your Obsidian vault root

The vault root is the folder that contains `.raw/`, `wiki/`, and `principles/` directories.

- [ ] **Step 5: Run the initial wiki build**

Open a Claude Code session in your Obsidian vault directory (or with the vault root configured):

```
/wiki-ingest
```

This processes all `.raw/` files from the backfill into the wiki. For ~200 items this may take several minutes (one Gemini call per topic group, plus a cross-topic pass).

Expected: `wiki/topics/`, `wiki/entities/`, `wiki/concepts/`, `wiki/index.md` populated. Check Obsidian's graph view — you should see a connected graph of entity nodes.

- [ ] **Step 6: Verify the live pipeline end-to-end**

Save a new item through the WebApp triage flow (any source). Wait for Drive for Desktop to sync (watch the Drive icon in the system tray — it'll show syncing then idle).

Open Obsidian → `.raw/` — the new file should appear.

Run `/wiki-ingest` again — the new item should be integrated into the relevant topic article.

---

## Self-Review

**Spec coverage:**
- ✅ `RawStore.js` with per-source content capture (Task 1)
- ✅ YouTube transcript via `ytInitialPlayerResponse` (Task 1 Step 2)
- ✅ Gmail uses `fullSummary` (best available without pipeline change) (Task 1 Step 1)
- ✅ Tasks/web URLs fetched via `UrlFetchApp` + `stripHtml` (Task 1 Step 2)
- ✅ Graceful degradation to `shortSummary` on all failure paths (Task 1)
- ✅ Idempotent writes (Task 1 Step 1)
- ✅ `writeRawItem` call already in `WebApp.js:1093` — no WebApp change needed
- ✅ `Wiki.js` and `Synthesis.js` deprecated (Task 3)
- ✅ `sendWeeklyDigest` trigger removed (Task 3 Step 4)
- ✅ `runWeeklySynthesis` and `runWeeklyWiki` removed from `Code.js` (Task 3 Step 1)
- ✅ Backfill script with trafilatura (Task 4)
- ✅ YouTube/Gmail backfill falls back to `shortSummary` (Task 4 Step 3)
- ✅ Drive for Desktop sync setup (Task 6)
- ✅ claude-obsidian install and initial wiki build (Task 6)

**Placeholder scan:** No TBDs. All code is complete and all commands have expected outputs.

**Type consistency:**
- `writeRawItem(item, summary, selectedTags)` — matches existing call at `WebApp.js:1093`
- `item.itemId` — consistent with `buildInboxItemCard` usage throughout `WebApp.js`
- `item.dateAdded` — consistent with Sheets row structure observed in `WebApp.js`
- `summary.shortSummary`, `summary.fullSummary` — consistent with Gemini JSON structure in `handleSaveConfirm`
- `_rawGetOrCreateFolder`, `_rawSlugify`, `_rawBuildMarkdown`, `_rawFetchContent`, `_rawYouTubeTranscript`, `_rawExtractVideoId`, `_rawFetchUrlText` — all internal helpers prefixed `_raw` to avoid naming collisions; consistent throughout
- `stripHtml` in `_rawFetchUrlText` — defined in `Utils.js`, available globally in Apps Script
