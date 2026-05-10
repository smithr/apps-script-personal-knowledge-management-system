const DEBUG = false; // Set to true to re-process all items (bypasses deduplication)

// Maximum number of YouTube videos to summarize per pipeline run.
// Keeps individual executions well within the 6-minute Apps Script time limit.
const YOUTUBE_BATCH_SIZE = 3;

// ─── Script Property Keys ───────────────────────────────────────────────────
const PROP = {
  GEMINI_API_KEY:       'GEMINI_API_KEY',
  GEMINI_MODEL:         'GEMINI_MODEL',
  YOUTUBE_PLAYLIST_ID:  'YOUTUBE_PLAYLIST_ID',
  TASKS_LIST_ID:        'TASKS_LIST_ID',         // '@default' or specific list ID
  GMAIL_LABEL:          'GMAIL_LABEL',           // label name to monitor
  DIGEST_EMAIL:         'DIGEST_EMAIL',
  WEBAPP_URL:           'WEBAPP_URL',
  SHEET_ID:             'SHEET_ID',
  DRIVE_ROOT_FOLDER:    'DRIVE_ROOT_FOLDER_ID',
  PROCESSED_IDS:        'PROCESSED_IDS',         // JSON array, managed by system
  LIBRARY_INDEX_FILE_ID: 'LIBRARY_INDEX_FILE_ID', // cached Drive file ID, managed by system
  TOPIC_DOC_CACHE:       'TOPIC_DOC_CACHE',       // JSON map of docName::quarter → {id, count}, managed by system
  SYNTHESIS_DOC_ID:      'SYNTHESIS_DOC_ID',      // cached ID of the Weekly Synthesis doc
  WIKI_FOLDER_ID:        'WIKI_FOLDER_ID',        // cached Drive folder ID for /Wiki/ subfolder
  WIKI_INDEX_DOC_ID:     'WIKI_INDEX_DOC_ID',     // cached Doc ID for the Wiki Index
  RAW_FOLDER_ID:         'RAW_FOLDER_ID',         // cached Drive folder ID for /raw/ subfolder
};

// ─── Sheet Tab Names ─────────────────────────────────────────────────────────
const TABS = {
  INBOX:   'Inbox',
  ARCHIVE: 'Archive',
  CONFIG:  'Config',
};

// ─── Column Indices (1-based) ─────────────────────────────────────────────────
const COL = {
  ITEM_ID:      1,
  DATE_ADDED:   2,
  SOURCE_TYPE:  3,
  TITLE:        4,
  URL:          5,
  SUMMARY:      6,
  TAGS:         7,
  STATUS:       8,
  DIGEST_SENT:  9,
  DOC_LINK:     10,
  SUMMARY_JSON: 11,  // full Gemini JSON blob for downstream use
  SOURCE_ID:    12,  // source-native ID used for deduplication (videoId / threadId / taskId)
};

// ─── Status Values ────────────────────────────────────────────────────────────
const STATUS = {
  PENDING:   'Pending',
  SAVED:     'Saved',
  DISMISSED: 'Dismissed',
};

// ─── Source Types ─────────────────────────────────────────────────────────────
const SOURCE = {
  YOUTUBE: 'YouTube',
  GMAIL:   'Gmail',
  TASKS:   'Tasks',
  CAPTURE: 'Capture', // manually captured via bookmarklet
};

// ─── Property Accessors ───────────────────────────────────────────────────────
function getProperty(key) {
  const value = PropertiesService.getScriptProperties().getProperty(key);
  if (!value) throw new Error(`Missing script property: ${key}`);
  return value;
}

function setProperty(key, value) {
  PropertiesService.getScriptProperties().setProperty(key, value);
}

function getSheet(tabName) {
  const ss = SpreadsheetApp.openById(getProperty(PROP.SHEET_ID));
  return ss.getSheetByName(tabName);
}

// ─── Processed ID Store ───────────────────────────────────────────────────────
function getProcessedIds() {
  const raw = PropertiesService.getScriptProperties()
    .getProperty(PROP.PROCESSED_IDS);
  return raw ? new Set(JSON.parse(raw)) : new Set();
}

function addProcessedId(id) {
  addProcessedIds([id]);
}

/**
 * Adds multiple processed IDs in a single Script Properties read + write.
 * Use this at the end of a pipeline loop instead of calling addProcessedId
 * per item, which would do N reads and N writes.
 *
 * @param {string[]} ids
 */
