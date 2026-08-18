// Script Writing Engine — the heart of the pipeline and its ENTRY POINT.
//
// Unlike the finance channel (which started from a news/trends/competitor
// fetch), this channel starts from a single IDEA. You give it a one-line idea;
// it does the rest.
//
// Stage 0: Claude expands the raw idea into a structured topic brief (title,
//          hook, narrative beats, the hidden truth) using the channel brief —
//          this replaces the old topic-selection pipeline. Written to
//          output/topics.json (one topic, rank 1) so the metadata step reads it
//          exactly like the finance flow did.
// Stage 1: Claude writes the full 8–10 minute voiceover script — pure spoken
//          narration, built on the channel's storytelling DNA.
// Stage 2: Claude converts that script VERBATIM into scene-by-scene JSON:
//          narration chunk + a COLORED doodle image prompt + background color +
//          text overlay + Ken Burns move + mood per scene. Code then computes
//          start/end timestamps from word counts (replaced by real TTS timings
//          in the video step).
//
// Usage:
//   npm run script -- --idea="What did ancient humans do at night?"
//   npm run script -- --idea-file=ideas/my-idea.txt
//   npm run script                      (falls back to ideas/idea.txt)
//
// Outputs: output/topics.json, output/script.md, output/scenes.json

import Anthropic from "@anthropic-ai/sdk";
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { loadEnv, projectRoot } from "./env.js";
import { CHANNEL_BRIEF } from "../config/channel.js";
import {
  DOODLE_STYLE_PREFIX,
  BG_PALETTE,
  BG_COLORS,
  ACCENT_NOTE,
  KEN_BURNS,
  WORDS_PER_SECOND,
} from "../config/style.js";

loadEnv();

const MODEL = "claude-opus-4-8";
const TARGET_WORDS_MIN = 1100; // ≈7:00 at ~150 wpm
const TARGET_WORDS_MAX = 1250; // ≈8:10

// ── Input: the idea ───────────────────────────────────────────────────────────

function loadIdea() {
  const ideaArg = (process.argv.find((a) => a.startsWith("--idea=")) || "").split("=").slice(1).join("=").trim();
  if (ideaArg) return ideaArg;

  const fileArg = (process.argv.find((a) => a.startsWith("--idea-file=")) || "").split("=").slice(1).join("=").trim();
  const path = fileArg
    ? (fileArg.startsWith("/") ? fileArg : join(projectRoot, fileArg))
    : join(projectRoot, "ideas", "idea.txt");
  if (existsSync(path)) {
    const txt = readFileSync(path, "utf8").trim();
    if (txt) return txt;
  }
  throw new Error(
    'No idea provided. Pass one with --idea="…" or --idea-file=path, ' +
      "or put one line in ideas/idea.txt"
  );
}

const wordCount = (s) => s.trim().split(/\s+/).filter(Boolean).length;

// ── Stage 0: idea → structured topic brief ────────────────────────────────────

const TOPIC_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    title: { type: "string", description: "Final YouTube title. Question-with-you/we form, or 'Why You …'. Put the CONCEPT in the title, never an academic jargon name." },
    thumbnailText: { type: "string", description: "3–5 punchy words for a CONCRETE thumbnail (a human problem/feeling, not an abstract symbol)" },
    series: { type: "string", description: "Which channel series this belongs to if any (e.g. 'Ancient You'), else empty string" },
    everydayThing: { type: "string", description: "The exact thing the viewer does or feels every day that this video opens on" },
    hiddenTruth: { type: "string", description: "The ancient or scientific truth that secretly explains that everyday thing" },
    targetEmotion: { type: "string", description: "The dominant feeling: wonder, dread, self-recognition, awe, unease, relief, nostalgia, curiosity" },
    hook: { type: "string", description: "The first ~10 seconds of voiceover, written verbatim — the most surprising self-relevant claim, no intro, second person" },
    description: { type: "string", description: "2–3 sentences: what this video is and the reframe it gives the viewer about their own life" },
    beats: {
      type: "array",
      description: "The ordered story beats following the channel's DNA: modern hook → time-travel/turn → narrative science → evidence → modern mirror → emotional close. Each beat one concrete sentence.",
      items: { type: "string" },
    },
    caveats: {
      type: "array",
      description: "Where the claim is uncertain, contested, or the analogy breaks — to be handled honestly and EARLY. Empty array only if the topic is genuinely settled.",
      items: { type: "string" },
    },
    openQuestion: { type: "string", description: "The single open question to end on that opens the door to the next video" },
  },
  required: ["title", "thumbnailText", "series", "everydayThing", "hiddenTruth", "targetEmotion", "hook", "description", "beats", "caveats", "openQuestion"],
};

