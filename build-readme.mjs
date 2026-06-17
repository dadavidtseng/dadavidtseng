/**
 * ---------------------------------------------------------------------------------------------------
 * build_readme.mjs
 *
 * Fetches recent GitHub commits and blog posts, then updates README.md with the latest data.
 * Runs on a schedule via GitHub Actions (see .github/workflows/build.yml).
 * ---------------------------------------------------------------------------------------------------
 */

/**
 * ---------------------------------------------------------------------------------------------------
 * Node.js built-in modules (no install needed)
 * - fs: read/write files on disk
 * - https: make HTTPS requests to external APIs
 * - fileURLToPath: convert file:// URL to a filesystem path (cross-platform)
 * - parseString: third-party XML parser (installed via npm)
 * ---------------------------------------------------------------------------------------------------
 */
import fs from "node:fs";
import https from "node:https";
import {fileURLToPath} from "node:url";
import {parseString} from "xml2js";

/**
 * ---------------------------------------------------------------------------------------------------
 * Configuration constants - change these to adjust behavior without modifying logic
 * ---------------------------------------------------------------------------------------------------
 */
const TOKEN = process.env.GH_TOKEN || "";  // GitHub PAT from environment; empty string if unset
const README_PATH = fileURLToPath(new URL("./README.md", import.meta.url));  // absolute path to README.md in same directory
const GITHUB_USER = "dadavidtseng";
const MAX_COMMITS = 8;           // max commits to display in README
const MAX_BLOG_POSTS = 5;        // max blog posts to display
const MAX_PUSH_EVENTS = 15;      // max push events to inspect (API returns up to 100)
const COMMIT_MSG_MAX_LEN = 60;   // truncate commit messages longer than this

/**
 * ---------------------------------------------------------------------------------------------------
 * Makes an HTTPS GET request and returns the response body as a plain string.
 * Wraps Node's callback-based https.get into a Promise so we can use async/await.
 *
 * @param {string} url Target endpoint to fetch
 * @param {Record<string, string>} headers Additional HTTP headers (auth, etc.)
 * @returns {Promise<string>} The raw response body
 * ---------------------------------------------------------------------------------------------------
 */
function fetchText(url, headers = {}) {
    // Promise: represents a value that arrives later. resolve = success, reject = failure.
    return new Promise((resolve, reject) => {
        const parsed = new URL(url);
        // @type {any} - silences IDE type mismatch on RequestOptions
        const opts = /** @type {any} */ ({
            hostname: parsed.hostname, path: parsed.pathname + parsed.search, // ...headers merges caller's headers into the object (spread operator)
            headers: {"User-Agent": `${GITHUB_USER}-readme-bot`, ...headers},
        });

        // https.get streams data in chunks (pieces), not all at once
        const req = https.get(opts, (res) => {
            let data = "";
            res.on("data", (c) => (data += c));     // append each chunk as it arrives
            res.on("end", () => resolve(data));     // all chunks received, return full body
        });

        req.on("error", reject);  // network failure rejects the promise
    });
}

/**
 * ---------------------------------------------------------------------------------------------------
 * Fetches a URL and parses the response as JSON.
 * Thin wrapper over fetchText that adds JSON.parse.
 *
 * @param {string} url Target endpoint to fetch
 * @param {Record<string, string>} headers Additional HTTP headers (auth, etc.)
 * @returns {Promise<any>} Parsed JSON object from the response
 * ---------------------------------------------------------------------------------------------------
 */
async function fetchJSON(url, headers = {}) {
    const raw = await fetchText(url, headers);
    return JSON.parse(raw);  // convert JSON string into a JS object/array
}

/**
 * ---------------------------------------------------------------------------------------------------
 * Converts an XML string into a JS object using the xml2js library.
 * Used for parsing the blog RSS feed.
 *
 * @param {string} xml Raw XML string to parse
 * @returns {Promise<any>} Parsed XML as a nested JS object
 * ---------------------------------------------------------------------------------------------------
 */
function parseXML(xml) {
    return new Promise((resolve, reject) => {
        // parseString uses callback style: (error, result) => ...
        // Ternary: if err is truthy, reject; otherwise resolve with result
        parseString(xml, (err, result) => (err ? reject(err) : resolve(result)));
    });
}

/**
 * ---------------------------------------------------------------------------------------------------
 * Replaces content between HTML comment markers in the README.
 * Example: <!-- recent_commits starts -->...<!-- recent_commits ends -->
 *
 * @param {string} content Full README text
 * @param {string} marker The marker name (e.g. "recent_commits", "blog")
 * @param {string} chunk The new content to insert between the markers
 * @returns {string} Updated README text
 * ---------------------------------------------------------------------------------------------------
 */
function replaceChunk(content, marker, chunk) {
    // RegExp with "s" flag: dot (.) matches newlines too, so it spans multiple lines
    const re = new RegExp(`<!-- ${marker} starts -->.*<!-- ${marker} ends -->`, "s");
    return content.replace(re, `<!-- ${marker} starts -->\n${chunk}\n<!-- ${marker} ends -->`);
}

/**
 * ---------------------------------------------------------------------------------------------------
 * Formats an array of commit objects into a Markdown bullet list.
 *
 * @param {Array<{sha: string, url: string, repo: string, message: string, date: string}>} commits
 * @returns {string} Markdown-formatted commit list
 * ---------------------------------------------------------------------------------------------------
 */
function renderCommits(commits) {
    // .map transforms each item; .join connects them with newlines
    // Template literal (backtick string) allows embedded expressions via ${...}
    return commits
        .map((c) => `* [\`${c.sha}\`](${c.url}) **${c.repo}** — ${c.message} (${c.date})`)
        .join("\n");
}

