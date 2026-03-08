/**
 * WebApp.js
 * doGet approval endpoint. Handles digest email link clicks and serves the
 * real-time inbox view.
 *
 * Deployment settings (set in Apps Script editor > Deploy > Manage deployments):
 *   Execute as: Me (script owner)
 *   Who has access: Only myself
 *
 * This ensures all pages only function when the user is authenticated,
 * preventing unintended saves if a link is forwarded.
 *
 * Request format (all GET):
 *   (no params)                                     — real-time inbox view
 *   ?action=capture&url=...                         — bookmarklet capture review page
 *   ?id=ITEM_ID&action=save                         — show tag selection page
 *   ?id=ITEM_ID&action=confirm&tags=tag1&tags=tag2  — save to selected tags
 *   ?id=ITEM_ID&action=dismiss                      — dismiss item
 *
 * Capture confirm uses google.script.run (no HTTP round-trip).
 * Tweet content is fetched server-side via oEmbed — nothing large in the URL.
 */

/**
 * Apps Script web app entry point.
 *
 * @param {GoogleAppsScript.Events.DoGet} e
 * @returns {GoogleAppsScript.HTML.HtmlOutput}
 */
function doGet(e) {
  const params = e.parameter  || {};
  const itemId = params.id;
  const action = params.action;

  // No params — serve the real-time inbox view
  if (!action && !itemId) {
    return handleInboxView();
  }

  // Bookmarklet capture — only the URL is passed; content fetched server-side.
  if (action === 'capture') {
    return handleCaptureLoad(params);
  }

  if (action === 'library') {
    return handleLibraryView();
  }

  if (!itemId || !action) {
    return buildConfirmationPage('Invalid request — missing id or action parameter.');
  }
  if (action !== 'save' && action !== 'confirm' && action !== 'dismiss' && action !== 'provide') {
    return buildConfirmationPage(`Invalid action: "${escapeHtml(action)}".`);
  }

  const found = getItemById(itemId);
  if (!found) {
    return buildConfirmationPage('Item not found. It may have already been removed.');
  }

  const item = found.data;

  if (item.status === STATUS.SAVED || item.status === STATUS.DISMISSED) {
    return buildConfirmationPage(
      `This item was already ${item.status.toLowerCase()}. No changes made.`
    );
  }

  if (action === 'save') {
    return handleSaveSelection(itemId, item);
  }
  if (action === 'confirm') {
    const selectedTags = (e.parameters.tags || []).filter(t => t);
    return handleSaveConfirm(itemId, item, selectedTags);
  }
  if (action === 'provide') {
    return handleProvideContent(itemId, item);
  }
  return handleDismiss(itemId, item);
}

// ─── Capture Handlers ─────────────────────────────────────────────────────────

/**
 * Fetches tweet data via the public oEmbed API.
 * Returns { title, content } where title is "Tweet by @handle" and content
 * is the tweet text extracted from the <p> element only (the attribution
 * line — author name, handle, date — is excluded).
 * Returns null if the request fails.
 *
 * @param {string} tweetUrl
 * @returns {{ title: string, content: string } | null}
 */
