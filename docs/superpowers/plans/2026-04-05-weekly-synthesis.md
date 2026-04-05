# Weekly Synthesis Pipeline Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a `runWeeklySynthesis()` pipeline that reads all Pending and Saved items from the past 7 days, sends them to Gemini in one pass, and delivers a structured insight report (themes, gaps, connections, open questions) as both an email and an appended section in a persistent Drive doc.

**Architecture:** New `Synthesis.js` file owns all synthesis logic. `Code.js` gains one new entry point. `Config.js` gains one new `PROP` key. No other files are modified.

**Tech Stack:** Google Apps Script (V8), Gemini REST API, Google Docs REST API batchUpdate, MailApp, DriveApp, DocumentApp, clasp for deployment.

---

## File Map

| Action | File | What changes |
|--------|------|-------------|
| Modify | `Config.js` | Add `SYNTHESIS_DOC_ID` to `PROP` constant |
| Create | `Synthesis.js` | All synthesis functions |
| Modify | `Code.js` | Add `runWeeklySynthesis()` entry point |

---

## Task 1: Add PROP.SYNTHESIS_DOC_ID to Config.js

**Files:**
- Modify: `Config.js`

- [ ] **Step 1: Open Config.js and add the new PROP key**

In `Config.js`, find the `PROP` constant (around line 8). Add `SYNTHESIS_DOC_ID` after `TOPIC_DOC_CACHE`:

```javascript
const PROP = {
  GEMINI_API_KEY:       'GEMINI_API_KEY',
  GEMINI_MODEL:         'GEMINI_MODEL',
  YOUTUBE_PLAYLIST_ID:  'YOUTUBE_PLAYLIST_ID',
  TASKS_LIST_ID:        'TASKS_LIST_ID',
  GMAIL_LABEL:          'GMAIL_LABEL',
  DIGEST_EMAIL:         'DIGEST_EMAIL',
  WEBAPP_URL:           'WEBAPP_URL',
  SHEET_ID:             'SHEET_ID',
  DRIVE_ROOT_FOLDER:    'DRIVE_ROOT_FOLDER_ID',
  PROCESSED_IDS:        'PROCESSED_IDS',
  LIBRARY_INDEX_FILE_ID: 'LIBRARY_INDEX_FILE_ID',
  TOPIC_DOC_CACHE:       'TOPIC_DOC_CACHE',
  SYNTHESIS_DOC_ID:      'SYNTHESIS_DOC_ID',   // cached ID of the Weekly Synthesis doc
};
```

- [ ] **Step 2: Push to Apps Script**

```bash
clasp push
```

Expected: `Pushed N files.`

- [ ] **Step 3: Commit**

```bash
git add Config.js
git commit -m "feat: add PROP.SYNTHESIS_DOC_ID for weekly synthesis doc cache"
```

---

## Task 2: Implement getSynthesisItems and buildSynthesisPrompt

These two functions are the data-preparation layer. `getSynthesisItems` reads both sheet tabs and returns parsed item data. `buildSynthesisPrompt` formats that data into a Gemini prompt string.

**Files:**
- Create: `Synthesis.js`

- [ ] **Step 1: Create Synthesis.js with getSynthesisItems**

Create `Synthesis.js` with the following content:

```javascript
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
  "connections": ["Item Title A \u2194 Item Title B: one sentence on how they relate"],
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
  const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
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
      ? item.keyPoints.map(p => `    \u2022 ${p}`).join('\n')
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
```

- [ ] **Step 2: Add a test helper to verify getSynthesisItems**

Append this to `Synthesis.js`:

```javascript
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
```

- [ ] **Step 3: Push to Apps Script**

```bash
clasp push
```

- [ ] **Step 4: Run testGetSynthesisItems in the Apps Script editor**

In the Apps Script editor, select `testGetSynthesisItems` from the function dropdown and click Run.

Expected in Logs:
- `getSynthesisItems: found N item(s)` where N ≥ 0
- One log line per item showing title, source, and key point count
- A prompt preview showing correctly formatted item text

