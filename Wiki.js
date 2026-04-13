/**
 * Wiki.js
 * Weekly wiki generation pipeline. Reads all saved items from the library index,
 * groups them by Config topic group, and generates one Google Doc per group plus
 * a top-level Wiki Index doc via Gemini.
 *
 * Entry point: buildWiki() — called by runWeeklyWiki() in Code.js.
 */

// Delay between per-group Gemini calls to avoid rate limits (milliseconds).
const WIKI_GEMINI_DELAY_MS = 2000;

// Delay before retrying a Gemini 429 response (milliseconds).
const WIKI_RATE_LIMIT_RETRY_DELAY_MS = 60000;

/**
 * Returns the Script Property key used to cache a wiki doc ID for a given group.
 * Group name is uppercased and non-alphanumeric characters replaced with underscores
 * so the key is safe for Script Properties storage.
 *
 * @param {string} groupName
 * @returns {string} e.g. 'WIKI_DOC_MACHINE_LEARNING'
 */
function wikiDocPropKey(groupName) {
  return 'WIKI_DOC_' + groupName.toUpperCase().replace(/[^A-Z0-9]/g, '_');
}

/**
 * Reads the Config sheet and returns all unique topic groups with their associated tags.
 * Groups are derived from column C (group name); when column C is blank the tag name
 * (column A) is used as the group — the same logic as getTagConfig() in Sheets.js.
 *
 * Tags sharing the same group name are consolidated into one wiki article, mirroring
 * how they are consolidated into one Topic Doc by Docs.js.
 *
 * @returns {Array<{group: string, tags: string[]}>}
 */
function getWikiGroups() {
  const sheet = getSheet(TABS.CONFIG);
  const data  = sheet.getDataRange().getValues();

  const groupMap = {}; // group → [tags]

  data.slice(1).forEach(row => { // slice(1) skips the header row explicitly
    const tag      = String(row[0] || '').trim();
    const folderId = String(row[1] || '').trim();
    if (!tag || !folderId) return; // skip rows with no tag or no folder configured

    const group = String(row[2] || '').trim() || tag;
    if (!groupMap[group]) groupMap[group] = [];
    if (!groupMap[group].includes(tag)) groupMap[group].push(tag);
  });

  return Object.keys(groupMap).map(group => ({ group, tags: groupMap[group] }));
}

// ─── Per-Group Article Generation ─────────────────────────────────────────────

/**
 * Builds the Gemini prompt for a single topic group wiki article.
 * Uses shortSummary (not fullSummary) to keep token cost bounded.
 *
 * @param {string}   groupName  - The topic group name (e.g. "Machine Learning")
 * @param {Object[]} items      - Library index items belonging to this group
 * @param {string[]} allGroups  - All group names (used to prompt for related topics)
 * @returns {string} Complete prompt text
 */
function buildWikiPrompt(groupName, items, allGroups) {
  const otherGroups = allGroups.filter(g => g !== groupName);

  const itemsText = items.map((item, i) =>
    `Item ${i + 1}: ${item.title}
  Date: ${(item.date || '').slice(0, 10)}
  Source: ${item.sourceType}
  Tags: ${(item.tags || []).join(', ')}
  Summary: ${item.shortSummary || '(none)'}`
  ).join('\n\n');

  const schema = `{
  "overview": "3-5 sentence narrative synthesis of what this topic is about",
  "keyTerms": [{"term": "term name", "definition": "one sentence definition"}],
  "recurringThemes": ["pattern or idea that appears across multiple items"],
  "actionItems": ["concrete action item from the collected material"],
  "relatedTopics": [{"group": "group name from the provided list", "reason": "one sentence explaining the connection"}]
}`;

  return `You are maintaining a personal knowledge wiki for the topic "${groupName}".
Return ONLY a valid JSON object matching this schema — no preamble, no markdown fences:
${schema}

Instructions:
- overview: 3-5 sentences synthesizing what this topic is about based on all saved items
- keyTerms: compiled glossary of important terms across all items; deduplicate entries where the same term appears in multiple items, merging their definitions into one
- recurringThemes: 3-5 patterns or ideas that appear across multiple items; omit themes mentioned in only one item
- actionItems: aggregate concrete action items from all items; deduplicate and omit vague ones like "learn more"
- relatedTopics: from the list [${otherGroups.join(', ')}], identify topics that connect to "${groupName}" and explain why in one sentence each; omit groups with no clear connection

Here are the ${items.length} saved items for "${groupName}":

${itemsText}`;
}