function buildBriefSystem() {
  return `You are the head of content for the faceless YouTube channel below. You turn a one-line idea into a fully-formed video brief that fits THIS channel's growth formula exactly.

${CHANNEL_BRIEF}

# YOUR TASK
Take the raw idea the user gives you and develop it into ONE complete video brief matching the schema.

Rules:
- Stay inside the winning lane. If the raw idea drifts toward engineering/economics/news, find the body/ancient/psychology/everyday-science angle that brings it back into the lane, or sharpen it onto the most self-relevant human hook.
- everydayThing must be something the viewer literally does or feels; hiddenTruth must genuinely explain it. The whole video lives or dies on this connection — make it real, not a stretch.
- title: put the concept in plain words (benefit/feeling), never an academic name. Use the proven patterns in the brief.
- hook: verbatim first ~10 seconds, second person, the single most surprising self-relevant claim, NO intro.
- beats: follow the storytelling DNA in order; concrete, not vague.
- caveats: be honest. If the topic is commonly overstated online, name where it's uncertain or where the analogy breaks so the script can defuse it early.
- openQuestion: leave the viewer curious enough to click the next video.

Return ONLY the structured object.`;
}

async function developBrief(client, idea) {
  console.log(`Stage 0/2 — developing the idea into a brief (${MODEL})…`);
  const stream = client.messages.stream({
    model: MODEL,
    max_tokens: 8000,
    thinking: { type: "adaptive" },
    output_config: { effort: "high", format: { type: "json_schema", schema: TOPIC_SCHEMA } },
    system: buildBriefSystem(),
    messages: [{ role: "user", content: `Develop this idea into a complete video brief for the channel:\n\n"${idea}"` }],
  });
  const message = await stream.finalMessage();
  if (message.stop_reason === "refusal") throw new Error("Model refused (safety stop) on Stage 0.");
  const text = message.content.find((b) => b.type === "text")?.text;
  if (!text) throw new Error("Stage 0 returned no brief.");
  return { topic: JSON.parse(text), usage: message.usage };
}

// ── Stage 1: the script ───────────────────────────────────────────────────────