If N = 0 and you have recent items in your sheet, verify that their `DATE_ADDED` column contains valid ISO timestamp strings and their `STATUS` is `Pending` or `Saved`.

- [ ] **Step 5: Commit**

```bash
git add Synthesis.js
git commit -m "feat: add getSynthesisItems and buildSynthesisPrompt"
```

---

## Task 3: Implement callGeminiForSynthesis and parseSynthesisJson

**Files:**
- Modify: `Synthesis.js`

- [ ] **Step 1: Add callGeminiForSynthesis and parseSynthesisJson to Synthesis.js**

Add these functions after `buildSynthesisPrompt` (before the test helpers block):

```javascript
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
    Logger.log(`Synthesis: Gemini rate limit hit — retrying after ${SYNTHESIS_RATE_LIMIT_RETRY_DELAY_MS}ms`);
    Utilities.sleep(SYNTHESIS_RATE_LIMIT_RETRY_DELAY_MS);
    response = UrlFetchApp.fetch(endpoint, options);
  }

  if (response.getResponseCode() === 429) {
    throw new Error('RATE_LIMIT: Gemini rate limit persisted after retry — synthesis aborted');
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
  const parsed = JSON.parse(rawText.slice(start, end + 1));
  return {
    themes:      Array.isArray(parsed.themes)      ? parsed.themes      : [],
    gaps:        Array.isArray(parsed.gaps)         ? parsed.gaps        : [],
    connections: Array.isArray(parsed.connections)  ? parsed.connections : [],
    questions:   Array.isArray(parsed.questions)    ? parsed.questions   : [],
  };
}
```

- [ ] **Step 2: Add a test helper for the Gemini call**

Add to the test helpers block in `Synthesis.js`:

```javascript
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
```

- [ ] **Step 3: Push to Apps Script**

```bash
clasp push
```

- [ ] **Step 4: Run testCallGeminiForSynthesis in the Apps Script editor**

Select `testCallGeminiForSynthesis` and click Run.

Expected in Logs:
- Token usage line: `Synthesis Gemini tokens — prompt: N, output: N, total: N`
- Four JSON arrays logged for themes, gaps, connections, questions
- Each array has 2-5 string entries

If you get `Gemini API error`, check that `GEMINI_API_KEY` and `GEMINI_MODEL` are set in Script Properties.

- [ ] **Step 5: Commit**

```bash
git add Synthesis.js
git commit -m "feat: add callGeminiForSynthesis and parseSynthesisJson"
```

---

## Task 4: Implement sendSynthesisEmail and buildSynthesisEmailHtml

**Files:**
- Modify: `Synthesis.js`

- [ ] **Step 1: Add sendSynthesisEmail and buildSynthesisEmailHtml to Synthesis.js**

Add these functions after `parseSynthesisJson` (before the test helpers block):

```javascript
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
  const subject   = `PKM Weekly Synthesis \u2014 ${weekLabel}`;
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
        PKM Weekly Synthesis \u2014 ${escapeHtml(weekLabel)}
      </h1>
      <p style="color:#888;font-size:13px;margin-bottom:24px;">
        Synthesized from ${itemCount} item${itemCount !== 1 ? 's' : ''} captured this week.
      </p>
      ${section('Themes \u0026 Patterns',  '#1a73e8', synthesis.themes)}
      ${section('Knowledge Gaps',          '#e65100', synthesis.gaps)}
      ${section('Connections',             '#0f9d58', synthesis.connections)}
      ${section('Open Questions',          '#9334e6', synthesis.questions)}
      <p style="color:#999;font-size:12px;margin-top:32px;">
        Sent by your PKM system. This synthesis is also saved to your Weekly Synthesis doc in Drive.
      </p>
    </div>
  `;
}
```

- [ ] **Step 2: Add a test helper for the email**

Add to the test helpers block:

```javascript
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
```

- [ ] **Step 3: Push to Apps Script**

```bash
clasp push
```

- [ ] **Step 4: Run testSendSynthesisEmail in the Apps Script editor**

Select `testSendSynthesisEmail` and click Run.

Expected:
- Log: `Synthesis: email sent for week of YYYY-MM-DD`
- Email arrives in your inbox with four colour-coded sections (blue themes, orange gaps, green connections, purple questions)

- [ ] **Step 5: Commit**

```bash
git add Synthesis.js
git commit -m "feat: add sendSynthesisEmail and buildSynthesisEmailHtml"
```

---

## Task 5: Implement getOrCreateSynthesisDoc and appendSynthesisToDoc

**Files:**
- Modify: `Synthesis.js`

- [ ] **Step 1: Add getOrCreateSynthesisDoc and appendSynthesisToDoc to Synthesis.js**

Add these functions after `buildSynthesisEmailHtml` (before the test helpers block):

```javascript
// ─── Drive Doc ────────────────────────────────────────────────────────────────

