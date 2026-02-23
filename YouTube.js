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
        addProcessedId(item.id);
      } catch (e) {
        Logger.log(`YouTube: failed to process "${item.title}" — will retry next run. Error: ${e.message}`);
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
        rawMetadata: { playlistId },
      }));
    });

    pageToken = response.nextPageToken;
  } while (pageToken);

  return newItems;
}