function buildScriptSystem() {
  return `You are the lead script writer for the faceless YouTube channel below. You write voiceover scripts that hold a curious viewer for 7–8 minutes because every fact is a story and the viewer is always the subject. Your scripts sound like a sharp, curious friend telling you something that's going to slightly rearrange how you see yourself — never like AI, never like a corporate explainer.

${CHANNEL_BRIEF}

# HOW TO WRITE THE SCRIPT

## Length & format
- ${TARGET_WORDS_MIN}–${TARGET_WORDS_MAX} words of PURE SPOKEN NARRATION (≈7–8 minutes). Be tight — cut anything that doesn't earn its place. Every sentence either advances the story or deepens the feeling.
- Output ONLY the words the narrator speaks. No headings, no stage directions, no [brackets], no "Section 1", no markdown. Plain paragraphs separated by blank lines. Every word will be read aloud verbatim.

## The engagement spine (mandatory, but invisible as structure)
1. COLD OPEN (first ~25 words): open on the exact everyday thing the viewer does or feels — second person, present tense ("It's late. You're on the couch, phone an inch from your face…"). Then land the single most surprising, self-relevant claim. No greeting, no "in this video", no "today we're going to". Immediately OPEN A LOOP — tease the turn coming ("and what people did instead, for almost all of human history, is going to make your worst nights feel completely normal").
2. MID-VIDEO RE-HOOK (around halfway): pay off part of the opening loop OR twist it — "but here's the part that actually changes how you'll feel about it." This is where retention dies; re-grab them.
3. END HOOK (final ~60 words): close the loop, deliver the emotional/philosophical payoff that slightly RELIEVES the tension the opening created (the viewer should end feeling seen, not lectured), then ONE open question that naturally opens the next video and makes commenting easy ("So tell me — when you wake up at 3am, does it feel like a problem, or like something older?").

## The storytelling DNA (build it, don't label it)
- Modern hook → time-travel / turn → narrative science → the evidence → the modern mirror → emotional close. Move through these in order.
- NARRATIVE SCIENCE: never a dry list of facts. Each fact arrives inside a small scene — someone by a fire, a researcher opening a 400-year-old diary, a baby's brain wiring itself. Wonder, fear, or self-recognition on every beat.
- THE MIRROR: keep snapping back to the viewer. "This is why you…", "your brain is still doing this…", "that thing you felt last night — that's this."

## Sounding human (non-negotiable)
- Contractions everywhere: you're, it's, don't, here's, they'd.
- Vary sentence length hard. Some long, building a picture. Some four words. Some one.
- Talk TO one person: "you", "your night", "your brain". Never "viewers", "folks", "people out there".
- Concrete over abstract, always. Specific numbers, places, names, dates make it feel true (the 1500s, South Africa, 4 hours, 30 feet).
- Natural texture: "and here's the thing", "I'm not exaggerating", "sit with that for a second".
- BANNED: "dive in", "let's get started", "without further ado", "in today's video", "it's important to note", "in conclusion", "game-changer", "unlock", "delve", "navigate", "at the end of the day", and starting more than one sentence in the whole script with "Imagine".

## Honesty (this is how we keep trust while staying curious)
- Use the facts and beats from the brief. Where the brief lists a caveat, WORK IT IN EARLY and plainly — say where the claim is uncertain, contested, or where the famous analogy breaks. Don't bury it at the end. A confident "we don't fully know, but here's what the evidence shows" is stronger than false certainty for this audience.
- Don't invent precise statistics, dates, or studies that aren't in the brief. When unsure, phrase honestly ("roughly", "as far as we can tell", "the leading guess").

## Emotional register
- One arc across the video: curiosity → wonder/unease → recognition → a calmer, larger feeling. The viewer should END feeling slightly more at home in their own life.

Return ONLY the script text.`;
}

async function writeScript(client, topic) {
  console.log(`Stage 1/2 — writing the script (${MODEL})…`);
  const stream = client.messages.stream({
    model: MODEL,
    max_tokens: 16000,
    thinking: { type: "adaptive" },
    output_config: { effort: "high" },
    system: buildScriptSystem(),
    messages: [
      {
        role: "user",
        content:
          `Write the full voiceover script for this video:\n\n` +
          JSON.stringify(topic, null, 2) +
          `\n\nRemember: ${TARGET_WORDS_MIN}–${TARGET_WORDS_MAX} words, pure narration only, second person, hook the everyday thing first.`,
      },
    ],
  });
  const message = await stream.finalMessage();
  const text = message.content.find((b) => b.type === "text")?.text?.trim();
  if (!text) throw new Error("Stage 1 returned no script text.");
  return { text, usage: message.usage };
}

