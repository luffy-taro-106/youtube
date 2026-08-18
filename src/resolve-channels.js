// Diagnostic: checks every competitor handle resolves to a channelId.
// Run `npm run resolve` after editing config/competitors.js to catch typos
// or renamed handles before they fail mid-pipeline.

import { COMPETITORS } from "../config/competitors.js";
import { loadEnv } from "./env.js";

loadEnv();

const apiKey = process.env.YOUTUBE_API_KEY;
if (!apiKey) {
  console.error("YOUTUBE_API_KEY is not set (see .env.example)");
  process.exit(1);
}

const API = "https://www.googleapis.com/youtube/v3/channels";

async function check(comp) {
  const params = new URLSearchParams({ part: "snippet,statistics", key: apiKey });
  if (comp.channelId) params.set("id", comp.channelId);
  else params.set("forHandle", comp.handle.replace(/^@/, ""));

  const res = await fetch(`${API}?${params}`);
  const data = await res.json();
  const ch = data.items?.[0];
  if (ch) {
    const subs = Number(ch.statistics?.subscriberCount ?? 0);
    return { ok: true, id: ch.id, title: ch.snippet?.title, subs };
  }
  return { ok: false, error: data?.error?.message || "no match" };
}

console.log(`Checking ${COMPETITORS.length} channels…\n`);
let bad = 0;
for (const comp of COMPETITORS) {
  const r = await check(comp);
  const ref = comp.handle || comp.channelId || "?";
  if (r.ok) {
    const subs = r.subs >= 1e6 ? `${(r.subs / 1e6).toFixed(1)}M` : `${Math.round(r.subs / 1000)}k`;
    console.log(`✓ ${comp.name.padEnd(30)} ${ref.padEnd(30)} → ${r.id}  (${subs} subs)`);
  } else {
    bad++;
    console.log(`✗ ${comp.name.padEnd(30)} ${ref.padEnd(30)} → ${r.error}`);
  }
}
console.log(`\n${COMPETITORS.length - bad}/${COMPETITORS.length} resolved` + (bad ? `, ${bad} need fixing` : ""));
