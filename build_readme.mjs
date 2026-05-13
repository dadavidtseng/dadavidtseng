import https from "node:https";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { parseString } from "xml2js";

const TOKEN = process.env.GH_TOKEN || "";
const README_PATH = fileURLToPath(new URL("./README.md", import.meta.url));

function replaceChunk(content, marker, chunk) {
  const re = new RegExp(
    `<!-- ${marker} starts -->.*<!-- ${marker} ends -->`,
    "s"
  );
  return content.replace(
    re,
    `<!-- ${marker} starts -->\n${chunk}\n<!-- ${marker} ends -->`
  );
}

function fetchJSON(url, headers = {}) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const opts = {
      hostname: parsed.hostname,
      path: parsed.pathname + parsed.search,
      headers: { "User-Agent": "dadavidtseng-readme-bot", ...headers },
    };
    https
      .get(opts, (res) => {
        let data = "";
        res.on("data", (c) => (data += c));
        res.on("end", () => resolve(JSON.parse(data)));
      })
      .on("error", reject);
  });
}

function fetchText(url) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const opts = {
      hostname: parsed.hostname,
      path: parsed.pathname + parsed.search,
      headers: { "User-Agent": "dadavidtseng-readme-bot" },
    };
    https
      .get(opts, (res) => {
        let data = "";
        res.on("data", (c) => (data += c));
        res.on("end", () => resolve(data));
      })
      .on("error", reject);
  });
}

function parseXML(xml) {
  return new Promise((resolve, reject) => {
    parseString(xml, (err, result) => (err ? reject(err) : resolve(result)));
  });
}

async function fetchRecentCommits() {
  const headers = TOKEN ? { Authorization: `Bearer ${TOKEN}` } : {};

  const events = await fetchJSON(
    "https://api.github.com/users/dadavidtseng/events/public?per_page=100",
    headers
  );

  const pushEvents = events
    .filter((e) => e.type === "PushEvent")
    .slice(0, 15);

  const commits = [];
  const seen = new Set();

  for (const event of pushEvents) {
    const repo = event.repo.name;
    const sha = event.payload.head;
    if (!sha || seen.has(sha)) continue;
    seen.add(sha);

    try {
      const commit = await fetchJSON(
        `https://api.github.com/repos/${repo}/commits/${sha}`,
        headers
      );
      const msg = (commit.commit?.message || "").split("\n")[0];
      if (msg.startsWith("Merge") || msg.startsWith("Updated content"))
        continue;
      commits.push({
        repo: repo.replace("dadavidtseng/", ""),
        repoUrl: `https://github.com/${repo}`,
        message: msg.length > 60 ? msg.slice(0, 57) + "..." : msg,
        sha: sha.slice(0, 7),
        url: `https://github.com/${repo}/commit/${sha}`,
        date: event.created_at.split("T")[0],
      });
    } catch {
      continue;
    }
    if (commits.length >= 8) break;
  }

  return commits.slice(0, 8);
}

async function fetchBlogPosts() {
  try {
    const xml = await fetchText("https://dadavidtseng.com/rss.xml");
    const parsed = await parseXML(xml);
    const items = parsed?.rss?.channel?.[0]?.item || [];
    return items.slice(0, 5).map((item) => ({
      title: item.title[0],
      url: item.link[0],
      date: new Date(item.pubDate[0]).toISOString().split("T")[0],
    }));
  } catch (e) {
    console.error("Failed to fetch blog RSS:", e.message);
    return [];
  }
}

async function fetchContributionStats() {
  if (!TOKEN) return null;

  const query = `query {
    user(login: "dadavidtseng") {
      contributionsCollection {
        contributionCalendar {
          totalContributions
          weeks {
            contributionDays {
              contributionCount
              date
            }
          }
        }
      }
    }
  }`;

  return new Promise((resolve) => {
    const body = JSON.stringify({ query });
    const opts = {
      hostname: "api.github.com",
      path: "/graphql",
      method: "POST",
      headers: {
        "User-Agent": "dadavidtseng-readme-bot",
        Authorization: `Bearer ${TOKEN}`,
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(body),
      },
    };

    const req = https.request(opts, (res) => {
      let data = "";
      res.on("data", (c) => (data += c));
      res.on("end", () => {
        try {
          const json = JSON.parse(data);
          const calendar =
            json.data.user.contributionsCollection.contributionCalendar;
          const days = calendar.weeks.flatMap((w) => w.contributionDays);
          const today = new Date().toISOString().split("T")[0];
          const todayEntry = days.find((d) => d.date === today);
          const todayCount = todayEntry?.contributionCount || 0;

          let streak = 0;
          for (let i = days.length - 1; i >= 0; i--) {
            if (days[i].date > today) continue;
            if (days[i].date === today && days[i].contributionCount === 0) break;
            if (days[i].contributionCount > 0) streak++;
            else break;
          }

          resolve({ streak, todayCount, total: calendar.totalContributions });
        } catch (e) {
          console.error("Failed to parse contribution stats:", e.message);
          resolve(null);
        }
      });
    });

    req.on("error", () => resolve(null));
    req.write(body);
    req.end();
  });
}

async function main() {
  const [commits, posts, stats] = await Promise.all([
    fetchRecentCommits(),
    fetchBlogPosts(),
    fetchContributionStats(),
  ]);

  let readme = fs.readFileSync(README_PATH, "utf-8");

  if (stats) {
    const parts = [];
    if (stats.streak > 0)
      parts.push(`${stats.streak}-day commit streak`);
    if (stats.todayCount > 0)
      parts.push(`${stats.todayCount} contributions today`);
    parts.push(`${stats.total} contributions this year`);
    readme = replaceChunk(readme, "stats", parts.join(" | "));
  }

  if (commits.length) {
    const commitsMd = commits
      .map(
        (c) =>
          `* [\`${c.sha}\`](${c.url}) **${c.repo}** — ${c.message} (${c.date})`
      )
      .join("\n");
    readme = replaceChunk(readme, "recent_commits", commitsMd);
  }

  if (posts.length) {
    const blogMd = posts
      .map((p) => `* [${p.title}](${p.url}) (${p.date})`)
      .join("\n");
    readme = replaceChunk(readme, "blog", blogMd);
  }

  fs.writeFileSync(README_PATH, readme);
  console.log(
    `Updated README: ${commits.length} commits, ${posts.length} blog posts, streak: ${stats?.streak ?? "N/A"}`
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