function fetchTweetData(tweetUrl) {
  try {
    const endpoint = 'https://publish.twitter.com/oembed?omit_script=true&url='
      + encodeURIComponent(tweetUrl);
    const response = UrlFetchApp.fetch(endpoint, { muteHttpExceptions: true });
    if (response.getResponseCode() !== 200) return null;
    const data = JSON.parse(response.getContentText());
    if (!data.html) return null;

    // Extract only the <p> element to exclude the attribution line
    // (the "— Author (@handle) Date" text that follows the <p> in oEmbed HTML).
    const pMatch = data.html.match(/<p[^>]*>([\s\S]*?)<\/p>/i);
    const rawContent = pMatch ? pMatch[1] : data.html;

    const content = decodeHtmlEntities(
      rawContent
        .replace(/<br\s*\/?>/gi, '\n')
        .replace(/<[^>]+>/g, '')  // strip all remaining HTML tags
    ).replace(/\n{3,}/g, '\n\n').trim();

    const handle = data.author_url
      ? '@' + data.author_url.replace(/.*\//, '')
      : '';
    const title = `Tweet by ${data.author_name || ''}${handle ? ' (' + handle + ')' : ''}`.trim();

    return { title, content };
  } catch (e) {
    Logger.log(`fetchTweetData failed for ${tweetUrl}: ${e.message}`);
    return null;
  }
}

/**
 * Decodes common HTML entities to their plain-text equivalents.
 *
 * @param {string} str
 * @returns {string}
 */
function decodeHtmlEntities(str) {
  return str
    .replace(/&amp;/g,   '&')
    .replace(/&lt;/g,    '<')
    .replace(/&gt;/g,    '>')
    .replace(/&quot;/g,  '"')
    .replace(/&#39;/g,   "'")
    .replace(/&mdash;/g, '—')
    .replace(/&ndash;/g, '–')
    .replace(/&nbsp;/g,  ' ')
    .replace(/&#(\d+);/g,   (_, n) => String.fromCharCode(Number(n)))
    .replace(/&#x([\da-f]+);/gi, (_, h) => String.fromCharCode(parseInt(h, 16)));
}

/**
 * Serves the bookmarklet capture review page.
 * For X.com/Twitter URLs the tweet text is fetched server-side via the public
 * oEmbed API — no content needs to be passed through the browser at all.
 * For other URLs, content can be passed as a query parameter.
 *
 * @param {Object} params - Parsed query parameters from doGet (or POST body)
 * @returns {GoogleAppsScript.HTML.HtmlOutput}
 */
function handleCaptureLoad(params) {
  const webAppUrl = getProperty(PROP.WEBAPP_URL);
  const url       = (params.url     || '').trim();
  let   content   = (params.content || '').trim();
  let   title     = (params.title   || '').trim();

  // For tweet URLs with no content supplied, fetch via oEmbed server-side.
  if (!content && (url.includes('x.com/') || url.includes('twitter.com/')) && url.includes('/status/')) {
    const tweetData = fetchTweetData(url);
    if (tweetData) {
      content = tweetData.content;
      if (!title) title = tweetData.title;
    }
  }
  if (!title && content) {
    title = content.slice(0, 100).replace(/[\n\r]+/g, ' ');
  }

  const html = `<!DOCTYPE html>
<html>
  <head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>Capture to PKM</title>
    <style>
      * { box-sizing: border-box; }
      body {
        font-family: sans-serif;
        max-width: 640px;
        margin: 40px auto;
        padding: 0 16px 40px;
        background: #f8f9fa;
        color: #222;
      }
      h1 { font-size: 20px; margin: 0 0 4px; }
      .subtitle { color: #888; font-size: 13px; margin: 0 0 24px; }
      label { display: block; font-size: 13px; font-weight: 600; margin-bottom: 4px; color: #444; }
      input[type=text], textarea {
        width: 100%;
        border: 1px solid #ddd;
        border-radius: 4px;
        padding: 8px 10px;
        font-size: 14px;
        font-family: inherit;
        margin-bottom: 16px;
        background: white;
      }
      textarea { height: 280px; resize: vertical; line-height: 1.5; }
      .note { font-size: 12px; color: #888; margin: -12px 0 16px; }
      .actions { display: flex; gap: 8px; }
      .btn {
        display: inline-block;
        padding: 8px 20px;
        border-radius: 4px;
        font-size: 14px;
        font-weight: 500;
        border: none;
        cursor: pointer;
        text-decoration: none;
      }
      .btn-primary { background: #1a73e8; color: white; }
      .btn-secondary { background: #f1f3f4; color: #444; }
    </style>
  </head>
  <body>
    <h1>Capture to PKM</h1>
    <p class="subtitle">Review and edit before adding to your inbox.</p>
    <label for="title">Title</label>
    <input type="text" id="title" value="${escapeHtml(title)}">
    <label for="url">URL</label>
    <input type="text" id="url" value="${escapeHtml(url)}">
    <label for="content">Content</label>
    <textarea id="content">${escapeHtml(content)}</textarea>
    <p class="note">Tip: describe any images or graphics above — Gemini will include them in the summary.</p>
    <div class="actions">
      <button id="submitBtn" class="btn btn-primary" onclick="submitCapture()">Add to PKM</button>
      <a href="${webAppUrl}" class="btn btn-secondary" target="_top">Cancel</a>
    </div>
    <script>
      function submitCapture() {
        var btn     = document.getElementById('submitBtn');
        var title   = document.getElementById('title').value.trim();
        var url     = document.getElementById('url').value.trim();
        var content = document.getElementById('content').value.trim();
        if (!content) { alert('Content is required.'); return; }
        btn.disabled    = true;
        btn.textContent = 'Adding\u2026';
        google.script.run
          .withSuccessHandler(function(msg) {
            document.body.innerHTML =
              '<div style="max-width:520px;margin:80px auto;font-family:sans-serif;text-align:center;">'
              + '<p style="font-size:15px;">' + msg + '</p></div>';
          })
          .withFailureHandler(function(err) {
            btn.disabled    = false;
            btn.textContent = 'Add to PKM';
            alert('Error: ' + err.message);
          })
          .captureConfirmFromClient(title, url, content);
      }
    </script>
  </body>
</html>`;

  return HtmlService.createHtmlOutput(html)
    .setTitle('Capture to PKM')
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.DEFAULT);
}

/**
 * Server-side function called via google.script.run from the capture review
 * page. Returns a plain HTML string (not HtmlOutput) so the client can insert
 * it directly into the page without a full navigation.
 *
 * @param {string} title
 * @param {string} url
 * @param {string} content
 * @returns {string} Success message HTML
 */
function captureConfirmFromClient(title, url, content) {
  if (!content) return 'No content provided — nothing was added.';

  const item = normalizeItem({
    sourceType: SOURCE.CAPTURE,
    title:      title || url || 'Captured item',
    url:        url,
    content:    content,
  });

  let summary;
  try {
    summary = summarizeItem(item);
  } catch (e) {
    Logger.log(`Capture: Gemini failed for "${item.title}" — storing raw content. Error: ${e.message}`);
    summary = {
      shortSummary: content.slice(0, 300),
      fullSummary:  content,
      tags:         [],
      keyTerms:     [],
      keyPoints:    [],
      actionItems:  [],
    };
  }

  addItemToInbox(item, summary);
  addProcessedId(item.id);
  Logger.log(`Capture: added "${item.title}" to inbox`);

  const webAppUrl = getProperty(PROP.WEBAPP_URL);
  return `Added to inbox. <a href="${webAppUrl}" target="_top" style="color:#1a73e8;">← Back to Inbox</a>`;
}

// ─── Provide Content Handler ─────────────────────────────────────────────────

/**
 * Returns true when an inbox item has the fetch-failure stub summary,
 * meaning the URL could not be fetched at ingest time.
 *
 * @param {Object} item - Row object from Sheets
 * @returns {boolean}
 */
function isFetchFailureItem(item) {
  return String(item.summary || '').startsWith('Unable to summarize:');
}

/**
 * Serves the "Provide Content" page for an item whose URL could not be
 * fetched. The user pastes the article text into a textarea; on submit
 * google.script.run.provideContentFromClient() re-summarizes in-place.
 *
 * @param {string} itemId
 * @param {Object} item - Row object from Sheets
 * @returns {GoogleAppsScript.HTML.HtmlOutput}
 */
function handleProvideContent(itemId, item) {
  const webAppUrl = getProperty(PROP.WEBAPP_URL);

  const html = `<!DOCTYPE html>
<html>
  <head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>Provide Content</title>
    <style>
      * { box-sizing: border-box; }
      body {
        font-family: sans-serif;
        max-width: 680px;
        margin: 40px auto;
        padding: 0 16px 40px;
        background: #f8f9fa;
        color: #222;
      }
      h1 { font-size: 20px; margin: 0 0 4px; }
      .subtitle { color: #888; font-size: 13px; margin: 0 0 24px; }
      .item-title { font-size: 15px; font-weight: 600; margin: 0 0 4px; }
      .item-url { font-size: 12px; color: #888; margin: 0 0 20px; word-break: break-all; }
      label { display: block; font-size: 13px; font-weight: 600; margin-bottom: 4px; color: #444; }
      textarea {
        width: 100%;
        height: 360px;
        border: 1px solid #ddd;
        border-radius: 4px;
        padding: 10px;
        font-size: 13px;
        font-family: inherit;
        line-height: 1.5;
        resize: vertical;
        background: white;
        margin-bottom: 4px;
      }
      .char-count { font-size: 12px; color: #aaa; text-align: right; margin-bottom: 16px; }
      .char-count.warn { color: #e67e22; }
      .note { font-size: 12px; color: #888; margin: 0 0 16px; }
      .actions { display: flex; gap: 8px; }
      .btn {
        display: inline-block;
        padding: 8px 20px;
        border-radius: 4px;
        font-size: 14px;
        font-weight: 500;
        border: none;
        cursor: pointer;
        text-decoration: none;
      }
      .btn-primary { background: #1a73e8; color: white; }
      .btn-secondary { background: #f1f3f4; color: #444; }
    </style>
  </head>
  <body>
    <h1>Provide Content</h1>
    <p class="subtitle">The URL for this item could not be fetched automatically. Paste the article text below and it will be re-summarized.</p>
    <p class="item-title">${escapeHtml(item.title)}</p>
    <p class="item-url"><a href="${encodeURI(item.url)}" target="_blank">${escapeHtml(item.url)}</a></p>
    <label for="content">Article text</label>
    <textarea id="content" placeholder="Paste the full article text here\u2026" oninput="updateCount()"></textarea>
    <div id="charCount" class="char-count">0 / 50,000</div>
    <p class="note">Tip: select all text on the article page (Ctrl+A / Cmd+A), copy, then paste here. Images and graphics won't transfer but everything else will.</p>
    <div class="actions">
      <button id="submitBtn" class="btn btn-primary" onclick="submitContent()">Re-summarize</button>
      <a href="${webAppUrl}" class="btn btn-secondary" target="_top">Cancel</a>
    </div>
    <script>
      var MAX = 50000;
      function updateCount() {
        var len = document.getElementById('content').value.length;
        var el  = document.getElementById('charCount');
        el.textContent = len.toLocaleString() + ' / 50,000';
        el.className = 'char-count' + (len > MAX * 0.9 ? ' warn' : '');
      }
      function submitContent() {
        var btn     = document.getElementById('submitBtn');
        var content = document.getElementById('content').value.trim().slice(0, MAX);
        if (!content) { alert('Please paste some content first.'); return; }
        btn.disabled    = true;
        btn.textContent = 'Summarizing\u2026';
        google.script.run
          .withSuccessHandler(function(msg) {
            document.body.innerHTML =
              '<div style="max-width:520px;margin:80px auto;font-family:sans-serif;text-align:center;">'
              + '<p style="font-size:15px;">' + msg + '</p></div>';
          })
          .withFailureHandler(function(err) {
            btn.disabled    = false;
            btn.textContent = 'Re-summarize';
            alert('Error: ' + err.message);
          })
          .provideContentFromClient('${escapeHtml(itemId)}', content);
      }
    </script>
  </body>
</html>`;

  return HtmlService.createHtmlOutput(html)
    .setTitle('Provide Content')
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.DEFAULT);
}

/**
 * Server-side function called via google.script.run from the provide-content
 * page. Re-summarizes the item with the user-supplied text and updates the
 * SUMMARY, TAGS, and SUMMARY_JSON columns in-place.
 *
 * @param {string} itemId
 * @param {string} content - Pasted article text (max 50,000 chars)
 * @returns {string} Success message HTML
 */
function provideContentFromClient(itemId, content) {
  if (!content) return 'No content provided — nothing was changed.';

  const found = getItemById(itemId);
  if (!found) return 'Item not found — it may have already been removed.';

  const item = found.data;

  // Build a temporary item with the pasted content so summarizeItem can use it.
  // Use SOURCE.CAPTURE so buildRequestParts passes item.content directly to
  // Gemini rather than trying (and failing) to fetch the URL again.
  const tempItem = normalizeItem({
    sourceType: SOURCE.CAPTURE,
    title:      item.title,
    url:        item.url,
    content:    content.slice(0, 50000),
  });

  let summary;
  try {
    summary = summarizeItem(tempItem);
  } catch (e) {
    Logger.log(`provideContentFromClient: Gemini failed for item ${itemId}: ${e.message}`);
    throw e; // propagate to withFailureHandler on the client
  }

  updateItemSummary(itemId, summary);
  Logger.log(`provideContentFromClient: re-summarized item ${itemId} ("${item.title}")`);

  const webAppUrl = getProperty(PROP.WEBAPP_URL);
  return `Summary updated. <a href="${webAppUrl}" target="_top" style="color:#1a73e8;">← Back to Inbox</a>`;
}

// ─── Inbox View ───────────────────────────────────────────────────────────────

/**
 * Renders the real-time inbox page: all pending items with collapsible
 * summaries and Save/Dismiss actions.
 *
 * @returns {GoogleAppsScript.HTML.HtmlOutput}
 */
function handleInboxView() {
  const items     = getAllPendingItems();
  const webAppUrl = getProperty(PROP.WEBAPP_URL);
  return HtmlService.createHtmlOutput(buildInboxPage(items, webAppUrl))
    .setTitle('PKM Inbox')
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.DEFAULT);
}

/**
 * Builds the full inbox page HTML.
 *
 * @param {Object[]} items
 * @param {string}   webAppUrl
 * @returns {string}
 */
function buildInboxPage(items, webAppUrl) {
  const cards = items.length > 0
    ? items.map(item => buildInboxItemCard(item, webAppUrl)).join('\n')
    : '<p style="color:#888;text-align:center;padding:40px 0;">No pending items.</p>';

  return `<!DOCTYPE html>
<html>
  <head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>PKM Inbox</title>
    <style>
      * { box-sizing: border-box; }
      body {
        font-family: sans-serif;
        max-width: 720px;
        margin: 40px auto;
        padding: 0 16px 40px;
        background: #f8f9fa;
        color: #222;
      }
      h1 { font-size: 22px; margin: 0 0 4px; }
      .subtitle { color: #888; font-size: 14px; margin: 0 0 24px; }
      .card {
        background: white;
        border: 1px solid #e0e0e0;
        border-radius: 6px;
        padding: 16px;
        margin-bottom: 12px;
      }
      .meta { display: flex; align-items: center; gap: 8px; margin-bottom: 8px; }
      .badge {
        font-size: 10px;
        font-weight: bold;
        padding: 2px 7px;
        border-radius: 3px;
        text-transform: uppercase;
        letter-spacing: 0.5px;
        color: white;
      }
      .date { color: #888; font-size: 12px; }
      .item-title { font-size: 16px; font-weight: 600; margin: 0 0 6px; }
      .item-title a { color: #1a0dab; text-decoration: none; }
      .item-title a:hover { text-decoration: underline; }
      .tags { font-size: 12px; color: #666; margin: 0 0 12px; }
      details { margin-bottom: 12px; }
      summary {
        cursor: pointer;
        font-size: 13px;
        color: #1a73e8;
        user-select: none;
        list-style: none;
      }
      summary::-webkit-details-marker { display: none; }
      summary::before { content: '▶  '; font-size: 10px; }
      details[open] summary::before { content: '▼  '; }
      .summary-body {
        margin-top: 10px;
        font-size: 13px;
        line-height: 1.6;
        border-top: 1px solid #f0f0f0;
        padding-top: 10px;
        color: #333;
      }
      .summary-body ul { margin: 0 0 8px; padding-left: 20px; }
      .summary-body li { margin-bottom: 4px; }
      .summary-body p { margin: 0 0 8px; }
      .actions { display: flex; gap: 8px; }
      .btn {
        display: inline-block;
        padding: 6px 14px;
        border-radius: 4px;
        text-decoration: none;
        font-size: 13px;
        font-weight: 500;
      }
      .btn-save { background: #1a73e8; color: white; }
      .btn-dismiss { background: #f1f3f4; color: #444; }
    </style>
  </head>
  <body>
    <h1>PKM Inbox</h1>
    <p class="subtitle">${items.length} pending item${items.length !== 1 ? 's' : ''} &nbsp;·&nbsp; <a href="${webAppUrl}?action=library" style="color:#1a73e8;text-decoration:none;" target="_top">Library →</a></p>
    ${cards}
  </body>
</html>`;
}

/**
 * Builds a card for a single pending item in the inbox view.
 *
 * @param {Object} item
 * @param {string} webAppUrl
 * @returns {string} HTML fragment
 */
function buildInboxItemCard(item, webAppUrl) {
  const saveUrl    = `${webAppUrl}?id=${encodeURIComponent(item.itemId)}&action=save`;
  const dismissUrl = `${webAppUrl}?id=${encodeURIComponent(item.itemId)}&action=dismiss`;
  const title      = escapeHtml(item.title);
  const tags       = escapeHtml(item.tags || '');
  const date       = new Date(item.dateAdded).toLocaleDateString();
  const sourceType = escapeHtml(item.sourceType);
  const summary    = formatSummaryAsHtml(item.summary || '');
  const itemUrl    = encodeURI(item.url);

  const badgeColor = {
    [SOURCE.YOUTUBE]: '#FF0000',
    [SOURCE.GMAIL]:   '#EA4335',
    [SOURCE.TASKS]:   '#1A73E8',
    [SOURCE.CAPTURE]: '#00897B',
  }[item.sourceType] || '#888';

  return `
    <div class="card">
      <div class="meta">
        <span class="badge" style="background:${badgeColor};">${sourceType}</span>
        <span class="date">${date}</span>
      </div>
      <p class="item-title"><a href="${itemUrl}" target="_blank">${title}</a></p>
      ${tags ? `<p class="tags">Tags: ${tags}</p>` : ''}
      <details>
        <summary>View summary</summary>
        <div class="summary-body">${summary}</div>
      </details>
      <div class="actions">
        <a href="${saveUrl}" class="btn btn-save" target="_top">Save to PKM</a>
        <a href="${dismissUrl}" class="btn btn-dismiss" target="_top">Dismiss</a>
        ${isFetchFailureItem(item) ? `<a href="${webAppUrl}?id=${encodeURIComponent(item.itemId)}&action=provide" class="btn" style="background:#f1f3f4;color:#444;" target="_top">Provide Content</a>` : ''}
      </div>
    </div>`;
}

// ─── Library View ─────────────────────────────────────────────────────────────

/**
 * Serves the PKM Library page. Data is loaded client-side via
 * google.script.run.getLibraryIndexJson() so the page renders quickly
 * and all filtering happens in the browser.
 *
 * @returns {GoogleAppsScript.HTML.HtmlOutput}
 */
function handleLibraryView() {
  const webAppUrl = getProperty(PROP.WEBAPP_URL);
  return HtmlService.createHtmlOutput(buildLibraryPage(webAppUrl))
    .setTitle('PKM Library')
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.DEFAULT);
}

