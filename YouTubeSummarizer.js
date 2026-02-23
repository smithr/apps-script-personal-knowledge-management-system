/** 
  Summary:
  The script will retrieve all videos from a YouTube playlist and then use Gemini (https://ai.google.dev/gemini-api/docs/video-understanding#youtube) 
  to summarize the video. That summary is emailed to a specified email address from your gmail account. 

  Purpose:
  - Reviewing a summary of a video will help me determine if I want to commit the time to watching the video. 
  - In cases where I do watch the vide, the summary is helpful in setting context before watching, and reinforcing key takeaways/insights after watching
  - The sample NotebookLM questions are helpful if I add this video as a source to a notebook in NotebookLM. 

  Setup: 
  1. Create a new Project on Google Cloud Platform (using https://console.cloud.google.com/). I named my Project "YouTube Playlist Summarizer"
  2. Enable Necessary APIs
    - Go to "APIs & Services" > "Enabled APIs & Services"
    - Search for enab enable the following APIs
      - Gemini (or Generative Language API) 
      - YouTube Data API v3
  3. Create API Keys for Gemini and OAuth Client ID for Youtube
    - Go to "APIs & Services" > "Credentials."
    - For the Gemini API: Create an API Key. Keep this key safe; you'll paste it into the `GEMINI_API_KEY` in your copy of the Apps Script
    - For YouTube Data API v3: Google Apps Script often handles the OAuth 2.0 flow for you (prompting for authorization the first time you run it). So, you generally don't need to create a separate OAuth Client ID here unless Apps Script gives you a specific error about it. The Apps Script environment simplifies this for standard Google services.
  4. Open Google Apps Script
    - Go to script.google.com.
    - Start a "New project." I named my project "YouTube Playlist Summarizer"
  5. Copy this script into `Code.gs`
    - Update the `GEMINI_MODEL` if you would like to. 
    - Add Script Properties for the secure variables used by this script
      - Go to Project Settings (gear icon)
      - Click Edit Script Properties
      - Click Add Script Property
      - Add a new property named `EMAIL_ADDRESS` with a value that is your gmail address.
      - Add a new property `YOUTUBE_PLAYLIST_ID`with the the value of the Youtube Playlist you want to summarize videos from. You can retrieve this from the URL of your playlist. Note that built-in playlists like "Watch Later" (the `wl` playlist) will not work. 
      - Add a new property `GEMINI_API_KEY`with a value that is the API Key you created for your Google Cloud Project in Step #1. 
  6. Confirm that your Apps Script project is linked to your Google Cloud Project to be able to access Gemini, etc.
    - On the left-hand sidebar, click the Project Settings icon.
    - Look for the section titled "Google Cloud Platform (GCP) Project.
    - Confirm that Project Number is set to the Project ID of your Google Cloud Project. If not, click "Change Project" and select the project that you created in Step #1. 
  7. Enabling Advanced Services in Apps Script
    - For `YoutubelistItems.list`  you might need to enable Advanced Google Services within your Apps Script project.
    - In the Apps Script editor, go to Services (+)  on the left sidebar.
    - Search for "YouTube Data API" and and add it. This allows Apps Script to use those services directly.
  8. Set Up a Time-Driven Trigger:
    - In your Google Apps Script editor, look for the alarm clock icon (Triggers) on the left sidebar.
    - Click "+ Add Trigger."
    - Configure it: 
      - Choose which function to run: Select processYouTubePlaylist
      - Choose deployment to run: Head 
      - Select event source: Time-driven.
      - Select type of time-based trigger: Day timer or Hour timer (e.g., "Every hour" or "Every 12 hours"). Choose a frequency that makes sense for how often you add videos and how quickly you want them summarized.
      - Select time of day: (If applicable, e.g., "between 10 AM and 11 AM").
    - Click Save.
  9. Authorization:
    - The very first time this script (or a function within it) ND it tries to access your YouTube, Google will prompt you to authorize it. You'll see a pop-up asking for permissions. This is normal and necessary. Ensure you grant the required permissions.

  Testing: 
  - You can Run/Debug the `processYouTubePlaylist` as you're iterating on the script. 
    - I suggest setting the `DEBUG` variable to true while you're testing so you don't have to keep adding new videos to the playlist.
*/
const YOUTUBE_GEMINI_PROMPT = `Task: Analyze this video and generate a highly detailed, dense summary of the core concepts.
Instruction: Act as an expert note-taker. Do not just list the topics. For every concept, extract the specific reasoning, the "how-to" mechanics, and the ultimate value to the user. Write as if you are transcribing the most important points word-for-word.
Formatting Rules:
1. No Introductions: Start immediately with the first point.
2. Format: Concept Name (MM:SS): A dense, 3-4 sentence paragraph.
3. Depth Requirement: Each paragraph must explain what the concept is, why the speaker recommends it, and how to implement it.
4. Use Bullets. Each paragraph should be in a separate bullet. 
5. External Links: Conclude with a single sentence noting any external resources (GitHub, docs) mentioned, with timestamps.
Tone: Highly technical, objective, and information-dense.
Return the response as a single block of clean HTML, without using markdown code fences like \`\`\`html. Just return the HTML itself.`

