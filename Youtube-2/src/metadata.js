// Thumbnail + Metadata Agent.
//
// A Claude agent given (1) the channel brief, (2) the full context of THIS video
// — the topic brief, the actual script, the strongest visual moments, the real
// chapter timeline — and it returns:
//   • 3 A/B-ready thumbnail concepts, each with a Gemini-ready generation prompt
//   • 5 title options (proven structures for this channel)
//   • an SEO description (keyword-first, chapters, sources, hashtags)
//   • backend tags, hashtags, chapters, a pinned comment, and an A/B plan
//
// Outputs: output/metadata.json, output/metadata.md, output/thumbnail_prompts.txt
//
//   npm run metadata

import Anthropic from "@anthropic-ai/sdk";
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { loadEnv, projectRoot } from "./env.js";
import { CHANNEL_BRIEF } from "../config/channel.js";
import { THUMBNAIL_STYLE, THUMBNAIL_TEXT_RULES } from "../config/style.js";

loadEnv();

const MODEL = "claude-opus-4-8";
const OUT = join(projectRoot, "output");

// ── inputs ─────────────────────────────────────────────────────────────────

function read(path, fallback = "") {
  return existsSync(path) ? readFileSync(path, "utf8") : fallback;
}

function loadTopic() {
  const p = join(OUT, "topics.json");
  if (!existsSync(p)) throw new Error("output/topics.json not found — run `npm run script` first");
  const bundle = JSON.parse(readFileSync(p, "utf8"));
  const topic = bundle.topics?.find((t) => t.rank === 1) || bundle.topics?.[0];
  if (!topic) throw new Error("No topic in topics.json");
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
    .map((s) => ({ id: s.id, overlay: s.textOverlay, mood: s.mood, bg: s.bgColor, visual: s.imagePrompt }))
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
        alternates: { type: "array", items: { type: "string" }, description: "5 alternates across different proven structures for this channel" },
      },
      required: ["primary", "alternates"],
    },
    thumbnails: {
      type: "array",
      description: "Exactly 3 distinct concepts attacking different emotions. At least 2 should be MODE A (illustrated reaction); include 1 MODE B (stark symbol on black) only if the topic has a genuinely unsettling standalone symbol.",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          label: { type: "string", description: "Short name + emotion + mode, e.g. 'A — Self-recognition (Mode A)'" },
          mode: { type: "string", enum: ["A", "B"], description: "A = illustrated reaction (big expressive stick figure in a scene). B = stark mysterious symbol on solid black." },
          concept: { type: "string", description: "The visual idea in one sentence" },
          overlayText: { type: "string", description: "The 1–3 word curiosity phrase that goes ON the thumbnail. ALL CAPS, almost always ends with '?'. MUST open a curiosity gap and MUST be different from the title (a NEW mystery, not a restatement). Use violation-of-expectation, concrete and sensory. Think '2 SLEEPS?', 'ROTTEN MEAT?', 'NO MOON?' — never a full sentence, never the title repeated." },
          focalElement: { type: "string", description: "The single dominant element — for Mode A, the big stick figure and its facial expression; for Mode B, the one bold symbol" },
          palette: { type: "string", description: "Background color + the yellow/black text treatment + any red accent" },
          geminiPrompt: { type: "string", description: "Full text-to-image prompt for Gemini, 16:9, in the exact channel thumbnail style described in the system prompt. Describe composition, the focal element, the EXACT facial expression (worried slanted brows / wide eyes / uneasy mouth) for Mode A, the background color, any red arrow/circle, and leave the top third clear for the big text. Do NOT bake the overlay words into the image description — they are added as text separately." },
          whyItWorks: { type: "string", description: "The psychological mechanism: which curiosity lever the phrase pulls and why this audience can't not click. Must pass 'strip the text — can you still feel the stakes?'" },
        },
        required: ["label", "mode", "concept", "overlayText", "focalElement", "palette", "geminiPrompt", "whyItWorks"],
      },
    },
    description: { type: "string", description: "Full YouTube description: keyword-first opening line, 250-450 words of context that pays off the curiosity, a CHAPTERS section, a SOURCES placeholder block, 3-5 hashtags at the bottom." },
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
    pinnedComment: { type: "string", description: "A pinned comment that restates the open question and invites replies" },
    abTest: { type: "string", description: "Which title+thumbnail pair to test first and what to measure" },
  },
  required: ["titles", "thumbnails", "description", "chapters", "tags", "hashtags", "pinnedComment", "abTest"],
};

// ── prompt ───────────────────────────────────────────────────────────────────