/**
 * Builds the full library page HTML shell.
 * Tag sidebar + card grid; data loaded and rendered client-side.
 *
 * @param {string} webAppUrl
 * @returns {string}
 */
function buildLibraryPage(webAppUrl) {
  return `<!DOCTYPE html>
<html>
  <head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>PKM Library</title>
    <style>
      * { box-sizing: border-box; }
      body { font-family: sans-serif; margin: 0; background: #f8f9fa; color: #222; }
      .layout { display: flex; min-height: 100vh; }
      .sidebar {
        width: 200px; flex-shrink: 0;
        background: white; border-right: 1px solid #e0e0e0;
        padding: 20px 12px; position: sticky; top: 0; height: 100vh; overflow-y: auto;
      }
      .sidebar h3 {
        font-size: 11px; text-transform: uppercase; color: #aaa;
        letter-spacing: 0.8px; margin: 0 0 10px; padding: 0 8px;
      }
      .tag-btn {
        display: block; width: 100%; text-align: left;
        padding: 6px 8px; border-radius: 4px; border: none; background: none;
        font-size: 13px; cursor: pointer; color: #444; white-space: nowrap;
        overflow: hidden; text-overflow: ellipsis;
      }
      .tag-btn:hover { background: #f1f3f4; }
      .tag-btn.active { background: #e8f0fe; color: #1a73e8; font-weight: 600; }
      .main { flex: 1; padding: 24px; min-width: 0; }
      .top-bar { display: flex; align-items: center; gap: 16px; margin-bottom: 20px; flex-wrap: wrap; }
      .top-bar h1 { font-size: 20px; margin: 0; }
      .top-bar a { font-size: 13px; color: #1a73e8; text-decoration: none; margin-left: auto; }
      input[type=search] {
        flex: 1; max-width: 360px; min-width: 160px;
        padding: 7px 14px; border: 1px solid #ddd; border-radius: 20px;
        font-size: 14px; outline: none; background: white;
      }
      input[type=search]:focus { border-color: #1a73e8; }
      .count { font-size: 13px; color: #888; }
      .grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(280px, 1fr)); gap: 14px; }
      .card {
        background: white; border: 1px solid #e0e0e0; border-radius: 6px;
        padding: 14px 16px; display: flex; flex-direction: column; gap: 6px;
      }
      .card-meta { font-size: 11px; color: #aaa; }
      .card-title { font-size: 14px; font-weight: 600; margin: 0; line-height: 1.3; }
      .card-title a { color: #1a0dab; text-decoration: none; }
      .card-title a:hover { text-decoration: underline; }
      .card-summary { font-size: 12px; color: #555; line-height: 1.5; margin: 0; flex: 1; }
      .card-footer { display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap; gap: 4px; }
      .card-tags { display: flex; flex-wrap: wrap; gap: 4px; }
      .tag-pill {
        font-size: 11px; background: #f1f3f4; color: #555;
        border-radius: 10px; padding: 2px 8px;
      }
      .doc-link { font-size: 12px; color: #1a73e8; text-decoration: none; white-space: nowrap; }
      .doc-link:hover { text-decoration: underline; }
      .empty { color: #888; text-align: center; padding: 60px 0; grid-column: 1/-1; }
      .loading { color: #888; text-align: center; padding: 60px 0; }
      .badge {
        display: inline-block; font-size: 10px; font-weight: bold;
        padding: 1px 6px; border-radius: 3px; text-transform: uppercase;
        letter-spacing: 0.5px; color: white; vertical-align: middle;
        margin-right: 4px;
      }
    </style>
  </head>
  <body>
    <div class="layout">
      <nav class="sidebar">
        <h3>Tags</h3>
        <button class="tag-btn active" onclick="filterTag(null, this)">All</button>
        <div id="tagList"></div>
      </nav>
      <main class="main">
        <div class="top-bar">
          <h1>PKM Library</h1>
          <input type="search" id="searchBox" placeholder="Search titles and summaries…" oninput="renderGrid()">
          <span class="count" id="countLabel"></span>
          <a href="${webAppUrl}" target="_top">← Inbox</a>
        </div>
        <div id="status" class="loading">Loading library…</div>
        <div class="grid" id="grid"></div>
      </main>
    </div>
    <script>
      var allItems  = [];
      var activeTag = null;

      var BADGE_COLORS = {
        'YouTube': '#FF0000',
        'Gmail':   '#EA4335',
        'Tasks':   '#1A73E8',
        'Capture': '#00897B',
      };

      google.script.run
        .withSuccessHandler(function(index) {
          allItems = (index.items || []).slice().reverse(); // newest first
          buildTagSidebar();
          renderGrid();
          document.getElementById('status').style.display = 'none';
        })
        .withFailureHandler(function(err) {
          document.getElementById('status').textContent = 'Failed to load library: ' + err.message;
        })
        .getLibraryIndexJson();

      function buildTagSidebar() {
        var counts = {};
        allItems.forEach(function(item) {
          (item.tags || []).forEach(function(t) { counts[t] = (counts[t] || 0) + 1; });
        });
        document.getElementById('tagList').innerHTML = Object.keys(counts).sort().map(function(t) {
          return '<button class="tag-btn" onclick="filterTag(' + JSON.stringify(t) + ', this)">'
               + esc(t) + ' <span style="color:#bbb;font-weight:400;">(' + counts[t] + ')</span></button>';
        }).join('');
      }

      function filterTag(tag, btn) {
        activeTag = tag;
        document.querySelectorAll('.tag-btn').forEach(function(b) { b.classList.remove('active'); });
        btn.classList.add('active');
        renderGrid();
      }

      function renderGrid() {
        var q = document.getElementById('searchBox').value.trim().toLowerCase();
        var visible = allItems.filter(function(item) {
          if (activeTag && !(item.tags || []).includes(activeTag)) return false;
          if (q) return (item.title + ' ' + item.shortSummary).toLowerCase().indexOf(q) !== -1;
          return true;
        });

        document.getElementById('countLabel').textContent =
          visible.length + ' item' + (visible.length !== 1 ? 's' : '');

        if (visible.length === 0) {
          document.getElementById('grid').innerHTML = '<p class="empty">No items match.</p>';
          return;
        }

        document.getElementById('grid').innerHTML = visible.map(function(item) {
          var date   = item.date ? new Date(item.date).toLocaleDateString() : '';
          var color  = BADGE_COLORS[item.sourceType] || '#888';
          var pills  = (item.tags || []).map(function(t) {
            return '<span class="tag-pill">' + esc(t) + '</span>';
          }).join('');
          var docBtn = item.docLink
            ? '<a class="doc-link" href="' + esc(item.docLink) + '" target="_blank">View in Doc →</a>'
            : '';
          return '<div class="card">'
            + '<div class="card-meta">'
            + '<span class="badge" style="background:' + color + '">' + esc(item.sourceType) + '</span>'
            + date
            + '</div>'
            + '<p class="card-title"><a href="' + esc(item.url) + '" target="_blank">' + esc(item.title) + '</a></p>'
            + '<p class="card-summary">' + esc(item.shortSummary) + '</p>'
            + '<div class="card-footer">'
            + '<div class="card-tags">' + pills + '</div>'
            + docBtn
            + '</div>'
            + '</div>';
        }).join('');
      }

      function esc(s) {
        return String(s || '').replace(/&/g,'&amp;').replace(/</g,'&lt;')
          .replace(/>/g,'&gt;').replace(/"/g,'&quot;');
      }
    </script>
  </body>
</html>`;
}

