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
    throw new Error(`Wiki index: Gemini returned unparseable JSON — ${e.message}`);
  }
  return {
    summary: typeof parsed.summary === 'string' ? parsed.summary : '',
    topics:  Array.isArray(parsed.topics)       ? parsed.topics  : [],
  };
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
