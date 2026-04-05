/**
 * Synthesis.js
 * Weekly synthesis pipeline. Reads all Pending and Saved items from the past
 * N days, sends key points to Gemini for aggregate analysis, and delivers the
 * result as an email and an appended section in a persistent Drive doc.
 *
 * Entry point: runWeeklySynthesis() — called by a weekly time-driven trigger.
 */

// Delay before retrying a Gemini 429 response (milliseconds).
const SYNTHESIS_RATE_LIMIT_RETRY_DELAY_MS = 60000;

// Gemini output schema for the synthesis prompt.
const SYNTHESIS_OUTPUT_SCHEMA = `{
  "themes":      ["theme name: 2-3 sentence description of the recurring pattern"],
  "gaps":        ["knowledge gap or unanswered question implied by the captured content"],
  "connections": ["Item Title A ↔ Item Title B: one sentence on how they relate"],
  "questions":   ["open question worth exploring based on this week's captures"]
}`;

// ─── Data Preparation ─────────────────────────────────────────────────────────

/**
 * Reads both the Inbox (Pending) and Archive (Saved) tabs and returns items
 * added within the past `days` days that have parseable SUMMARY_JSON.
 * Dismissed items are excluded.
 *
 * @param {number} days - Lookback window (7 for weekly synthesis)
 * @returns {Object[]} Array of { title, sourceType, tags, keyPoints }
 */
function getSynthesisItems(days) {
  const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000); // rolling window, not calendar-week-aligned
  const result = [];

  [TABS.INBOX, TABS.ARCHIVE].forEach(tabName => {
    const sheet = getSheet(tabName);
    const data  = sheet.getDataRange().getValues();

    for (let i = 1; i < data.length; i++) {
      const row    = data[i];
      const status = row[COL.STATUS - 1];

      if (status !== STATUS.PENDING && status !== STATUS.SAVED) continue;

      const dateAdded = new Date(row[COL.DATE_ADDED - 1]);
      if (isNaN(dateAdded.getTime()) || dateAdded < cutoff) continue;

      let summaryJson;
      try {
        summaryJson = JSON.parse(row[COL.SUMMARY_JSON - 1]);
      } catch (e) {
        Logger.log(`Synthesis: could not parse SUMMARY_JSON for row ${i + 1} in ${tabName} — skipping`);
        continue;
      }

      result.push({
        title:      String(row[COL.TITLE       - 1] || ''),
        sourceType: String(row[COL.SOURCE_TYPE - 1] || ''),
        // Use summaryJson.tags (authoritative) over COL.TAGS (denormalized string, not updated post-ingest)
        tags:       Array.isArray(summaryJson.tags)      ? summaryJson.tags      : [],
        keyPoints:  Array.isArray(summaryJson.keyPoints) ? summaryJson.keyPoints : [],
      });
    }
  });

  return result;
}

/**
 * Formats the items array into a Gemini prompt string.
 *
 * @param {Object[]} items - Output of getSynthesisItems()
 * @returns {string} Complete prompt text
 */
function buildSynthesisPrompt(items) {
  const itemsText = items.map((item, i) => {
    const points = item.keyPoints.length > 0
      ? item.keyPoints.map(p => `    • ${p}`).join('\n')
      : '    (none)';
    return `Item ${i + 1}: ${item.title}
  Source: ${item.sourceType}
  Tags: ${item.tags.join(', ') || 'none'}
  Key Points:
${points}`;
  }).join('\n\n');

  return `You are an expert knowledge curator analyzing a week's worth of captured content from a personal knowledge management system.
Return ONLY a valid JSON object matching this schema — no preamble, no markdown fences:
${SYNTHESIS_OUTPUT_SCHEMA}

Instructions:
- themes: identify 3-5 recurring ideas, patterns, or topics that appear across multiple items. Name each theme clearly and describe what makes it a pattern in 2-3 sentences.
- gaps: identify 2-4 knowledge gaps or unanswered questions that the captured content implies but does not answer. What is conspicuously missing?
- connections: identify 2-4 non-obvious connections between specific items from different sources or tags that point at the same underlying concept.
- questions: identify 2-4 open questions worth exploring next week based on what was captured.

Here are the ${items.length} items captured this week:

${itemsText}`;
}

// ─── Gemini API ───────────────────────────────────────────────────────────────

/**
 * Sends the synthesis prompt to Gemini and returns parsed JSON.
 * Retries once after SYNTHESIS_RATE_LIMIT_RETRY_DELAY_MS on HTTP 429.
 * Throws on API error or unparseable response so the caller can exit cleanly.
 *
 * @param {string} prompt
 * @returns {{ themes: string[], gaps: string[], connections: string[], questions: string[] }}
 * @throws {Error} On API failure or unparseable JSON
 */
