/**
 * Sheets.js
 * All read/write operations against the Google Sheet.
 *
 * Tab names are defined in TABS (Config.js).
 * Column indices (1-based) are defined in COL (Config.js).
 * Status values are defined in STATUS (Config.js).
 */

// ─── Inbox Writes ────────────────────────────────────────────────────────────

/**
 * Appends a new item row to the Inbox tab.
 *
 * @param {Object} item    - Normalized item from a source connector
 * @param {Object} summary - Structured summary object from Gemini.js
 */
function addItemToInbox(item, summary) {
  const sheet = getSheet(TABS.INBOX);
  const row   = new Array(Object.keys(COL).length);

  row[COL.ITEM_ID     - 1] = item.id;
  row[COL.DATE_ADDED  - 1] = item.dateAdded;
  row[COL.SOURCE_TYPE - 1] = item.sourceType;
  row[COL.TITLE       - 1] = item.title;
  row[COL.URL         - 1] = item.url;
  row[COL.SUMMARY     - 1] = summary.fullSummary;
  row[COL.TAGS        - 1] = (summary.tags || []).join(', ');
  row[COL.STATUS      - 1] = STATUS.PENDING;
  row[COL.DIGEST_SENT - 1] = false;
  row[COL.DOC_LINK    - 1] = '';

  sheet.appendRow(row);
}

// ─── Inbox Reads ─────────────────────────────────────────────────────────────

/**
 * Returns all Inbox rows where Status = Pending and DigestSent = false.
 * Each row is returned as an object keyed by column name for easy access.
 *
 * @returns {Object[]} Array of row objects
 */
function getPendingUnsentItems() {
  const sheet  = getSheet(TABS.INBOX);
  const data   = sheet.getDataRange().getValues();
  const result = [];

  // Row 1 is the header; data rows start at index 1 (row 2 in the sheet)
  for (let i = 1; i < data.length; i++) {
    const row = data[i];
    if (row[COL.STATUS      - 1] !== STATUS.PENDING) continue;
    if (row[COL.DIGEST_SENT - 1] === true)           continue;

    result.push(rowToObject(row, i + 1)); // i + 1 = 1-based sheet row index
  }

  return result;
}

/**
 * Finds a single Inbox row by item ID.
 *
 * @param {string} itemId
 * @returns {{ rowIndex: number, data: Object }|null}
 */
function getItemById(itemId) {
  const sheet = getSheet(TABS.INBOX);
  const data  = sheet.getDataRange().getValues();

  for (let i = 1; i < data.length; i++) {
    if (data[i][COL.ITEM_ID - 1] === itemId) {
      return { rowIndex: i + 1, data: rowToObject(data[i], i + 1) };
    }
  }

  return null;
}

// ─── Inbox Updates ────────────────────────────────────────────────────────────

/**
 * Updates the Status column for a given item.
 *
 * @param {string} itemId
 * @param {string} status - STATUS.SAVED | STATUS.DISMISSED
 */
function updateItemStatus(itemId, status) {
  const found = getItemById(itemId);
  if (!found) throw new Error(`Item not found: ${itemId}`);
  getSheet(TABS.INBOX)
    .getRange(found.rowIndex, COL.STATUS)
    .setValue(status);
}

/**
 * Sets DigestSent = true for each provided item ID.
 *
 * @param {string[]} itemIds
 */
function markItemsDigestSent(itemIds) {
  const sheet = getSheet(TABS.INBOX);
  const data  = sheet.getDataRange().getValues();

  const idSet = new Set(itemIds);
  for (let i = 1; i < data.length; i++) {
    if (idSet.has(data[i][COL.ITEM_ID - 1])) {
      sheet.getRange(i + 1, COL.DIGEST_SENT).setValue(true);
    }
  }
}

/**
 * Updates the Doc Link column for a saved item.
 *
 * @param {string} itemId
 * @param {string} docLink - Deep link URL to the Doc section
 */
function updateDocLink(itemId, docLink) {
  const found = getItemById(itemId);
  if (!found) throw new Error(`Item not found: ${itemId}`);
  getSheet(TABS.INBOX)
    .getRange(found.rowIndex, COL.DOC_LINK)
    .setValue(docLink);
}

// ─── Config Tab ───────────────────────────────────────────────────────────────

/**
 * Returns all tag names that have a configured folder ID in the Config tab.
 * Used by the WebApp to populate the tag selection page.
 *
 * @returns {string[]}
 */
function getConfiguredTags() {
  const sheet = getSheet(TABS.CONFIG);
  const data  = sheet.getDataRange().getValues();
  return data
    .filter(row => row[0] && row[1])
    .map(row => String(row[0]).trim());
}

/**
 * Looks up the Drive folder ID for a given topic tag from the Config tab.
 * The Config tab is expected to have tag names in column 1, folder IDs in column 2.
 *
 * @param {string} tag
 * @returns {string|null} Drive folder ID or null if not configured
 */
function getFolderIdForTag(tag) {
  const sheet = getSheet(TABS.CONFIG);
  const data  = sheet.getDataRange().getValues();
  const normalizedTag = tag.trim().toLowerCase();

  for (let i = 0; i < data.length; i++) {
    if (String(data[i][0]).trim().toLowerCase() === normalizedTag) {
      return data[i][1] || null;
    }
  }

  return null;
}

// ─── Internal Helpers ─────────────────────────────────────────────────────────

/**
 * Converts a raw row array to a plain object keyed by column name.
 *
 * @param {Array}  row
 * @param {number} rowIndex - 1-based sheet row index
 * @returns {Object}
 */
function rowToObject(row, rowIndex) {
  return {
    rowIndex,
    itemId:     row[COL.ITEM_ID     - 1],
    dateAdded:  row[COL.DATE_ADDED  - 1],
    sourceType: row[COL.SOURCE_TYPE - 1],
    title:      row[COL.TITLE       - 1],
    url:        row[COL.URL         - 1],
    summary:    row[COL.SUMMARY     - 1],
    tags:       row[COL.TAGS        - 1],
    status:     row[COL.STATUS      - 1],
    digestSent: row[COL.DIGEST_SENT - 1],
    docLink:    row[COL.DOC_LINK    - 1],
  };
}