// ── Stage 2: scene breakdown (COLORED doodle frames) ──────────────────────────

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
            description: "Scene-specific COLORED doodle prompt for ONE still frame. The global doodle style is prepended automatically, so do NOT restate it. Describe one clear visual beat: subject, action, key prop/diagram, emotion, simple composition. State the background color phrase from bgColor inside the prompt. Use RED only for emphasis (circle/arrow/X/underline). Do not combine multiple moments.",
          },
          bgColor: {
            type: "string",
            enum: BG_COLORS,
            description: "The background color carrying this beat's emotion: white=explanation/science/neutral, night-navy=night/sleep/ancient/mystery, black=drama/reveal/the unknown, warm=light/day/fire/comfort/hope.",
          },
          textOverlay: {
            type: "string",
            description: "Short ALL-CAPS text burned over the frame: a number, a date, a place, or ≤4 punchy words. Empty string if the frame is stronger without text.",
          },
          kenBurns: { type: "string", enum: KEN_BURNS },
          mood: { type: "string", description: "One word for the emotional tone (e.g. wonder, dread, revelation, recognition, calm, unease, awe, nostalgia)" },
        },
        required: ["id", "narration", "imagePrompt", "bgColor", "textOverlay", "kenBurns", "mood"],
      },
    },
  },
  required: ["scenes"],
};

function buildScenesSystem() {
  const palette = BG_COLORS.map((k) => `  - ${k}: ${BG_PALETTE[k]}`).join("\n");
  return `You are the storyboard director for a faceless YouTube channel that animates curiosity/science explainers as COLORED hand-drawn DOODLE frames (static images brought to life with slow zooms/pans and text overlays). You split a finished voiceover script into scenes and write the image prompt for each one.

THE LOOK: childlike stick-figure doodles, thick black outlines, flat colors, very expressive simple faces. The single biggest tool is COLOR — the BACKGROUND COLOR of each frame carries the emotion of that beat. The second biggest tool is the DIAGRAM — wherever the narration states a structure, a number, a comparison, or a process, draw it as a simple labeled diagram instead of a literal scene.

# THE COLOR SYSTEM (this is what makes the channel look like itself)
Every scene MUST pick a bgColor from:
${palette}
${ACCENT_NOTE}

# DIAGRAMS BEAT LITERAL SCENES
Whenever you can, turn the idea into a simple doodle DIAGRAM, because diagrams are what make this channel feel smart and clear:
- a horizontal labeled bar split into segments (e.g. FIRST SLEEP | AWAKE | SECOND SLEEP)
- a circle with a measured radius and a label (e.g. a fire with "30 FEET" across it)
- a doodle equation of two objects (e.g. a scroll labeled HISTORY, an = sign, a beaker labeled SCIENCE)
- a BEFORE / AFTER pair shown as two boxes
- a smooth line that suddenly turns jagged, with a labeled arrow underneath
- a wrong thing with a big red X over it
The stick figure (the viewer) and the diagram are the two main visual modes — alternate between them.

# SCENE SPLITTING RULES
- These are STILL IMAGE PROMPTS, not video prompts. Each scene becomes one static frame.
- One frame shows ONE visual beat only. Keep frames SHORT and change the image OFTEN — if a sentence holds two images, or an action and its result, or a subject and a number, split it into separate frames.
- Aim for one scene per 2–4 seconds of narration (≈5–11 words) — a fast, constantly-moving picture. A 7–8 minute script should yield roughly 150–200 scenes.
- Split at the FINEST natural beat: a new action, a number, a metaphor, an emotional turn, a place — and you MAY split WITHIN a sentence at clause boundaries: after a comma, before "and"/"but"/"because"/"so"/"then", or at each item in a list. Don't split awkwardly mid-phrase (never between "the" and its noun); every fragment must still read as a clean chunk.
- narration must be VERBATIM from the script. Concatenated scenes must equal the full script — nothing added, dropped, or reworded.

# IMAGE PROMPT RULES (optimized for a smart image model)
The global doodle style is prepended automatically. You write ONLY the scene idea, 15–35 words, plain English (these are short beats — keep prompts lean, don't pad). Include:
- who/what is in the frame (the stick-figure "you", an ancient stick figure, an object, or a diagram)
- the ONE main action, diagram, or visual metaphor
- the emotion (via the face) if it matters
- one key prop / number / label when needed
- the background color phrase (copy the bgColor meaning into the prompt, e.g. "on a deep navy-blue night background")
- a simple framing note only if it helps (close-up, wide, centered)

Good examples:
- "A stick figure slumped on a couch at night, phone glowing on their bored face, on a deep navy-blue night background."
- "A simple doodle cave with a tiny orange fire inside, a red map pin and the label SOUTH AFRICA above it, on a plain off-white background."
- "A horizontal bar split into three labeled blocks — FIRST SLEEP, AWAKE, SECOND SLEEP — with a small rising sun doodle at the right end, on a plain off-white background."
- "Three stick figures sitting around a glowing campfire, relaxed and talking, on a deep navy-blue night background."
- "A smooth blue wave that suddenly breaks into a jagged spiky line where a yellow lightning bolt strikes, a red arrow labeled MILLIONS OF YEARS underneath, on a plain off-white background."

Avoid: long camera directions, exact body-pose descriptions, restating the doodle style, split-screen/collage/multi-panel, two locations in one frame, two moments in one frame, prompts over ~60 words. Never use generic prompts like "stickman thinking".

If the narration states a specific number, prefer putting it in textOverlay unless the number IS the visual (then label it inside the diagram).

# TEXT OVERLAY RULES
- Use for: numbers, dates ("THE 1500s"), places ("SOUTH AFRICA"), and 2–4 word punches ("TWO SLEEPS", "BEFORE / AFTER").
- ALL CAPS. Empty string when the image alone is stronger. Aim for overlays on roughly half the scenes.

# KEN BURNS
- zoom-in for tension, reveals, emotional close-ups. zoom-out for scale and context.
- pan-left/pan-right for journeys, transitions, before/after.
- static for clean diagrams that should read calmly.
- Vary it — never the same move three scenes running.

Return ONLY the structured object.`;
}