/**
 * Returns the ID of the "Weekly Synthesis" Drive doc, creating it if needed.
 * The doc is placed in the root PKM folder (DRIVE_ROOT_FOLDER_ID).
 * The ID is cached in PROP.SYNTHESIS_DOC_ID to avoid repeated Drive scans.
 *
 * @returns {string} Google Doc file ID
 */
function getOrCreateSynthesisDoc() {
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
    segments.push({ text: 'Themes \u0026 Patterns', style: 'heading3' });
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
}
```

- [ ] **Step 2: Add a test helper for the doc append**

Add to the test helpers block:

```javascript
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
  appendSynthesisToDoc(synthesis, weekLabel);
  const docId = PropertiesService.getScriptProperties().getProperty(PROP.SYNTHESIS_DOC_ID);
  Logger.log(`testAppendSynthesisToDoc: done — open https://docs.google.com/document/d/${docId}/edit`);
}
```

- [ ] **Step 3: Push to Apps Script**

```bash
clasp push
```

- [ ] **Step 4: Run testAppendSynthesisToDoc in the Apps Script editor**

Select `testAppendSynthesisToDoc` and click Run.

Expected in Logs:
- `Synthesis: created "Weekly Synthesis" doc (DOCID)` (first run) or `found existing doc (DOCID)` (subsequent)
- `Synthesis: appended week "YYYY-MM-DD" to doc DOCID`
- A Google Docs URL to open and verify

Open the URL and verify:
- A `Week of YYYY-MM-DD` heading (H2)
- Four sections (Themes & Patterns, Knowledge Gaps, Connections, Open Questions) each with H3 headings and bullet lists
- A separator line at the bottom

- [ ] **Step 5: Commit**

```bash
git add Synthesis.js
git commit -m "feat: add getOrCreateSynthesisDoc and appendSynthesisToDoc"
```

---

## Task 6: Implement runWeeklySynthesis orchestrator and wire up Code.js

**Files:**
- Modify: `Synthesis.js`
- Modify: `Code.js`

- [ ] **Step 1: Add runWeeklySynthesis to Synthesis.js**

Add this function after `appendSynthesisToDoc` (before the test helpers block):

```javascript
// ─── Orchestrator ─────────────────────────────────────────────────────────────

/**
 * Main entry point. Called by a weekly time-driven trigger (Sunday evening).
 *
 * Flow:
 *   1. Collect Pending + Saved items from the past 7 days
 *   2. Skip if fewer than 3 items
 *   3. Call Gemini for synthesis
 *   4. Send synthesis email
 *   5. Append synthesis to Drive doc (failure here does not block email)
 */
