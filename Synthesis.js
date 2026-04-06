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

// ─── Email Delivery ───────────────────────────────────────────────────────────

/**
 * Sends the weekly synthesis report as an HTML email to DIGEST_EMAIL.
 *
 * @param {{ themes: string[], gaps: string[], connections: string[], questions: string[] }} synthesis
 * @param {number} itemCount  - Number of items that were synthesized
 * @param {string} weekLabel  - ISO date string used as the report date (e.g. "2026-04-06")
 */
function sendSynthesisEmail(synthesis, itemCount, weekLabel) {
  const recipient = getProperty(PROP.DIGEST_EMAIL);
  const subject   = `PKM Weekly Synthesis — ${weekLabel}`;
  const htmlBody  = buildSynthesisEmailHtml(synthesis, itemCount, weekLabel);
  MailApp.sendEmail({ to: recipient, subject, htmlBody });
  Logger.log(`Synthesis: email sent for week of ${weekLabel}`);
}

/**
 * Builds the HTML body for the weekly synthesis email.
 * All user-derived text (synthesis output) is escaped before interpolation.
 *
 * @param {{ themes: string[], gaps: string[], connections: string[], questions: string[] }} synthesis
 * @param {number} itemCount
 * @param {string} weekLabel
 * @returns {string} Complete HTML email body
 */
function buildSynthesisEmailHtml(synthesis, itemCount, weekLabel) {
  function renderList(items) {
    if (!items || items.length === 0) {
      return '<p style="color:#888;font-size:13px;margin:0 0 8px;">None identified.</p>';
    }
    return '<ul style="margin:0 0 8px;padding-left:20px;">'
      + items.map(item =>
          `<li style="margin-bottom:8px;line-height:1.5;">${escapeHtml(item)}</li>`
        ).join('')
      + '</ul>';
  }

  function section(title, color, items) {
    return `
      <div style="margin-bottom:24px;">
        <h2 style="font-size:14px;color:${color};margin:0 0 8px;text-transform:uppercase;letter-spacing:0.5px;">${escapeHtml(title)}</h2>
        ${renderList(items)}
      </div>`;
  }

  return `
    <div style="font-family:sans-serif;max-width:640px;margin:0 auto;color:#222;">
      <h1 style="font-size:20px;border-bottom:2px solid #eee;padding-bottom:8px;">
        PKM Weekly Synthesis — ${escapeHtml(weekLabel)}
      </h1>
      <p style="color:#888;font-size:13px;margin-bottom:24px;">
        Synthesized from ${itemCount} item${itemCount !== 1 ? 's' : ''} captured this week.
      </p>
      ${section('Themes & Patterns',  '#1a73e8', synthesis.themes)}
      ${section('Knowledge Gaps',     '#e65100', synthesis.gaps)}
      ${section('Connections',        '#0f9d58', synthesis.connections)}
      ${section('Open Questions',     '#9334e6', synthesis.questions)}
      <p style="color:#999;font-size:12px;margin-top:32px;">
        Sent by your PKM system. This synthesis is also saved to your Weekly Synthesis doc in Drive.
      </p>
    </div>
  `;
}

// ─── Drive Doc ────────────────────────────────────────────────────────────────

/**
 * Returns the ID of the "Weekly Synthesis" Drive doc, creating it if needed.
 * The doc is placed in the root PKM folder (DRIVE_ROOT_FOLDER_ID).
 * The ID is cached in PROP.SYNTHESIS_DOC_ID to avoid repeated Drive scans.
 *
 * @returns {string} Google Doc file ID
 */
