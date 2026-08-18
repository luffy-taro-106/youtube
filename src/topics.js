// Topic Selection Engine.
//
// Reads the Step-0 context bundle (output/context.json — news + Google Trends +
// competitor videos), hands it to Claude along with the channel brief and the
// psychologist-analyst skill, and asks for 3 fully-formed video ideas engineered
// to make our specific audience click.
//
// Model: claude-opus-4-8 (most capable — this is a psychology-heavy creative
// reasoning task). Adaptive thinking + high effort + structured output.

import Anthropic from "@anthropic-ai/sdk";
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { loadEnv, projectRoot } from "./env.js";
import { CHANNEL_BRIEF } from "../config/channel.js";

loadEnv();

const MODEL = "claude-opus-4-8";

// ── Load inputs ─────────────────────────────────────────────────────────────

function loadContext() {
  const path = join(projectRoot, "output", "context.json");
  if (!existsSync(path)) {
    throw new Error("output/context.json not found — run `npm run context` first");
  }
  return JSON.parse(readFileSync(path, "utf8"));
}

function loadPsychologySkill() {
  // Read the skill live so edits to it flow through automatically.
  const path = join(projectRoot, "psychologist-analyst-1.0.0", "SKILL.md");
  return existsSync(path) ? readFileSync(path, "utf8") : "";
}

// Trim the raw context into a compact, signal-dense digest for the prompt.
function buildDigest(ctx) {
  const lines = [];

  if (ctx.news) {
    lines.push("## HIGH-IMPACT NEWS (last 14 days, by pillar)");
    for (const p of Object.values(ctx.news.byPillar)) {
      if (!p.items?.length) continue;
      lines.push(`\n### ${p.name}`);
      for (const a of p.items) lines.push(`- ${a.title} (${a.source || "?"})`);
    }
  }

  if (ctx.trends && ctx.trends.byPillar) {
    lines.push("\n## GOOGLE TRENDS — rising searches (🚀 = breakout spike)");
    for (const p of Object.values(ctx.trends.byPillar)) {
      const rows = [];
      for (const s of p.seeds || []) {
        for (const r of s.rising || [])
          rows.push(`- ${r.query}${r.breakout ? " 🚀" : ` (${r.growth})`}`);
      }
      if (rows.length) {
        lines.push(`\n### ${p.name}`);
        lines.push(...rows);
      }
    }
  }

  if (ctx.videos && ctx.videos.channels) {
    lines.push(`\n## COMPETITOR VIDEOS — what's landing now (≥${ctx.videos.minViews / 1000}k views, last ${ctx.videos.lookbackDays} days)`);
    for (const c of ctx.videos.channels) {
      if (!c.videos?.length) continue;
      lines.push(`\n### ${c.name} (tier ${c.tier})`);
      for (const v of c.videos) lines.push(`- ${v.title} — ${Math.round(v.views / 1000)}k views`);
    }
  }

  return lines.join("\n");
}

// ── Structured-output schema ────────────────────────────────────────────────

const PILLARS = [
  "Tax Strategy",
  "Insurance",
  "Investing & Markets",
  "Real Estate",
  "Business Tech & AI",
  "Money Foundations",
];

const SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    topics: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          rank: { type: "integer" },
          pillar: { type: "string", enum: PILLARS },
          title: { type: "string", description: "Final YouTube title, click-optimized using a proven pattern" },
          thumbnailText: { type: "string", description: "3–5 punchy words for the thumbnail overlay" },
          targetEmotion: { type: "string", description: "The single dominant emotion this video targets (e.g. fear of loss, relief, vindication, curiosity)" },
          hook: { type: "string", description: "The first ~15 seconds of voiceover, written verbatim — the most surprising claim, no intro" },
          description: { type: "string", description: "2–3 sentences: what this video actually is and the transformation it promises the viewer" },
          whatToCover: {
            type: "array",
            description: "The ordered segments/points the script must cover, implementation-first",
            items: { type: "string" },
          },
          psychologicalTriggers: {
            type: "array",
            description: "The specific psychological levers this idea pulls and how",
            items: {
              type: "object",
              additionalProperties: false,
              properties: {
                principle: { type: "string", description: "Named principle (e.g. loss aversion, social proof, curiosity gap, authority, availability heuristic)" },
                howItsUsed: { type: "string", description: "How this idea uses that principle on our audience" },
              },
              required: ["principle", "howItsUsed"],
            },
          },
          whyTheyClick: { type: "string", description: "The psychological case for why OUR specific audience clicks this over a competitor's video" },
          sourceSignals: {
            type: "array",
            description: "Which news headlines, trend queries, or competitor videos from the digest justify this pick",
            items: { type: "string" },
          },
          appeal: { type: "string", enum: ["broad", "core", "niche"], description: "broad = nearly everyone, core = our main personal-finance audience, niche = a sharp sub-segment" },
        },
        required: [
          "rank", "pillar", "title", "thumbnailText", "targetEmotion", "hook",
          "description", "whatToCover", "psychologicalTriggers", "whyTheyClick",
          "sourceSignals", "appeal",
        ],
      },
    },
  },
  required: ["topics"],
};

// ── Prompt assembly ─────────────────────────────────────────────────────────