// --- Main Function to Run on Schedule ---
function processYouTubePlaylist() {
  try {
    clearProcessedVideoIdsIfDebugMode();
    
    // 1. Get previously processed video IDs (e.g., from a Google Sheet or Script Properties)
    //    For simplicity, let's use Script Properties for now.
    const processedVideoIds = getProcessedVideoIds();

    // 2. Get current videos from the YouTube playlist
    const currentVideos = getVideosFromPlaylist(getProperty(PROP.YOUTUBE_PLAYLIST_ID));

    // 3. Loop through current videos and check for new ones
    let newVideoIds = [];
    let newVideoSummaries = [];
    currentVideos.forEach(video => {
      if (!processedVideoIds.includes(video.id)) {
        Logger.log(`Found new video: ${video.title} (${video.id})`);
        
        // 4. Summarize the video using Gemini API, note that this summary response is in HTML via the prompt. 
        const summary = summarizeYouTubeVideo(video.url);
        newVideoSummaries.push({ title: video.title, summary: summary, url: video.url });
        
        //`Here is a summary of the new video:\n\n${summary}\n\nWatch it here: ${video.url}`
        newVideoIds.push(video.id);
      }

    });
    // Email the summaries
    if (newVideoSummaries.length > 0) {
        newVideoSummaries.forEach(video => {
          let emailBody = "Here are the summary video: " + video.title; 
           emailBody += `<h2>${video.title}</h2><div style="text-align: left; max-width: 600px;">${video.summary}</div><p><a href="${video.url}">Watch the video</a></p><hr/>`;   
          MailApp.sendEmail({
            to: getProperty(PROP.DIGEST_EMAIL),
            subject: `[YouTube Video Summary] ${video.title}`,
            htmlBody: emailBody
          });
        });
    }

    // 6. Update the list of processed video IDs
    if (newVideoIds.length > 0) {
      updateProcessedVideoIds(processedVideoIds.concat(newVideoIds));
      Logger.log(`Processed ${newVideoIds.length} new videos.`);
    } else {
      Logger.log('No new videos found in playlist.');
    }
  } catch (e) {
    // Log the error for debugging
    Logger.log(`A critical error occurred: ${e.message}`);

    // Optional: Email yourself an error notification
    MailApp.sendEmail({
      to: getProperty(PROP.DIGEST_EMAIL),
      subject: 'YouTube Summarizer Script Failed',
      body: `The script failed with the following error: \n\n${e.message}\n\nStack Trace:\n${e.stack}`
    });
  }
}

function clearProcessedVideoIdsIfDebugMode() {
  if (DEBUG) {
    setProperty(PROP.PROCESSED_IDS, "[]");
  }
}

// Fetches processed video IDs. On first run, this will be empty.
function getProcessedVideoIds() {
  const idsString = getProperty(PROP.PROCESSED_IDS);
  return idsString ? JSON.parse(idsString) : [];
}

// Saves processed video IDs.
function updateProcessedVideoIds(ids) {
  setProperty(PROP.PROCESSED_IDS, JSON.stringify(ids));
}

// This function will call the YouTube Data API to get videos
function getVideosFromPlaylist(playlistId) {
  Logger.log(`Fetching videos from playlist ID: ${playlistId}`);

  let allVideos = [];
  let pageToken = null; // Used for pagination
  

  do {
    // Make the API call using the YouTube Advanced Service
    // 'snippet' part gives us title, description, thumbnails, resourceId (which contains videoId)
    // 'contentDetails' part gives us useful info like video duration or privacyStatus if needed
    const response = YouTube.PlaylistItems.list('snippet,contentDetails', {
      playlistId: playlistId,
      maxResults: 50, // Max results per page is 50
      pageToken: pageToken // Include page token for subsequent requests
    });

    response.items.forEach(item => {
      // Basic check to ensure it's a video item and has a videoId
      if (item.snippet && item.snippet.resourceId && item.snippet.resourceId.kind === 'youtube#video') {
        allVideos.push({
          id: item.snippet.resourceId.videoId, // The unique video ID (e.g., 'dQw4w9WgXcQ')
          title: item.snippet.title,
          description: item.snippet.description, 
          url: `https://www.youtube.com/watch?v=${item.snippet.resourceId.videoId}`
          // You could also add thumbnail URLs, publishedAt, etc.
        });
      }
    });

    // Get the next page token if more results exist
    pageToken = response.nextPageToken;

  } while (pageToken); // Continue looping until there are no more pages

  Logger.log(`Found ${allVideos.length} videos in the playlist.`);
  return allVideos;
}


// This function will call the Gemini API for summarization
function summarizeYouTubeVideo(videoUrl) {
  Logger.log(`Summarizing video: ${videoUrl}`);
  
  // Summrize the video using Gemini 
  const API_ENDPOINT = `https://generativelanguage.googleapis.com/v1beta/models/${getProperty(PROP.GEMINI_MODEL)}:generateContent?key=${getProperty(PROP.GEMINI_API_KEY)}`;
  const payload = {
    contents: [{
      parts: [
        {"text": `${YOUTUBE_GEMINI_PROMPT}`},
        {
          "file_data": { 
            "file_uri": `${videoUrl}` 
          }
        }
      ]
    }]
  };

  const options = {
    method: 'post',
    contentType: 'application/json',
    "x-goog-api-key": getProperty(PROP.GEMINI_API_KEY),
    payload: JSON.stringify(payload),
    muteHttpExceptions: true
  };

  try {
    // Note that this call can take some time depending on the length of the video
    const response = UrlFetchApp.fetch(API_ENDPOINT, options);
    const jsonResponse = JSON.parse(response.getContentText());
    // Extract the summary from the Gemini response
    let summaryHtml =  jsonResponse.candidates[0].content.parts[0].text || 'No summary available.';

    // This regex removes the opening and closing markdown code fences.
    summaryHtml = summaryHtml.replace(/^```(html)?\s*/, '').replace(/\s*```$/, '');

    return summaryHtml.trim();
  } catch (e) {
    Logger.log(`Error summarizing video ${videoUrl}: ${e.message}`);
    return `Failed to summarize: ${e.message}`;
  }
}


