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
 * Called by the WebApp after the user confirms their tag selection.
 *
 * @param {Object}   item         - Normalized item
 * @param {Object}   summary      - Structured summary from Gemini
 * @param {string[]} [selectedTags] - Explicit tag list from the user; falls back to summary.tags
 * @returns {string} Deep link URL to the appended section (first successful doc)
 */
function saveItemToDoc(item, summary, selectedTags) {
  const tags = (selectedTags || summary.tags || []).filter(tag => tag);
  let primaryDocLink = '';

  tags.forEach((tag, index) => {
    const folderId = getFolderIdForTag(tag);
    if (!folderId) {
      Logger.log(`Docs: no folder configured for tag "${tag}" — skipping`);
      return;
    }

    const docFile = getOrCreateTopicDoc(tag, folderId);
    const docLink = appendSectionToDoc(docFile.getId(), item, summary);

    if (!primaryDocLink) primaryDocLink = docLink;
  });

  return primaryDocLink;
}

/**
 * Finds the current active quarterly Topic Doc for a tag.
 * Creates a new doc if none exists for the current quarter. If the current doc
 * has reached the 50-item rotation threshold, moves to the next rotation
 * (e.g. "ai - 2026-Q1" → "ai - 2026-Q1-2" → "ai - 2026-Q1-3").
 *
 * @param {string} tag      - Topic tag name (e.g. "ai-research")
 * @param {string} folderId - Drive folder ID for this topic
 * @returns {GoogleAppsScript.Drive.File}
 */
function getOrCreateTopicDoc(tag, folderId) {
  const quarter = getCurrentQuarterLabel();
  const folder  = DriveApp.getFolderById(folderId);

  // Walk rotation slots (1 = base name, 2+ = suffixed) until we find one
  // that either doesn't exist yet (create it) or still has capacity.
  for (let rotation = 1; ; rotation++) {
    const docName  = rotation === 1
      ? `${tag} - ${quarter}`
      : `${tag} - ${quarter}-${rotation}`;
    const existing = folder.getFilesByName(docName);

    if (!existing.hasNext()) {
      const newDoc  = DocumentApp.create(docName);
      const newFile = DriveApp.getFileById(newDoc.getId());
      newFile.moveTo(folder);
      Logger.log(`Docs: created new doc "${docName}"`);
      return newFile;
    }

    const docFile = existing.next();
    if (countEntriesInDoc(docFile.getId()) < 50) {
      return docFile;
    }

    Logger.log(`Docs: "${docName}" is full — checking next rotation`);
  }
}

/**
 * Counts the number of entries in a Topic Doc by counting HEADING2 paragraphs.
 * Each entry appended by appendSectionToDoc adds exactly one HEADING2.
 *
 * @param {string} docId
 * @returns {number}
 */
function countEntriesInDoc(docId) {
  const body  = DocumentApp.openById(docId).getBody();
  let   count = 0;

  for (let i = 0; i < body.getNumChildren(); i++) {
    const child = body.getChild(i);
    if (child.getType() === DocumentApp.ElementType.PARAGRAPH &&
        child.asParagraph().getHeading() === DocumentApp.ParagraphHeading.HEADING2) {
      count++;
    }
  }

  return count;
}

/**
 * Appends a formatted knowledge entry to a Google Doc.
 * Entry structure:
 *   [Title] — heading
 *   Source type | Date | Original URL
 *   Full summary paragraph
 *   Key Terms list (omitted if empty)
 *   Key Points list (omitted if empty)
 *   Action Items list (omitted if empty)
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

  // Key terms
  if (summary.keyTerms && summary.keyTerms.length > 0) {
    body.appendParagraph('Key Terms').setHeading(DocumentApp.ParagraphHeading.HEADING3);
    summary.keyTerms.forEach(term => {
      body.appendListItem(term).setGlyphType(DocumentApp.GlyphType.BULLET);
    });
  }

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
