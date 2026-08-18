// Orchestrator. Fetches news + competitor videos and writes a single
// context bundle (JSON for the pipeline, Markdown for humans) into output/.
//
//   npm run context            → news + videos + trends
//   npm run news               → news only   (--only=news)
//   npm run videos             → videos only (--only=videos)
//   npm run trends             → trends only (--only=trends)

import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { loadEnv, projectRoot } from "./env.js";
import { fetchNews } from "./news.js";
import { fetchCompetitorVideos } from "./youtube.js";
import { fetchTrends } from "./trends.js";

loadEnv();

const only = (process.argv.find((a) => a.startsWith("--only=")) || "").split("=")[1];
const wantNews = !only || only === "news";
const wantVideos = !only || only === "videos";
const wantTrends = !only || only === "trends";

function fmtViews(n) {
  return n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : `${Math.round(n / 1000)}k`;
}

function toMarkdown(ctx) {
  const lines = [];
  lines.push(`# Founder Finance — Content Context`);
  lines.push(`_Generated ${ctx.generatedAt}_\n`);

  if (ctx.news) {
    lines.push(`## 📰 High-Impact News (by pillar)\n`);
    for (const pillar of Object.values(ctx.news.byPillar)) {
      lines.push(`### ${pillar.name}`);
      if (!pillar.items.length) {
        lines.push(`_no items_\n`);
        continue;
      }
      pillar.items.forEach((a, i) => {
        const date = (a.publishedAt || "").slice(0, 10);
        lines.push(`${i + 1}. **${a.title}** — _${a.source || "?"}, ${date}_`);
      });
      lines.push("");
    }
  }

  if (ctx.trends) {
    lines.push(`## 🔥 Google Trends — Rising Searches (${ctx.trends.geo}, ${ctx.trends.timeframe})\n`);
    for (const pillar of Object.values(ctx.trends.byPillar)) {
      lines.push(`### ${pillar.name}`);
      for (const s of pillar.seeds) {
        if (s.error) {
          lines.push(`_"${s.seed}" — unavailable (${s.error})_\n`);
          continue;
        }
        if (!s.rising.length) {
          lines.push(`_"${s.seed}" — no rising queries_\n`);
          continue;
        }
        lines.push(`**seed: "${s.seed}"**`);
        for (const r of s.rising) {
          const tag = r.breakout ? " 🚀 **BREAKOUT**" : ` _(${r.growth})_`;
          lines.push(`- ${r.query}${tag}`);
        }
        lines.push("");
      }
    }
  }

  if (ctx.videos) {
    lines.push(`## 📹 Competitor Videos (≥${fmtViews(ctx.videos.minViews)} views, last ${ctx.videos.lookbackDays} days)\n`);
    const byTier = [1, 2, 3, 4];
    for (const tier of byTier) {
      const chans = ctx.videos.channels.filter((c) => c.tier === tier && c.videos.length);
      if (!chans.length) continue;
      lines.push(`### Tier ${tier}`);
      for (const c of chans) {
        lines.push(`**${c.name}** — ${fmtViews(c.subscribers)} subs`);
        for (const v of c.videos) {
          lines.push(`- ${v.title} — _${fmtViews(v.views)} views_`);
        }
        lines.push("");
      }
    }
    if (ctx.videos.unresolved.length) {
      lines.push(`### ⚠️ Unresolved channels (fix handle in config/competitors.js)`);
      for (const u of ctx.videos.unresolved) {
        lines.push(`- ${u.name} (\`${u.handle}\`) — ${u.error}`);
      }
      lines.push("");
    }
  }

  return lines.join("\n");
}

async function main() {
  const ctx = { generatedAt: new Date().toISOString() };

  if (wantNews) {
    console.log("Fetching news…");
    ctx.news = await fetchNews();
  }
  if (wantTrends) {
    console.log("Fetching Google Trends (best-effort)…");
    try {
      ctx.trends = await fetchTrends();
    } catch (err) {
      console.warn(`  trends unavailable — ${err.message}`);
      ctx.trends = { error: err.message, byPillar: {} };
    }
  }
  if (wantVideos) {
    console.log("Fetching competitor videos…");
    ctx.videos = await fetchCompetitorVideos();
  }

  const outDir = join(projectRoot, "output");
  mkdirSync(outDir, { recursive: true });

  const jsonPath = join(outDir, "context.json");
  const mdPath = join(outDir, "context.md");
  writeFileSync(jsonPath, JSON.stringify(ctx, null, 2));
  writeFileSync(mdPath, toMarkdown(ctx));

  console.log("\n✓ Done");
  if (ctx.news) console.log(`  ${ctx.news.total} news items across 6 pillars`);
  if (ctx.trends && ctx.trends.totalRising != null)
    console.log(`  ${ctx.trends.totalRising} rising trend queries (${ctx.trends.totalBreakouts} breakouts)`);
  if (ctx.videos)
    console.log(
      `  ${ctx.videos.totalVideos} videos from ${ctx.videos.channels.length} channels` +
        (ctx.videos.unresolved.length ? ` (${ctx.videos.unresolved.length} unresolved)` : "")
    );
  console.log(`  → ${jsonPath}`);
  console.log(`  → ${mdPath}`);
}

main().catch((err) => {
  console.error("\n✗ Fatal:", err.message);
  process.exit(1);
});
