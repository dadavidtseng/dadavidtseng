/**
 * Fetches the portfolio's blog and TIL RSS feeds, then updates README.md.
 * Runs on a schedule via GitHub Actions (see .github/workflows/build.yml).
 */
import fs from "node:fs";
import http from "node:http";
import https from "node:https";
import { fileURLToPath } from "node:url";
import { parseString } from "xml2js";

const README_PATH = fileURLToPath(new URL("./README.md", import.meta.url));
const PORTFOLIO_BASE_URL = process.env.PORTFOLIO_BASE_URL || "https://dadavidtseng.com";
const MAX_BLOG_POSTS = 5;
const MAX_TIL_POSTS = 5;

function fetchText(url) {
    return new Promise((resolve, reject) => {
        const parsed = new URL(url);
        const opts = {
            hostname: parsed.hostname,
            port: parsed.port || undefined,
            path: parsed.pathname + parsed.search,
            headers: { "User-Agent": "dadavidtseng-readme-bot" },
        };

        const client = parsed.protocol === "http:" ? http : https;
        const req = client.get(opts, (res) => {
            let data = "";
            res.on("data", (chunk) => (data += chunk));
            res.on("end", () => resolve(data));
        });

        req.on("error", reject);
    });
}

function parseXML(xml) {
    return new Promise((resolve, reject) => {
        parseString(xml, (err, result) => (err ? reject(err) : resolve(result)));
    });
}

function replaceChunk(content, marker, chunk) {
    const re = new RegExp(`<!-- ${marker} starts -->.*<!-- ${marker} ends -->`, "s");
    return content.replace(re, `<!-- ${marker} starts -->\n${chunk}\n<!-- ${marker} ends -->`);
}

function renderPosts(posts) {
    return posts.map((post) => `* [${post.title}](${post.url}) (${post.date})`).join("\n");
}

async function fetchFeedPosts(feedUrl, maxPosts, feedName) {
    try {
        const xml = await fetchText(feedUrl);
        const parsed = await parseXML(xml);
        const items = parsed?.rss?.channel?.[0]?.item || [];

        return items.slice(0, maxPosts).map((item) => ({
            title: item.title[0],
            url: item.link[0],
            date: new Date(item.pubDate[0]).toISOString().split("T")[0],
        }));
    } catch (error) {
        console.error(`Failed to fetch ${feedName} RSS:`, error.message);
        return [];
    }
}

async function main() {
    const [blogPosts, tilPosts] = await Promise.all([
        fetchFeedPosts(`${PORTFOLIO_BASE_URL}/rss.xml`, MAX_BLOG_POSTS, "blog"),
        fetchFeedPosts(`${PORTFOLIO_BASE_URL}/til.xml`, MAX_TIL_POSTS, "TIL"),
    ]);

    let readme = fs.readFileSync(README_PATH, "utf-8");

    if (blogPosts.length > 0) {
        readme = replaceChunk(readme, "blog", renderPosts(blogPosts));
    }
    if (tilPosts.length > 0) {
        readme = replaceChunk(readme, "til", renderPosts(tilPosts));
    }

    fs.writeFileSync(README_PATH, readme);
    console.log(`Updated README: ${blogPosts.length} blog posts, ${tilPosts.length} TILs`);
}

main().catch((error) => {
    console.error(error);
    process.exit(1);
});
