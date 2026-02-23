/**
 * Gemini.js
 * Summarization engine. Calls the Gemini API with a source-specific prompt
 * and returns a structured JSON summary object.
 *
 * Output schema (all fields always present):
 *   shortSummary: string    — 2-3 sentence summary for triage
 *   fullSummary:  string    — detailed summary with key points
 *   tags:         string[]  — 2-5 lowercase topic tags
 *   keyPoints:    string[]  — 3-7 most important points
 *   actionItems:  string[]  — concrete next actions (empty array if none)
 */

// ─── Prompt Templates ────────────────────────────────────────────────────────
// Version: 1.0
// Each prompt instructs Gemini to return ONLY valid JSON — no preamble, no markdown.

const OUTPUT_SCHEMA = `{
  "shortSummary": "2-3 sentence summary for triage",
  "fullSummary":  "detailed summary with key points",
  "tags":         ["tag1", "tag2"],
  "keyPoints":    ["point 1", "point 2"],
  "actionItems":  ["action 1"]
}`;

const FULL_SUMMARY_INSTRUCTIONS = `Task: Analyze this video and generate a highly detailed, dense summary of the core concepts.
  Instruction: Act as an expert note-taker. Do not just list the topics. For every concept, extract the specific reasoning, the "how-to" mechanics, and the ultimate value to the user. Write as if you are transcribing the most important points word-for-word.
  Formatting Rules:
  1. No Introductions: Start immediately with the first point.
  2. Format: Concept Name (MM:SS): A dense, 3-4 sentence paragraph.
  3. Depth Requirement: Each paragraph must explain what the concept is, why the speaker recommends it, and how to implement it.
  4. Use Bullets. Each paragraph should be in a separate bullet. 
  5. External Links: Conclude with a single sentence noting any external resources (GitHub, docs) mentioned, with timestamps.
  Tone: Highly technical, objective, and information-dense.`

const PROMPT_YOUTUBE = `You are an expert note-taker analyzing a YouTube video.
Return ONLY a valid JSON object matching this schema — no preamble, no markdown fences:
${OUTPUT_SCHEMA}

Instructions:
- shortSummary: 2-3 sentences on the core topic and whether it is worth deeper engagement
- fullSummary:
  ${FULL_SUMMARY_INSTRUCTIONS}
  Tone: Highly technical, objective, and information-dense.
- tags: 2-5 lowercase topic tags (e.g. "productivity", "ai", "leadership")
- keyPoints: the 3-7 most important specific points or recommendations from the video
- actionItems: concrete next actions the viewer could take (empty array if none)`;

const PROMPT_GMAIL = `You are an expert assistant analyzing an email.
Return ONLY a valid JSON object matching this schema — no preamble, no markdown fences:
${OUTPUT_SCHEMA}

Instructions:
- shortSummary: 2-3 sentences covering what the email is about and what (if anything) is required
- fullSummary: 
  ${FULL_SUMMARY_INSTRUCTIONS}
- tags: 2-5 lowercase topic tags
- keyPoints: key facts, decisions, or information from the email
- actionItems: any explicit or implied action items, deadlines, or decisions required`;

const PROMPT_TASKS = `You are an expert assistant researching a topic captured as a task.
Return ONLY a valid JSON object matching this schema — no preamble, no markdown fences:
${OUTPUT_SCHEMA}

Instructions:
- The task title is the topic or URL to research/summarize
- The notes field provides additional context
- shortSummary: 2-3 sentences on what this topic is and why it might be worth exploring
- fullSummary: 
  ${FULL_SUMMARY_INSTRUCTIONS}
- tags: 2-5 lowercase topic tags
- keyPoints: key facts or concepts about this topic
- actionItems: concrete next steps if any are implied`;

// ─── Summarization ───────────────────────────────────────────────────────────

/**
 * Summarizes a normalized item using the Gemini API.
 * Throws if the API returns an error or an unparseable response.
 * Callers are responsible for catching and deciding whether to retry.
 *
 * @param {Object} item - Normalized item from a source connector
 * @returns {Object} Summary with shortSummary, fullSummary, tags, keyPoints, actionItems
 * @throws {Error} On API failure or unparseable JSON response
 */
