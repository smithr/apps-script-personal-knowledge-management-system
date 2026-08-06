/**
 * RawStore.js
 * Writes a full-text markdown file to /PKM/raw/ in Drive when an item is saved.
 * Called by WebApp.js handleSaveConfirm after the Doc write and library index
 * update succeed. Failures are logged and swallowed — the save flow is never
 * interrupted by a raw store error.
 *
 * Entry point: writeRawItem(item, summary, selectedTags)
 */

// ─── Drive Folder ──────────────────────────────────────────────────────────────

/**
 * Returns the Drive folder ID for /PKM/raw/, creating it if needed.
 * ID is cached in PROP.RAW_FOLDER_ID to avoid repeated Drive scans.
 *
 * @returns {string} Drive folder ID
 */
function getOrCreateRawFolder() {
  const props  = PropertiesService.getScriptProperties();
  const cached = props.getProperty(PROP.RAW_FOLDER_ID);
  if (cached) {
    try {
      DriveApp.getFolderById(cached);
      return cached;
    } catch (e) {
      Logger.log('RawStore: cached folder ID stale — rescanning Drive');
    }
  }
  const rootFolder = DriveApp.getFolderById(getProperty(PROP.DRIVE_ROOT_FOLDER));
  const existing   = rootFolder.getFoldersByName('raw');
  const folder     = existing.hasNext() ? existing.next() : rootFolder.createFolder('raw');
  props.setProperty(PROP.RAW_FOLDER_ID, folder.getId());
  Logger.log(`RawStore: raw folder ready (${folder.getId()})`);
  return folder.getId();
}

// ─── Markdown Helpers ──────────────────────────────────────────────────────────

/**
 * Converts a title to a URL-safe slug for use in filenames.
 * Lowercases, replaces non-alphanumeric runs with hyphens, trims leading/trailing
 * hyphens, caps at 60 characters.
 *
 * @param {string} title
 * @returns {string}
 */
function _rawSlugify(title) {
  return String(title)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
}

/**
 * Assembles the markdown file content: YAML frontmatter followed by the full
 * text body. fullText normally includes the full structured Gemini summary
 * (see _rawBuildFullText) so it's empty only when Gemini produced no summary
 * fields at all — in that rare case only the frontmatter block is written,
 * and the wiki compiler falls back to shortSummary as its signal for the item.
 *
 * @param {Object}   item         - Row object from Sheets (itemId, title, url, dateAdded, sourceType)
 * @param {Object}   summary      - Parsed summaryJson (shortSummary, fullSummary)
 * @param {string[]} selectedTags - User-confirmed tags
 * @param {string}   fullText     - Raw content body (may be empty)
 * @returns {string} Complete markdown file content
 */
function _rawBuildMarkdown(item, summary, selectedTags, fullText) {
  const frontmatter = [
    '---',
    `id: ${String(item.itemId || '')}`,
    `title: ${JSON.stringify(String(item.title || ''))}`,
    `url: ${String(item.url || '')}`,
    `date: ${String(item.dateAdded || new Date().toISOString())}`,
    `sourceType: ${String(item.sourceType || '')}`,
    `tags: [${selectedTags.map(t => JSON.stringify(t)).join(', ')}]`,
    `shortSummary: ${JSON.stringify(String(summary.shortSummary || ''))}`,
    '---',
  ].join('\n');

  return fullText
    ? `${frontmatter}\n\n${fullText}`
    : frontmatter;
}

// ─── Source-Specific Content Fetch ────────────────────────────────────────────

/**
 * Below this character count, raw fetched content (transcript, description,
 * email body, article text) is considered too thin to stand alone and the
 * full structured Gemini summary (fullSummary + keyTerms + keyPoints +
 * actionItems — already computed, no extra API cost) is appended after it.
 */
const RAW_FETCH_THIN_THRESHOLD = 500;

/**
 * Formats the full structured Gemini summary as a markdown section.
 * Used as a fallback body — or supplement — when the raw source fetch comes
 * back empty, too thin, or is known to be lower-quality (e.g. a YouTube video
 * description standing in for a missing transcript).
 *
 * @param {Object} summary - Parsed summaryJson
 * @returns {string}
 */
function _rawBuildGeminiSummarySection(summary) {
  const parts = [];
  if (summary.fullSummary) parts.push(summary.fullSummary);
  if (summary.keyTerms && summary.keyTerms.length > 0) {
    parts.push('Key Terms:\n' + summary.keyTerms.map(t => `- ${t}`).join('\n'));
  }
  if (summary.keyPoints && summary.keyPoints.length > 0) {
    parts.push('Key Points:\n' + summary.keyPoints.map(p => `- ${p}`).join('\n'));
  }
  if (summary.actionItems && summary.actionItems.length > 0) {
    parts.push('Action Items:\n' + summary.actionItems.map(a => `- ${a}`).join('\n'));
  }
  return parts.join('\n\n');
}

