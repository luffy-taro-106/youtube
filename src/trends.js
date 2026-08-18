// Google Trends enrichment — RISING related queries (incl. "Breakout" spikes)
// per pillar seed keyword.
//
// Google has no official Trends API. We call the same internal endpoints the
// trends.google.com UI uses:
//   1. /api/explore            → returns a token + request for each widget
//   2. /api/widgetdata/relatedsearches → the actual rising-queries data
// Responses are prefixed with ")]}'" garbage we strip before JSON.parse.
//
// This is BEST-EFFORT. Datacenter IPs and heavy use get 429'd. Everything
// here degrades gracefully — a failure returns an error string, never throws
// up to the pipeline, so news + videos always succeed.

import { PILLARS } from "../config/pillars.js";
import { envInt } from "./env.js";

const BASE = "https://trends.google.com/trends/api";
const GEO = process.env.TREND_GEO || "US";
const TIMEFRAME = process.env.TREND_TIMEFRAME || "today 3-m"; // last 90 days
const HL = "en-US";
const TZ = "-330";

const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Google Trends gates the API behind a session cookie. The first request
// 429s but returns a Set-Cookie (NID/__Secure-ENID); we capture it and reuse
// it on retries and all subsequent calls.
let COOKIE = null;

function captureCookies(res) {
  const set = res.headers.getSetCookie?.() || [];
  if (set.length) COOKIE = set.map((c) => c.split(";")[0]).join("; ");
}

// Prime a cookie by hitting the homepage before the API loop.
async function bootstrapCookie() {
  try {
    const res = await fetch("https://trends.google.com/trends/?geo=" + GEO, {
      headers: { "User-Agent": UA, "Accept-Language": HL },
    });
    captureCookies(res);
  } catch { /* non-fatal — the 429 path will grab a cookie too */ }
}

// Google prepends ")]}'\n" (or similar) to its JSON. Slice from first brace.
function parseGoogleJSON(text) {
  const i = text.indexOf("{");
  if (i === -1) throw new Error("unexpected Trends response (no JSON)");
  return JSON.parse(text.slice(i));
}

async function getWithRetry(url, { tries = 4 } = {}) {
  let lastErr;
  for (let attempt = 0; attempt < tries; attempt++) {
    try {
      const res = await fetch(url, {
        headers: {
          "User-Agent": UA,
          "Accept-Language": HL,
          ...(COOKIE ? { Cookie: COOKIE } : {}),
        },
      });
      captureCookies(res); // refresh cookie from any response, incl. 429
      if (res.status === 429) {
        lastErr = new Error("rate limited (429)");
        await sleep(1200 * (attempt + 1)); // backoff, then retry with cookie
        continue;
      }
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.text();
    } catch (err) {
      lastErr = err;
      await sleep(800 * (attempt + 1));
    }
  }
  throw lastErr;
}

// Step 1: explore → find the RELATED_QUERIES widget (its token + request).
async function exploreRelatedQueries(keyword) {
  const req = {
    comparisonItem: [{ keyword, geo: GEO, time: TIMEFRAME }],
    category: 0,
    property: "",
  };
  const url =
    `${BASE}/explore?hl=${HL}&tz=${TZ}` +
    `&req=${encodeURIComponent(JSON.stringify(req))}`;
  const text = await getWithRetry(url);
  const data = parseGoogleJSON(text);
  const widget = (data.widgets || []).find((w) => w.id === "RELATED_QUERIES");
  if (!widget) throw new Error("no RELATED_QUERIES widget");
  return widget;
}

// Step 2: pull the rising list from the widget.
async function risingQueries(widget) {
  const url =
    `${BASE}/widgetdata/relatedsearches?hl=${HL}&tz=${TZ}` +
    `&req=${encodeURIComponent(JSON.stringify(widget.request))}` +
    `&token=${encodeURIComponent(widget.token)}`;
  const text = await getWithRetry(url);
  const data = parseGoogleJSON(text);

  // rankedList[0] = TOP queries, rankedList[1] = RISING queries.
  const ranked = data.default?.rankedList || [];
  const rising = ranked[1]?.rankedKeyword || [];

  return rising.map((k) => ({
    query: k.query,
    // value 0 + formattedValue "Breakout" means >5000% growth.
    growth: k.formattedValue, // e.g. "Breakout", "+450%"
    breakout: /breakout/i.test(k.formattedValue || ""),
    link: k.link ? `https://trends.google.com${k.link}` : null,
  }));
}

// Broad seeds ("stock market") return cross-contaminated rising queries —
// Google mixes in globally-trending junk ("how to learn python"). Keep a
// query only if it shares a meaningful token with the seed or a pillar topic
// term, which drops the off-topic noise.
function relevanceFilter(rising, seed, pillar) {
  const allow = [
    seed.toLowerCase(),
    ...seed.toLowerCase().split(/\s+/).filter((w) => w.length >= 4),
    ...(pillar?.titleTerms || []).map((t) => t.toLowerCase()),
  ];
  return rising.filter((r) => {
    const q = r.query.toLowerCase();
    return allow.some((t) => q.includes(t));
  });
}

async function fetchSeed(keyword, pillar) {
  const widget = await exploreRelatedQueries(keyword);
  await sleep(400); // be polite between the two calls
  const rising = await risingQueries(widget);
  return relevanceFilter(rising, keyword, pillar);
}

export async function fetchTrends() {
  const perSeedCap = envInt("TREND_QUERIES_PER_SEED", 8);
  const byPillar = {};
  let totalRising = 0;
  let totalBreakouts = 0;

  await bootstrapCookie();

  for (const pillar of PILLARS) {
    const seeds = [];
    for (const seed of pillar.trendSeeds || []) {
      try {
        const rising = await fetchSeed(seed, pillar);
        const breakouts = rising.filter((r) => r.breakout);
        seeds.push({ seed, rising: rising.slice(0, perSeedCap), breakouts });
        totalRising += rising.length;
        totalBreakouts += breakouts.length;
        console.log(
          `  trend· ${pillar.name.padEnd(22)} "${seed}"`.padEnd(40) +
            ` ${rising.length} rising, ${breakouts.length} breakout`
        );
      } catch (err) {
        seeds.push({ seed, rising: [], breakouts: [], error: err.message });
        console.warn(`  trend· ${pillar.name.padEnd(22)} "${seed}" FAILED — ${err.message}`);
      }
      await sleep(1200); // pace requests to avoid 429
    }
    byPillar[pillar.id] = { name: pillar.name, seeds };
  }

  return { geo: GEO, timeframe: TIMEFRAME, totalRising, totalBreakouts, byPillar };
}
