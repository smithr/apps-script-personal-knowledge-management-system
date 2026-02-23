/**
 * Docs.js
 * Manages aggregate Topic Docs in Google Drive.
 * On approval, appends a formatted knowledge entry to the active quarterly doc
 * for each tag associated with the item.
 *
 * Drive folder structure (per spec section 3.7):
 *   /PKM (root)
 *     /Topics
 *       /[tag]
 *         [tag] - 2026-Q1.gdoc
 *         [tag] - 2026-Q2.gdoc
 *     /Projects
 *       /[project]
 *         [project] - Notes.gdoc
 */

/**
 * Saves an approved item to its Topic Doc(s).
 * Called by the WebApp when a user clicks [Save to PKM].
 *
 * For items with multiple tags, the item is appended to the doc for each
 * tag that has a configured folder in the Config tab.
 *
 * @param {Object} item    - Normalized item
 * @param {Object} summary - Structured summary from Gemini
 * @returns {string} Deep link URL to the appended section (first tag's doc)
 */
function saveItemToDoc(item, summary) {
  const tags = (summary.tags || []).filter(tag => tag);
  let primaryDocLink = '';

  tags.forEach((tag, index) => {
    const folderId = getFolderIdForTag(tag);
    if (!folderId) {
      Logger.log(`Docs: no folder configured for tag "${tag}" — skipping`);
      return;
    }

    const docFile = getOrCreateTopicDoc(tag, folderId);
    const docLink = appendSectionToDoc(docFile.getId(), item, summary);

    if (index === 0) primaryDocLink = docLink;
  });

  return primaryDocLink;
}

/**
 * Finds the current active quarterly Topic Doc for a tag.
 * Creates a new doc if none exists for the current quarter, or if the existing
 * doc has reached the 50-item rotation threshold.
 *
 * @param {string} tag      - Topic tag name (e.g. "ai-research")
 * @param {string} folderId - Drive folder ID for this topic
 * @returns {GoogleAppsScript.Drive.File}
 */
function getOrCreateTopicDoc(tag, folderId) {
  const quarter  = getCurrentQuarterLabel();
  const docName  = `${tag} - ${quarter}`;
  const folder   = DriveApp.getFolderById(folderId);
  const existing = folder.getFilesByName(docName);

  if (existing.hasNext()) {
    const docFile = existing.next();
    // TODO: Check item count in doc; if >= 50, rotate to a new doc
    //   Rotation: append a suffix like "-2" to the new doc name
    return docFile;
  }

  // Create a new quarterly doc
  const newDoc  = DocumentApp.create(docName);
  const newFile = DriveApp.getFileById(newDoc.getId());
  newFile.moveTo(folder);

  Logger.log(`Docs: created new doc "${docName}"`);
  return newFile;
}

/**
 * Appends a formatted knowledge entry to a Google Doc.
 * Entry structure:
 *   [Title] — heading
 *   Source type | Date | Original URL
 *   Full summary paragraph
 *   Key points list
 *   Action items list (omitted if empty)
 *
 * @param {string} docId   - Google Doc file ID
 * @param {Object} item    - Normalized item
 * @param {Object} summary - Structured summary
 * @returns {string} Deep link URL to the doc (section anchors not supported via API)
 */
function appendSectionToDoc(docId, item, summary) {
  const doc  = DocumentApp.openById(docId);
  const body = doc.getBody();

  // Heading
  body.appendParagraph(item.title)
      .setHeading(DocumentApp.ParagraphHeading.HEADING2);

  // Metadata line
  const date       = new Date(item.dateAdded).toLocaleDateString();
  const metaText   = `${item.sourceType}  ·  ${date}  ·  ${item.url}`;
  body.appendParagraph(metaText)
      .setItalic(true);

  // Full summary
  body.appendParagraph(summary.fullSummary || '');

  // Key points
  if (summary.keyPoints && summary.keyPoints.length > 0) {
    body.appendParagraph('Key Points').setHeading(DocumentApp.ParagraphHeading.HEADING3);
    summary.keyPoints.forEach(point => {
      body.appendListItem(point)
          .setGlyphType(DocumentApp.GlyphType.BULLET);
    });
  }

  // Action items
  if (summary.actionItems && summary.actionItems.length > 0) {
    body.appendParagraph('Action Items').setHeading(DocumentApp.ParagraphHeading.HEADING3);
    summary.actionItems.forEach(action => {
      body.appendListItem(action)
          .setGlyphType(DocumentApp.GlyphType.BULLET);
    });
  }

  // Divider between entries
  body.appendHorizontalRule();

  doc.saveAndClose();
  return `https://docs.google.com/document/d/${docId}/edit`;
}

/**
 * Returns the current quarter label string, e.g. "2026-Q1".
 *
 * @returns {string}
 */
function getCurrentQuarterLabel() {
  const now     = new Date();
  const year    = now.getFullYear();
  const quarter = Math.ceil((now.getMonth() + 1) / 3);
  return `${year}-Q${quarter}`;
}
