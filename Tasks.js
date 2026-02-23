/**
 * Tasks.js
 * Source connector for Google Tasks.
 * Monitors a configured task list and returns normalized items for summarization.
 * Tasks are marked completed after processing so they clear from the active list.
 */

/**
 * Entry point for the Tasks pipeline. Called by runFrequentPipeline() in Code.js.
 */
function runTasksPipeline() {
  const taskListId = getProperty(PROP.TASKS_LIST_ID);
  const newItems   = fetchPendingTasks(taskListId);
  Logger.log(`Tasks: ${newItems.length} new task(s) found`);

  newItems.forEach(item => {
    // TODO: Call summarizeItem(item) from Gemini.js
    // TODO: Call addItemToInbox(item, summary) from Sheets.js
    // TODO: Call addProcessedId(item.id) from Config.js
    // TODO: Call completeTask(taskListId, item.rawMetadata.taskId)
  });
}

/**
 * Fetches all active (needsAction) tasks from the configured task list that
 * have not already been processed.
 *
 * @param {string} taskListId - Google Tasks list ID (e.g. '@default')
 * @returns {Object[]} Array of normalized items (sourceType: SOURCE.TASKS)
 */
function fetchPendingTasks(taskListId) {
  // TODO: Tasks is an Advanced Service — enable it in the Apps Script editor
  //   Services > Tasks API v1
  const response = Tasks.Tasks.list(taskListId, { showCompleted: false });
  const newItems = [];

  (response.items || []).forEach(task => {
    if (task.status !== 'needsAction') return;
    if (isProcessed(task.id)) return;

    const notes = task.notes || '';
    // If the notes field contains a URL, use it as the item URL; otherwise use a Tasks deep link
    const url = extractUrl(notes) || `https://tasks.google.com/`;

    newItems.push(normalizeItem({
      sourceType:  SOURCE.TASKS,
      title:       task.title,
      url:         url,
      content:     notes ? `${task.title}\n\n${notes}` : task.title,
      rawMetadata: { taskId: task.id, taskListId },
    }));
  });

  return newItems;
}

/**
 * Marks a Google Task as completed.
 *
 * @param {string} taskListId
 * @param {string} taskId
 */
function completeTask(taskListId, taskId) {
  // TODO: Tasks is an Advanced Service — must be enabled
  Tasks.Tasks.patch({ status: 'completed' }, taskListId, taskId);
}

/**
 * Extracts the first URL found in a string, or null if none.
 *
 * @param {string} text
 * @returns {string|null}
 */
function extractUrl(text) {
  const match = String(text).match(/https?:\/\/[^\s]+/);
  return match ? match[0] : null;
}
