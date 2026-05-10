# Compounding Wiki — Plan A: Apps Script Full-Text Capture

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add full-text content capture to the Apps Script pipeline so every saved item writes a markdown file (YAML frontmatter + raw content) to a `/PKM/raw/` Drive folder, ready for the Linux server wiki compiler to sync and process.

**Architecture:** A new `RawStore.js` handles all Drive writes and source-specific content fetch in isolation. `WebApp.js` calls `writeRawItem()` with one added line after the existing save logic succeeds. `Config.js` gets one new constant. Failures in `writeRawItem` are logged and swallowed — the save flow is never blocked.

**Tech Stack:** Google Apps Script (V8), DriveApp, GmailApp, YouTube Advanced Service (already enabled), UrlFetchApp (already used in `Utils.js`).

---

## Note on Testing

Apps Script has no local test runner. Each task ends with `clasp push` and a manual run in the Apps Script editor (Executions tab shows logs). Commit after each manual test passes.

## Note on Scope

This is Plan A of two. Plan B (Linux server: Drive sync, wiki compiler, web app) is a separate plan. `Wiki.js` and `Synthesis.js` are deprecated by Plan B, not this plan — leave them in place for now.

---

## File Map

| File | Change |
|---|---|
| `Config.js` | Add `RAW_FOLDER_ID: 'RAW_FOLDER_ID'` to the `PROP` object |
| `RawStore.js` | Create: Drive folder management, source-specific content fetch, markdown assembly, Drive write, test helpers |
| `WebApp.js` | Add one `writeRawItem()` call inside `handleSaveConfirm` after `addItemToLibrary()` |

---

### Task 1: Add RAW_FOLDER_ID constant to Config.js

**Files:**
- Modify: `Config.js:8-24`

- [ ] **Step 1: Add the constant**

In `Config.js`, add `RAW_FOLDER_ID` as the last entry in the `PROP` object:

```javascript
const PROP = {
  GEMINI_API_KEY:        'GEMINI_API_KEY',
  GEMINI_MODEL:          'GEMINI_MODEL',
  YOUTUBE_PLAYLIST_ID:   'YOUTUBE_PLAYLIST_ID',
  TASKS_LIST_ID:         'TASKS_LIST_ID',
  GMAIL_LABEL:           'GMAIL_LABEL',
  DIGEST_EMAIL:          'DIGEST_EMAIL',
  WEBAPP_URL:            'WEBAPP_URL',
  SHEET_ID:              'SHEET_ID',
  DRIVE_ROOT_FOLDER:     'DRIVE_ROOT_FOLDER_ID',
  PROCESSED_IDS:         'PROCESSED_IDS',
  LIBRARY_INDEX_FILE_ID: 'LIBRARY_INDEX_FILE_ID',
  TOPIC_DOC_CACHE:       'TOPIC_DOC_CACHE',
  SYNTHESIS_DOC_ID:      'SYNTHESIS_DOC_ID',
  WIKI_FOLDER_ID:        'WIKI_FOLDER_ID',
  WIKI_INDEX_DOC_ID:     'WIKI_INDEX_DOC_ID',
  RAW_FOLDER_ID:         'RAW_FOLDER_ID',
};
```

- [ ] **Step 2: Commit**

```bash
git add Config.js
git commit -m "feat(raw-store): add RAW_FOLDER_ID constant to PROP"
```

---

### Task 2: Create RawStore.js — Drive folder and markdown helpers

**Files:**
- Create: `RawStore.js`

- [ ] **Step 1: Create the file with folder management and markdown helpers**

Create `RawStore.js` in the project root:

```javascript
/**
 * RawStore.js
 * Writes a full-text markdown file to /PKM/raw/ in Drive when an item is saved.
 * Called by WebApp.js handleSaveConfirm after the Doc write and library index
 * update succeed. Failures are logged and swallowed — the save flow is never
 * interrupted by a raw store error.
 *
 * Entry point: writeRawItem(item, summary, selectedTags)
 */

// ─── Drive Folder ──────────────────────────────────────────────────────────────

/**
 * Returns the Drive folder ID for /PKM/raw/, creating it if needed.
 * ID is cached in PROP.RAW_FOLDER_ID to avoid repeated Drive scans.
 *
 * @returns {string} Drive folder ID
 */
function getOrCreateRawFolder() {
  const props  = PropertiesService.getScriptProperties();
  const cached = props.getProperty(PROP.RAW_FOLDER_ID);
  if (cached) {
    try {
      DriveApp.getFolderById(cached);
      return cached;
    } catch (e) {
      Logger.log('RawStore: cached folder ID stale — rescanning Drive');
    }
  }
  const rootFolder = DriveApp.getFolderById(getProperty(PROP.DRIVE_ROOT_FOLDER));
  const existing   = rootFolder.getFoldersByName('raw');
  const folder     = existing.hasNext() ? existing.next() : rootFolder.createFolder('raw');
  props.setProperty(PROP.RAW_FOLDER_ID, folder.getId());
  Logger.log(`RawStore: raw folder ready (${folder.getId()})`);
  return folder.getId();
}

// ─── Markdown Helpers ──────────────────────────────────────────────────────────

/**
 * Converts a title to a URL-safe slug for use in filenames.
 * Lowercases, replaces non-alphanumeric runs with hyphens, trims leading/trailing
 * hyphens, caps at 60 characters.
 *
 * @param {string} title
 * @returns {string}
 */
function slugify(title) {
  return String(title)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
}

/**
 * Assembles the markdown file content: YAML frontmatter followed by the full
 * text body. If fullText is empty only the frontmatter block is written —
 * the wiki compiler will use shortSummary as its signal for that item.
 *
 * @param {Object}   item         - Row object from Sheets (itemId, title, url, dateAdded, sourceType)
 * @param {Object}   summary      - Parsed summaryJson (shortSummary, fullSummary)
 * @param {string[]} selectedTags - User-confirmed tags
 * @param {string}   fullText     - Raw content body (may be empty)
 * @returns {string} Complete markdown file content
 */
function buildRawMarkdown(item, summary, selectedTags, fullText) {
  const frontmatter = [
    '---',
    `id: ${String(item.itemId || '')}`,
    `title: ${JSON.stringify(String(item.title || ''))}`,
    `url: ${String(item.url || '')}`,
    `date: ${String(item.dateAdded || new Date().toISOString())}`,
    `sourceType: ${String(item.sourceType || '')}`,
    `tags: [${selectedTags.map(t => JSON.stringify(t)).join(', ')}]`,
    `shortSummary: ${JSON.stringify(String(summary.shortSummary || ''))}`,
    '---',
  ].join('\n');

  return fullText
    ? `${frontmatter}\n\n${fullText}`
    : frontmatter;
}
```

- [ ] **Step 2: Push and verify no syntax errors**

```bash
clasp push
```

In the Apps Script editor, open the script and confirm `RawStore.js` appears without errors in the file list. No function needs to run yet.

- [ ] **Step 3: Commit**

```bash
git add RawStore.js
git commit -m "feat(raw-store): scaffold RawStore.js with folder management and markdown helpers"
```

---

### Task 3: Add source-specific content fetch and main entry point to RawStore.js

**Files:**
- Modify: `RawStore.js` (append)

- [ ] **Step 1: Add Gmail and YouTube content fetch functions**

Append to `RawStore.js`:

```javascript
// ─── Source-Specific Content Fetch ────────────────────────────────────────────

/**
 * Fetches the full email body for a Gmail item.
 * Extracts the thread ID from the Gmail URL and re-fetches via GmailApp.
 * Returns an empty string on any failure.
 *
 * Gmail URL format stored on items:
 *   https://mail.google.com/mail/u/0/#inbox/{threadId}
 *
 * @param {string} url
 * @returns {string}
 */
function fetchGmailContent(url) {
  const match = String(url).match(/#[^/]+\/([a-f0-9]+)$/i);
  if (!match) {
    Logger.log(`RawStore: could not extract threadId from Gmail URL: ${url}`);
    return '';
  }
  try {
    const thread  = GmailApp.getThreadById(match[1]);
    const message = thread.getMessages()[0];
    // stripHtml() is defined in Utils.js
    return stripHtml(message.getBody()).slice(0, 50000);
  } catch (e) {
    Logger.log(`RawStore: Gmail body fetch failed — ${e.message}`);
    return '';
  }
}

/**
 * Fetches transcript or description text for a YouTube item.
 * First tries the YouTube timedtext API (works for most public videos with
 * auto-generated or uploaded captions). Falls back to the video description
 * via the YouTube Advanced Service if captions are unavailable.
 * Returns an empty string if both fail.
 *
 * @param {string} url - YouTube video URL (https://www.youtube.com/watch?v={videoId})
 * @returns {string}
 */
function fetchYouTubeContent(url) {
  const match = String(url).match(/[?&]v=([^&]+)/);
  if (!match) {
    Logger.log(`RawStore: could not extract videoId from YouTube URL: ${url}`);
    return '';
  }
  const videoId = match[1];

  // Attempt 1: timedtext API returns caption XML for most public videos
  try {
    const timedtextUrl = `https://www.youtube.com/api/timedtext?v=${videoId}&lang=en`;
    const response = UrlFetchApp.fetch(timedtextUrl, {
      muteHttpExceptions: true,
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; PKM-Bot/1.0)' },
    });
    if (response.getResponseCode() === 200) {
      const xml = response.getContentText();
      if (xml && xml.includes('<text')) {
        const transcript = xml
          .replace(/<[^>]*>/g, ' ')
          .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
          .replace(/&#39;/g, "'").replace(/&quot;/g, '"')
          .replace(/\s+/g, ' ')
          .trim();
        if (transcript) return transcript.slice(0, 50000);
      }
    }
  } catch (e) {
    Logger.log(`RawStore: YouTube timedtext fetch failed — ${e.message}`);
  }

  // Attempt 2: video description via YouTube Advanced Service
  try {
    const result = YouTube.Videos.list('snippet', { id: videoId });
    const video  = (result.items || [])[0];
    if (video && video.snippet) {
      return [video.snippet.title, video.snippet.description]
        .filter(Boolean).join('\n\n').slice(0, 50000);
    }
  } catch (e) {
    Logger.log(`RawStore: YouTube description fetch failed — ${e.message}`);
  }

  return '';
}
```

- [ ] **Step 2: Add content dispatch, writeRawItem, and test helpers**

Append to `RawStore.js`:

```javascript
/**
 * Dispatches to the correct content fetch function based on item.sourceType.
 *
 * - Gmail:   re-fetches email body via GmailApp using threadId from URL
 * - YouTube: tries transcript, falls back to description
 * - Tasks:   fetches the web page body when item.url is a real URL;
 *            falls back to summary.fullSummary for plain tasks (tasks.google.com URL)
 * - Capture: uses summary.fullSummary — content was user-supplied at capture time,
 *            avoids re-fetching paywalled content
 *
 * fetchUrlContent() is defined in Utils.js (50,000-char cap, handles failures).
 *
 * @param {Object} item    - Row object from Sheets
 * @param {Object} summary - Parsed summaryJson
 * @returns {string}
 */
function buildFullText(item, summary) {
  switch (item.sourceType) {
    case SOURCE.GMAIL:
      return fetchGmailContent(item.url);

    case SOURCE.YOUTUBE:
      return fetchYouTubeContent(item.url);

    case SOURCE.TASKS: {
      const url      = String(item.url || '');
      const isWebUrl = url.startsWith('http') && !url.includes('tasks.google.com');
      return isWebUrl ? fetchUrlContent(url) : (summary.fullSummary || '');
    }

    case SOURCE.CAPTURE:
      return summary.fullSummary || '';

    default:
      return '';
  }
}