// ─── Save / Dismiss Handlers ──────────────────────────────────────────────────

/**
 * Shows a tag selection page. Configured tags are listed as checkboxes;
 * tags Gemini assigned to the item are pre-checked.
 *
 * @param {string} itemId
 * @param {Object} item - Row object from Sheets
 * @returns {GoogleAppsScript.HTML.HtmlOutput}
 */
function handleSaveSelection(itemId, item) {
  const configuredTags = getConfiguredTags();
  const itemTags = item.tags
    ? item.tags.split(',').map(t => t.trim().toLowerCase())
    : [];
  const webAppUrl = getProperty(PROP.WEBAPP_URL);

  if (configuredTags.length === 0) {
    return buildConfirmationPage(
      'No topics are configured. Add tag → folder mappings to the Config tab in your Google Sheet first.'
    );
  }

  const checkboxes = configuredTags.map(tag => {
    const checked = itemTags.includes(tag.toLowerCase()) ? 'checked' : '';
    return `
      <label style="display: flex; align-items: center; gap: 10px; padding: 8px 0;
                    border-bottom: 1px solid #f0f0f0; cursor: pointer;">
        <input type="checkbox" name="tags" value="${escapeHtml(tag)}" ${checked}
               style="width: 16px; height: 16px; cursor: pointer;">
        <span>${escapeHtml(tag)}</span>
      </label>`;
  }).join('');

  const html = `<!DOCTYPE html>
<html>
  <head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>Save to PKM</title>
    <style>
      body {
        font-family: sans-serif;
        display: flex;
        align-items: center;
        justify-content: center;
        min-height: 100vh;
        margin: 0;
        background: #f8f9fa;
      }
      .card {
        background: white;
        border-radius: 8px;
        padding: 28px 32px;
        box-shadow: 0 1px 4px rgba(0,0,0,0.1);
        width: 100%;
        max-width: 420px;
      }
      h2 { font-size: 15px; margin: 0 0 4px; color: #222; }
      .subtitle { font-size: 13px; color: #888; margin: 0 0 20px; }
      .tag-list { margin-bottom: 20px; }
      .btn {
        display: inline-block;
        background: #1a73e8;
        color: white;
        padding: 8px 20px;
        border-radius: 4px;
        border: none;
        font-size: 14px;
        cursor: pointer;
        margin-right: 8px;
      }
      .btn-secondary {
        background: #f1f3f4;
        color: #444;
        text-decoration: none;
      }
    </style>
  </head>
  <body>
    <div class="card">
      <h2>${escapeHtml(item.title)}</h2>
      <p class="subtitle">Select topics to save this item to:</p>
      <form method="GET" action="${webAppUrl}" target="_top">
        <input type="hidden" name="id" value="${escapeHtml(itemId)}">
        <input type="hidden" name="action" value="confirm">
        <div class="tag-list">${checkboxes}</div>
        <button type="submit" class="btn">Save</button>
        <a href="${webAppUrl}?id=${encodeURIComponent(itemId)}&action=dismiss"
           class="btn btn-secondary" target="_top">Dismiss</a>
      </form>
    </div>
  </body>
</html>`;

  return HtmlService.createHtmlOutput(html)
    .setTitle('Save to PKM')
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.DEFAULT);
}

