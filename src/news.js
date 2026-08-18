// News fetcher — high-precision. For each pillar we:
//   1. require a topic term in the HEADLINE (qInTitle) — kills most noise
//   2. sort by relevancy (not popularity, which rewards clickbait)
//   3. drop anything matching the political/lifestyle NOISE patterns
//   4. score what's left on topic + impact keywords and keep the top N
//
// One request per pillar.

import { PILLARS, NEWS_DOMAINS, NOISE_PATTERNS } from "../config/pillars.js";
import { envInt } from "./env.js";

const NEWSAPI_URL = "https://newsapi.org/v2/everything";

const quote = (t) => (t.includes(" ") ? `"${t}"` : t);

function dedupeKey(title = "") {
  return title
    .toLowerCase()
    .split(" - ")[0]
    .replace(/[^a-z0-9 ]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function isNoise(title = "") {
  return NOISE_PATTERNS.some((re) => re.test(title));
}

// Count how many of `terms` appear in `text` (whole-word-ish, case-insensitive).
function countHits(text = "", terms) {
  const hay = text.toLowerCase();
  let n = 0;
  for (const t of terms) if (hay.includes(t.toLowerCase())) n++;
  return n;
}

// Relevance score: topic terms in the title are worth most, then in the
// description, then impact/boost words. Recency breaks ties.
function scoreArticle(a, pillar) {
  const title = a.title || "";
  const desc = a.description || "";
  const titleTopic = countHits(title, pillar.titleTerms);
  const descTopic = countHits(desc, pillar.titleTerms);
  const boost = countHits(`${title} ${desc}`, pillar.boost);
  const ageDays = (Date.now() - new Date(a.publishedAt).getTime()) / 86400e3;
  const recency = Math.max(0, 1 - ageDays / 14); // 0..1 over the 14-day window
  return titleTopic * 5 + descTopic * 2 + boost * 1 + recency;
}

async function fetchPillarNews(pillar, { apiKey, perPillar, fromISO }) {
  const qInTitle = pillar.titleTerms.map(quote).join(" OR ");
  const params = new URLSearchParams({
    qInTitle,
    domains: NEWS_DOMAINS,
    language: "en",
    sortBy: "relevancy",
    pageSize: "60", // over-fetch, then filter + rank down to perPillar
    from: fromISO,
    apiKey,
  });

  const res = await fetch(`${NEWSAPI_URL}?${params}`);
  const data = await res.json();
  if (data.status !== "ok") {
    throw new Error(
      `NewsAPI error for "${pillar.name}": ${data.code || res.status} — ${data.message || "unknown"}`
    );
  }

  const seen = new Set();
  const scored = [];
  let dropped = 0;

  for (const a of data.articles ?? []) {
    if (!a.title || a.title === "[Removed]") continue;
    if (isNoise(a.title)) { dropped++; continue; }
    // Require at least one topic term in the TITLE (qInTitle can match the
    // body in some edge cases) — enforce precision client-side too.
    if (countHits(a.title, pillar.titleTerms) === 0) { dropped++; continue; }
    const key = dedupeKey(a.title);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    scored.push({
      title: a.title,
      source: a.source?.name ?? null,
      url: a.url,
      publishedAt: a.publishedAt,
      description: a.description ?? null,
      _score: Number(scoreArticle(a, pillar).toFixed(2)),
    });
  }

  scored.sort((x, y) => y._score - x._score);
  const items = scored.slice(0, perPillar);
  return { items, dropped };
}

export async function fetchNews() {
  const apiKey = process.env.NEWSAPI_KEY;
  if (!apiKey) throw new Error("NEWSAPI_KEY is not set (see .env.example)");

  const perPillar = envInt("NEWS_PER_PILLAR", 10);
  const fromISO = new Date(Date.now() - 14 * 86400e3).toISOString().slice(0, 10);

  const byPillar = {};
  let total = 0;

  for (const pillar of PILLARS) {
    try {
      const { items, dropped } = await fetchPillarNews(pillar, { apiKey, perPillar, fromISO });
      byPillar[pillar.id] = { name: pillar.name, items };
      total += items.length;
      console.log(
        `  news · ${pillar.name.padEnd(22)} ${String(items.length).padStart(2)} kept  (${dropped} noise dropped)`
      );
    } catch (err) {
      console.warn(`  news · ${pillar.name.padEnd(22)} FAILED — ${err.message}`);
      byPillar[pillar.id] = { name: pillar.name, items: [], error: err.message };
    }
  }

  return { total, byPillar };
}