/**
 * Writes a full-text markdown file for a saved item to the /PKM/raw/ Drive folder.
 * Non-fatal: all errors are logged and swallowed so the save confirmation page
 * is never blocked.
 *
 * File name format: {itemId}-{title-slug}.md
 *
 * @param {Object}   item         - Row object from Sheets (itemId, title, url, dateAdded, sourceType)
 * @param {Object}   summary      - Parsed summaryJson (shortSummary, fullSummary)
 * @param {string[]} selectedTags - User-confirmed tags
 */
function writeRawItem(item, summary, selectedTags) {
  try {
    const folderId = getOrCreateRawFolder();
    const folder   = DriveApp.getFolderById(folderId);
    const fullText = buildFullText(item, summary);
    const markdown = buildRawMarkdown(item, summary, selectedTags, fullText);
    const filename = item.itemId + '-' + slugify(item.title) + '.md';
    folder.createFile(filename, markdown, MimeType.PLAIN_TEXT);
    Logger.log(`RawStore: wrote "${filename}" (${markdown.length} chars, body: ${fullText.length} chars)`);
  } catch (e) {
    Logger.log(`RawStore: failed for item "${item.itemId}" — ${e.message}`);
  }
}

// ─── Test Helpers (run manually from Apps Script editor) ───────────────────────

/**
 * Smoke test: creates (or finds) the /PKM/raw/ folder and logs its Drive ID.
 * Run this first to verify Drive access before testing the full pipeline.
 */
function testRawStoreSetup() {
  const folderId = getOrCreateRawFolder();
  Logger.log(`testRawStoreSetup: raw folder ID = ${folderId}`);
  Logger.log('testRawStoreSetup: Drive access OK');
}

/**
 * End-to-end test: takes the most recent row from the Archive tab and writes
 * its raw markdown to /PKM/raw/. Open Drive → PKM → raw/ after running to
 * verify the file was created with valid frontmatter and body content.
 *
 * Uses real quota — only run when saved items exist in the Archive tab.
 */
function testWriteRawItem() {
  const archiveSheet = getSheet(TABS.ARCHIVE);
  const data = archiveSheet.getDataRange().getValues();
  if (data.length < 2) {
    Logger.log('testWriteRawItem: no rows in Archive tab — save an item first');
    return;
  }
  const row = data[data.length - 1]; // most recently saved row

  const item = {
    itemId:     String(row[COL.ITEM_ID     - 1] || ''),
    dateAdded:  String(row[COL.DATE_ADDED  - 1] || ''),
    sourceType: String(row[COL.SOURCE_TYPE - 1] || ''),
    title:      String(row[COL.TITLE       - 1] || ''),
    url:        String(row[COL.URL         - 1] || ''),
  };

  let summary = { shortSummary: '', fullSummary: '' };
  try { summary = JSON.parse(row[COL.SUMMARY_JSON - 1]); } catch (_) {}

  const selectedTags = String(row[COL.TAGS - 1] || '')
    .split(',').map(t => t.trim()).filter(Boolean);

  Logger.log(`testWriteRawItem: testing "${item.title}" (${item.sourceType})`);
  writeRawItem(item, summary, selectedTags);
  Logger.log('testWriteRawItem: done — open Drive → PKM → raw/ to verify');
}
```

- [ ] **Step 3: Push to Apps Script**

```bash
clasp push
```

- [ ] **Step 4: Run smoke test**

In the Apps Script editor, run `testRawStoreSetup`.

Expected log output:
```
RawStore: raw folder ready ([drive-folder-id])
testRawStoreSetup: raw folder ID = [drive-folder-id]
testRawStoreSetup: Drive access OK
```

If you see a "Missing script property" error, verify `DRIVE_ROOT_FOLDER_ID` is set in Project Settings → Script Properties.

- [ ] **Step 5: Run end-to-end test**

Run `testWriteRawItem` in the Apps Script editor.

Expected log output:
```
testWriteRawItem: testing "[title]" ([sourceType])
RawStore: wrote "[itemId]-[slug].md" ([N] chars, body: [M] chars)
testWriteRawItem: done — open Drive → PKM → raw/ to verify
```

Open Drive → PKM → raw/. Confirm:
1. A `.md` file exists for the tested item
2. The file opens and shows valid YAML frontmatter (id, title, url, date, sourceType, tags, shortSummary)
3. For Gmail/YouTube/Tasks-with-URL items: body text appears below the `---` separator
4. For plain Tasks or Capture items: only frontmatter (body intentionally empty is fine)

- [ ] **Step 6: Commit**

```bash
git add RawStore.js
git commit -m "feat(raw-store): add source-specific content fetch and writeRawItem entry point"
```

---

### Task 4: Wire writeRawItem into WebApp.js handleSaveConfirm

**Files:**
- Modify: `WebApp.js:1090-1093`

- [ ] **Step 1: Add the writeRawItem call**

In `WebApp.js`, `handleSaveConfirm` currently reads:

```javascript
    const docLink = saveItemToDoc(item, summary, selectedTags);
    addItemToLibrary(item, summary, selectedTags, docLink);
    updateItemStatusAndDocLink(itemId, STATUS.SAVED, docLink);