// Delay between Gemini API calls per source type (milliseconds).
// YouTube uses a longer delay because video processing is token-heavy and
// consumes tokens-per-minute quota much faster than text-based sources.
const GEMINI_RATE_LIMIT_DELAY_MS = {
  [SOURCE.YOUTUBE]: 15000,
  [SOURCE.GMAIL]:    2000,
  [SOURCE.TASKS]:    2000,
};

function summarizeItem(item) {
  Utilities.sleep(GEMINI_RATE_LIMIT_DELAY_MS[item.sourceType] || 2000);

  const model    = getProperty(PROP.GEMINI_MODEL);
  const apiKey   = getProperty(PROP.GEMINI_API_KEY);
  // https://generativelanguage.googleapis.com/v1beta/models/${getProperty(PROP.GEMINI_MODEL)}:generateContent?key=${getProperty(PROP.GEMINI_API_KEY)}`;
  const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`;
  const prompt   = getPromptForSource(item.sourceType);

  const payload = {
    contents: [{
      parts: buildRequestParts(item, prompt),
    }],
    generationConfig: {
      temperature: 0.2,
      responseMimeType: 'application/json',
    },
  };

  const options = {
    method:          'post',
    contentType:     'application/json',
    headers:         { 'x-goog-api-key': apiKey },
    payload:         JSON.stringify(payload),
    muteHttpExceptions: true,
  };

  const response     = UrlFetchApp.fetch(endpoint, options);
  const jsonResponse = JSON.parse(response.getContentText());

  if (!jsonResponse.candidates || !jsonResponse.candidates[0]) {
    throw new Error(`Gemini API error: ${response.getContentText()}`);
  }

  const rawText = jsonResponse.candidates[0].content.parts[0].text || '';
  return parseSummaryJson(rawText, item);
}

/**
 * Builds the content parts array for the Gemini request.
 * YouTube items pass the video URL as a file_data part; other sources pass text.
 *
 * @param {Object} item
 * @param {string} prompt
 * @returns {Object[]}
 */
function buildRequestParts(item, prompt) {
  if (item.sourceType === SOURCE.YOUTUBE) {
    return [
      { text: prompt },
      { file_data: { file_uri: item.content } },
    ];
  }
  if (item.sourceType === SOURCE.TASKS) {
    return [
      { text: `${prompt}\n\nURL: ${item.url}` },
    ];
  }
  return [
    { text: `${prompt}\n\n---\n\n${item.content}` },
  ];
}

/**
 * Parses Gemini's text response into a summary object.
 * Strips any residual markdown fences before parsing.
 * Returns a fallback object if parsing fails.
 *
 * @param {string} rawText
 * @param {Object} item - Used only for fallback logging
 * @returns {Object}
 */
function parseSummaryJson(rawText, item) {
  // Extract the JSON object by finding the outermost { } bounds.
  // This handles cases where Gemini appends commentary after the closing brace.
  const start = rawText.indexOf('{');
  const end   = rawText.lastIndexOf('}');

  if (start === -1 || end === -1 || end < start) {
    throw new Error(`Gemini response contained no JSON object for item ${item.id}`);
  }

  try {
    const parsed = JSON.parse(rawText.slice(start, end + 1));

    // Gemini occasionally returns string fields as arrays when the prompt mentions bullets.
    // Normalize to strings so spreadsheet cells don't receive array objects.
    if (Array.isArray(parsed.shortSummary)) parsed.shortSummary = parsed.shortSummary.join('\n');
    if (Array.isArray(parsed.fullSummary))  parsed.fullSummary  = parsed.fullSummary.join('\n');

    return parsed;
  } catch (e) {
    throw new Error(`Gemini returned unparseable JSON for item ${item.id}: ${e.message}`);
  }
}

/**
 * Returns the prompt template for a given source type.
 *
 * @param {string} sourceType - SOURCE.YOUTUBE | SOURCE.GMAIL | SOURCE.TASKS
 * @returns {string}
 */
function getPromptForSource(sourceType) {
  switch (sourceType) {
    case SOURCE.YOUTUBE: return PROMPT_YOUTUBE;
    case SOURCE.GMAIL:   return PROMPT_GMAIL;
    case SOURCE.TASKS:   return PROMPT_TASKS;
    default: throw new Error(`Unknown sourceType: ${sourceType}`);
  }
}
