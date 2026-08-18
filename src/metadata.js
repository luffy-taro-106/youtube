// Thumbnail + Metadata Agent.
//
// A Claude agent equipped with (1) the channel brief, (2) the thumbnail-seo
// SKILL, and (3) the full context of THIS video — the chosen topic, the actual
// script, the strongest visual moments, the real chapter timeline, and the
// competitor titles currently winning the niche. It returns:
//   • 3 A/B-ready thumbnail concepts, each with a Gemini-ready generation prompt
//   • 5 title options (proven structures)
//   • an SEO-optimized description (keyword-first, chapters, links, hashtags)
//   • backend tags, hashtags, chapters, a pinned comment, and an A/B plan
//
// Outputs: output/metadata.json, output/metadata.md, output/thumbnail_prompts.txt
//
//   npm run metadata               → uses topic rank 1
//   npm run metadata -- --topic=2  → another topic from the slate

import Anthropic from "@anthropic-ai/sdk";
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { loadEnv, projectRoot } from "./env.js";
import { CHANNEL_BRIEF } from "../config/channel.js";

loadEnv();

const MODEL = "claude-opus-4-8";
const OUT = join(projectRoot, "output");

// ── inputs ───────────────────────────────────────────────────────────────────

function read(path, fallback = "") {
  return existsSync(path) ? readFileSync(path, "utf8") : fallback;
}

function loadTopic(rank) {
  const p = join(OUT, "topics.json");
  if (!existsSync(p)) throw new Error("output/topics.json not found — run `npm run topics` first");
  const bundle = JSON.parse(readFileSync(p, "utf8"));
  const topic = bundle.topics.find((t) => t.rank === rank);
  if (!topic) throw new Error(`No topic rank ${rank} (have: ${bundle.topics.map((t) => t.rank).join(", ")})`);
  return topic;
}

const mmss = (s) => `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, "0")}`;

// Strongest thumbnail-worthy moments: scenes that already carry a punch overlay.
function heroCandidates() {
  const p = join(OUT, "scenes.json");
  if (!existsSync(p)) return [];
  const { scenes } = JSON.parse(readFileSync(p, "utf8"));
  return scenes
    .filter((s) => (s.textOverlay || "").trim())
    .map((s) => ({ id: s.id, overlay: s.textOverlay, mood: s.mood, visual: s.imagePrompt }))
    .slice(0, 14);
}

// Real chapter timeline if the video was rendered; else estimated from scenes.
function chapterTimeline() {
  const tl = join(OUT, "video", "timeline.json");
  if (existsSync(tl)) {
    const d = JSON.parse(readFileSync(tl, "utf8"));
    return d.scenes.map((s) => `${mmss(s.start)} — ${(s.narration || "").slice(0, 70)}…`);
  }
  const sc = join(OUT, "scenes.json");
  if (!existsSync(sc)) return [];
  const { scenes } = JSON.parse(readFileSync(sc, "utf8"));
  return scenes.map((s) => `${mmss(s.start || 0)} — ${(s.narration || "").slice(0, 70)}…`);
}

// What's winning in the niche right now — title patterns to learn from.
function competitorTitles() {
  const p = join(OUT, "context.json");
  if (!existsSync(p)) return [];
  const ctx = JSON.parse(readFileSync(p, "utf8"));
  const all = [];
  for (const c of ctx.videos?.channels || [])
    for (const v of c.videos || []) all.push({ t: v.title, v: v.views });
  return all.sort((a, b) => b.v - a.v).slice(0, 25).map((x) => `- ${x.t} (${Math.round(x.v / 1000)}k)`);
}

// ── schema ───────────────────────────────────────────────────────────────────

const SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    titles: {
      type: "object",
      additionalProperties: false,
      properties: {
        primary: { type: "string", description: "The single best title to publish with" },
        alternates: { type: "array", items: { type: "string" }, description: "5 alternates across different proven structures" },
      },
      required: ["primary", "alternates"],
    },
    thumbnails: {
      type: "array",
      description: "Exactly 3 distinct concepts attacking different emotions",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          label: { type: "string", description: "Short name + the emotion it targets, e.g. 'A — Number shock'" },
          concept: { type: "string", description: "The visual idea in one sentence" },
          overlayText: { type: "string", description: "≤4 words to place on the thumbnail" },
          focalElement: { type: "string", description: "The single dominant object/character" },
          palette: { type: "string", description: "Background + text + accent colors" },
          geminiPrompt: { type: "string", description: "Full text-to-image prompt for Gemini, 16:9. Use WHATEVER visual style maximizes clicks for this topic — photorealistic, bold 3D, dramatic photo, graphic illustration, etc. It does NOT need to match the video's stick-man style. Describe composition, focal element, expression/emotion, colors, and leave space for the overlay text (the user may add the words separately)." },
          whyItWorks: { type: "string", description: "The psychological reason this earns the click from our broad personal-finance audience" },
        },
        required: ["label", "concept", "overlayText", "focalElement", "palette", "geminiPrompt", "whyItWorks"],
      },
    },
    description: { type: "string", description: "Full YouTube description: keyword-first opening line, 300-500 words of useful context, a CHAPTERS section, an [AFFILIATE: ...] links block, 3-5 hashtags at the bottom, and the educational-not-advice disclaimer." },
    chapters: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: { time: { type: "string", description: "mm:ss, first is 0:00" }, title: { type: "string", description: "curiosity-tinged label" } },
        required: ["time", "title"],
      },
    },
    tags: { type: "array", items: { type: "string" }, description: "12-18 backend search tags" },
    hashtags: { type: "array", items: { type: "string" }, description: "3-5 hashtags (with #)" },
    pinnedComment: { type: "string", description: "A pinned comment that drives replies and restates the one action step" },
    abTest: { type: "string", description: "Which title+thumbnail pair to test first and what to measure" },
  },
  required: ["titles", "thumbnails", "description", "chapters", "tags", "hashtags", "pinnedComment", "abTest"],
};

// ── prompt ───────────────────────────────────────────────────────────────────

function buildSystem(skill) {
  return `You are the packaging strategist for the faceless YouTube channel below. You design the thumbnail + title + metadata that makes the channel's specific viewer click — and that the script can honestly pay off.

${CHANNEL_BRIEF}

═══════════════ THUMBNAIL + SEO SKILL (follow this exactly) ═══════════════
${skill}
═══════════════════════════════════════════════════════════════════════════

TASK: Using the video's topic, its actual script, its strongest visual moments,
the real chapter timeline, and the competitor titles currently winning the niche,
produce the complete packaging set per the schema.

Hard requirements:
- Every promise must be payable-off by the provided script. Honest curiosity only.
- 3 thumbnail concepts, each a DIFFERENT emotional angle, each with a Gemini-ready
  prompt and a ≤4-word overlay. The thumbnail style is FREE — pick whatever pulls
  clicks for the topic (photoreal, 3D, dramatic photo, bold graphic). It does NOT
  have to match the video's stick-man look.
- 5 title alternates across different proven structures; pick the strongest as primary.
- Description: keyword in the first sentence, scannable, with chapters + an
  [AFFILIATE: ...] links block + 3-5 hashtags + the educational-not-advice disclaimer.
- Chapters aligned to the REAL timeline provided (0:00 first), curiosity-tinged labels.
- Learn title rhythm from the competitor list, but do not copy any title.

Return ONLY the structured object.`;
}

function buildUser(topic, script, heroes, timeline, comps) {
  return [
    `VIDEO TOPIC:\n${JSON.stringify(topic, null, 2)}`,
    `\nFULL SCRIPT (the promise must be payable from this):\n<script>\n${script}\n</script>`,
    `\nSTRONGEST VISUAL MOMENTS (thumbnail fodder — overlay · mood · visual):\n${heroes.map((h) => `- [${h.mood}] "${h.overlay}" — ${h.visual}`).join("\n")}`,
    `\nREAL CHAPTER TIMELINE (use these timestamps):\n${timeline.join("\n")}`,
    `\nCOMPETITOR TITLES WINNING NOW (learn the rhythm, don't copy):\n${comps.join("\n")}`,
    `\nProduce the full packaging set and return the structured object.`,
  ].join("\n");
}