function addProcessedIds(ids) {
  if (!ids || ids.length === 0) return;
  const existing = getProcessedIds();
  ids.forEach(id => existing.add(id));
  // Script Properties has a 9 KB per-value limit. At ~18 bytes per JSON-encoded
  // ID, 500 entries ≈ 9 KB. This rolling window also covers ~5 days of heavy
  // ingest before old IDs age out — sufficient since source items don't
  // re-appear in feeds/labels after that window.
  const trimmed = Array.from(existing).slice(-500);
  setProperty(PROP.PROCESSED_IDS, JSON.stringify(trimmed));
}

function isProcessed(id) {
  return DEBUG ? false : getProcessedIds().has(id);
}

/**
 * Returns the source-native deduplication ID from a normalized item.
 * This is the ID that is stored in PROCESSED_IDS — not the UUID item.id.
 *
 * @param {Object} item - Normalized item from a source connector
 * @returns {string}
 */
function getSourceNativeId(item) {
  switch (item.sourceType) {
    case SOURCE.YOUTUBE: return item.rawMetadata.videoId;
    case SOURCE.GMAIL:   return item.rawMetadata.threadId;
    case SOURCE.TASKS:   return item.rawMetadata.taskId;
    case SOURCE.CAPTURE: return item.rawMetadata.captureId || item.id;
    default:             return item.id;
  }
}

/**
 * Removes a single ID from the processed store so the item will be
 * re-fetched and re-summarized on the next pipeline run.
 *
 * Run this manually in the Apps Script editor when you want to
 * reprocess a specific item. Pass the source-specific ID:
 *   YouTube : videoId   (e.g. "dQw4w9WgXcQ")
 *   Gmail   : threadId  (e.g. "18abc123def")
 *   Tasks   : task.id   (e.g. "MDEwMTAxMDE")
 *
 * @param {string} id
 */
function removeProcessedId(id) {
  const ids = getProcessedIds();
  if (!ids.has(id)) {
    Logger.log(`removeProcessedId: "${id}" not found in processed store — nothing changed.`);
    return;
  }
  ids.delete(id);
  setProperty(PROP.PROCESSED_IDS, JSON.stringify(Array.from(ids)));
  Logger.log(`removeProcessedId: "${id}" removed. It will be reprocessed on the next pipeline run.`);
}
/**
 * Convenience runner — replace REPLACE_ME with the ID you want to reprocess,
 * then run this function from the Apps Script editor.
 */
function reprocessItem() {
  removeProcessedId('REPLACE_ME');
}

/**
 * Clears all Gmail thread IDs and Google Task IDs from the processed store,
 * keeping only YouTube video IDs. YouTube IDs are identified by matching
 * SOURCE_ID values in the Inbox and Archive sheets.
 *
 * Run this one-off from the Apps Script editor to unstick tasks or emails
 * that were blacklisted due to processing failures.
 */
function clearNonYoutubeProcessedIds() {
  const youtubeIds = new Set();
  [getSheet(TABS.INBOX), getSheet(TABS.ARCHIVE)].forEach(sheet => {
    const lastRow = sheet.getLastRow();
    if (lastRow < 2) return;
    const data = sheet.getRange(2, 1, lastRow - 1, COL.SOURCE_ID).getValues();
    data.forEach(row => {
      if (row[COL.SOURCE_TYPE - 1] === SOURCE.YOUTUBE && row[COL.SOURCE_ID - 1]) {
        youtubeIds.add(String(row[COL.SOURCE_ID - 1]));
      }
    });
  });

  const before = getProcessedIds();
  const kept   = Array.from(before).filter(id => youtubeIds.has(id));
  setProperty(PROP.PROCESSED_IDS, JSON.stringify(kept));
  Logger.log(`clearNonYoutubeProcessedIds: ${before.size} → ${kept.length} entries kept (removed ${before.size - kept.length}).`);
}

/**
 * Trims the PROCESSED_IDS store to the current 500-entry cap.
 * Run once manually from the Apps Script editor if the store was allowed
 * to grow beyond the cap before this limit was enforced in addProcessedId.
 * Logs the before/after count so you can confirm the trim worked.
 */
function trimProcessedIds() {
  const raw = PropertiesService.getScriptProperties().getProperty(PROP.PROCESSED_IDS);
  if (!raw) {
    Logger.log('trimProcessedIds: store is empty — nothing to do.');
    return;
  }
  const ids    = JSON.parse(raw);
  const before = ids.length;
  const trimmed = ids.slice(-500);
  setProperty(PROP.PROCESSED_IDS, JSON.stringify(trimmed));
  Logger.log(`trimProcessedIds: ${before} → ${trimmed.length} entries (removed ${before - trimmed.length}).`);
}
