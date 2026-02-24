/**
 * Gemini.js
 * Summarization engine. Calls the Gemini API with a source-specific prompt
 * and returns a structured JSON summary object.
 *
 * Output schema (all fields always present):
 *   shortSummary: string    — 2-3 sentence summary for triage
 *   fullSummary:  string    — detailed summary with key points
 *   tags:         string[]  — 2-5 lowercase topic tags
 *   keyTerms:     string[]  — 3-8 named concepts with one-sentence definitions
 *   keyPoints:    string[]  — 3-7 most important points
 *   actionItems:  string[]  — concrete next actions (empty array if none)
 */

// ─── Prompt Templates ────────────────────────────────────────────────────────
// Version: 2.0
// Each prompt instructs Gemini to return ONLY valid JSON — no preamble, no markdown.

const OUTPUT_SCHEMA = `{
  "shortSummary": "2-3 sentence summary for triage",
  "fullSummary":  "detailed summary with key points",
  "tags":         ["tag1", "tag2"],
  "keyTerms":     ["TermName: one-sentence definition", "AnotherTerm: definition"],
  "keyPoints":    ["point 1", "point 2"],
  "actionItems":  ["action 1"]
}`;

// Base instructions used for Gmail and Tasks sources.
const FULL_SUMMARY_INSTRUCTIONS = `Task: Generate a highly detailed, dense summary of the core concepts from this content.
  Instruction: Act as an expert note-taker. Do not just list the topics. For every concept,
  extract the specific reasoning, the "how-to" mechanics, and the ultimate value to the reader.
  Preserve the exact terminology, acronyms, tool names, framework names, and proper nouns
  from the source — do not substitute synonyms for technical terms.
  Formatting Rules:
  1. No Introductions: Start immediately with the first point.
  2. Format: Concept Name: A dense, 3-5 sentence paragraph.
  3. Depth Requirement: Each paragraph must explain what the concept is, why it matters,
     and how to implement it. State conclusions as direct claims ("X is better than Y because Z"),
     not as attributed opinions ("the author thinks X is better").
  4. Use plain-text bullet characters (•) only — no HTML, no markdown.
  5. Specificity: Include specific examples, tool versions, statistics, benchmarks, and numbers
     mentioned. A reader should be able to answer "what specific tools were recommended?" and
     "what numbers were cited?" from this summary alone.
  6. External Links: Conclude with a single sentence noting any external resources mentioned.
  Tone: Highly technical, objective, and information-dense.`;

// YouTube variant — identical to base but rule 2 includes timestamps and rule 6 adds timestamps.
const FULL_SUMMARY_INSTRUCTIONS_YOUTUBE = `Task: Generate a highly detailed, dense summary of the core concepts from this video.
  Instruction: Act as an expert note-taker. Do not just list the topics. For every concept,
  extract the specific reasoning, the "how-to" mechanics, and the ultimate value to the viewer.
  Preserve the exact terminology, acronyms, tool names, framework names, and proper nouns
  from the source — do not substitute synonyms for technical terms.
  Formatting Rules:
  1. No Introductions: Start immediately with the first point.
  2. Format: Concept Name (MM:SS): A dense, 3-5 sentence paragraph.
  3. Depth Requirement: Each paragraph must explain what the concept is, why it matters,
     and how to implement it. State conclusions as direct claims ("X is better than Y because Z"),
     not as attributed opinions ("the speaker thinks X is better").
  4. Use plain-text bullet characters (•) only — no HTML, no markdown.
  5. Specificity: Include specific examples, tool versions, statistics, benchmarks, and numbers
     mentioned. A reader should be able to answer "what specific tools were recommended?" and
     "what numbers were cited?" from this summary alone.
  6. External Links: Conclude with a single sentence noting any external resources (GitHub, docs)
     mentioned, with timestamps (MM:SS).
  Tone: Highly technical, objective, and information-dense.`;

const PROMPT_YOUTUBE = `You are an expert note-taker analyzing a YouTube video.
Return ONLY a valid JSON object matching this schema — no preamble, no markdown fences:
${OUTPUT_SCHEMA}

Instructions:
- shortSummary: 2-3 sentences on the core topic and whether it is worth deeper engagement
- fullSummary:
  ${FULL_SUMMARY_INSTRUCTIONS_YOUTUBE}
- tags: 2-5 lowercase topic tags (e.g. "productivity", "ai", "leadership")
- keyTerms: extract 3-8 important named concepts, tools, frameworks, or jargon from the video,
  each with a one-sentence definition using exact source terminology
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
- keyTerms: extract 3-8 important named concepts, tools, frameworks, or jargon from the email,
  each with a one-sentence definition using exact source terminology
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
- keyTerms: extract 3-8 important named concepts, tools, frameworks, or jargon from the topic,
  each with a one-sentence definition using exact source terminology
- keyPoints: key facts or concepts about this topic
- actionItems: concrete next steps if any are implied`;

// ─── Summarization ───────────────────────────────────────────────────────────

/**
 * Summarizes a normalized item using the Gemini API.
 * Throws if the API returns an error or an unparseable response.
 * Callers are responsible for catching and deciding whether to retry.
 *
 * @param {Object} item - Normalized item from a source connector
 * @returns {Object} Summary with shortSummary, fullSummary, tags, keyTerms, keyPoints, actionItems
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

  const usage = jsonResponse.usageMetadata;
  if (usage) {
    Logger.log(`Gemini [${item.sourceType}] tokens — prompt: ${usage.promptTokenCount}, output: ${usage.candidatesTokenCount}, total: ${usage.totalTokenCount}`);
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
      { file_data: { file_uri: item.content }, video_metadata: { fps: 0.1 } },
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
    if (!Array.isArray(parsed.keyTerms))    parsed.keyTerms     = [];

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