/**
 * Fetches the full email body for a Gmail item.
 * Extracts the thread ID from the Gmail URL and re-fetches via GmailApp.
 * Returns an empty string on any failure.
 *
 * Gmail URL format stored on items:
 *   https://mail.google.com/mail/u/0/#inbox/{threadId}
 *
 * @param {string} url
 * @returns {string}
 */
function _rawFetchGmailContent(url) {
  const match = String(url).match(/#[^/]+\/([a-f0-9]+)$/i);
  if (!match) {
    Logger.log(`RawStore: could not extract threadId from Gmail URL: ${url}`);
    return '';
  }
  try {
    const thread  = GmailApp.getThreadById(match[1]);
    const message = thread.getMessages()[0];
    // stripHtml() is defined in Utils.js
    return stripHtml(message.getBody()).slice(0, 50000);
  } catch (e) {
    Logger.log(`RawStore: Gmail body fetch failed — ${e.message}`);
    return '';
  }
}

/**
 * Fetches transcript or description text for a YouTube item.
 * First tries the YouTube timedtext API (works for most public videos with
 * auto-generated or uploaded captions). Falls back to the video description
 * via the YouTube Advanced Service if captions are unavailable.
 *
 * The description fallback is marked `isPrimary: false` even when it returns
 * plenty of characters — it's marketing copy, not the video's actual content,
 * and far thinner than Gemini's transcript-based analysis. Callers use this
 * flag (not just length) to decide whether to supplement with the full
 * Gemini summary.
 *
 * @param {string} url - YouTube video URL (https://www.youtube.com/watch?v={videoId})
 * @returns {{ text: string, isPrimary: boolean }}
 */
function _rawFetchYouTubeContent(url) {
  const match = String(url).match(/[?&]v=([^&]+)/);
  if (!match) {
    Logger.log(`RawStore: could not extract videoId from YouTube URL: ${url}`);
    return { text: '', isPrimary: false };
  }
  const videoId = match[1];

  // Attempt 1: timedtext API returns caption XML for most public videos.
  // lang=en is English-only; videos without English captions will fall through to Attempt 2.
  try {
    const timedtextUrl = `https://www.youtube.com/api/timedtext?v=${videoId}&lang=en`;
    const response = UrlFetchApp.fetch(timedtextUrl, {
      muteHttpExceptions: true,
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; PKM-Bot/1.0)' },
    });
    if (response.getResponseCode() === 200) {
      const xml = response.getContentText();
      if (xml && xml.includes('<text')) {
        const transcript = xml
          .replace(/<[^>]*>/g, ' ')
          .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
          .replace(/&#39;/g, "'").replace(/&quot;/g, '"')
          .replace(/\s+/g, ' ')
          .trim();
        if (transcript) return { text: transcript.slice(0, 50000), isPrimary: true };
      }
    }
  } catch (e) {
    Logger.log(`RawStore: YouTube timedtext fetch failed — ${e.message}`);
  }

  // Attempt 2: video description via YouTube Advanced Service
  try {
    const result = YouTube.Videos.list('snippet', { id: videoId });
    const video  = (result.items || [])[0];
    if (video && video.snippet) {
      const description = [video.snippet.title, video.snippet.description]
        .filter(Boolean).join('\n\n').slice(0, 50000);
      return { text: description, isPrimary: false };
    }
  } catch (e) {
    Logger.log(`RawStore: YouTube description fetch failed — ${e.message}`);
  }

  return { text: '', isPrimary: false };
}

/**
 * Dispatches to the correct content fetch function based on item.sourceType.
 * Returns the raw fetched text plus whether it's a primary/ground-truth source
 * (real transcript, email body, fetched article) as opposed to a thin stand-in
 * (video description, or no fetch at all).
 *
 * - Gmail:   re-fetches email body via GmailApp using threadId from URL
 * - YouTube: tries transcript (primary), falls back to description (not primary)
 * - Tasks:   fetches the web page body when item.url is a real URL (primary);
 *            skips the fetch entirely when Gemini already produced a rich
 *            summary, to avoid unnecessary quota use and paywall/redirect
 *            timeouts (UrlFetchApp has no configurable timeout; Apps Script
 *            infrastructure enforces ~30s)
 * - Capture: no raw fetch — content was user-supplied at capture time and
 *            re-fetching risks hitting a paywall the user already got past
 *
 * fetchUrlContent() is defined in Utils.js (50,000-char cap, handles failures).
 *
 * @param {Object} item    - Row object from Sheets
 * @param {Object} summary - Parsed summaryJson
 * @returns {{ text: string, isPrimary: boolean }}
 */
function _rawFetchSourceContent(item, summary) {
  switch (item.sourceType) {
    case SOURCE.GMAIL:
      return { text: _rawFetchGmailContent(item.url), isPrimary: true };

    case SOURCE.YOUTUBE:
      return _rawFetchYouTubeContent(item.url);

    case SOURCE.TASKS: {
      if (summary.fullSummary && summary.fullSummary.length > 100) {
        return { text: '', isPrimary: false };
      }
      const url = String(item.url || '');
      const isWebUrl = url.startsWith('http') && !url.includes('tasks.google.com');
      return { text: isWebUrl ? (fetchUrlContent(url) || '') : '', isPrimary: true };
    }

    case SOURCE.CAPTURE:
      return { text: '', isPrimary: false };

    default:
      return { text: '', isPrimary: false };
  }
}

/**
 * Builds the raw markdown body: the fetched source content when it's a rich
 * primary source, with the full structured Gemini summary (fullSummary +
 * keyTerms + keyPoints + actionItems) appended whenever that content is
 * missing, thin (< RAW_FETCH_THIN_THRESHOLD chars), or only ever a thin
 * stand-in (e.g. a YouTube description filling in for a missing transcript).
 *
 * @param {Object} item    - Row object from Sheets
 * @param {Object} summary - Parsed summaryJson
 * @returns {string}
 */
function _rawBuildFullText(item, summary) {
  const { text: fetched, isPrimary } = _rawFetchSourceContent(item, summary);

  if (isPrimary && fetched.length >= RAW_FETCH_THIN_THRESHOLD) {
    return fetched;
  }

  const geminiSection = _rawBuildGeminiSummarySection(summary);
  if (!geminiSection) return fetched;
  return fetched ? `${fetched}\n\n---\n\n${geminiSection}` : geminiSection;
}

/**
 * Writes a full-text markdown file for a saved item to the /PKM/raw/ Drive folder.
 * Non-fatal: all errors are logged and swallowed so the save confirmation page
 * is never blocked.
 *
 * File name format: {itemId}-{title-slug}.md
 *
 * @param {Object}   item         - Row object from Sheets (itemId, title, url, dateAdded, sourceType)
 * @param {Object}   summary      - Parsed summaryJson (shortSummary, fullSummary)
 * @param {string[]} selectedTags - User-confirmed tags
 */
function writeRawItem(item, summary, selectedTags) {
  try {
    const folderId = getOrCreateRawFolder();
    const folder   = DriveApp.getFolderById(folderId);
    const filename = item.itemId + '-' + _rawSlugify(item.title) + '.md';
    const existing = folder.getFilesByName(filename);
    if (existing.hasNext()) {
      Logger.log(`RawStore: ${filename} already exists — skipping`);
      return;
    }
    const fullText = _rawBuildFullText(item, summary);
    const markdown = _rawBuildMarkdown(item, summary, selectedTags, fullText);
    folder.createFile(filename, markdown, MimeType.PLAIN_TEXT);
    Logger.log(`RawStore: wrote "${filename}" (${markdown.length} chars, body: ${fullText.length} chars)`);
  } catch (e) {
    Logger.log(`RawStore: failed for item "${item.itemId}" — ${e.message}`);
  }
}

// ─── Test Helpers (run manually from Apps Script editor) ───────────────────────

/**
 * Smoke test: creates (or finds) the /PKM/raw/ folder and logs its Drive ID.
 * Run this first to verify Drive access before testing the full pipeline.
 */
function testRawStoreSetup() {
  const folderId = getOrCreateRawFolder();
  Logger.log(`testRawStoreSetup: raw folder ID = ${folderId}`);
  Logger.log('testRawStoreSetup: Drive access OK');
}

/**
 * End-to-end test: takes the most recent row from the Archive tab and writes
 * its raw markdown to /PKM/raw/. Open Drive → PKM → raw/ after running to
 * verify the file was created with valid frontmatter and body content.
 *
 * Uses real quota — only run when saved items exist in the Archive tab.
 */
function testWriteRawItem() {
  const archiveSheet = getSheet(TABS.ARCHIVE);
  const data = archiveSheet.getDataRange().getValues();
  if (data.length < 2) {
    Logger.log('testWriteRawItem: no rows in Archive tab — save an item first');
    return;
  }
  const row = data[data.length - 1]; // most recently saved row

  const item = {
    itemId:     String(row[COL.ITEM_ID     - 1] || ''),
    dateAdded:  String(row[COL.DATE_ADDED  - 1] || ''),
    sourceType: String(row[COL.SOURCE_TYPE - 1] || ''),
    title:      String(row[COL.TITLE       - 1] || ''),
    url:        String(row[COL.URL         - 1] || ''),
  };

  let summary = { shortSummary: '', fullSummary: '' };
  try { summary = JSON.parse(row[COL.SUMMARY_JSON - 1]); } catch (_) {}

  const selectedTags = String(row[COL.TAGS - 1] || '')
    .split(',').map(t => t.trim()).filter(Boolean);

  Logger.log(`testWriteRawItem: testing "${item.title}" (${item.sourceType})`);
  writeRawItem(item, summary, selectedTags);
  Logger.log('testWriteRawItem: done — open Drive → PKM → raw/ to verify');
}
