# Weekly Synthesis Pipeline — Design Spec

**Date:** 2026-04-05  
**Status:** Approved

## Overview

A weekly synthesis pipeline that reads all items captured in the past 7 days, sends them to Gemini in a single pass, and delivers a structured insight report as both an email and a persisted Drive document. The goal is to surface aggregate patterns — themes, knowledge gaps, cross-item connections, and open questions — that are invisible when reviewing items one at a time.

## Architecture

One new file: `Synthesis.js`. A single entry point `runWeeklySynthesis()` is added to `Code.js`. No other existing files are modified except `Config.js` for the new `PROP.SYNTHESIS_DOC_ID` key.

The synthesis doc ID is cached in Script Properties under `PROP.SYNTHESIS_DOC_ID` so Drive is not scanned on every run — consistent with the `TOPIC_DOC_CACHE` pattern.

## Data Flow

1. Read all rows from the Inbox tab (Pending items) and Archive tab (Saved and Dismissed items)
2. Filter to rows where `DATE_ADDED` is within the past 7 days and `STATUS` is Pending or Saved (exclude Dismissed — user explicitly rejected those)
3. Parse `SUMMARY_JSON` for each row; extract `title`, `keyPoints`, `tags`, and `sourceType`
4. If fewer than 3 items pass the filter, log and exit — no email sent
5. Build a single Gemini prompt containing all items' extracted data
6. Call Gemini once; expect structured JSON response (see Output Schema below)
7. On HTTP 429, sleep `SYNTHESIS_RATE_LIMIT_RETRY_DELAY_MS` (60 000 ms default constant in `Synthesis.js`) and retry once; if the retry also fails, log and exit
8. Send HTML email to `DIGEST_EMAIL`
9. Append a dated section to the "Weekly Synthesis" Drive doc; create the doc if it does not yet exist and cache its ID in `PROP.SYNTHESIS_DOC_ID`
10. If the doc append fails, log the error and continue — email delivery is the primary output

## Output Schema

Gemini returns a JSON object with four fields:

```json
{
  "themes":      ["theme name: 2-3 sentence description", "..."],
  "gaps":        ["gap or unanswered question implied by the week's content", "..."],
  "connections": ["item A title ↔ item B title: one sentence on how they relate", "..."],
  "questions":   ["open question worth exploring based on the week's captures", "..."]
}
```

## Components

| Function | Responsibility |
|---|---|
| `runWeeklySynthesis()` | Orchestrates the full pipeline; entry point called by trigger |
| `getSynthesisItems(days)` | Reads Inbox + Archive tabs, filters by date, returns parsed item data |
| `buildSynthesisPrompt(items)` | Formats item data into the Gemini synthesis prompt |
| `callGeminiForSynthesis(prompt)` | Calls Gemini API with one retry on 429; returns parsed JSON |
| `sendSynthesisEmail(synthesis, itemCount, weekLabel)` | Formats and sends HTML digest email |
| `appendSynthesisToDoc(synthesis, weekLabel)` | Creates or appends to the "Weekly Synthesis" Drive doc |

## Configuration

| Key | Type | Description |
|---|---|---|
| `PROP.SYNTHESIS_DOC_ID` | Script Property | Cached Drive doc ID; managed by the system, set on first run |
| `SYNTHESIS_RATE_LIMIT_RETRY_DELAY_MS` | Constant in `Synthesis.js` | Sleep duration before retrying a 429 response; default 60 000 ms |

No new user-facing Script Properties are required beyond `SYNTHESIS_DOC_ID`.

## Error Handling

| Condition | Behaviour |
|---|---|
| Fewer than 3 items in window | Log and exit; no email sent |
| Gemini 429 on first attempt | Sleep `SYNTHESIS_RATE_LIMIT_RETRY_DELAY_MS`, retry once |
| Gemini 429 on retry | Log and exit; no email sent |
| Gemini other error | Log and exit; no email sent |
| Doc append failure | Log error; email still sent |
| Doc create failure | Log error; email still sent |

## Drive Document

- **Name:** "Weekly Synthesis"
- **Location:** Root Drive folder (`DRIVE_ROOT_FOLDER_ID`)
- **Structure:** One cumulative document; each run appends a new `## Week of YYYY-MM-DD` section
- **NotebookLM:** Upload this single doc to NotebookLM as a source for cross-week pattern queries

## Trigger Setup

Add a time-driven trigger in the Apps Script dashboard:

- **Function:** `runWeeklySynthesis`
- **Trigger type:** Time-driven → Week timer → Sunday → 6pm–7pm (or user preference)