/**
 * Sends a wiki article prompt to Gemini and returns parsed JSON.
 * Retries once after 60 seconds on HTTP 429.
 * Throws on API error or unparseable response.
 *
 * @param {string} prompt
 * @returns {{ overview: string, keyTerms: Array, recurringThemes: string[], actionItems: string[], relatedTopics: Array }}
 * @throws {Error}
 */
function callGeminiForWiki(prompt) {
  const model    = getProperty(PROP.GEMINI_MODEL);
  const apiKey   = getProperty(PROP.GEMINI_API_KEY);
  const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`;

  const payload = {
    contents: [{ parts: [{ text: prompt }] }],
    generationConfig: {
      temperature:      0.3,
      responseMimeType: 'application/json',
    },
  };

  const options = {
    method:             'post',
    contentType:        'application/json',
    headers:            { 'x-goog-api-key': apiKey },
    payload:            JSON.stringify(payload),
    muteHttpExceptions: true,
  };

  let response = UrlFetchApp.fetch(endpoint, options);

  if (response.getResponseCode() === 429) {
    Logger.log(`Wiki: Gemini rate limit — retrying after ${WIKI_RATE_LIMIT_RETRY_DELAY_MS}ms`);
    Utilities.sleep(WIKI_RATE_LIMIT_RETRY_DELAY_MS);
    response = UrlFetchApp.fetch(endpoint, options);
  }

  if (response.getResponseCode() === 429) {
    throw new Error('RATE_LIMIT: Gemini rate limit persisted after retry — wiki article aborted');
  }

  const code = response.getResponseCode();
  if (code !== 200) {
    throw new Error(`Wiki: Gemini API returned HTTP ${code}: ${response.getContentText().slice(0, 200)}`);
  }

  const jsonResponse = JSON.parse(response.getContentText());
  if (!jsonResponse.candidates || !jsonResponse.candidates[0]) {
    throw new Error(`Wiki: Gemini API error: ${response.getContentText()}`);
  }

  const usage = jsonResponse.usageMetadata;
  if (usage) {
    Logger.log(`Wiki Gemini tokens — prompt: ${usage.promptTokenCount}, output: ${usage.candidatesTokenCount}, total: ${usage.totalTokenCount}`);
  }

  const rawText = jsonResponse.candidates[0].content.parts[0].text || '';
  return parseWikiJson(rawText);
}

/**
 * Parses Gemini's wiki article JSON response.
 * Normalises each field so callers never receive undefined.
 *
 * @param {string} rawText
 * @returns {{ overview: string, keyTerms: Array, recurringThemes: string[], actionItems: string[], relatedTopics: Array }}
 * @throws {Error} If no JSON object found or JSON.parse fails
 */
function parseWikiJson(rawText) {
  const start = rawText.indexOf('{');
  const end   = rawText.lastIndexOf('}');
  if (start === -1 || end === -1 || end < start) {
    throw new Error('Wiki: Gemini response contained no JSON object');
  }
  let parsed;
  try {
    parsed = JSON.parse(rawText.slice(start, end + 1));
  } catch (e) {
    throw new Error(`Wiki: Gemini returned unparseable JSON — ${e.message}. Raw prefix: ${rawText.slice(0, 120)}`);
  }
  return {
    overview:        typeof parsed.overview === 'string'     ? parsed.overview        : '',
    keyTerms:        Array.isArray(parsed.keyTerms)          ? parsed.keyTerms        : [],
    recurringThemes: Array.isArray(parsed.recurringThemes)   ? parsed.recurringThemes : [],
    actionItems:     Array.isArray(parsed.actionItems)       ? parsed.actionItems     : [],
    relatedTopics:   Array.isArray(parsed.relatedTopics)     ? parsed.relatedTopics   : [],
  };
}

// ─── Wiki Index Generation ─────────────────────────────────────────────────────

/**
 * Builds the Gemini prompt for the Wiki Index doc.
 * Each group contributes its generated overview paragraph.
 *
 * @param {Array<{group: string, overview: string}>} groupArticles
 * @returns {string}
 */
function buildIndexPrompt(groupArticles) {
  const topicsText = groupArticles.map(a => `${a.group}:\n${a.overview}`).join('\n\n');

  const schema = `{
  "summary": "one paragraph (3-5 sentences) describing the full knowledge base",
  "topics": [{"group": "group name", "description": "one-line description under 100 characters"}]
}`;

  return `You are summarizing a personal knowledge base index.
Return ONLY a valid JSON object matching this schema — no preamble, no markdown fences:
${schema}

Instructions:
- summary: 3-5 sentences describing the overall knowledge base, its main themes, and how the topics relate to each other
- topics: for each topic below, write a crisp one-line description (under 100 characters) that captures its essence; preserve the group name exactly as given

Here are the ${groupArticles.length} topic overviews:

${topicsText}`;
}

/**
 * Sends the index prompt to Gemini and returns parsed JSON.
 * Same retry/error pattern as callGeminiForWiki.
 *
 * @param {string} prompt
 * @returns {{ summary: string, topics: Array<{group: string, description: string}> }}
 * @throws {Error}
 */
function callGeminiForIndex(prompt) {
  const model    = getProperty(PROP.GEMINI_MODEL);
  const apiKey   = getProperty(PROP.GEMINI_API_KEY);
  const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`;

  const payload = {
    contents: [{ parts: [{ text: prompt }] }],
    generationConfig: {
      temperature:      0.3,
      responseMimeType: 'application/json',
    },
  };

  const options = {
    method:             'post',
    contentType:        'application/json',
    headers:            { 'x-goog-api-key': apiKey },
    payload:            JSON.stringify(payload),
    muteHttpExceptions: true,
  };

  let response = UrlFetchApp.fetch(endpoint, options);

  if (response.getResponseCode() === 429) {
    Logger.log(`Wiki index: Gemini rate limit — retrying after ${WIKI_RATE_LIMIT_RETRY_DELAY_MS}ms`);
    Utilities.sleep(WIKI_RATE_LIMIT_RETRY_DELAY_MS);
    response = UrlFetchApp.fetch(endpoint, options);
  }

  if (response.getResponseCode() === 429) {
    throw new Error('RATE_LIMIT: Gemini rate limit persisted after retry — wiki index aborted');
  }

  const code = response.getResponseCode();
  if (code !== 200) {
    throw new Error(`Wiki index: Gemini API returned HTTP ${code}: ${response.getContentText().slice(0, 200)}`);
  }

  const jsonResponse = JSON.parse(response.getContentText());
  if (!jsonResponse.candidates || !jsonResponse.candidates[0]) {
    throw new Error(`Wiki index: Gemini API error: ${response.getContentText()}`);
  }

  const usage = jsonResponse.usageMetadata;
  if (usage) {
    Logger.log(`Wiki index Gemini tokens — prompt: ${usage.promptTokenCount}, output: ${usage.candidatesTokenCount}, total: ${usage.totalTokenCount}`);
  }

  const rawText = jsonResponse.candidates[0].content.parts[0].text || '';
  return parseIndexJson(rawText);
}

