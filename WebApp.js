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
 * Request format:
 *   (no params)                                     — real-time inbox view
 *   ?id=ITEM_ID&action=save                         — show tag selection page
 *   ?id=ITEM_ID&action=confirm&tags=tag1&tags=tag2  — save to selected tags
 *   ?id=ITEM_ID&action=dismiss                      — dismiss item
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

  if (!itemId || !action) {
    return buildConfirmationPage('Invalid request — missing id or action parameter.');
  }
  if (action !== 'save' && action !== 'confirm' && action !== 'dismiss') {
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
  return handleDismiss(itemId, item);
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
    <p class="subtitle">${items.length} pending item${items.length !== 1 ? 's' : ''}</p>
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
        <a href="${saveUrl}" class="btn btn-save">Save to PKM</a>
        <a href="${dismissUrl}" class="btn btn-dismiss">Dismiss</a>
      </div>
    </div>`;
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
      <form method="GET" action="${webAppUrl}">
        <input type="hidden" name="id" value="${escapeHtml(itemId)}">
        <input type="hidden" name="action" value="confirm">
        <div class="tag-list">${checkboxes}</div>
        <button type="submit" class="btn">Save</button>
        <a href="${webAppUrl}?id=${encodeURIComponent(itemId)}&action=dismiss"
           class="btn btn-secondary">Dismiss</a>
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
    updateItemStatus(itemId, STATUS.SAVED);

    const tagList  = selectedTags.map(escapeHtml).join(', ');
    const webAppUrl = getProperty(PROP.WEBAPP_URL);
    const viewLink = docLink
      ? ` <a href="${encodeURI(docLink)}">View in Doc →</a>`
      : '';
    const backLink = ` <a href="${webAppUrl}">← Back to Inbox</a>`;
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
    return buildConfirmationPage(`Dismissed. <a href="${webAppUrl}">← Back to Inbox</a>`);
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
