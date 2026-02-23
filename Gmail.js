/**
 * Gmail.js
 * Source connector for Gmail.
 * Monitors a configured label and returns normalized items for summarization.
 * Plain text is extracted from message bodies via stripHtml() in Utils.js.
 */

/**
 * Entry point for the Gmail pipeline. Called by runFrequentPipeline() in Code.js.
 */
function runGmailPipeline() {
  const newItems = fetchLabeledMessages();
  Logger.log(`Gmail: ${newItems.length} new message(s) found`);

  newItems.forEach(item => {
    try {
      const summary = summarizeItem(item);
      addItemToInbox(item, summary);
    } catch (e) {
      Logger.log(`Gmail: failed to process "${item.title}" — skipping. Error: ${e.message}`);
    } finally {
      // Always mark as processed to prevent infinite retries on persistent failures
      addProcessedId(item.rawMetadata.threadId);
    }
  });
}

/**
 * Fetches unprocessed messages matching the configured Gmail label.
 * Uses thread-level deduplication: stores the thread ID as the processed ID.
 *
 * @returns {Object[]} Array of normalized items (sourceType: SOURCE.GMAIL)
 */
function fetchLabeledMessages() {
  const label = getProperty(PROP.GMAIL_LABEL);
  const threads = GmailApp.search(`label:${label} in:inbox`);
  const newItems = [];

  threads.forEach(thread => {
    const threadId = thread.getId();
    if (isProcessed(threadId)) return;

    const message = thread.getMessages()[0]; // use first message in thread
    const subject = message.getSubject() || '(no subject)';
    const sender  = message.getFrom();
    const bodyHtml = message.getBody();
    const bodyText = stripHtml(bodyHtml).slice(0, 8000);

    newItems.push(normalizeItem({
      sourceType:  SOURCE.GMAIL,
      title:       subject,
      url:         `https://mail.google.com/mail/u/0/#inbox/${threadId}`,
      content:     `From: ${sender}\n\n${bodyText}`,
      rawMetadata: { threadId, sender, label },
    }));
  });

  return newItems;
}