/**
 * Parses Gemini's wiki index JSON response.
 *
 * @param {string} rawText
 * @returns {{ summary: string, topics: Array<{group: string, description: string}> }}
 * @throws {Error}
 */
function parseIndexJson(rawText) {
  const start = rawText.indexOf('{');
  const end   = rawText.lastIndexOf('}');
  if (start === -1 || end === -1 || end < start) {
    throw new Error('Wiki index: Gemini response contained no JSON object');
  }
  let parsed;
  try {
    parsed = JSON.parse(rawText.slice(start, end + 1));
  } catch (e) {
    throw new Error(`Wiki index: Gemini returned unparseable JSON — ${e.message}. Raw prefix: ${rawText.slice(0, 120)}`);
  }
  return {
    summary: typeof parsed.summary === 'string' ? parsed.summary : '',
    topics:  Array.isArray(parsed.topics)       ? parsed.topics  : [],
  };
}

// ─── Drive / Doc Helpers ───────────────────────────────────────────────────────

/**
 * Returns the Drive folder ID for the /Wiki/ subfolder, creating it if needed.
 * The folder lives inside DRIVE_ROOT_FOLDER_ID. ID is cached in PROP.WIKI_FOLDER_ID.
 *
 * @returns {string} Drive folder ID
 */
function getOrCreateWikiFolder() {
  const props  = PropertiesService.getScriptProperties();
  const cached = props.getProperty(PROP.WIKI_FOLDER_ID);
  if (cached) {
    try {
      DriveApp.getFolderById(cached);
      return cached;
    } catch (e) {
      Logger.log('Wiki: cached folder ID stale — rescanning Drive');
    }
  }
  const rootFolder = DriveApp.getFolderById(getProperty(PROP.DRIVE_ROOT_FOLDER));
  const existing   = rootFolder.getFoldersByName('Wiki');
  const folder     = existing.hasNext() ? existing.next() : rootFolder.createFolder('Wiki');
  props.setProperty(PROP.WIKI_FOLDER_ID, folder.getId());
  Logger.log(`Wiki: folder ready (${folder.getId()})`);
  return folder.getId();
}

