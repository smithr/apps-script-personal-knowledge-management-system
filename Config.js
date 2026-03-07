const DEBUG = false; // Set to true to re-process all items (bypasses deduplication)

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
  const ids = getProcessedIds();
  ids.add(id);
  // Keep the store from growing unboundedly — retain last 10,000 IDs
  const trimmed = Array.from(ids).slice(-10000);
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
