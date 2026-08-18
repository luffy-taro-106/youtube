// Script Writing Engine — the heart of the faceless pipeline.
//
// Stage 1: Claude writes the full 10–12 minute voiceover script for one topic
//          from output/topics.json. Pure spoken narration, engineered with
//          retention psychology but written like a human, not an AI.
// Stage 2: Claude converts that script VERBATIM into a scene-by-scene JSON:
//          narration chunk + a hyper-specific stick-man image prompt + text
//          overlay + Ken Burns move per scene. Code then computes start/end
//          timestamps from word counts (replaced later by ElevenLabs real
//          timings in the voiceover step).
//
// Usage:
//   npm run script              → uses topic rank 1 from output/topics.json
//   npm run script -- --topic=2 → pick a different topic from the slate
//
// Outputs: output/script.md, output/scenes.json

import Anthropic from "@anthropic-ai/sdk";
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { loadEnv, projectRoot } from "./env.js";
import { CHANNEL_BRIEF } from "../config/channel.js";
import { STICKMAN_STYLE_PREFIX, KEN_BURNS, WORDS_PER_SECOND } from "../config/style.js";

loadEnv();

const MODEL = "claude-opus-4-8";
const TARGET_WORDS_MIN = 1550; // ≈10:00 at 153 wpm
const TARGET_WORDS_MAX = 1850; // ≈12:00

// ── Inputs ──────────────────────────────────────────────────────────────────

function loadTopic(rank) {
  const path = join(projectRoot, "output", "topics.json");
  if (!existsSync(path)) {
    throw new Error("output/topics.json not found — run `npm run topics` first");
  }
  const bundle = JSON.parse(readFileSync(path, "utf8"));
  const topic = bundle.topics.find((t) => t.rank === rank);
  if (!topic) {
    throw new Error(`No topic with rank ${rank} in topics.json (have: ${bundle.topics.map((t) => t.rank).join(", ")})`);
  }
  return topic;
}

function loadPsychologyQuickRef() {
  const path = join(projectRoot, "psychologist-analyst-1.0.0", "QUICK_REFERENCE.md");
  return existsSync(path) ? readFileSync(path, "utf8") : "";
}

const wordCount = (s) => s.trim().split(/\s+/).filter(Boolean).length;

// ── Stage 1: the script ─────────────────────────────────────────────────────

function buildScriptSystem(psychRef) {
  return `You are the lead script writer for the faceless YouTube channel described below. You write voiceover scripts that hold a broad personal-finance audience for 10+ minutes because you understand both their money problems AND the psychology of attention. Your scripts sound like a sharp, trustworthy friend talking — never like AI, never like a corporate explainer.

${CHANNEL_BRIEF}

═══════════════ PSYCHOLOGY REFERENCE (your retention toolkit) ═══════════════
${psychRef}
═══════════════════════════════════════════════════════════════════════════

# HOW TO WRITE THE SCRIPT

## Length & format
- ${TARGET_WORDS_MIN}–${TARGET_WORDS_MAX} words of PURE SPOKEN NARRATION (≈10–12 minutes at a natural pace).
- Output ONLY the words the narrator speaks. No headings, no stage directions, no [brackets], no "Section 1", no markdown. Plain paragraphs separated by blank lines. Every word you write will be read aloud verbatim by a voice engine.

## The three engagement hooks (mandatory, but invisible as structure)
1. COLD OPEN (first ~40 words): the single most surprising, loss-relevant claim of the entire video. No greeting, no "in this video", no introduction of any kind.
   - PREFER A CONTRADICTION OPEN when the topic genuinely supports one: lead by overturning something the viewer currently believes is true or safe ("The safest thing you did with your money this year is the reason you're exposed", "Recognizing a familiar voice on the phone now means nothing", "Paying off your house early just cost one couple $61,000"). People stay to resolve the dissonance — being told you're wrong about something you're confident in is the strongest retention trigger we know.
   - Do NOT force it. If the topic has no honest, defensible contradiction, use the shocking-claim open instead. A stretched or dishonest contradiction reads as clickbait and kills trust with our audience.
   Then immediately OPEN A LOOP: tease one specific thing coming later ("and near the end I'll show you the one move that undoes all of it") — this is the mid-video magnet.
2. MID-VIDEO RE-HOOK (around the halfway point): pay off part of the opening loop OR raise the stakes with a twist — "now here's the part almost everyone gets wrong, and it's the expensive part." This is where retention graphs die; this is where you re-grab them.
3. END HOOK + ENGAGEMENT (final ~60 words): close the loop you opened, give the single most important action step, then ask ONE specific, easy-to-answer question that makes commenting feel natural ("Which of these three have you already set up? Tell me below — I read every comment."). Never beg. Never say "smash that like button." A single, quiet, confident ask.

## Sounding human (this is non-negotiable)
- Use contractions everywhere: you're, it's, don't, here's.
- Vary sentence length hard. Some sentences are long and build a complete picture of what is happening to the viewer's money. Some are four words. Some are one.
- Talk TO one person: "you", "your 401k", "your phone". Never "viewers", "folks", "people out there".
- Concrete over abstract, always: not "significant tax implications" but "that's $4,200 you handed the IRS for nothing."
- Allow natural asides and texture: "and look —", "here's the thing though", "I'm not exaggerating", "do the math with me for a second."
- BANNED: "dive in", "let's get started", "without further ado", "in today's video", "it's important to note", "in conclusion", "game-changer", "unlock", "delve", "navigate the landscape", "at the end of the day", rhetorical question stacking, and any sentence that starts with "Imagine" more than once in the whole script.
- Numbers do the persuading. Real dollar figures, real ages, real IRS limits, real form names. Round numbers feel fake; specific ones feel true ($4,212 beats $4,000).
- One emotional register shift per act: fear → understanding → control. The viewer should END feeling capable, not scared. Scared viewers click away; capable viewers subscribe.

## Structure beneath the surface (don't label it, just build it)
- Act 1 (≈0:00–1:30): cold open claim → who this hits and why now → open the loop → establish the stakes with one vivid, specific story or case.
- Act 2 (≈1:30–6:00): the mechanism — HOW the problem actually works, step by step, with numbers. The viewer should feel smarter every 30 seconds. Use a running example with consistent named figures (e.g. "back to our $500,000 IRA").
- MID RE-HOOK at ≈6:00.
- Act 3 (≈6:00–10:30): implementation — the exact moves, forms, thresholds, and the order to do them in. This is our USP: the form name, the box, the number, where to click.
- Close (final 45–60s): close the loop, the ONE thing to do this week, engagement question.

## Accuracy
- Use the facts, figures, and steps from the topic brief you're given. Where the brief cites a number (limits, brackets, form names), keep it. Don't invent statutes or precise legal thresholds that aren't in the brief — instead phrase honestly ("the current limit", "roughly", "as of this year") when unsure.

Return ONLY the script text.`;
}

