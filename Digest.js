/**
 * Digest.js
 * Digest email composition and delivery.
 *
 * sendDigest() is the trigger function — set up a time-based trigger in the
 * Apps Script editor to call it multiple times per day.
 */

/**
 * Main trigger function.
 * Queries pending unsent items, composes a digest email, sends it,
 * then marks all included items as digest-sent.
 * Exits silently if there are no pending items.
 */
function sendDigest() {
  const items = getPendingUnsentItems();

  if (items.length === 0) {
    Logger.log('Digest: no pending items — skipping');
    return;
  }

  Logger.log(`Digest: sending ${items.length} item(s)`);

  const recipient = getProperty(PROP.DIGEST_EMAIL);
  const subject   = `PKM Digest — ${items.length} new item${items.length > 1 ? 's' : ''}`;
  const htmlBody  = buildDigestEmail(items);

  MailApp.sendEmail({ to: recipient, subject, htmlBody });

  const sentIds = items.map(item => item.itemId);
  markItemsDigestSent(sentIds);

  Logger.log(`Digest: sent and marked ${sentIds.length} item(s) as digest-sent`);
}

/**
 * Composes the full HTML digest email body from an array of pending items.
 *
 * @param {Object[]} items - Row objects from Sheets.js getPendingUnsentItems()
 * @returns {string} Complete HTML email body
 */
function buildDigestEmail(items) {
  const cards = items.map(buildItemCard).join('\n');

  return `
    <div style="font-family: sans-serif; max-width: 640px; margin: 0 auto; color: #222;">
      <h1 style="font-size: 20px; border-bottom: 2px solid #eee; padding-bottom: 8px;">
        PKM Digest — ${items.length} new item${items.length > 1 ? 's' : ''}
      </h1>
      ${cards}
      <p style="color: #999; font-size: 12px; margin-top: 32px;">
        Sent by your PKM system. Items not acted on will reappear in the next digest.
      </p>
    </div>
  `;
}

/**
 * Builds an HTML card for a single digest item.
 * All user-supplied text is escaped before interpolation.
 *
 * @param {Object} item - Row object from Sheets.js
 * @returns {string} HTML fragment
 */
function buildItemCard(item) {
  const webAppUrl  = getProperty(PROP.WEBAPP_URL);
  const saveUrl    = `${webAppUrl}?id=${encodeURIComponent(item.itemId)}&action=save`;
  const dismissUrl = `${webAppUrl}?id=${encodeURIComponent(item.itemId)}&action=dismiss`;

  const title      = escapeHtml(item.title);
  const summary    = formatSummaryAsHtml(item.summary);
  const tags       = escapeHtml(item.tags);
  const sourceType = escapeHtml(item.sourceType);
  const date       = new Date(item.dateAdded).toLocaleDateString();
  const itemUrl    = encodeURI(item.url);

  const sourceBadgeColor = {
    [SOURCE.YOUTUBE]: '#FF0000',
    [SOURCE.GMAIL]:   '#EA4335',
    [SOURCE.TASKS]:   '#1A73E8',
  }[item.sourceType] || '#888';

  return `
    <div style="border: 1px solid #e0e0e0; border-radius: 6px; padding: 16px; margin-bottom: 16px;">
      <div style="margin-bottom: 8px;">
        <span style="
          background: ${sourceBadgeColor};
          color: white;
          font-size: 11px;
          font-weight: bold;
          padding: 2px 7px;
          border-radius: 3px;
          text-transform: uppercase;
          letter-spacing: 0.5px;
        ">${sourceType}</span>
        <span style="color: #888; font-size: 12px; margin-left: 8px;">${date}</span>
      </div>

      <h2 style="font-size: 16px; margin: 0 0 8px;">
        <a href="${itemUrl}" style="color: #1a0dab; text-decoration: none;">${title}</a>
      </h2>

      <div style="margin: 0 0 8px; line-height: 1.6;">${summary}</div>

      ${tags ? `<p style="margin: 0 0 12px; font-size: 12px; color: #666;">Tags: ${tags}</p>` : ''}

      <div>
        <a href="${saveUrl}" style="
          display: inline-block;
          background: #1a73e8;
          color: white;
          padding: 6px 14px;
          border-radius: 4px;
          text-decoration: none;
          font-size: 13px;
          margin-right: 8px;
        ">Save to PKM</a>
        <a href="${dismissUrl}" style="
          display: inline-block;
          background: #f1f3f4;
          color: #444;
          padding: 6px 14px;
          border-radius: 4px;
          text-decoration: none;
          font-size: 13px;
        ">Dismiss</a>
      </div>
    </div>
  `;
}

/**
 * Converts a plain-text summary (with • bullets and newlines) to formatted HTML.
 * Lines starting with •, -, or * become <li> items grouped in a <ul>.
 * All other non-empty lines become <p> elements.
 * All text content is escaped before being embedded in HTML.
 *
 * @param {string} text
 * @returns {string} HTML string
 */
function formatSummaryAsHtml(text) {
  const lines     = String(text).split('\n').map(l => l.trim()).filter(l => l);
  const parts     = [];
  let listItems   = [];

  lines.forEach(line => {
    if (/^[•\-\*]/.test(line)) {
      const content = escapeHtml(line.replace(/^[•\-\*]\s*/, ''));
      listItems.push(`<li style="margin-bottom: 6px;">${content}</li>`);
    } else {
      if (listItems.length > 0) {
        parts.push(`<ul style="margin: 0 0 8px; padding-left: 20px;">${listItems.join('')}</ul>`);
        listItems = [];
      }
      parts.push(`<p style="margin: 0 0 8px;">${escapeHtml(line)}</p>`);
    }
  });

  if (listItems.length > 0) {
    parts.push(`<ul style="margin: 0 0 8px; padding-left: 20px;">${listItems.join('')}</ul>`);
  }

  return parts.join('');
}