async function breakdownScenes(client, script) {
  console.log(`Stage 2/2 — storyboarding colored scenes (${MODEL})…`);
  const stream = client.messages.stream({
    model: MODEL,
    max_tokens: 48000,
    thinking: { type: "adaptive" },
    output_config: { effort: "high", format: { type: "json_schema", schema: SCENES_SCHEMA } },
    system: buildScenesSystem(),
    messages: [
      {
        role: "user",
        content: `Here is the finished script. Split it into scenes and storyboard every one — assign each a background color and favor diagrams.\n\n<script>\n${script}\n</script>`,
      },
    ],
  });
  const message = await stream.finalMessage();
  const text = message.content.find((b) => b.type === "text")?.text;
  if (!text) throw new Error("Stage 2 returned no scenes.");
  return { scenes: JSON.parse(text).scenes, usage: message.usage };
}

// ── Timestamps + validation ───────────────────────────────────────────────────

function applyTimestamps(scenes) {
  let cursor = 0;
  for (const s of scenes) {
    const dur = wordCount(s.narration) / WORDS_PER_SECOND;
    s.start = Math.round(cursor * 10) / 10;
    cursor += dur;
    s.end = Math.round(cursor * 10) / 10;
  }
  return cursor;
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
  if (scenes.length < 130 || scenes.length > 230) {
    warnings.push(`${scenes.length} scenes — expected roughly 150–200 still frames for this length`);
  }
  const mins = totalSec / 60;
  if (mins < 6.5 || mins > 9.0) {
    warnings.push(`estimated duration ${mins.toFixed(1)} min — outside the 7–8 minute target`);
  }
  const badBg = scenes.filter((s) => !BG_COLORS.includes(s.bgColor));
  if (badBg.length) warnings.push(`${badBg.length} scenes have an unknown bgColor`);
  return warnings;
}

// ── Run ───────────────────────────────────────────────────────────────────────

