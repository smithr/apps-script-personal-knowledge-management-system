/**
 * Wiki.js
 * Weekly wiki generation pipeline. Reads all saved items from the library index,
 * groups them by Config topic group, and generates one Google Doc per group plus
 * a top-level Wiki Index doc via Gemini.
 *
 * Entry point: buildWiki() — called by runWeeklyWiki() in Code.js.
 */

// Delay between per-group Gemini calls to avoid rate limits (milliseconds).
const WIKI_GEMINI_DELAY_MS = 2000;

/**
 * Returns the Script Property key used to cache a wiki doc ID for a given group.
 * Group name is uppercased and non-alphanumeric characters replaced with underscores
 * so the key is safe for Script Properties storage.
 *
 * @param {string} groupName
 * @returns {string} e.g. 'WIKI_DOC_MACHINE_LEARNING'
 */
function wikiDocPropKey(groupName) {
  return 'WIKI_DOC_' + groupName.toUpperCase().replace(/[^A-Z0-9]/g, '_');
}

/**
 * Reads the Config sheet and returns all unique topic groups with their associated tags.
 * Groups are derived from column C (group name); when column C is blank the tag name
 * (column A) is used as the group — the same logic as getTagConfig() in Sheets.js.
 *
 * Tags sharing the same group name are consolidated into one wiki article, mirroring
 * how they are consolidated into one Topic Doc by Docs.js.
 *
 * @returns {Array<{group: string, tags: string[]}>}
 */
function getWikiGroups() {
  const sheet = getSheet(TABS.CONFIG);
  const data  = sheet.getDataRange().getValues();

  const groupMap = {}; // group → [tags]

  data.forEach(row => {
    const tag      = String(row[0] || '').trim();
    const folderId = String(row[1] || '').trim();
    if (!tag || !folderId) return; // skip rows with no tag or no folder configured

    const group = String(row[2] || '').trim() || tag;
    if (!groupMap[group]) groupMap[group] = [];
    if (!groupMap[group].includes(tag)) groupMap[group].push(tag);
  });

  return Object.keys(groupMap).map(group => ({ group, tags: groupMap[group] }));
}

// ─── Test Helpers (run manually from Apps Script editor) ──────────────────────

/**
 * Logs all wiki groups and their associated tags.
 * Run from the Apps Script editor to verify Config sheet parsing before going live.
 */
function testGetWikiGroups() {
  const groups = getWikiGroups();
  Logger.log(`getWikiGroups: found ${groups.length} group(s)`);
  groups.forEach(g => Logger.log(`  "${g.group}": [${g.tags.join(', ')}]`));
}