/**
 * Handles the confirmed save: writes to the selected Topic Docs, updates Sheets.
 *
 * @param {string}   itemId
 * @param {Object}   item         - Row object from Sheets
 * @param {string[]} selectedTags - Tags chosen by the user on the selection page
 * @returns {GoogleAppsScript.HTML.HtmlOutput}
 */
function handleSaveConfirm(itemId, item, selectedTags) {
  if (selectedTags.length === 0) {
    return buildConfirmationPage('No topics selected — item was not saved.');
  }

  try {
    let summary;
    try {
      summary = item.summaryJson ? JSON.parse(item.summaryJson) : null;
    } catch (_) {
      summary = null;
    }

    if (!summary) {
      // Fallback for rows written before the SUMMARY_JSON column existed.
      summary = {
        shortSummary: item.summary,
        fullSummary:  item.summary,
        tags:         selectedTags,
        keyTerms:     [],
        keyPoints:    [],
        actionItems:  [],
      };
    } else {
      summary.tags = selectedTags; // use the user's confirmed tag selection
    }

    const docLink = saveItemToDoc(item, summary, selectedTags);
    updateDocLink(itemId, docLink);
    addItemToLibrary(item, summary, selectedTags, docLink);
    updateItemStatus(itemId, STATUS.SAVED);

    const tagList  = selectedTags.map(escapeHtml).join(', ');
    const webAppUrl = getProperty(PROP.WEBAPP_URL);
    const viewLink = docLink
      ? ` <a href="${encodeURI(docLink)}" target="_top">View in Doc →</a>`
      : '';
    const backLink = ` <a href="${webAppUrl}" target="_top">← Back to Inbox</a>`;
    Logger.log(`WebApp: saved item ${itemId} to tags [${tagList}] → ${docLink}`);
    return buildConfirmationPage(`Saved to: ${tagList}.${viewLink}${backLink}`);
  } catch (e) {
    Logger.log(`WebApp: error saving item ${itemId}: ${e.message}`);
    return buildConfirmationPage(`Something went wrong: ${escapeHtml(e.message)}`);
  }
}