function getOrCreateSynthesisDoc() {
  // Use raw PropertiesService (not getProperty()) — SYNTHESIS_DOC_ID may legitimately
  // not exist on first run, and getProperty() throws on missing keys.
  const cached = PropertiesService.getScriptProperties().getProperty(PROP.SYNTHESIS_DOC_ID);
  if (cached) {
    try {
      DriveApp.getFileById(cached); // verify file still exists
      return cached;
    } catch (e) {
      Logger.log('Synthesis: cached doc ID is stale — rescanning Drive');
    }
  }

  const rootFolderId = getProperty(PROP.DRIVE_ROOT_FOLDER);
  const folder       = DriveApp.getFolderById(rootFolderId);
  const existing     = folder.getFilesByName('Weekly Synthesis');

  if (existing.hasNext()) {
    const file = existing.next();
    setProperty(PROP.SYNTHESIS_DOC_ID, file.getId());
    Logger.log(`Synthesis: found existing doc (${file.getId()})`);
    return file.getId();
  }

  const newDoc  = DocumentApp.create('Weekly Synthesis');
  const newFile = DriveApp.getFileById(newDoc.getId());
  newFile.moveTo(folder);
  setProperty(PROP.SYNTHESIS_DOC_ID, newFile.getId());
  Logger.log(`Synthesis: created "Weekly Synthesis" doc (${newFile.getId()})`);
  return newFile.getId();
}

/**
 * Appends a weekly synthesis section to the "Weekly Synthesis" Drive doc using
 * the Docs REST API batchUpdate endpoint (same pattern as appendSectionToDoc
 * in Docs.js). All mutations are sent in two HTTP calls.
 *
 * Section structure:
 *   Week of YYYY-MM-DD    — HEADING_2
 *   Themes & Patterns     — HEADING_3 + bullets
 *   Knowledge Gaps        — HEADING_3 + bullets
 *   Connections           — HEADING_3 + bullets
 *   Open Questions        — HEADING_3 + bullets
 *   separator             — bottom-border paragraph
 *
 * Throws on HTTP error so the caller can degrade gracefully to email-only.
 *
 * @param {{ themes: string[], gaps: string[], connections: string[], questions: string[] }} synthesis
 * @param {string} weekLabel - ISO date string (e.g. "2026-04-06")
 * @returns {string} URL to the Weekly Synthesis doc
 */
function appendSynthesisToDoc(synthesis, weekLabel) {
  const docId   = getOrCreateSynthesisDoc();
  const token   = ScriptApp.getOAuthToken();
  const baseUrl = 'https://docs.googleapis.com/v1/documents/' + docId;
  const auth    = { Authorization: 'Bearer ' + token };

  // ── Step 1: find the insertion point ─────────────────────────────────────────
  const getRes = UrlFetchApp.fetch(baseUrl + '?fields=body.content.endIndex', {
    headers:            auth,
    muteHttpExceptions: true,
  });
  if (getRes.getResponseCode() !== 200) {
    throw new Error('Synthesis doc GET failed (' + getRes.getResponseCode() + '): ' + getRes.getContentText());
  }
  const bodyContent = JSON.parse(getRes.getContentText()).body.content;
  const insertAt    = bodyContent[bodyContent.length - 1].endIndex - 1;

  // ── Step 2: build segments ────────────────────────────────────────────────────
  const segments = [];
  segments.push({ text: 'Week of ' + weekLabel, style: 'heading2' });

  if (synthesis.themes.length > 0) {
    segments.push({ text: 'Themes & Patterns', style: 'heading3' });
    synthesis.themes.forEach(t => segments.push({ text: t, style: 'bullet' }));
  }
  if (synthesis.gaps.length > 0) {
    segments.push({ text: 'Knowledge Gaps', style: 'heading3' });
    synthesis.gaps.forEach(g => segments.push({ text: g, style: 'bullet' }));
  }
  if (synthesis.connections.length > 0) {
    segments.push({ text: 'Connections', style: 'heading3' });
    synthesis.connections.forEach(c => segments.push({ text: c, style: 'bullet' }));
  }
  if (synthesis.questions.length > 0) {
    segments.push({ text: 'Open Questions', style: 'heading3' });
    synthesis.questions.forEach(q => segments.push({ text: q, style: 'bullet' }));
  }
  segments.push({ text: '', style: 'separator' });

  // ── Step 3: compute character ranges ─────────────────────────────────────────
  let offset = insertAt;
  segments.forEach(seg => {
    seg.start = offset;
    seg.end   = offset + seg.text.length + 1;
    offset    = seg.end;
  });

  // ── Step 4: build all batchUpdate requests ────────────────────────────────────
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
      case 'bullet':
        requests.push({
          createParagraphBullets: {
            range: { startIndex: seg.start, endIndex: seg.end },
            bulletPreset: 'BULLET_DISC_CIRCLE_SQUARE',
          },
        });
        break;
      case 'separator':
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
    method:             'post',
    contentType:        'application/json',
    headers:            auth,
    payload:            JSON.stringify({ requests }),
    muteHttpExceptions: true,
  });
  if (postRes.getResponseCode() !== 200) {
    throw new Error('Synthesis doc batchUpdate failed (' + postRes.getResponseCode() + '): ' + postRes.getContentText());
  }

  Logger.log(`Synthesis: appended week "${weekLabel}" to doc ${docId}`);
  return 'https://docs.google.com/document/d/' + docId + '/edit';
}

