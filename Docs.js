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
  const writtenGroups = new Set(); // deduplicate tags that share a group

  tags.forEach(tag => {
    const config = getTagConfig(tag);
    if (!config) {
      Logger.log(`Docs: no folder configured for tag "${tag}" — skipping`);
      return;
    }

    const { folderId, group } = config;
    const dedupeKey = `${folderId}::${group}`;
    if (writtenGroups.has(dedupeKey)) {
      Logger.log(`Docs: tag "${tag}" shares group "${group}" — skipping duplicate write`);
      return;
    }
    writtenGroups.add(dedupeKey);

    const { file: docFile, cacheKey } = getOrCreateTopicDoc(group, folderId);
    const docLink = appendSectionToDoc(docFile.getId(), item, summary, cacheKey);

    if (!primaryDocLink) primaryDocLink = docLink;
  });

  return primaryDocLink;
}

/**
 * Reads the topic doc cache from Script Properties.
 * Cache structure: { "docName::quarter": { id: string, count: number } }
 *
 * @returns {Object}
 */
function readTopicDocCache() {
  const raw = PropertiesService.getScriptProperties().getProperty(PROP.TOPIC_DOC_CACHE);
  try { return raw ? JSON.parse(raw) : {}; } catch (e) { return {}; }
}

/**
 * Writes the topic doc cache back to Script Properties.
 *
 * @param {Object} cache
 */
function writeTopicDocCache(cache) {
  PropertiesService.getScriptProperties().setProperty(
    PROP.TOPIC_DOC_CACHE, JSON.stringify(cache)
  );
}

/**
 * Finds the current active quarterly Topic Doc for a tag group.
 * On a cache hit the folder scan and doc-open are skipped entirely.
 * On a cache miss (new quarter, first save, or stale entry) falls back to
 * the Drive folder scan, then updates the cache.
 *
 * Rotation logic: each doc holds up to 50 entries. When full, the next
 * rotation slot is tried (e.g. "ai - 2026-Q1" → "ai - 2026-Q1-2").
 *
 * @param {string} docName  - Group/tag name used as the doc title prefix
 * @param {string} folderId - Drive folder ID for this topic
 * @returns {{ file: GoogleAppsScript.Drive.File, cacheKey: string }}
 */
function getOrCreateTopicDoc(docName, folderId) {
  const quarter  = getCurrentQuarterLabel();
  const cache    = readTopicDocCache();

  // Walk rotation slots until we find one with capacity (cache-first).
  for (let rotation = 1; ; rotation++) {
    const name     = rotation === 1 ? `${docName} - ${quarter}` : `${docName} - ${quarter}-${rotation}`;
    const cacheKey = `${docName}::${quarter}::${rotation}`;
    const cached   = cache[cacheKey];

    if (cached) {
      if (cached.count < 50) {
        // Verify the file still exists; fall through on stale ID
        try {
          const file = DriveApp.getFileById(cached.id);
          return { file, cacheKey };
        } catch (e) {
          Logger.log(`Docs: stale cache for "${name}" — rescanning`);
          delete cache[cacheKey];
        }
      } else {
        Logger.log(`Docs: cache says "${name}" is full — checking next rotation`);
        continue;
      }
    }

    // Cache miss — scan the folder
    const folder   = DriveApp.getFolderById(folderId);
    const existing = folder.getFilesByName(name);

    if (!existing.hasNext()) {
      const newDoc  = DocumentApp.create(name);
      const newFile = DriveApp.getFileById(newDoc.getId());
      newFile.moveTo(folder);
      Logger.log(`Docs: created new doc "${name}"`);
      cache[cacheKey] = { id: newFile.getId(), count: 0 };
      writeTopicDocCache(cache);
      return { file: newFile, cacheKey };
    }

    const docFile = existing.next();
    const count   = countEntriesInDoc(docFile.getId());

    if (count < 50) {
      cache[cacheKey] = { id: docFile.getId(), count };
      writeTopicDocCache(cache);
      return { file: docFile, cacheKey };
    }

    // Full — mark it so next iteration skips the scan too
    cache[cacheKey] = { id: docFile.getId(), count };
    writeTopicDocCache(cache);
    Logger.log(`Docs: "${name}" is full — checking next rotation`);
  }
}

/**
 * Counts the number of entries in a Topic Doc by counting HEADING2 paragraphs.
 * Only called on a cache miss; normal saves use the cached count.
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
 * Appends a formatted knowledge entry to a Google Doc and increments the
 * cached entry count for that doc so the next save skips the folder scan.
 *
 * Entry structure:
 *   [Title] — heading
 *   Source type | Date | Original URL
 *   Full summary paragraph
 *   Key Terms list (omitted if empty)
 *   Key Points list (omitted if empty)
 *   Action Items list (omitted if empty)
 *
 * @param {string} docId    - Google Doc file ID
 * @param {Object} item     - Normalized item
 * @param {Object} summary  - Structured summary
 * @param {string} cacheKey - Key returned by getOrCreateTopicDoc for count update
 * @returns {string} Deep link URL to the doc (section anchors not supported via API)
 */
function appendSectionToDoc(docId, item, summary, cacheKey) {
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

  // Keep the cached count in sync so the next save skips countEntriesInDoc
  if (cacheKey) {
    const cache = readTopicDocCache();
    if (cache[cacheKey]) {
      cache[cacheKey].count += 1;
      writeTopicDocCache(cache);
    }
  }

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