function runWeeklySynthesis() {
  Logger.log('--- runWeeklySynthesis start ---');

  const items = getSynthesisItems(7);
  Logger.log(`Synthesis: found ${items.length} item(s) in the past 7 days`);

  if (items.length < 3) {
    Logger.log('Synthesis: fewer than 3 items — skipping');
    Logger.log('--- runWeeklySynthesis end ---');
    return;
  }

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
```

- [ ] **Step 2: Add runWeeklySynthesis entry point to Code.js**

In `Code.js`, add after `runHourlyPipeline`:

```javascript
/**
 * Weekly synthesis trigger (once per week, Sunday evening).
 * Synthesizes all items from the past 7 days into themes, gaps, connections,
 * and open questions. Delivers via email and appends to a Drive doc.
 */
function runWeeklySynthesis() {
  Logger.log('--- runWeeklySynthesis (Code.js) ---');
  try {
    // Defined in Synthesis.js
    runWeeklySynthesis();
  } catch (e) {
    Logger.log(`Weekly synthesis error: ${e.message}`);
  }
}
```

Wait — both Code.js and Synthesis.js would define `runWeeklySynthesis()`, which would be a naming conflict in Apps Script (all .js files share the global namespace). Instead, name the Synthesis.js orchestrator differently:

**Correction for Step 1:** The function in Synthesis.js must be named `runWeeklySynthesisInternal()` (not `runWeeklySynthesis()`) to avoid a global namespace collision with the trigger entry point in Code.js. Use this complete body:

```javascript
function runWeeklySynthesisInternal() {
  Logger.log('--- runWeeklySynthesis start ---');

  const items = getSynthesisItems(7);
  Logger.log(`Synthesis: found ${items.length} item(s) in the past 7 days`);

  if (items.length < 3) {
    Logger.log('Synthesis: fewer than 3 items — skipping');
    Logger.log('--- runWeeklySynthesis end ---');
    return;
  }

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
```

**Step 2 (revised):** In `Code.js`, add:

```javascript
/**
 * Weekly synthesis trigger (once per week, Sunday evening).
 * Synthesizes all items from the past 7 days into themes, gaps, connections,
 * and open questions. Delivers via email and appends to a Drive doc.
 */
function runWeeklySynthesis() {
  try {
    runWeeklySynthesisInternal();
  } catch (e) {
    Logger.log(`Weekly synthesis error: ${e.message}`);
  }
}
```

- [ ] **Step 3: Push to Apps Script**

```bash
clasp push
```

- [ ] **Step 4: Run runWeeklySynthesis from the Apps Script editor**

Select `runWeeklySynthesis` and click Run.

Expected in Logs (assuming ≥ 3 items in the past 7 days):
```
--- runWeeklySynthesis start ---
Synthesis: found N item(s) in the past 7 days
Synthesis Gemini tokens — prompt: N, output: N, total: N
Synthesis: email sent for week of YYYY-MM-DD
Synthesis: appended week "YYYY-MM-DD" to doc DOCID
--- runWeeklySynthesis end ---
```

Verify:
- Email received in inbox
- Drive doc has a new dated section
- `SYNTHESIS_DOC_ID` appears in Script Properties (Project Settings → Script Properties)

- [ ] **Step 5: Commit**

```bash
git add Synthesis.js Code.js
git commit -m "feat: add runWeeklySynthesis orchestrator and Code.js entry point"
```

---

## Task 7: Set up the weekly trigger

This is a one-time manual step in the Apps Script dashboard — triggers cannot be set programmatically from `clasp push`.

- [ ] **Step 1: Open the trigger dashboard**

In the Apps Script editor: click the clock icon (Triggers) in the left sidebar.

- [ ] **Step 2: Add a new trigger**

Click **+ Add Trigger** (bottom right) and configure:

| Setting | Value |
|---------|-------|
| Function to run | `runWeeklySynthesis` |
| Deployment | Head |
| Event source | Time-driven |
| Type of time-based trigger | Week timer |
| Day of week | Sunday |
| Time of day | 6pm – 7pm |

Click **Save**.

- [ ] **Step 3: Verify the trigger appears in the list**

The trigger dashboard should show:
```
runWeeklySynthesis   Time-driven   Weekly   Sunday 6pm-7pm
```

---