function buildSystem(psychologySkill) {
  return `You are the head of content strategy for the faceless YouTube channel described below. You think like a world-class YouTube packaging strategist AND a research psychologist: you choose topics that win on the algorithm because they exploit how the human mind actually decides to click, not because they are "good information."

${CHANNEL_BRIEF}

═══════════════════════════════════════════════════════════════════════════
You have been given the PSYCHOLOGIST-ANALYST skill below. Use it as your lens.
Reason explicitly about System 1 vs System 2, loss aversion, the curiosity gap,
the availability heuristic, social proof, authority, identity, and the specific
anxieties of a broad personal-finance audience. Design for how this viewer's
brain works — fear of losing or wasting money, desire for control and
reassurance, status, and the relief of "finally someone is explaining this to ME."
═══════════════════════════════════════════════════════════════════════════

${psychologySkill}

═══════════════════════════════════════════════════════════════════════════
YOUR TASK
Using the live signals (news, Google Trends, competitor videos) the user
provides, select exactly 3 video topics for THIS channel and THIS audience.

Rules:
- Ground every pick in the provided signals — cite the exact headline, trend
  query, or competitor video that justifies it. Do not invent trends.
- Prefer topics where multiple signals agree (a news story + a rising trend +
  competitor traction = a strong, timely bet).
- Each of the 3 should ideally hit a different pillar and a different emotion,
  so the slate isn't one-note.
- Titles MUST use one of the proven patterns from the brief, tuned to a broad
  money audience — not generic explainer titles.
- The hook must be implementation-first and front-load the single most
  surprising, loss-or-money-relevant claim in the first 15 seconds.
- whatToCover must be concrete and actionable (the form, the number, the step),
  reflecting our implementation-first USP.
- For each topic, make the psychology explicit and honest: which lever, on which
  fear or desire, and why it beats the competitor's version of the same topic.

Return ONLY the structured object matching the schema.`;
}

// ── Run ─────────────────────────────────────────────────────────────────────

async function main() {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error("ANTHROPIC_API_KEY is not set (see .env.example)");

  const ctx = loadContext();
  const digest = buildDigest(ctx);
  const psychologySkill = loadPsychologySkill();

  const client = new Anthropic({ apiKey });

  console.log(`Generating 3 topic ideas with ${MODEL}…`);

  const stream = client.messages.stream({
    model: MODEL,
    max_tokens: 20000,
    thinking: { type: "adaptive" },
    output_config: {
      effort: "high",
      format: { type: "json_schema", schema: SCHEMA },
    },
    system: buildSystem(psychologySkill),
    messages: [
      {
        role: "user",
        content:
          `Here are today's live signals for the channel. Generation date: ${new Date().toISOString().slice(0, 10)}.\n\n` +
          digest +
          `\n\nSelect the 3 best video topics for our audience and return the structured object.`,
      },
    ],
  });

  const message = await stream.finalMessage();

  if (message.stop_reason === "refusal") {
    throw new Error("Model refused to generate (safety stop).");
  }

  const textBlock = message.content.find((b) => b.type === "text");
  if (!textBlock) throw new Error("No text block in response.");

  let result;
  try {
    result = JSON.parse(textBlock.text);
  } catch {
    throw new Error("Could not parse structured output as JSON.");
  }

  // ── Write outputs ──
  const outDir = join(projectRoot, "output");
  mkdirSync(outDir, { recursive: true });

  const bundle = {
    generatedAt: new Date().toISOString(),
    model: MODEL,
    sourceContextAt: ctx.generatedAt,
    topics: result.topics,
  };
  const jsonPath = join(outDir, "topics.json");
  const mdPath = join(outDir, "topics.md");
  writeFileSync(jsonPath, JSON.stringify(bundle, null, 2));
  writeFileSync(mdPath, toMarkdown(bundle));

  const u = message.usage;
  console.log(`\n✓ ${result.topics.length} topics generated`);
  if (u) console.log(`  tokens — in: ${u.input_tokens}, out: ${u.output_tokens}`);
  console.log(`  → ${jsonPath}`);
  console.log(`  → ${mdPath}`);
}

function toMarkdown(bundle) {
  const L = [];
  L.push(`# Founder Finance — Topic Slate`);
  L.push(`_Generated ${bundle.generatedAt} · ${bundle.model} · signals from ${bundle.sourceContextAt}_\n`);
  for (const t of bundle.topics) {
    L.push(`## ${t.rank}. ${t.title}`);
    L.push(`**Pillar:** ${t.pillar}  ·  **Emotion:** ${t.targetEmotion}  ·  **Appeal:** ${t.appeal}`);
    L.push(`**Thumbnail:** ${t.thumbnailText}\n`);
    L.push(`**Hook (first 15s):**\n> ${t.hook}\n`);
    L.push(`**What it is:** ${t.description}\n`);
    L.push(`**Cover, in order:**`);
    t.whatToCover.forEach((c, i) => L.push(`${i + 1}. ${c}`));
    L.push(`\n**Why they click:** ${t.whyTheyClick}\n`);
    L.push(`**Psychological triggers:**`);
    for (const p of t.psychologicalTriggers) L.push(`- **${p.principle}** — ${p.howItsUsed}`);
    L.push(`\n**Backed by signals:**`);
    for (const s of t.sourceSignals) L.push(`- ${s}`);
    L.push(`\n---\n`);
  }
  return L.join("\n");
}

main().catch((err) => {
  console.error("\n✗ Fatal:", err.message);
  process.exit(1);
});
