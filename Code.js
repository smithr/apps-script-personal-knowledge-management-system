/**
 * Code.js
 * Main trigger entry points. Configure these functions in the Apps Script
 * trigger dashboard (clock icon in the editor sidebar).
 *
 * Recommended trigger setup:
 *   runFrequentPipeline → Time-driven, every 15–30 minutes
 *   runDailyPipeline    → Time-driven, day timer (once per day)
 *   sendDigest          → Time-driven, multiple times per day (defined in Digest.js)
 */

/**
 * Frequent pipeline trigger (every 15–30 min).
 * Runs the Gmail and Tasks source connectors.
 */
function runFrequentPipeline() {
  Logger.log('--- runFrequentPipeline start ---');
  try {
    runGmailPipeline();
  } catch (e) {
    Logger.log(`Gmail pipeline error: ${e.message}`);
  }
  try {
    runTasksPipeline();
  } catch (e) {
    Logger.log(`Tasks pipeline error: ${e.message}`);
  }
  Logger.log('--- runFrequentPipeline end ---');
}

/**
 * Hourly pipeline trigger (once per day).
 * Runs the YouTube source connector.
 */
function runHourlyPipeline() {
  Logger.log('--- runHourlyPipeline start ---');
  try {
    runYouTubePipeline();
  } catch (e) {
    Logger.log(`YouTube pipeline error: ${e.message}`);
  }
  Logger.log('--- runHourlyPipeline end ---');
}

/**
 * Weekly synthesis trigger (once per week, Sunday evening).
 * Synthesizes all items from the past 7 days into themes, gaps, connections,
 * and open questions. Delivers via email and appends to a Drive doc.
 *
 * Configure in the Apps Script trigger dashboard:
 *   Trigger type: Time-driven → Week timer → Sunday → 6pm–7pm
 */
function runWeeklySynthesis() {
  try {
    runWeeklySynthesisInternal();
  } catch (e) {
    Logger.log(`Weekly synthesis error: ${e.message}`);
  }
}

/**
 * Weekly wiki rebuild trigger (once per week, Sunday night).
 * Generates/updates one Google Doc per topic group plus a Wiki Index doc.
 * Run after archiveProcessedItems so the wiki reflects committed knowledge.
 *
 * Configure in the Apps Script trigger dashboard:
 *   Trigger type: Time-driven → Week timer → Sunday → 10pm–11pm
 */
function runWeeklyWiki() {
  try {
    buildWiki();
  } catch (e) {
    Logger.log(`Weekly wiki error: ${e.message}`);
  }
}
