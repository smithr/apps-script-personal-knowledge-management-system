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
  // Keep the store from growing unboundedly — retain last 2000 IDs
  const trimmed = Array.from(ids).slice(-2000);
  setProperty(PROP.PROCESSED_IDS, JSON.stringify(trimmed));
}

function isProcessed(id) {
  return DEBUG ? false: getProcessedIds().has(id);
}