/**
 * Returns the Doc ID for a group's wiki article, creating it if needed.
 * Doc is placed in the /Wiki/ subfolder. ID is cached using wikiDocPropKey(groupName).
 * The doc title format is "[groupName] — Knowledge Wiki".
 *
 * @param {string} groupName
 * @returns {string} Google Doc ID
 */
function getOrCreateWikiDoc(groupName) {
  const propKey = wikiDocPropKey(groupName);
  const props   = PropertiesService.getScriptProperties();
  const cached  = props.getProperty(propKey);
  if (cached) {
    try {
      DriveApp.getFileById(cached);
      return cached;
    } catch (e) {
      Logger.log(`Wiki: cached doc ID stale for "${groupName}" — recreating`);
    }
  }
  const folderId = getOrCreateWikiFolder();
  const folder   = DriveApp.getFolderById(folderId);
  const docTitle = groupName + ' — Knowledge Wiki';
  const existing = folder.getFilesByName(docTitle);
  let docId;
  if (existing.hasNext()) {
    docId = existing.next().getId();
    Logger.log(`Wiki: found existing doc for "${groupName}" (${docId})`);
  } else {
    const doc  = DocumentApp.create(docTitle);
    const file = DriveApp.getFileById(doc.getId());
    file.moveTo(folder);
    docId = doc.getId();
    Logger.log(`Wiki: created doc for "${groupName}" (${docId})`);
  }
  props.setProperty(propKey, docId);
  return docId;
}

/**
 * Returns the Doc ID for the Wiki Index doc, creating it if needed.
 * Doc is placed in the /Wiki/ subfolder. ID is cached in PROP.WIKI_INDEX_DOC_ID.
 *
 * @returns {string} Google Doc ID
 */
