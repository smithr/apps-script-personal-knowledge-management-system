/**
 * YouTube.js
 * Source connector for YouTube playlists.
 * Fetches new videos, deduplicates against the processed ID store, and returns
 * normalized items to be summarized and written to the Sheets inbox.
 *
 * Note: Config.js defines PROP.YOUTUBE_PLAYLIST_ID (singular). The spec calls for
 * PROP.YOUTUBE_PLAYLIST_IDS (plural, comma-separated) to support multiple playlists.
 * Update the Script Property key and PROP constant when ready to support multiple playlists.
 */

/**
 * Entry point for the YouTube pipeline. Called by runDailyPipeline() in Code.js.
 * Fetches new videos from all configured playlists, summarizes them, and writes
 * each to the Sheets inbox.
 */
function runYouTubePipeline() {
  //   When supporting multiple playlists: split by comma, trim each ID
  const playlistId = getProperty(PROP.YOUTUBE_PLAYLIST_ID);
  const playlistIds = [playlistId]; // extend to .split(',').map(s => s.trim()) for multi-playlist

  playlistIds.forEach(id => {
    const newItems = fetchPlaylistVideos(id);
    Logger.log(`YouTube: ${newItems.length} new video(s) from playlist ${id}`);

    newItems.forEach(item => {
      try {
        const summary = summarizeItem(item);
        addItemToInbox(item, summary);
        removeFromPlaylist(item.rawMetadata.playlistItemId, item.title);
      } catch (e) {
        Logger.log(`YouTube: failed to process "${item.title}" — skipping. Error: ${e.message}`);
      } finally {
        // Always mark as processed to prevent infinite retries on persistent failures
        addProcessedId(item.rawMetadata.videoId);
      }
    });
  });
}

/**
 * Fetches all unprocessed video items from a single YouTube playlist.
 * Handles API pagination automatically.
 *
 * @param {string} playlistId
 * @returns {Object[]} Array of normalized items (sourceType: SOURCE.YOUTUBE)
 */
function fetchPlaylistVideos(playlistId) {
  const newItems = [];
  let pageToken = null;

  do {
    const response = YouTube.PlaylistItems.list('snippet', {
      playlistId: playlistId,
      maxResults: 50,
      pageToken:  pageToken,
    });

    (response.items || []).forEach(item => {
      if (!item.snippet || !item.snippet.resourceId) return;
      if (item.snippet.resourceId.kind !== 'youtube#video') return;

      const videoId = item.snippet.resourceId.videoId;
      if (isProcessed(videoId)) return;

      const videoUrl = `https://www.youtube.com/watch?v=${videoId}`;
      newItems.push(normalizeItem({
        sourceType:  SOURCE.YOUTUBE,
        title:       item.snippet.title,
        url:         videoUrl,
        content:     videoUrl, // Gemini receives the URL directly for video understanding
        rawMetadata: { videoId, playlistId, playlistItemId: item.id },
      }));
    });

    pageToken = response.nextPageToken;
  } while (pageToken);

  return newItems;
}

/**
 * Removes a video from the playlist after it has been summarized and added
 * to the inbox. Failures are logged but do not affect the pipeline — the
 * item is already in the inbox regardless.
 *
 * @param {string} playlistItemId - The playlist entry ID (item.id from the API response)
 * @param {string} title          - Video title, used only for logging
 */
function removeFromPlaylist(playlistItemId, title) {
  try {
    YouTube.PlaylistItems.remove(playlistItemId);
    Logger.log(`YouTube: removed "${title}" from playlist`);
  } catch (e) {
    Logger.log(`YouTube: failed to remove "${title}" from playlist — ${e.message}`);
  }
}

/**
 * One-time cleanup: removes any playlist videos that have already been
 * processed (i.e. their videoId is in PROCESSED_IDS) but were never
 * removed because the removal feature didn't exist when they were summarized.
 *
 * Run this manually once from the Apps Script editor. After it completes,
 * the ongoing pipeline will keep the playlist clean automatically.
 */
function cleanupPlaylist() {
  const playlistId  = getProperty(PROP.YOUTUBE_PLAYLIST_ID);
  let   pageToken   = null;
  let   removed     = 0;
  let   skipped     = 0;

  do {
    const response = YouTube.PlaylistItems.list('snippet', {
      playlistId,
      maxResults: 50,
      pageToken,
    });

    (response.items || []).forEach(item => {
      if (!item.snippet?.resourceId) return;
      if (item.snippet.resourceId.kind !== 'youtube#video') return;

      const videoId = item.snippet.resourceId.videoId;
      const title   = item.snippet.title;

      if (isProcessed(videoId)) {
        removeFromPlaylist(item.id, title);
        removed++;
      } else {
        Logger.log(`cleanupPlaylist: skipping unprocessed video "${title}" — will be summarized on next run`);
        skipped++;
      }
    });

    pageToken = response.nextPageToken;
  } while (pageToken);

  Logger.log(`cleanupPlaylist: done — removed ${removed}, left ${skipped} unprocessed video(s)`);
}
