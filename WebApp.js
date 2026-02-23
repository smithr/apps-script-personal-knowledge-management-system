/**
 * WebApp.js
 * doGet approval endpoint. Handles [Save to PKM] and [Dismiss] link clicks
 * from the digest email.
 *
 * Deployment settings (set in Apps Script editor > Deploy > Manage deployments):
 *   Execute as: Me (script owner)
 *   Who has access: Only myself
 *
 * This ensures approval links only function when the user is authenticated,
 * preventing unintended saves if a link is forwarded.
 *
 * Request format: ?id=ITEM_ID&action=save|dismiss
 */

/**
 * Apps Script web app entry point.
 *
 * @param {GoogleAppsScript.Events.DoGet} e
 * @returns {GoogleAppsScript.HTML.HtmlOutput}
 */
function doGet(e) {
  const params = e.parameter || {};
  const itemId = params.id;
  const action = params.action;

  // Validate required parameters
  if (!itemId || !action) {
    return buildConfirmationPage('Invalid request — missing id or action parameter.');
  }
  if (action !== 'save' && action !== 'dismiss') {
    return buildConfirmationPage(`Invalid action: "${escapeHtml(action)}". Expected "save" or "dismiss".`);
  }

  // Look up the item in Sheets
  const found = getItemById(itemId);
  if (!found) {
    return buildConfirmationPage('Item not found. It may have already been removed.');
  }

  const item = found.data;

  // Idempotency: if already actioned, confirm without re-processing
  if (item.status === STATUS.SAVED || item.status === STATUS.DISMISSED) {
    return buildConfirmationPage(
      `This item was already ${item.status.toLowerCase()}. No changes made.`
    );
  }

  // Process the action
  if (action === 'save') {
    return handleSave(itemId, item);
  } else {
    return handleDismiss(itemId, item);
  }
}

/**
 * Handles the save action: writes to Doc, updates Sheets.
 *
 * @param {string} itemId
 * @param {Object} item   - Row object from Sheets
 * @returns {GoogleAppsScript.HTML.HtmlOutput}
 */
function handleSave(itemId, item) {
  try {
    // TODO: The full summary and structured fields (keyPoints, actionItems) are not
    //   stored in Sheets — only shortSummary is. For Docs.js to append a rich entry,
    //   either store fullSummary in an additional column, or re-summarize here.
    //   For now, a minimal summary object is constructed from available Sheets data.
    const summary = {
      shortSummary: item.summary,
      fullSummary:  item.summary,
      tags:         item.tags ? item.tags.split(',').map(t => t.trim()) : [],
      keyPoints:    [],
      actionItems:  [],
    };

    const docLink = saveItemToDoc(item, summary);
    updateDocLink(itemId, docLink);
    updateItemStatus(itemId, STATUS.SAVED);

    Logger.log(`WebApp: saved item ${itemId} → ${docLink}`);
    return buildConfirmationPage(`Saved! <a href="${encodeURI(docLink)}">View in Doc →</a>`);
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
    return buildConfirmationPage('Dismissed.');
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