// ─── Orchestrator ─────────────────────────────────────────────────────────────

/**
 * Main synthesis logic. Called by runWeeklySynthesis() in Code.js.
 * Named "Internal" to avoid a global namespace collision with the Code.js trigger
 * entry point — all Apps Script .js files share one global namespace.
 *
 * Flow:
 *   1. Collect Pending + Saved items from the past 7 days
 *   2. Skip if fewer than 3 items (not enough signal)
 *   3. Call Gemini for synthesis (themes, gaps, connections, questions)
 *   4. Send synthesis email to DIGEST_EMAIL
 *   5. Append synthesis to Drive doc (failure here does not block email)
 */
function runWeeklySynthesisInternal() {
  Logger.log('--- runWeeklySynthesis start ---');

  const items = getSynthesisItems(7);
  Logger.log(`Synthesis: found ${items.length} item(s) in the past 7 days`);

  if (items.length < 3) {
    Logger.log('Synthesis: fewer than 3 items — skipping');
    Logger.log('--- runWeeklySynthesis end ---');
    return;
  }

  // weekLabel is always YYYY-MM-DD (ISO date slice) — no HTML-sensitive characters
  const weekLabel = new Date().toISOString().slice(0, 10);
  const prompt    = buildSynthesisPrompt(items);

  let synthesis;
  try {
    synthesis = callGeminiForSynthesis(prompt);
  } catch (e) {
    Logger.log(`Synthesis: Gemini call failed — ${e.message}`);
    Logger.log('--- runWeeklySynthesis end (no output) ---');
    return;
  }

  sendSynthesisEmail(synthesis, items.length, weekLabel);

  try {
    appendSynthesisToDoc(synthesis, weekLabel);
  } catch (e) {
    Logger.log(`Synthesis: doc append failed — ${e.message}`);
  }

  Logger.log('--- runWeeklySynthesis end ---');
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

/**
 * Sends a test synthesis email using real item data.
 * Delivers to DIGEST_EMAIL — check your inbox after running.
 */
function testSendSynthesisEmail() {
  const items = getSynthesisItems(7);
  if (items.length < 3) {
    Logger.log('testSendSynthesisEmail: fewer than 3 items — skipping');
    return;
  }
  const weekLabel = new Date().toISOString().slice(0, 10);
  const synthesis = callGeminiForSynthesis(buildSynthesisPrompt(items));
  sendSynthesisEmail(synthesis, items.length, weekLabel);
  Logger.log('testSendSynthesisEmail: email sent — check your inbox');
}

/**
 * Creates/finds the Weekly Synthesis doc and appends a test section.
 * Open the doc in Drive after running to verify formatting.
 */
function testAppendSynthesisToDoc() {
  const items = getSynthesisItems(7);
  if (items.length < 3) {
    Logger.log('testAppendSynthesisToDoc: fewer than 3 items — skipping');
    return;
  }
  const weekLabel = new Date().toISOString().slice(0, 10);
  const synthesis = callGeminiForSynthesis(buildSynthesisPrompt(items));
  const docUrl = appendSynthesisToDoc(synthesis, weekLabel);
  Logger.log(`testAppendSynthesisToDoc: done — open ${docUrl}`);
}