function getOrCreateWikiIndexDoc() {
  const props  = PropertiesService.getScriptProperties();
  const cached = props.getProperty(PROP.WIKI_INDEX_DOC_ID);
  if (cached) {
    try {
      DriveApp.getFileById(cached);
      return cached;
    } catch (e) {
      Logger.log('Wiki: cached index doc ID stale — recreating');
    }
  }
  const folderId = getOrCreateWikiFolder();
  const folder   = DriveApp.getFolderById(folderId);
  const existing = folder.getFilesByName('Wiki Index');
  let docId;
  if (existing.hasNext()) {
    docId = existing.next().getId();
    Logger.log(`Wiki: found existing index doc (${docId})`);
  } else {
    const doc  = DocumentApp.create('Wiki Index');
    const file = DriveApp.getFileById(doc.getId());
    file.moveTo(folder);
    docId = doc.getId();
    Logger.log(`Wiki: created index doc (${docId})`);
  }
  props.setProperty(PROP.WIKI_INDEX_DOC_ID, docId);
  return docId;
}

/**
 * Returns the Drive URL for the Wiki Index doc, or null if it has not been
 * generated yet (PROP.WIKI_INDEX_DOC_ID not set).
 * Used by WebApp.js to render a nav link without triggering doc creation.
 *
 * @returns {string|null}
 */
function getWikiIndexDocUrl() {
  const docId = PropertiesService.getScriptProperties()
    .getProperty(PROP.WIKI_INDEX_DOC_ID);
  return docId ? 'https://docs.google.com/document/d/' + docId + '/edit' : null;
}

// ─── Doc Writers ──────────────────────────────────────────────────────────────

/**
 * Replaces the content of a wiki article doc with freshly generated content.
 * Uses two Docs REST API calls: GET to find the body length, batchUpdate to
 * delete old content and insert new plain text.
 *
 * Doc format (plain text, section headers in ALL CAPS):
 *   [Group Name] — Knowledge Wiki
 *   Last updated: YYYY-MM-DD
 *   ─────────────────────────────
 *   OVERVIEW / KEY TERMS / RECURRING THEMES / ACTION ITEMS /
 *   RECENT ADDITIONS (last 5) / RELATED TOPICS
 *
 * @param {string}   docId       - Google Doc ID
 * @param {string}   groupName   - Topic group name
 * @param {Object}   wikiData    - Parsed result from parseWikiJson()
 * @param {Object[]} recentItems - Up to 5 most-recent library items for this group
 */