```

Change to:

```javascript
    const docLink = saveItemToDoc(item, summary, selectedTags);
    addItemToLibrary(item, summary, selectedTags, docLink);
    updateItemStatusAndDocLink(itemId, STATUS.SAVED, docLink);
    writeRawItem(item, summary, selectedTags);
```

- [ ] **Step 2: Push**

```bash
clasp push
```

- [ ] **Step 3: End-to-end test through the web app**

Open your deployed WEBAPP_URL. Find a Pending item. Click "Save to PKM", select at least one topic tag, and confirm the save. Verify:
1. The confirmation page shows "Saved to: [tag]" as before — no change in user experience
2. Open Drive → PKM → raw/ and confirm a new `.md` file appeared for the just-saved item
3. Check the Apps Script execution log (Executions tab) and confirm a line like:
   ```
   RawStore: wrote "[itemId]-[slug].md" ([N] chars, body: [M] chars)
   ```

- [ ] **Step 4: Commit**

```bash
git add WebApp.js
git commit -m "feat(raw-store): call writeRawItem on item save in handleSaveConfirm"
```

---

## Self-Review Checklist

### Spec coverage
- [x] Gmail full-text: `fetchGmailContent` extracts threadId from URL, fetches body via `GmailApp`
- [x] YouTube transcript: `fetchYouTubeContent` tries timedtext API, falls back to description
- [x] Tasks with web URL: `buildFullText` calls `fetchUrlContent(url)` (existing Utils.js function)
- [x] Tasks plain (no URL): falls back to `summary.fullSummary`
- [x] Capture items: uses `summary.fullSummary` (avoids re-fetching paywalled content)
- [x] Markdown frontmatter: `buildRawMarkdown` produces YAML with id, title, url, date, sourceType, tags, shortSummary
- [x] Drive folder `/PKM/raw/`: `getOrCreateRawFolder` mirrors existing Wiki.js folder pattern
- [x] Non-fatal writes: `writeRawItem` is fully wrapped in try/catch
- [x] No breakage to save flow: `writeRawItem` called last, after all existing operations succeed
- [x] Config constant: `PROP.RAW_FOLDER_ID` added in Task 1

### Type consistency
- `writeRawItem(item, summary, selectedTags)` — same signature used in Tasks 3 and 4
- `buildRawMarkdown(item, summary, selectedTags, fullText)` — consistent
- `buildFullText(item, summary)` — consistent
- `getOrCreateRawFolder()` — no arguments, returns string folder ID
- `fetchGmailContent(url)` / `fetchYouTubeContent(url)` — both take a URL string, return string
