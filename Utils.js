/**
 * Utils.js
 * Shared helpers: ID generation, timestamps, HTML utilities, and item normalization.
 * All source connectors return items via normalizeItem() to ensure a consistent shape.
 */

// ─── ID Generation ───────────────────────────────────────────────────────────

/**
 * Generates a UUID v4 using Apps Script's built-in Utilities service.
 *
 * @returns {string}
 */
function generateId() {
  return Utilities.getUuid();
}

// ─── Timestamps ──────────────────────────────────────────────────────────────

/**
 * Returns the current time as an ISO 8601 string.
 *
 * @returns {string}
 */
function getCurrentTimestamp() {
  return new Date().toISOString();
}

// ─── HTML Utilities ──────────────────────────────────────────────────────────

/**
 * Escapes a string for safe interpolation into HTML.
 * Apply to all untrusted text (titles, summaries, tags) before embedding
 * in email bodies or web app response pages.
 *
 * @param {string} str
 * @returns {string}
 */
function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Strips HTML tags from a string and collapses whitespace to single spaces.
 * Removes <style>, <script>, and <head> blocks (including their content) first
 * so that CSS rules and scripts don't end up in the extracted text.
 * Used by the Gmail connector to extract plain text from email bodies.
 *
 * @param {string} html
 * @returns {string}
 */
function stripHtml(html) {
  return String(html)
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, ' ')
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, ' ')
    .replace(/<head[^>]*>[\s\S]*?<\/head>/gi, ' ')
    .replace(/<[^>]*>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Fetches a URL and returns its content as plain text.
 * Strips scripts, styles, and HTML tags using stripHtml.
 * Returns an empty string on any failure so callers can fall back gracefully.
 *
 * Caps output at 50,000 characters — enough for a long article without
 * blowing through Gemini's token budget.
 *
 * @param {string} url
 * @returns {string}
 */
function fetchUrlContent(url) {
  if (!url || !url.startsWith('http')) return '';
  try {
    const response = UrlFetchApp.fetch(url, {
      muteHttpExceptions: true,
      followRedirects:    true,
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; PKM-Bot/1.0)' },
    });
    if (response.getResponseCode() !== 200) {
      Logger.log(`fetchUrlContent: HTTP ${response.getResponseCode()} for ${url}`);
      return '';
    }
    return stripHtml(response.getContentText()).slice(0, 50000);
  } catch (e) {
    Logger.log(`fetchUrlContent failed for ${url}: ${e.message}`);
    return '';
  }
}

// ─── Item Normalization ──────────────────────────────────────────────────────

/**
 * Creates a normalized item object from source-specific fields.
 * All connectors must return items in this shape before passing them downstream.
 *
 * Normalized Item Structure:
 *   id:          string  — UUID generated at ingest time
 *   sourceType:  string  — SOURCE.YOUTUBE | SOURCE.GMAIL | SOURCE.TASKS
 *   title:       string  — Video title, email subject, or task title
 *   url:         string  — Link to original content
 *   content:     string  — Raw text body (Gmail/Tasks) or video URL (YouTube)
 *   dateAdded:   string  — ISO timestamp of when the item was fetched
 *   rawMetadata: object  — Source-specific extras (playlist ID, label name, etc.)
 *
 * @param {Object} fields
 * @param {string} fields.sourceType
 * @param {string} fields.title
 * @param {string} fields.url
 * @param {string} fields.content
 * @param {Object} [fields.rawMetadata]
 * @returns {Object} Normalized item
 */
function normalizeItem({ sourceType, title, url, content, rawMetadata = {} }) {
  return {
    id:          generateId(),
    sourceType,
    title,
    url,
    content,
    dateAdded:   getCurrentTimestamp(),
    rawMetadata,
  };
}
