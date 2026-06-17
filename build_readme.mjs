/**
 * ---------------------------------------------------------------------------------------------------
 * build_readme.mjs
 * ---------------------------------------------------------------------------------------------------
 */

/**
 * ---------------------------------------------------------------------------------------------------
 */
import fs                from "node:fs";
import https             from "node:https";
import { fileURLToPath } from "node:url";
import { parseString }   from "xml2js";

/**
 * ---------------------------------------------------------------------------------------------------
 */
const TOKEN = process.env.GH_TOKEN || "";
const README_PATH = fileURLToPath(new URL("./README.md", import.meta.url));
const GITHUB_USER = "dadavidtseng";
const MAX_COMMITS = 8;
const MAX_BLOG_POSTS = 5;
const MAX_PUSH_EVENTS = 15;
const COMMIT_MSG_MAX_LEN = 60;

/**
 * ---------------------------------------------------------------------------------------------------
 * @param {string} url
 * @param {Record<string, string>} headers
 * @returns {Promise<string>}
 * ---------------------------------------------------------------------------------------------------
 */
function fetchText(url, headers = {})
{
    return new Promise((resolve, reject) =>
    {
        const parsed = new URL(url);
        const opts = {
            hostname: parsed.hostname,
            path: parsed.pathname + parsed.search,
            headers: {"User-Agent": `${GITHUB_USER}-readme-bot`, ...headers},
        };
        https
            .get(opts, (res) =>
            {
                let data = "";
                res.on("data", (c) => (data += c));
                res.on("end", () => resolve(data));
            })
            .on("error", reject);
    });
}

/**
 * ---------------------------------------------------------------------------------------------------
 * @param {string} url
 * @param {Record<string, string>} headers
 * @returns {Promise<object>}
 * ---------------------------------------------------------------------------------------------------
 */
async function fetchJSON(url, headers = {})
{
    const raw = await fetchText(url, headers);
    return JSON.parse(raw);
}

/**
 * ---------------------------------------------------------------------------------------------------
 * @param {string} xml
 * @returns {Promise<object>}
 * ---------------------------------------------------------------------------------------------------
 */
function parseXML(xml)
{
    return new Promise((resolve, reject) =>
    {
        parseString(xml, (err, result) => (err ? reject(err) : resolve(result)));
    });
}

/**
 * ---------------------------------------------------------------------------------------------------
 * @param {string} content
 * @param {string} marker
 * @param {string} chunk
 * @returns {string}
 * ---------------------------------------------------------------------------------------------------
 */
function replaceChunk(content, marker, chunk)
{
    const re = new RegExp(`<!-- ${marker} starts -->.*<!-- ${marker} ends -->`, "s");
    return content.replace(re, `<!-- ${marker} starts -->\n${chunk}\n<!-- ${marker} ends -->`);
}

/**
 * ---------------------------------------------------------------------------------------------------
 * @param {Array<{sha: string, url: string, repo: string, message: string, date: string}>} commits
 * @returns {string}
 * ---------------------------------------------------------------------------------------------------
 */
function renderCommits(commits)
{
    return commits
        .map((c) => `* [\`${c.sha}\`](${c.url}) **${c.repo}** — ${c.message} (${c.date})`)
        .join("\n");
}

/**
 * ---------------------------------------------------------------------------------------------------
 * @param {Array<{title: string, url: string, date: string}>} posts
 * @returns {string}
 * ---------------------------------------------------------------------------------------------------
 */
function renderBlogPosts(posts)
{
    return posts
        .map((p) => `* [${p.title}](${p.url}) (${p.date})`)
        .join("\n");
}

/**
 * ---------------------------------------------------------------------------------------------------
 * @returns {Promise<Array<{repo: string, repoUrl: string, message: string, sha: string, url: string, date: string}>>}
 * ---------------------------------------------------------------------------------------------------
 */
async function fetchRecentCommits()
{
    const headers = TOKEN ? {Authorization: `Bearer ${TOKEN}`} : {};

    const events = await fetchJSON(
        `https://api.github.com/users/${GITHUB_USER}/events?per_page=100`,
        headers
    );
    const pushEvents = events
        .filter((e) => e.type === "PushEvent")
        .slice(0, MAX_PUSH_EVENTS);

    const commits = [];
    const seen = new Set();

    for (const event of pushEvents)
    {
        const repo = event.repo.name;
        const sha = event.payload.head;
        if (!sha || seen.has(sha)) continue;
        seen.add(sha);

        try
        {
            const commit = await fetchJSON(
                `https://api.github.com/repos/${repo}/commits/${sha}`,
                headers
            );
            const msg = (commit.commit?.message || "").split("\n")[0];
            if (msg.startsWith("Merge") || msg.startsWith("Updated content")) continue;
            commits.push({
                repo: repo.replace(`${GITHUB_USER}/`, ""),
                repoUrl: `https://github.com/${repo}`,
                message: msg.length > COMMIT_MSG_MAX_LEN
                    ? msg.slice(0, COMMIT_MSG_MAX_LEN - 3) + "..."
                    : msg,
                sha: sha.slice(0, 7),
                url: `https://github.com/${repo}/commit/${sha}`,
                date: event.created_at.split("T")[0],
            });
        } catch
        {
            /* skip commits that fail to fetch */
        }
        if (commits.length >= MAX_COMMITS) break;
    }

    return commits;
}

/**
 * ---------------------------------------------------------------------------------------------------
 * @returns {Promise<Array<{title: string, url: string, date: string}>>}
 * ---------------------------------------------------------------------------------------------------
 */
async function fetchBlogPosts()
{
    try
    {
        const xml = await fetchText("https://dadavidtseng.com/rss.xml");
        const parsed = await parseXML(xml);
        const items = parsed?.rss?.channel?.[0]?.item || [];
        return items.slice(0, MAX_BLOG_POSTS).map((item) => ({
            title: item.title[0],
            url: item.link[0],
            date: new Date(item.pubDate[0]).toISOString().split("T")[0],
        }));
    } catch (e)
    {
        console.error("Failed to fetch blog RSS:", e.message);
        return [];
    }
}

/**
 * ---------------------------------------------------------------------------------------------------
 * @returns {Promise<void>}
 * ---------------------------------------------------------------------------------------------------
 */
async function main()
{
    const [commits, posts] = await Promise.all([fetchRecentCommits(), fetchBlogPosts()]);

    let readme = fs.readFileSync(README_PATH, "utf-8");

    if (commits.length) readme = replaceChunk(readme, "recent_commits", renderCommits(commits));
    if (posts.length) readme = replaceChunk(readme, "blog", renderBlogPosts(posts));

    fs.writeFileSync(README_PATH, readme);
    console.log(`Updated README: ${commits.length} commits, ${posts.length} blog posts`);
}

main().catch((e) =>
{
    console.error(e);
    process.exit(1);
});