async function writeScript(client, topic) {
  console.log(`Stage 1/2 — writing the script (${MODEL})…`);
  const stream = client.messages.stream({
    model: MODEL,
    max_tokens: 16000,
    thinking: { type: "adaptive" },
    output_config: { effort: "high" },
    system: buildScriptSystem(loadPsychologyQuickRef()),
    messages: [
      {
        role: "user",
        content:
          `Write the full voiceover script for this video:\n\n` +
          JSON.stringify(topic, null, 2) +
          `\n\nRemember: ${TARGET_WORDS_MIN}–${TARGET_WORDS_MAX} words, pure narration only.`,
      },
    ],
  });
  const message = await stream.finalMessage();
  const text = message.content.find((b) => b.type === "text")?.text?.trim();
  if (!text) throw new Error("Stage 1 returned no script text.");
  return { text, usage: message.usage };
}

// ── Stage 2: scene breakdown ────────────────────────────────────────────────

const SCENES_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    scenes: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          id: { type: "integer" },
          narration: {
            type: "string",
            description: "The exact, verbatim words from the script spoken during this scene. Concatenating all scenes' narration must reproduce the full script with nothing added, dropped, or reworded.",
          },
          imagePrompt: {
            type: "string",
            description: "Scene-specific still-image prompt. The global stick-man animation style is prepended automatically, so do NOT restate style. Describe one clear visual beat for this single frame with enough detail for image generation: subject, action, key prop, emotion, and simple composition. Do not combine multiple moments in one prompt.",
          },
          textOverlay: {
            type: "string",
            description: "Short text burned over the frame by FFmpeg: a dollar figure, an age, a form name, or ≤4 punchy words. Empty string if the frame is stronger without text.",
          },
          kenBurns: { type: "string", enum: KEN_BURNS },
          mood: { type: "string", description: "One word for the emotional tone of this beat (e.g. alarm, suspicion, clarity, relief, triumph)" },
        },
        required: ["id", "narration", "imagePrompt", "textOverlay", "kenBurns", "mood"],
      },
    },
  },
  required: ["scenes"],
};