// ── run ──────────────────────────────────────────────────────────────────────

async function main() {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error("ANTHROPIC_API_KEY is not set (see .env.example)");

  const rank = parseInt((process.argv.find((a) => a.startsWith("--topic=")) || "").split("=")[1], 10) || 1;
  const topic = loadTopic(rank);
  const script = read(join(OUT, "script.md")).replace(/^[\s\S]*?\n---\n/, "").trim();
  const skill = read(join(projectRoot, "skills", "thumbnail-seo", "SKILL.md"));
  const heroes = heroCandidates();
  const timeline = chapterTimeline();
  const comps = competitorTitles();

  if (!script) throw new Error("output/script.md not found — run `npm run script` first");

  console.log(`Packaging "${topic.title}" with ${MODEL}…`);
  const client = new Anthropic({ apiKey });
  const stream = client.messages.stream({
    model: MODEL,
    max_tokens: 16000,
    thinking: { type: "adaptive" },
    output_config: { effort: "high", format: { type: "json_schema", schema: SCHEMA } },
    system: buildSystem(skill),
    messages: [{ role: "user", content: buildUser(topic, script, heroes, timeline, comps) }],
  });

  const message = await stream.finalMessage();
  if (message.stop_reason === "refusal") throw new Error("Model refused (safety stop).");
  const text = message.content.find((b) => b.type === "text")?.text;
  if (!text) throw new Error("No structured output returned.");
  const data = JSON.parse(text);

  mkdirSync(OUT, { recursive: true });
  const bundle = { generatedAt: new Date().toISOString(), model: MODEL, topicRank: rank, title: topic.title, ...data };
  writeFileSync(join(OUT, "metadata.json"), JSON.stringify(bundle, null, 2));
  writeFileSync(join(OUT, "metadata.md"), toMarkdown(bundle));
  writeFileSync(
    join(OUT, "thumbnail_prompts.txt"),
    bundle.thumbnails.map((t, i) => `# ${t.label}\nOVERLAY: ${t.overlayText}\n\n${t.geminiPrompt}\n`).join("\n---\n\n")
  );

  const u = message.usage;
  console.log(`\n✓ Done`);
  if (u) console.log(`  tokens — in: ${u.input_tokens}, out: ${u.output_tokens}`);
  console.log(`  → ${join(OUT, "metadata.json")}`);
  console.log(`  → ${join(OUT, "metadata.md")}`);
  console.log(`  → ${join(OUT, "thumbnail_prompts.txt")} (paste into Gemini)`);
}

function toMarkdown(b) {
  const L = [];
  L.push(`# Packaging — ${b.title}`);
  L.push(`_Generated ${b.generatedAt} · ${b.model}_\n`);
  L.push(`## Titles`);
  L.push(`**Primary:** ${b.titles.primary}\n`);
  L.push(`Alternates:`);
  b.titles.alternates.forEach((t) => L.push(`- ${t}`));
  L.push(`\n## Thumbnails`);
  for (const t of b.thumbnails) {
    L.push(`### ${t.label}`);
    L.push(`- **Overlay:** ${t.overlayText}`);
    L.push(`- **Focal:** ${t.focalElement}`);
    L.push(`- **Palette:** ${t.palette}`);
    L.push(`- **Concept:** ${t.concept}`);
    L.push(`- **Why it works:** ${t.whyItWorks}`);
    L.push(`- **Gemini prompt:**\n\n> ${t.geminiPrompt}\n`);
  }
  L.push(`## Description`);
  L.push("```\n" + b.description + "\n```");
  L.push(`\n## Chapters`);
  b.chapters.forEach((c) => L.push(`- ${c.time} ${c.title}`));
  L.push(`\n## Tags`);
  L.push(b.tags.join(", "));
  L.push(`\n## Hashtags`);
  L.push(b.hashtags.join(" "));
  L.push(`\n## Pinned comment`);
  L.push(`> ${b.pinnedComment}`);
  L.push(`\n## A/B test`);
  L.push(b.abTest);
  return L.join("\n");
}

main().catch((err) => {
  console.error("\n✗ Fatal:", err.message);
  process.exit(1);
});
