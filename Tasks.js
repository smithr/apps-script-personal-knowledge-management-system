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
    try {
      const summary = summarizeItem(item);
      addItemToInbox(item, summary);
      completeTask(taskListId, item.rawMetadata.taskId);
    } catch (e) {
      Logger.log(`Tasks: failed to process "${item.title}" — skipping. Error: ${e.message}`);
    } finally {
      // Always mark as processed to prevent infinite retries on persistent failures
      addProcessedId(item.rawMetadata.taskId);
    }
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
  const response = Tasks.Tasks.list(taskListId, { showCompleted: false });
  const newItems = [];

  (response.items || []).forEach(task => {
    if (task.status !== 'needsAction') return;
    if (isProcessed(task.id)) return;

    const notes = task.notes || '';
    const urlFromTitle = extractUrl(task.title);
    // If the notes field contains a URL, use it as the item URL; otherwise use a Tasks deep link
    const url = urlFromTitle || extractUrl(notes) || `https://tasks.google.com/`;

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


function debugGetTasksListIds() {
  const lists = Tasks.Tasklists.list();
  lists.items.forEach(list => {
    Logger.log(`${list.title}: ${list.id}`);
      const response = Tasks.Tasks.list(list.id, { showCompleted: false });
      (response.items || []).forEach(task => {
      if (task.status !== 'needsAction') return;
      Logger.log(`Task: ${task.title}, id: ${task.id}`);
    });
  });
}