async function main() {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error("ANTHROPIC_API_KEY is not set (see .env.example)");

  const idea = loadIdea();
  console.log(`Idea: ${idea}\n`);

  const client = new Anthropic({ apiKey });

  const { topic, usage: u0 } = await developBrief(client, idea);
  console.log(`  title: ${topic.title}`);
  if (topic.series) console.log(`  series: ${topic.series}`);

  const { text: script, usage: u1 } = await writeScript(client, topic);
  console.log(`  script: ${wordCount(script)} words (≈${(wordCount(script) / WORDS_PER_SECOND / 60).toFixed(1)} min)`);

  const { scenes, usage: u2 } = await breakdownScenes(client, script);
  const totalSec = applyTimestamps(scenes);
  console.log(`  scenes: ${scenes.length}, estimated runtime ${(totalSec / 60).toFixed(1)} min`);

  // Prepend the locked doodle style to every image prompt.
  for (const s of scenes) {
    s.imagePrompt = `${DOODLE_STYLE_PREFIX} ${s.imagePrompt}`;
  }

  const warnings = validate(script, scenes, totalSec);

  const outDir = join(projectRoot, "output");
  mkdirSync(outDir, { recursive: true });

  // topics.json — one topic, rank 1 — so the metadata step reads it like the finance flow.
  const topicsBundle = {
    generatedAt: new Date().toISOString(),
    model: MODEL,
    source: "idea",
    idea,
    topics: [{ rank: 1, ...topic }],
  };
  writeFileSync(join(outDir, "topics.json"), JSON.stringify(topicsBundle, null, 2));

  const scriptMd = [
    `# ${topic.title}`,
    `_generated ${new Date().toISOString()} · ${MODEL}_`,
    `_${wordCount(script)} words ≈ ${(totalSec / 60).toFixed(1)} min · ${scenes.length} scenes · idea: "${idea}"_`,
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
    idea,
    title: topic.title,
    series: topic.series || "",
    estimatedDurationSec: Math.round(totalSec),
    wordCount: wordCount(script),
    timestampNote: "start/end estimated at ~150 wpm — replaced by real TTS word-level timings in the video step",
    scenes: scenes.map((s) => ({
      id: s.id,
      start: s.start,
      end: s.end,
      narration: s.narration,
      imagePrompt: s.imagePrompt,
      bgColor: s.bgColor,
      textOverlay: s.textOverlay,
      kenBurns: s.kenBurns,
      mood: s.mood,
    })),
  };
  const scenesPath = join(outDir, "scenes.json");
  writeFileSync(scenesPath, JSON.stringify(bundle, null, 2));

  // image_prompts.txt — one bare prompt per scene (no header lines), separated by
  // a single blank line, so it pastes straight into the image model (Flow/Gemini)
  // without the headers being read as part of the prompt. Prompts stay in scene
  // order, so save outputs in order as <id>_*.jpg into Images/zapi-img. The
  // background color is already stated inside each prompt; the full per-scene
  // metadata (id, bgColor, kenBurns, overlay) lives in scenes.json.
  const promptsTxt = scenes
    .map((s) => s.imagePrompt.trim())
    .join("\n\n");
  const promptsPath = join(outDir, "image_prompts.txt");
  writeFileSync(promptsPath, promptsTxt);

  console.log(`\n✓ Done`);
  const tin = (u0?.input_tokens ?? 0) + (u1?.input_tokens ?? 0) + (u2?.input_tokens ?? 0);
  const tout = (u0?.output_tokens ?? 0) + (u1?.output_tokens ?? 0) + (u2?.output_tokens ?? 0);
  console.log(`  tokens — in: ${tin}, out: ${tout}`);
  console.log(`  → ${join(outDir, "topics.json")}`);
  console.log(`  → ${scriptPath}`);
  console.log(`  → ${scenesPath}`);
  console.log(`  → ${promptsPath}`);
  if (warnings.length) {
    console.log(`\n⚠ Warnings:`);
    for (const w of warnings) console.log(`  - ${w}`);
  }
}

main().catch((err) => {
  console.error("\n✗ Fatal:", err.message);
  process.exit(1);
});
