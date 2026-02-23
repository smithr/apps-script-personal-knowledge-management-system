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
  Logger.log('--- runDailyPipeline start ---');
  try {
    runYouTubePipeline();
  } catch (e) {
    Logger.log(`YouTube pipeline error: ${e.message}`);
  }
  Logger.log('--- runDailyPipeline end ---');
}
