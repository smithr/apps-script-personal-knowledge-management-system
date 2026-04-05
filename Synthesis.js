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