function callGeminiForSynthesis(prompt) {
  const model    = getProperty(PROP.GEMINI_MODEL);
  const apiKey   = getProperty(PROP.GEMINI_API_KEY);
  const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`;

  const payload = {
    contents: [{ parts: [{ text: prompt }] }],
    generationConfig: {
      temperature:      0.3, // slightly higher than per-item summarization — encourages associative connections
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
    Logger.log(`Synthesis: Gemini rate limit hit — retrying after ${SYNTHESIS_RATE_LIMIT_RETRY_DELAY_MS}ms`);
    Utilities.sleep(SYNTHESIS_RATE_LIMIT_RETRY_DELAY_MS);
    response = UrlFetchApp.fetch(endpoint, options);
  }

  if (response.getResponseCode() === 429) {
    throw new Error('RATE_LIMIT: Gemini rate limit persisted after retry — synthesis aborted');
  }

  const responseCode = response.getResponseCode();
  if (responseCode !== 200) {
    throw new Error(`Gemini API returned HTTP ${responseCode}: ${response.getContentText().slice(0, 200)}`);
  }
  const jsonResponse = JSON.parse(response.getContentText());
  if (!jsonResponse.candidates || !jsonResponse.candidates[0]) {
    throw new Error(`Gemini API error: ${response.getContentText()}`);
  }

  const usage = jsonResponse.usageMetadata;
  if (usage) {
    Logger.log(`Synthesis Gemini tokens — prompt: ${usage.promptTokenCount}, output: ${usage.candidatesTokenCount}, total: ${usage.totalTokenCount}`);
  }

  const rawText = jsonResponse.candidates[0].content.parts[0].text || '';
  return parseSynthesisJson(rawText);
}

/**
 * Parses Gemini's synthesis JSON response.
 * Normalises each field to an array so callers never receive undefined.
 *
 * @param {string} rawText
 * @returns {{ themes: string[], gaps: string[], connections: string[], questions: string[] }}
 * @throws {Error} If no JSON object is found or JSON.parse fails
 */
function parseSynthesisJson(rawText) {
  const start = rawText.indexOf('{');
  const end   = rawText.lastIndexOf('}');
  if (start === -1 || end === -1 || end < start) {
    throw new Error('Gemini synthesis response contained no JSON object');
  }
  let parsed;
  try {
    parsed = JSON.parse(rawText.slice(start, end + 1));
  } catch (e) {
    throw new Error(`Synthesis: Gemini returned unparseable JSON — ${e.message}. Raw prefix: ${rawText.slice(0, 120)}`);
  }
  return {
    themes:      Array.isArray(parsed.themes)      ? parsed.themes      : [],
    gaps:        Array.isArray(parsed.gaps)         ? parsed.gaps        : [],
    connections: Array.isArray(parsed.connections)  ? parsed.connections : [],
    questions:   Array.isArray(parsed.questions)    ? parsed.questions   : [],
  };
}

// ─── Test Helpers (run manually from Apps Script editor) ──────────────────────

/**
 * Logs the items getSynthesisItems would pass to Gemini.
 * Run from the Apps Script editor to verify data collection before going live.
 */
function testGetSynthesisItems() {
  const items = getSynthesisItems(7);
  Logger.log(`getSynthesisItems: found ${items.length} item(s)`);
  items.forEach((item, i) => {
    Logger.log(`  [${i + 1}] ${item.title} (${item.sourceType}) — ${item.keyPoints.length} key points`);
  });
  if (items.length > 0) {
    Logger.log('--- Prompt preview (first 500 chars) ---');
    Logger.log(buildSynthesisPrompt(items).slice(0, 500));
  }
}

/**
 * Calls Gemini with real item data and logs the parsed synthesis result.
 * Run from the Apps Script editor to verify the Gemini integration end-to-end.
 * Uses real quota — only run when you have items in the sheet.
 */
function testCallGeminiForSynthesis() {
  const items = getSynthesisItems(7);
  if (items.length < 3) {
    Logger.log('testCallGeminiForSynthesis: fewer than 3 items — skipping (add test data or extend lookback)');
    return;
  }
  const prompt    = buildSynthesisPrompt(items);
  const synthesis = callGeminiForSynthesis(prompt);
  Logger.log('Themes: ' + JSON.stringify(synthesis.themes, null, 2));
  Logger.log('Gaps: '   + JSON.stringify(synthesis.gaps,   null, 2));
  Logger.log('Connections: ' + JSON.stringify(synthesis.connections, null, 2));
  Logger.log('Questions: '   + JSON.stringify(synthesis.questions,   null, 2));
}
