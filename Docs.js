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
 * Appends a formatted knowledge entry to a Google Doc using the Docs REST API
 * batchUpdate endpoint. All mutations are sent in two HTTP calls (one GET for
 * the insertion point, one POST with all insertText + formatting requests)
 * rather than ~15 sequential DocumentApp calls.
 *
 * Entry structure:
 *   [Title] — HEADING_2
 *   Source type · Date · URL — italic
 *   Full summary paragraph
 *   Key Terms section + bullets (omitted if empty)
 *   Key Points section + bullets (omitted if empty)
 *   Action Items section + bullets (omitted if empty)
 *   Separator paragraph with bottom border (replaces horizontal rule)
 *
 * @param {string} docId    - Google Doc file ID
 * @param {Object} item     - Normalized item
 * @param {Object} summary  - Structured summary
 * @param {string} cacheKey - Key returned by getOrCreateTopicDoc for count update
 * @returns {string} Deep link URL to the doc
 */
function appendSectionToDoc(docId, item, summary, cacheKey) {
  const token   = ScriptApp.getOAuthToken();
  const baseUrl = 'https://docs.googleapis.com/v1/documents/' + docId;
  const auth    = { Authorization: 'Bearer ' + token };

  // ── Step 1: find the insertion point (just before the doc's final \n) ────────
  const getRes = UrlFetchApp.fetch(baseUrl + '?fields=body.content.endIndex', {
    headers: auth,
    muteHttpExceptions: true,
  });
  if (getRes.getResponseCode() !== 200) {
    throw new Error('Docs GET failed (' + getRes.getResponseCode() + '): ' + getRes.getContentText());
  }
  const bodyContent = JSON.parse(getRes.getContentText()).body.content;
  const insertAt    = bodyContent[bodyContent.length - 1].endIndex - 1;

  // ── Step 2: build segments (each becomes one \n-terminated paragraph) ────────
  const metaText = item.sourceType + '  ·  '
    + new Date(item.dateAdded).toLocaleDateString() + '  ·  ' + item.url;

  const segments = [];
  segments.push({ text: item.title,              style: 'heading2'   });
  segments.push({ text: metaText,                style: 'italic'     });
  segments.push({ text: summary.fullSummary || '', style: 'normal'   });

  if (summary.keyTerms && summary.keyTerms.length > 0) {
    segments.push({ text: 'Key Terms', style: 'heading3' });
    summary.keyTerms.forEach(t => segments.push({ text: t, style: 'bullet' }));
  }
  if (summary.keyPoints && summary.keyPoints.length > 0) {
    segments.push({ text: 'Key Points', style: 'heading3' });
    summary.keyPoints.forEach(p => segments.push({ text: p, style: 'bullet' }));
  }
  if (summary.actionItems && summary.actionItems.length > 0) {
    segments.push({ text: 'Action Items', style: 'heading3' });
    summary.actionItems.forEach(a => segments.push({ text: a, style: 'bullet' }));
  }
  segments.push({ text: '', style: 'separator' });

  // ── Step 3: compute each segment's character range ───────────────────────────
  // Each segment occupies [start, end) where end = start + text.length + 1 (\n).
  let offset = insertAt;
  segments.forEach(seg => {
    seg.start = offset;
    seg.end   = offset + seg.text.length + 1;
    offset    = seg.end;
  });

  // ── Step 4: build all requests ────────────────────────────────────────────────
  const requests = [{
    insertText: {
      location: { index: insertAt },
      text: segments.map(s => s.text).join('\n') + '\n',
    },
  }];

  segments.forEach(seg => {
    switch (seg.style) {
      case 'heading2':
        requests.push({
          updateParagraphStyle: {
            range: { startIndex: seg.start, endIndex: seg.end },
            paragraphStyle: { namedStyleType: 'HEADING_2' },
            fields: 'namedStyleType',
          },
        });
        break;

      case 'heading3':
        requests.push({
          updateParagraphStyle: {
            range: { startIndex: seg.start, endIndex: seg.end },
            paragraphStyle: { namedStyleType: 'HEADING_3' },
            fields: 'namedStyleType',
          },
        });
        break;

      case 'italic':
        // Exclude the trailing \n from text styling
        requests.push({
          updateTextStyle: {
            range: { startIndex: seg.start, endIndex: seg.end - 1 },
            textStyle: { italic: true },
            fields: 'italic',
          },
        });
        break;

      case 'bullet':
        requests.push({
          createParagraphBullets: {
            range: { startIndex: seg.start, endIndex: seg.end },
            bulletPreset: 'BULLET_DISC_CIRCLE_SQUARE',
          },
        });
        break;

      case 'separator':
        // Bottom border approximates a horizontal rule (REST API has no insertHR)
        requests.push({
          updateParagraphStyle: {
            range: { startIndex: seg.start, endIndex: seg.end },
            paragraphStyle: {
              borderBottom: {
                color:     { color: { rgbColor: { red: 0.75, green: 0.75, blue: 0.75 } } },
                dashStyle: 'SOLID',
                padding:   { magnitude: 2, unit: 'PT' },
                width:     { magnitude: 1, unit: 'PT' },
              },
              spaceAbove: { magnitude: 6, unit: 'PT' },
              spaceBelow: { magnitude: 6, unit: 'PT' },
            },
            fields: 'borderBottom,spaceAbove,spaceBelow',
          },
        });
        break;
    }
  });

  // ── Step 5: send all mutations in one round trip ──────────────────────────────
  const postRes = UrlFetchApp.fetch(baseUrl + ':batchUpdate', {
    method: 'post',
    contentType: 'application/json',
    headers: auth,
    payload: JSON.stringify({ requests }),
    muteHttpExceptions: true,
  });
  if (postRes.getResponseCode() !== 200) {
    throw new Error('Docs batchUpdate failed (' + postRes.getResponseCode() + '): ' + postRes.getContentText());
  }

  // ── Step 6: keep cached entry count in sync ───────────────────────────────────
  if (cacheKey) {
    const cache = readTopicDocCache();
    if (cache[cacheKey]) {
      cache[cacheKey].count += 1;
      writeTopicDocCache(cache);
    }
  }

  return 'https://docs.google.com/document/d/' + docId + '/edit';
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