function buildSystem() {
  return `You are the packaging strategist for the faceless YouTube channel below. You design the thumbnail + title + metadata that makes the channel's curious viewer click — and that the script can honestly pay off. You think like a behavioral psychologist: the click is won or lost on curiosity, not information.

${CHANNEL_BRIEF}

═══════════════ THUMBNAIL LOOK (match this exactly) ═══════════════
${THUMBNAIL_STYLE}
═══════════════════════════════════════════════════════════════════

═══════════════ THUMBNAIL PHRASE PSYCHOLOGY ═══════════════
${THUMBNAIL_TEXT_RULES}
═══════════════════════════════════════════════════════════

TASK: Using the video's topic brief, its actual script, its strongest visual moments, and the real chapter timeline, produce the complete packaging set per the schema.

Hard requirements:
- Every promise must be payable-off by the provided script. Honest curiosity only.
- 3 thumbnail concepts, each a DIFFERENT emotional angle. Match the channel thumbnail look above. At least 2 are MODE A (one big stick figure with a very expressive face in a concrete scene); include a MODE B (stark symbol on black) only if there's a genuinely unsettling standalone symbol — never a chart/graph.
- Each thumbnail's overlay phrase MUST follow the phrase psychology above: 1–3 words, almost always a "?", a NEW mystery that is NOT the title restated, built on violation-of-expectation, concrete and sensory. The title and the thumbnail must work as two DIFFERENT hooks that multiply — never say the same thing twice.
- In whyItWorks, name the exact curiosity mechanism (gap / open loop / violation of expectation) and why THIS audience can't resist it.
- 5 title alternates across the channel's proven structures; pick the strongest as primary. Put the CONCEPT in the title, never an academic jargon name.
- Description: keyword in the first sentence, scannable, pays off the curiosity, with chapters + a SOURCES placeholder block + 3-5 hashtags. (This channel earns trust with source-heavy descriptions — leave clear placeholders.)
- Chapters aligned to the REAL timeline provided (0:00 first), curiosity-tinged labels.
- The pinned comment restates the video's open question to drive replies.

Return ONLY the structured object.`;
}

function buildUser(topic, script, heroes, timeline) {
  return [
    `VIDEO TOPIC BRIEF:\n${JSON.stringify(topic, null, 2)}`,
    `\nFULL SCRIPT (the promise must be payable from this):\n<script>\n${script}\n</script>`,
    `\nSTRONGEST VISUAL MOMENTS (thumbnail fodder — overlay · mood · bg · visual):\n${heroes.map((h) => `- [${h.mood}/${h.bg}] "${h.overlay}" — ${h.visual}`).join("\n")}`,
    `\nREAL CHAPTER TIMELINE (use these timestamps):\n${timeline.join("\n")}`,
    `\nProduce the full packaging set and return the structured object.`,
  ].join("\n");
}

// ── run ──────────────────────────────────────────────────────────────────────

async function main() {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error("ANTHROPIC_API_KEY is not set (see .env.example)");

  const topic = loadTopic();
  const script = read(join(OUT, "script.md")).replace(/^[\s\S]*?\n---\n/, "").trim();
  const heroes = heroCandidates();
  const timeline = chapterTimeline();

  if (!script) throw new Error("output/script.md not found — run `npm run script` first");

  console.log(`Packaging "${topic.title}" with ${MODEL}…`);
  const client = new Anthropic({ apiKey });
  const stream = client.messages.stream({
    model: MODEL,
    max_tokens: 16000,
    thinking: { type: "adaptive" },
    output_config: { effort: "high", format: { type: "json_schema", schema: SCHEMA } },
    system: buildSystem(),
    messages: [{ role: "user", content: buildUser(topic, script, heroes, timeline) }],
  });

  const message = await stream.finalMessage();
  if (message.stop_reason === "refusal") throw new Error("Model refused (safety stop).");
  const text = message.content.find((b) => b.type === "text")?.text;
  if (!text) throw new Error("No structured output returned.");
  const data = JSON.parse(text);

  mkdirSync(OUT, { recursive: true });
  const bundle = { generatedAt: new Date().toISOString(), model: MODEL, title: topic.title, ...data };
  writeFileSync(join(OUT, "metadata.json"), JSON.stringify(bundle, null, 2));
  writeFileSync(join(OUT, "metadata.md"), toMarkdown(bundle));
  writeFileSync(
    join(OUT, "thumbnail_prompts.txt"),
    bundle.thumbnails.map((t) => `# ${t.label}\nOVERLAY: ${t.overlayText}\n\n${t.geminiPrompt}\n`).join("\n---\n\n")
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