function writeWikiDoc(docId, groupName, wikiData, recentItems) {
  const token   = ScriptApp.getOAuthToken();
  const baseUrl = 'https://docs.googleapis.com/v1/documents/' + docId;
  const auth    = { Authorization: 'Bearer ' + token };

  // Step 1: GET current body length
  const getRes = UrlFetchApp.fetch(baseUrl + '?fields=body.content.endIndex', {
    headers:            auth,
    muteHttpExceptions: true,
  });
  if (getRes.getResponseCode() !== 200) {
    throw new Error(`Wiki: doc GET failed (${getRes.getResponseCode()}): ${getRes.getContentText()}`);
  }
  const bodyContent = JSON.parse(getRes.getContentText()).body.content;
  const endIndex    = bodyContent[bodyContent.length - 1].endIndex;

  // Step 2: Build plain-text content
  const dateLabel = new Date().toISOString().slice(0, 10);
  const lines     = [];

  lines.push(groupName + ' — Knowledge Wiki');
  lines.push('Last updated: ' + dateLabel);
  lines.push('─────────────────────────────');
  lines.push('');

  lines.push('OVERVIEW');
  lines.push(wikiData.overview || '(none)');
  lines.push('');

  lines.push('KEY TERMS');
  if (wikiData.keyTerms.length > 0) {
    wikiData.keyTerms.forEach(kt => lines.push((kt.term || '') + ': ' + (kt.definition || '')));
  } else {
    lines.push('(none)');
  }
  lines.push('');

  lines.push('RECURRING THEMES');
  if (wikiData.recurringThemes.length > 0) {
    wikiData.recurringThemes.forEach(t => lines.push('• ' + t));
  } else {
    lines.push('(none)');
  }
  lines.push('');

  lines.push('ACTION ITEMS');
  if (wikiData.actionItems.length > 0) {
    wikiData.actionItems.forEach(a => lines.push('• ' + a));
  } else {
    lines.push('(none)');
  }
  lines.push('');

  lines.push('RECENT ADDITIONS (last 5)');
  if (recentItems.length > 0) {
    recentItems.forEach(item =>
      lines.push((item.date || '').slice(0, 10) + ' — ' + (item.title || '(untitled)') + ': ' + (item.shortSummary || ''))
    );
  } else {
    lines.push('(none)');
  }
  lines.push('');

  lines.push('RELATED TOPICS');
  if (wikiData.relatedTopics.length > 0) {
    wikiData.relatedTopics.forEach(rt =>
      lines.push((rt.group || '') + ': ' + (rt.reason || ''))
    );
  } else {
    lines.push('(none)');
  }

  const newText = lines.join('\n');

  // Step 3: batchUpdate — delete existing content then insert new text
  const requests = [];
  if (endIndex > 2) {
    requests.push({ deleteContentRange: { range: { startIndex: 1, endIndex: endIndex - 1 } } });
  }
  requests.push({ insertText: { location: { index: 1 }, text: newText } });

  const postRes = UrlFetchApp.fetch(baseUrl + ':batchUpdate', {
    method:             'post',
    contentType:        'application/json',
    headers:            auth,
    payload:            JSON.stringify({ requests }),
    muteHttpExceptions: true,
  });
  if (postRes.getResponseCode() !== 200) {
    throw new Error(`Wiki: doc batchUpdate failed (${postRes.getResponseCode()}): ${postRes.getContentText()}`);
  }
  Logger.log(`Wiki: wrote article for "${groupName}" (${docId})`);
}

/**
 * Replaces the content of the Wiki Index doc.
 * Lists all groups with their Gemini-generated one-line descriptions and doc URLs.
 *
 * @param {string}   docId         - Wiki Index doc ID
 * @param {Object}   indexData     - Parsed result from parseIndexJson()
 * @param {Array<{group: string, overview: string, docId: string}>} groupArticles
 */
function writeIndexDoc(docId, indexData, groupArticles) {
  const token   = ScriptApp.getOAuthToken();
  const baseUrl = 'https://docs.googleapis.com/v1/documents/' + docId;
  const auth    = { Authorization: 'Bearer ' + token };

  const getRes = UrlFetchApp.fetch(baseUrl + '?fields=body.content.endIndex', {
    headers:            auth,
    muteHttpExceptions: true,
  });
  if (getRes.getResponseCode() !== 200) {
    throw new Error(`Wiki index: doc GET failed (${getRes.getResponseCode()}): ${getRes.getContentText()}`);
  }
  const bodyContent = JSON.parse(getRes.getContentText()).body.content;
  const endIndex    = bodyContent[bodyContent.length - 1].endIndex;

  const dateLabel = new Date().toISOString().slice(0, 10);
  const lines     = [];

  lines.push('PKM Knowledge Base — Wiki Index');
  lines.push('Last updated: ' + dateLabel);
  lines.push('─────────────────────────────');
  lines.push('');

  lines.push('OVERVIEW');
  lines.push(indexData.summary || '(none)');
  lines.push('');

  lines.push('TOPICS');

  // Build a map of group → Gemini-generated description for fast lookup
  const descMap = {};
  (indexData.topics || []).forEach(t => { if (t && t.group) descMap[t.group] = t.description || ''; });

  groupArticles.forEach(a => {
    const desc   = descMap[a.group] || '';
    const docUrl = 'https://docs.google.com/document/d/' + a.docId + '/edit';
    lines.push(a.group + (desc ? ': ' + desc : '') + '\n  ' + docUrl);
  });

  const newText = lines.join('\n');

  const requests = [];
  if (endIndex > 2) {
    requests.push({ deleteContentRange: { range: { startIndex: 1, endIndex: endIndex - 1 } } });
  }
  requests.push({ insertText: { location: { index: 1 }, text: newText } });

  const postRes = UrlFetchApp.fetch(baseUrl + ':batchUpdate', {
    method:             'post',
    contentType:        'application/json',
    headers:            auth,
    payload:            JSON.stringify({ requests }),
    muteHttpExceptions: true,
  });
  if (postRes.getResponseCode() !== 200) {
    throw new Error(`Wiki index: batchUpdate failed (${postRes.getResponseCode()}): ${postRes.getContentText()}`);
  }
  Logger.log(`Wiki: index written (${docId})`);
}