const SCENES_SYSTEM = `You are the storyboard director for a faceless YouTube channel that animates finance explainers as hand-drawn STICK-FIGURE illustrations (static images brought to life with slow zooms/pans and text overlays). Your job: split a finished voiceover script into scenes and write the image prompt for each one.

THE CHANNEL: "${"Founder Finance"}" — money explainers (tax, retirement, insurance, scams, investing) for a broad, general audience, from beginners to experienced savers. The animation IS the retention engine: if a frame is boring, the viewer leaves.

# SCENE SPLITTING RULES
- These are STILL IMAGE PROMPTS, not video prompts. Each scene becomes one static image frame.
- One frame should show ONE visual beat only. Keep frames SHORT and change the image OFTEN — if the narration holds two ideas, or an action and its result, or a claim and its number, split it into separate frames.
- It is not just okay but REQUIRED for the number of frames to go up — a fast, constantly-moving picture is the retention engine. Do not cram multiple actions, metaphors, locations, or time moments into one frame.
- Aim for one scene per 2–4 seconds of narration (≈5–11 words). A 10–12 minute script should yield roughly 180–280 scenes.
- Split at the FINEST natural beat: a new action, number reveal, visual metaphor, emotional turn, or object discussed — and you MAY split WITHIN a sentence at clause boundaries: after a comma, before "and"/"but"/"because"/"so"/"then", or at each item in a list. Don't split awkwardly mid-phrase (never between "the" and its noun); every fragment must still read as a clean chunk.
- narration must be VERBATIM from the script. Copy exactly. Concatenated scenes must equal the full script — nothing added, dropped, or reworded. This text drives the voice engine and timing sync.

# IMAGE PROMPT RULES — optimized for Nano Banana
Nano Banana is smart, but this is still an image prompt. It needs to clearly describe what must appear in the single still frame.

The global style "simple hand-drawn stickman animation frame" is prepended automatically. You write ONLY the scene idea.

Each imagePrompt must be:
- 1 clear still-image prompt.
- Usually 25–45 words.
- Plain English, easy for an image model to understand.
- Specific enough to show exactly what is in the frame, but not overly dense.

Include only:
- who/what is in the frame
- the ONE main action or visual metaphor
- the emotion or danger if important
- one key prop, number, or label when needed
- a simple framing note only when it helps, such as close-up, wide shot, or centered

Good examples:
- Close-up of a stickman answering a ringing phone, nervous face, with a savings jar sitting beside him.
- A giant savings jar tipped over, green dollar bills spilling out while a stickman reaches helplessly toward it.
- Robot voice-cloning machine pulling sound waves from a small social media video of someone's face.
- Worried stickman standing at the edge of a cliff labeled IRMAA, holding a 401k withdrawal form.

Avoid:
- long camera directions
- overly exact body pose descriptions
- repeated style language
- color explanations unless the color is essential
- showing a sequence of events in one image
- combining unrelated objects just because the narration mentions them
- split-screen, split-frame, side-by-side, before/after, collage, or multi-panel prompts
- two different locations in one image
- a phone call scene plus the imagined thing being discussed in the same frame
- prompts longer than about 60 words

Bad example: "Split frame: a man on the phone on one side, a relative in jail beside a crashed car on the other."
Better: "A stickman grips the phone in fear as a speech bubble says 'Your account has been locked.'"

Every frame still needs a concrete visual idea. Do not use generic prompts like "stickman talking" or "person thinking."

If narration states a specific number, put it in textOverlay instead of forcing it into the imagePrompt unless the number is the whole visual idea.

# TEXT OVERLAY RULES
- Use for: dollar figures ("$390,000"), ages ("73"), form names ("Form SSA-44"), and 2–4 word punches ("TWO YEARS LATER").
- Empty string when the image alone is stronger. Aim for overlays on roughly half the scenes.

# KEN BURNS
- zoom-in for tension, reveals, and emotional close-ups.
- zoom-out for context, scale, and "look how big this is".
- pan-left/pan-right for transitions, journeys, and before/after.
- Vary it. Never the same move three scenes running.

Return ONLY the structured object.`;

async function breakdownScenes(client, script) {
  console.log(`Stage 2/2 — storyboarding scenes (${MODEL})…`);
  const stream = client.messages.stream({
    model: MODEL,
    max_tokens: 40000,
    thinking: { type: "adaptive" },
    output_config: {
      effort: "high",
      format: { type: "json_schema", schema: SCENES_SCHEMA },
    },
    system: SCENES_SYSTEM,
    messages: [
      {
        role: "user",
        content: `Here is the finished script. Split it into scenes and storyboard every one.\n\n<script>\n${script}\n</script>`,
      },
    ],
  });
  const message = await stream.finalMessage();
  const text = message.content.find((b) => b.type === "text")?.text;
  if (!text) throw new Error("Stage 2 returned no scenes.");
  return { scenes: JSON.parse(text).scenes, usage: message.usage };
}

// ── Timestamps + validation ─────────────────────────────────────────────────