/**
 * Handles the dismiss action: updates status in Sheets.
 *
 * @param {string} itemId
 * @param {Object} item   - Row object from Sheets
 * @returns {GoogleAppsScript.HTML.HtmlOutput}
 */
function handleDismiss(itemId, item) {
  try {
    updateItemStatus(itemId, STATUS.DISMISSED);
    Logger.log(`WebApp: dismissed item ${itemId}`);
    const webAppUrl = getProperty(PROP.WEBAPP_URL);
    return buildConfirmationPage(`Dismissed. <a href="${webAppUrl}" target="_top">← Back to Inbox</a>`);
  } catch (e) {
    Logger.log(`WebApp: error dismissing item ${itemId}: ${e.message}`);
    return buildConfirmationPage(`Something went wrong: ${escapeHtml(e.message)}`);
  }
}

/**
 * Returns a minimal HTML confirmation page.
 *
 * @param {string} message - Message to display (may contain safe HTML like links)
 * @returns {GoogleAppsScript.HTML.HtmlOutput}
 */
function buildConfirmationPage(message) {
  const html = `<!DOCTYPE html>
<html>
  <head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>PKM</title>
    <style>
      body {
        font-family: sans-serif;
        display: flex;
        align-items: center;
        justify-content: center;
        min-height: 100vh;
        margin: 0;
        background: #f8f9fa;
      }
      .card {
        background: white;
        border-radius: 8px;
        padding: 32px 40px;
        text-align: center;
        box-shadow: 0 1px 4px rgba(0,0,0,0.1);
        max-width: 400px;
      }
      a { color: #1a73e8; }
    </style>
  </head>
  <body>
    <div class="card">
      <p>${message}</p>
    </div>
  </body>
</html>`;

  return HtmlService.createHtmlOutput(html)
    .setTitle('PKM')
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.DEFAULT);
}
