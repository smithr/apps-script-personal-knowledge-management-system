/**
 * Library.js
 * Manages a Drive-hosted JSON index of all saved PKM items.
 *
 * The index file (pkm-library-index.json) lives in DRIVE_ROOT_FOLDER_ID.
 * It is updated at save time and read by the library web app view.
 *
 * Index structure:
 *   {
 *     lastUpdated: string (ISO),
 *     items: [{
 *       id:           string  — item UUID
 *       title:        string
 *       url:          string
 *       date:         string  — ISO timestamp
 *       sourceType:   string  — SOURCE.*
 *       shortSummary: string
 *       docLink:      string
 *       tags:         string[]
 *     }]
 *   }
 */

const LIBRARY_INDEX_FILENAME = 'pkm-library-index.json';

/**
 * Returns the Drive File for the library index, creating it if it doesn't exist.
 *
 * @returns {GoogleAppsScript.Drive.File}
 */
function getOrCreateLibraryIndexFile() {
  const folder = DriveApp.getFolderById(getProperty(PROP.DRIVE_ROOT_FOLDER));
  const files  = folder.getFilesByName(LIBRARY_INDEX_FILENAME);
  if (files.hasNext()) return files.next();

  const empty = JSON.stringify({ lastUpdated: new Date().toISOString(), items: [] });
  return folder.createFile(LIBRARY_INDEX_FILENAME, empty, MimeType.PLAIN_TEXT);
}

/**
 * Reads and parses the library index from Drive.
 *
 * @returns {{ lastUpdated: string, items: Array }}
 */
function readLibraryIndex() {
  const file = getOrCreateLibraryIndexFile();
  try {
    return JSON.parse(file.getBlob().getDataAsString());
  } catch (e) {
    Logger.log(`Library: failed to parse index — returning empty. Error: ${e.message}`);
    return { lastUpdated: new Date().toISOString(), items: [] };
  }
}

/**
 * Overwrites the library index file in Drive.
 *
 * @param {{ lastUpdated: string, items: Array }} index
 */
function writeLibraryIndex(index) {
  const file = getOrCreateLibraryIndexFile();
  file.setContent(JSON.stringify(index));
}

/**
 * Adds a saved item to the library index.
 * Called by handleSaveConfirm in WebApp.js after the Doc write succeeds.
 * Non-fatal: logs and continues on Drive failure so the save confirmation
 * is never shown an error due to the library update.
 *
 * @param {Object}   item         - rowToObject result from Sheets
 * @param {Object}   summary      - parsed summaryJson (has .shortSummary)
 * @param {string[]} selectedTags - user-confirmed tags
 * @param {string}   docLink      - deep link URL returned by saveItemToDoc
 */
function addItemToLibrary(item, summary, selectedTags, docLink) {
  try {
    const index = readLibraryIndex();

    // Remove existing entry for this item (handles accidental re-saves)
    index.items = (index.items || []).filter(e => e.id !== item.itemId);

    index.items.push({
      id:           item.itemId,
      title:        item.title,
      url:          item.url,
      date:         new Date(item.dateAdded).toISOString(),
      sourceType:   item.sourceType,
      shortSummary: summary.shortSummary || '',
      docLink:      docLink || '',
      tags:         selectedTags,
    });

    index.lastUpdated = new Date().toISOString();
    writeLibraryIndex(index);
    Logger.log(`Library: indexed "${item.title}" under [${selectedTags.join(', ')}]`);
  } catch (e) {
    Logger.log(`Library: failed to index "${item.title}" — ${e.message}`);
  }
}

/**
 * Returns the full library index.
 * Exposed to the client via google.script.run.getLibraryIndexJson().
 *
 * @returns {{ lastUpdated: string, items: Array }}
 */
function getLibraryIndexJson() {
  return readLibraryIndex();
}