// ─── Test Helpers (run manually from Apps Script editor) ──────────────────────

/**
 * Logs all wiki groups and their associated tags.
 * Run from the Apps Script editor to verify Config sheet parsing before going live.
 */
function testGetWikiGroups() {
  const groups = getWikiGroups();
  Logger.log(`getWikiGroups: found ${groups.length} group(s)`);
  groups.forEach(g => Logger.log(`  "${g.group}": [${g.tags.join(', ')}]`));
}

/**
 * Calls Gemini with real library data for the first configured group and logs
 * the parsed wiki article result. Uses real quota — only run when you have saved items.
 */
function testCallGeminiForWiki() {
  const groups = getWikiGroups();
  if (groups.length === 0) {
    Logger.log('testCallGeminiForWiki: no configured groups — add rows to the Config sheet');
    return;
  }
  const { group, tags } = groups[0];
  const index  = readLibraryIndex();
  const tagSet = new Set(tags.map(t => t.toLowerCase()));
  const items  = (index.items || []).filter(item =>
    (item.tags || []).some(t => tagSet.has(t.toLowerCase()))
  );
  if (items.length === 0) {
    Logger.log(`testCallGeminiForWiki: no library items for group "${group}"`);
    return;
  }
  Logger.log(`testCallGeminiForWiki: testing group "${group}" with ${items.length} item(s)`);
  const allGroups = groups.map(g => g.group);
  const prompt    = buildWikiPrompt(group, items, allGroups);
  const wikiData  = callGeminiForWiki(prompt);
  Logger.log('Overview: '         + wikiData.overview);
  Logger.log('Key Terms: '        + JSON.stringify(wikiData.keyTerms,        null, 2));
  Logger.log('Recurring Themes: ' + JSON.stringify(wikiData.recurringThemes, null, 2));
  Logger.log('Action Items: '     + JSON.stringify(wikiData.actionItems,     null, 2));
  Logger.log('Related Topics: '   + JSON.stringify(wikiData.relatedTopics,   null, 2));
}

/**
 * Creates (or finds) the Wiki folder and Wiki Index doc without generating any content.
 * Run from the Apps Script editor to verify Drive permissions and folder creation.
 */
function testSetupWikiFolderAndDocs() {
  const folderId = getOrCreateWikiFolder();
  Logger.log('Wiki folder ID: ' + folderId);
  const indexDocId = getOrCreateWikiIndexDoc();
  Logger.log('Wiki Index doc ID: ' + indexDocId);
  Logger.log('Wiki Index URL: https://docs.google.com/document/d/' + indexDocId + '/edit');
  const groups = getWikiGroups();
  groups.forEach(({ group }) => {
    const docId = getOrCreateWikiDoc(group);
    Logger.log(`Doc for "${group}": https://docs.google.com/document/d/${docId}/edit`);
  });
}
