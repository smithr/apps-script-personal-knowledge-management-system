# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

A multi-file Google Apps Script PKM (Personal Knowledge Management) system. Monitors YouTube playlists, Gmail labels, and Google Tasks; summarizes new content with the Gemini API; delivers a digest email for triage; and commits approved items to structured Google Docs in Drive (queryable via NotebookLM).

## Deployment Workflow (clasp)

This project uses [clasp](https://github.com/google/clasp) to sync local files with Google Apps Script. The script runs in the cloud; there is no local execution.

```bash
# Push local changes to Apps Script
clasp push

# Pull current remote state
clasp pull

# Open the script in the browser
clasp open
```

`.clasp.json` links this directory to the remote Apps Script project and is excluded from git (`.gitignore`).

## Architecture

Multi-file Apps Script project. Each file has a single responsibility:

| File | Responsibility |
|---|---|
| `Code.js` | Trigger entry points (`runFrequentPipeline`, `runDailyPipeline`, `sendDigest`) |
| `Config.js` | Constants (PROP, TABS, COL, STATUS, SOURCE), Script Property accessors, deduplication store. `COL.SUMMARY_JSON` (col 11) stores the full Gemini JSON blob. |
| `Utils.js` | `generateId`, `getCurrentTimestamp`, `escapeHtml`, `stripHtml`, `normalizeItem` |
| `YouTube.js` | YouTube playlist connector (`runYouTubePipeline`, `fetchPlaylistVideos`) |
| `Gmail.js` | Gmail label connector (`runGmailPipeline`, `fetchLabeledMessages`) |
| `Tasks.js` | Google Tasks connector (`runTasksPipeline`, `fetchPendingTasks`, `completeTask`) |
| `Gemini.js` | Summarization engine; prompt templates per source type; rate-limit delays |
| `Sheets.js` | All Sheets read/write: Inbox tab, Config tab (tag→folder→group mappings). `getTagConfig(tag)` returns `{ folderId, group }` — tags sharing a folder ID and group name write to one consolidated Doc. |
| `Docs.js` | Topic Doc creation, quarterly rotation, entry append |
| `Digest.js` | HTML digest email composition and delivery |
| `WebApp.js` | `doGet` approval endpoint: tag selection page + save/dismiss handlers |

### Pipeline Flow

1. `runFrequentPipeline` (every 15 min) → Gmail + Tasks connectors
2. `runDailyPipeline` (once daily) → YouTube connector
3. Each connector: fetch → deduplicate → Gemini summarize → write to Sheets Inbox
4. `sendDigest` (every few hours) → email pending Inbox items with Save/Dismiss links
5. User clicks link → WebApp shows tag selection → confirmed save appends to Topic Doc in Drive

### Deduplication

`Config.js` manages a rolling store of up to 2,000 processed IDs in Script Properties (`PROCESSED_IDS` key, JSON array). Each source uses its native ID:
- YouTube: `videoId` (from `item.rawMetadata.videoId`)
- Gmail: `threadId` (from `item.rawMetadata.threadId`)
- Tasks: `task.id` (from `item.rawMetadata.taskId`)

### Error Handling Pattern

All pipeline `forEach` loops use try/finally to guarantee deduplication even on Gemini failure:

```javascript
newItems.forEach(item => {
  try {
    const summary = summarizeItem(item);
    addItemToInbox(item, summary);
  } catch (e) {
    Logger.log(`Source: failed to process "${item.title}" — skipping. Error: ${e.message}`);
  } finally {
    addProcessedId(item.rawMetadata.sourceSpecificId);
  }
});
```

## Configuration (Script Properties)

All secrets and user-specific values live in Apps Script Script Properties — never in code:

| Property | Description |
|---|---|
| `GEMINI_API_KEY` | Gemini API key from Google AI Studio |
| `GEMINI_MODEL` | Model name (e.g. `gemini-2.0-flash`) |
| `YOUTUBE_PLAYLIST_ID` | YouTube playlist ID to monitor |
| `GMAIL_LABEL` | Gmail label name to monitor (e.g. `PKM`) |
| `TASKS_LIST_ID` | Google Tasks list ID (`@default` for default list) |
| `DIGEST_EMAIL` | Address to receive digest emails |
| `SHEET_ID` | Google Sheets spreadsheet ID |
| `DRIVE_ROOT_FOLDER_ID` | Root Drive folder ID for Topic Docs |
| `WEBAPP_URL` | Deployed web app URL (set after first deploy) |

## Runtime Context

- Runs on Google's V8 runtime (see `appsscript.json`)
- Advanced Services enabled: YouTube Data API v3, Tasks API v1
- No `npm`, no local test runner — testing is done by running functions directly in the Apps Script editor
- Logs visible in Apps Script editor (Executions tab) and Google Cloud Stackdriver

## Testing / Debugging

Set `DEBUG = true` in `Config.js` before pushing to bypass deduplication and force reprocessing of all items. Reset to `false` before normal operation to avoid duplicate Inbox rows.

The `debugGetTasksListIds()` function in `Tasks.js` can be run manually to list available task list IDs and names.