function applyTimestamps(scenes) {
  let cursor = 0;
  for (const s of scenes) {
    const dur = wordCount(s.narration) / WORDS_PER_SECOND;
    s.start = Math.round(cursor * 10) / 10;
    cursor += dur;
    s.end = Math.round(cursor * 10) / 10;
  }
  return cursor; // total seconds
}

function validate(script, scenes, totalSec) {
  const warnings = [];
  const scriptWords = wordCount(script);
  const sceneWords = scenes.reduce((n, s) => n + wordCount(s.narration), 0);

  if (scriptWords < TARGET_WORDS_MIN || scriptWords > TARGET_WORDS_MAX + 100) {
    warnings.push(`script is ${scriptWords} words — outside the ${TARGET_WORDS_MIN}–${TARGET_WORDS_MAX} target (≈${(scriptWords / WORDS_PER_SECOND / 60).toFixed(1)} min)`);
  }
  const drift = Math.abs(sceneWords - scriptWords) / scriptWords;
  if (drift > 0.05) {
    warnings.push(`scene narration totals ${sceneWords} words vs script ${scriptWords} (${(drift * 100).toFixed(1)}% drift) — stage 2 may have dropped or reworded narration`);
  }
  if (scenes.length < 160 || scenes.length > 300) {
    warnings.push(`${scenes.length} scenes — expected roughly 180–280 still-image frames for this length`);
  }
  const mins = totalSec / 60;
  if (mins < 9.5 || mins > 12.8) {
    warnings.push(`estimated duration ${mins.toFixed(1)} min — outside the 10–12 minute target`);
  }
  return warnings;
}

// ── Run ─────────────────────────────────────────────────────────────────────

async function main() {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error("ANTHROPIC_API_KEY is not set (see .env.example)");

  const rankArg = (process.argv.find((a) => a.startsWith("--topic=")) || "").split("=")[1];
  const rank = parseInt(rankArg, 10) || 1;
  const topic = loadTopic(rank);
  console.log(`Topic ${rank}: ${topic.title}\n`);

  const client = new Anthropic({ apiKey });

  const { text: script, usage: u1 } = await writeScript(client, topic);
  console.log(`  script: ${wordCount(script)} words (≈${(wordCount(script) / WORDS_PER_SECOND / 60).toFixed(1)} min)`);

  const { scenes, usage: u2 } = await breakdownScenes(client, script);
  const totalSec = applyTimestamps(scenes);
  console.log(`  scenes: ${scenes.length}, estimated runtime ${(totalSec / 60).toFixed(1)} min`);

  // Prepend the locked global style to every image prompt.
  for (const s of scenes) {
    s.imagePrompt = `${STICKMAN_STYLE_PREFIX} ${s.imagePrompt}`;
  }

  const warnings = validate(script, scenes, totalSec);

  const outDir = join(projectRoot, "output");
  mkdirSync(outDir, { recursive: true });

  const scriptMd = [
    `# ${topic.title}`,
    `_Topic rank ${rank} · generated ${new Date().toISOString()} · ${MODEL}_`,
    `_${wordCount(script)} words ≈ ${(totalSec / 60).toFixed(1)} min · ${scenes.length} scenes_`,
    ``,
    `---`,
    ``,
    script,
  ].join("\n");
  const scriptPath = join(outDir, "script.md");
  writeFileSync(scriptPath, scriptMd);

  const bundle = {
    generatedAt: new Date().toISOString(),
    model: MODEL,
    topicRank: rank,
    title: topic.title,
    pillar: topic.pillar,
    estimatedDurationSec: Math.round(totalSec),
    wordCount: wordCount(script),
    timestampNote: "start/end estimated at 153 wpm — replaced by ElevenLabs word-level timings in the voiceover step",
    scenes: scenes.map((s) => ({
      id: s.id,
      start: s.start,
      end: s.end,
      narration: s.narration,
      imagePrompt: s.imagePrompt,
      textOverlay: s.textOverlay,
      kenBurns: s.kenBurns,
      mood: s.mood,
    })),
  };
  const scenesPath = join(outDir, "scenes.json");
  writeFileSync(scenesPath, JSON.stringify(bundle, null, 2));

  console.log(`\n✓ Done`);
  const tin = (u1?.input_tokens ?? 0) + (u2?.input_tokens ?? 0);
  const tout = (u1?.output_tokens ?? 0) + (u2?.output_tokens ?? 0);
  console.log(`  tokens — in: ${tin}, out: ${tout}`);
  console.log(`  → ${scriptPath}`);
  console.log(`  → ${scenesPath}`);
  if (warnings.length) {
    console.log(`\n⚠ Warnings:`);
    for (const w of warnings) console.log(`  - ${w}`);
  }
}

main().catch((err) => {
  console.error("\n✗ Fatal:", err.message);
  process.exit(1);
});