/**
 * ---------------------------------------------------------------------------------------------------
 * Formats an array of blog post objects into a Markdown bullet list.
 *
 * @param {Array<{title: string, url: string, date: string}>} posts
 * @returns {string} Markdown-formatted blog post list
 * ---------------------------------------------------------------------------------------------------
 */
function renderBlogPosts(posts) {
    return posts
        .map((p) => `* [${p.title}](${p.url}) (${p.date})`)
        .join("\n");
}

/**
 * ---------------------------------------------------------------------------------------------------
 * Fetches recent push events from the GitHub Events API, then retrieves
 * commit details for each. Returns up to MAX_COMMITS unique commits.
 *
 * Includes activity from personal repos and organization repos (requires
 * GH_TOKEN with repo + read:org scopes).
 *
 * @returns {Promise<Array<{repo: string, repoUrl: string, message: string, sha: string, url: string, date: string}>>}
 * ---------------------------------------------------------------------------------------------------
 */
async function fetchRecentCommits() {
    // Conditionally add auth header; without it, only public events are visible
    const headers = TOKEN ? /** @type {Record<string, string>} */ ({Authorization: `Bearer ${TOKEN}`}) : {};

    // Events API returns all activity (pushes, PRs, issues, etc.) for the user
    const events = await fetchJSON(`https://api.github.com/users/${GITHUB_USER}/events?per_page=100`, headers);

    // Keep only PushEvents (commits), limit how many we inspect
    const pushEvents = events
        .filter((e) => e.type === "PushEvent")
        .slice(0, MAX_PUSH_EVENTS);

    const commits = [];
    const seen = new Set();  // Set prevents duplicate SHAs from appearing

    for (const event of pushEvents) {
        const repo = event.repo.name;        // e.g. "dadavidtseng/LeetCodePractice"
        const sha = event.payload.head;      // latest commit SHA in this push
        if (!sha || seen.has(sha)) continue; // skip if no SHA or already processed
        seen.add(sha);

        try {
            // Fetch full commit details (message, author, etc.) from the Commits API
            const commit = await fetchJSON(`https://api.github.com/repos/${repo}/commits/${sha}`, headers);

            // Extract first line of commit message; ?. is optional chaining (safe access)
            const msg = (commit.commit?.message || "").split("\n")[0];

            // Skip auto-generated commits that aren't interesting
            if (msg.startsWith("Merge") || msg.startsWith("Updated content")) {
                continue;
            }

            commits.push({
                // Strip username prefix for personal repos; org repos keep "OrgName/repo" format
                repo: repo.replace(`${GITHUB_USER}/`, ""),
                repoUrl: `https://github.com/${repo}`, // Truncate long messages with "..." suffix
                message: msg.length > COMMIT_MSG_MAX_LEN ? msg.slice(0, COMMIT_MSG_MAX_LEN - 3) + "..." : msg,
                sha: sha.slice(0, 7),  // short SHA (first 7 chars) for display
                url: `https://github.com/${repo}/commit/${sha}`,
                date: event.created_at.split("T")[0],  // "2026-06-17T15:00:00Z" -> "2026-06-17"
            });
        } catch {
            /* skip commits that fail to fetch (e.g. deleted repo, permission denied) */
        }
        if (commits.length >= MAX_COMMITS) {
            break;
        }
    }

    return commits;
}

/**
 * ---------------------------------------------------------------------------------------------------
 * Fetches blog posts from the RSS feed and returns the most recent ones.
 * RSS is an XML format that blogs use to publish their latest articles.
 *
 * @returns {Promise<Array<{title: string, url: string, date: string}>>}
 * ---------------------------------------------------------------------------------------------------
 */
async function fetchBlogPosts() {
    try {
        const xml = await fetchText("https://dadavidtseng.com/rss.xml");
        const parsed = await parseXML(xml);

        // RSS structure: rss > channel > item[]. Each item is a blog post.
        // @type {any[]} - tells IDE not to type-check deeply nested XML properties
        const items = /** @type {any[]} */ (parsed?.rss?.channel?.[0]?.item || []);

        // .slice takes the first N items; .map transforms each into our format
        return items.slice(0, MAX_BLOG_POSTS).map((item) => ({
            title: item.title[0],       // xml2js wraps values in arrays
            url: item.link[0], date: new Date(item.pubDate[0]).toISOString().split("T")[0],  // "Mon, 20 Jul 2024..." -> "2024-07-20"
        }));
    } catch (e) {
        console.error("Failed to fetch blog RSS:", e.message);
        return [];  // return empty array on failure so the rest of the script continues
    }
}

/**
 * ---------------------------------------------------------------------------------------------------
 * Entry point: fetches all data, updates README, writes to disk.
 *
 * @returns {Promise<void>}
 * ---------------------------------------------------------------------------------------------------
 */
async function main() {
    const commits = await fetchRecentCommits();
    const posts = await fetchBlogPosts();

    // Read the current README from disk
    let readme = fs.readFileSync(README_PATH, "utf-8");

    // Replace each section between its HTML comment markers
    if (commits.length > 0) {
        readme = replaceChunk(readme, "recent_commits", renderCommits(commits));
    }
    if (posts.length > 0) {
        readme = replaceChunk(readme, "blog", renderBlogPosts(posts));
    }

    // Write the updated README back to disk
    fs.writeFileSync(README_PATH, readme);
    console.log(`Updated README: ${commits.length} commits, ${posts.length} blog posts`);
}

// Run main() and catch any unhandled errors
// .catch is a Promise method that handles rejection (errors)
main().catch((e) => {
    console.error(e);
    process.exit(1);  // exit with non-zero code signals failure to CI
});
