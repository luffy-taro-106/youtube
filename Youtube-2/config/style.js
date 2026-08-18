// The locked COLORED doodle visual style. Unlike the finance channel (black ink
// on off-white), this channel uses COLOR as a storytelling device: the
// BACKGROUND COLOR of each frame carries the emotional register of that beat,
// and RED is reserved as the emphasis tool. This prefix is prepended to EVERY
// scene image prompt so all frames look like the same artist drew them.
//
// Edit this once and the whole channel's look changes consistently.

export const DOODLE_STYLE_PREFIX = [
  "Simple hand-drawn doodle animation frame, 16:9.",
  "Thick black marker outlines, flat colors with at most a little hand-painted texture — no gradients, no shading, no 3D.",
  "Childlike stick-figure characters: round white heads, big round eyes with dot pupils, expressive slanted eyebrows, and a simple line mouth — the face reads instantly as worried, shocked, calm, sad, or happy.",
  "Clean and minimal with lots of empty space; one clear visual idea per frame.",
].join(" ");

// THE BACKGROUND CARRIES THE EMOTION. Every scene picks exactly one of these.
// The value is the literal instruction injected into the image prompt.
export const BG_PALETTE = {
  white: "on a plain off-white background — explanation / neutral / science / present-day rational mode",
  "night-navy": "on a deep navy-blue night background — night, sleep, the ancient past, mystery, quiet, stillness",
  black: "on a solid black background — drama, darkness, a hard pivot, the unknown, a reveal",
  warm: "on a warm glowing yellow/orange background (firelight or sunlight) — light, day, warmth, comfort, energy, hope",
};
export const BG_COLORS = Object.keys(BG_PALETTE);

// RED is NEVER a background. It is the single attention tool — this note is
// appended to the style guidance the storyboard agent reads.
export const ACCENT_NOTE =
  "RED is the emphasis device only: use it to circle the key thing, cross out (X) what is wrong, draw a pointing arrow, or underline a word. Never use red as a background fill.";

// ── THUMBNAILS ────────────────────────────────────────────────────────────
// The exact Zenn-style thumbnail recipe, derived from the channel's real
// thumbnails. Two modes — pick whichever hits harder for the topic.
export const THUMBNAIL_STYLE = [
  "Hand-drawn doodle thumbnail, 16:9, the SAME childlike style as the videos: thick black marker outlines, flat lightly-textured colors, no 3D, no realism.",
  "MODE A — illustrated reaction (default): ONE big stick-figure character, close to camera, with a VERY expressive face (worried slanted eyebrows, big wide eyes, uneasy open mouth) reacting to something inside a simple concrete scene. Use an emotional background color (deep navy night, warm firelight/savanna orange, brown cave, off-white). Optionally one red arrow or red circle pointing at the single thing that matters.",
  "MODE B — stark symbol: ONE bold, mysterious symbol or object, huge and centered, on a SOLID BLACK background. Use only when the symbol itself is unsettling or strange on its own (a single glowing eye, a clock at 0:00). A plain chart or graph does NOT qualify.",
  "Composition: very few elements, massive and instantly readable on a phone. Keep the TOP THIRD clear and uncluttered so large text can sit there.",
].join(" ");

// The 1–3 word phrase IS the click. Psychology-first rules for the overlay text.
export const THUMBNAIL_TEXT_RULES = `
THE THUMBNAIL PHRASE — this is the single most important click lever:
- 1–3 words. ALL CAPS. Almost always ends with a "?".
- It must open a CURIOSITY GAP: a fragment the brain cannot resolve without clicking. The viewer should feel a small itch of "wait — what?" they can only scratch by opening the video (Loewenstein's curiosity gap + the Zeigarnik open-loop effect).
- It must ADD A NEW MYSTERY — never just restate the title. The title and the thumbnail are TWO DIFFERENT HOOKS that multiply each other. (Title: "What Did Ancient Humans Do at Night?" → thumbnail: "2 SLEEPS?")
- Use VIOLATION OF EXPECTATION: weld an everyday, familiar word to something that doesn't fit, so it feels slightly wrong or impossible. Real examples that worked: "2 SLEEPS?", "ROTTEN MEAT?", "NO MOON?", "WHO ARE YOU?", "ARE WE ALIENS?".
- Concrete and sensory — a thing the viewer can picture instantly. Never abstract, never academic, never a full sentence.
- Render it as bright YELLOW fill with a thick BLACK outline (or plain white/black on a black Mode-B thumbnail), in a bold hand-drawn rounded ALL-CAPS font, across the top.
`.trim();

// Ken Burns directions the assembly step supports. "static" = no movement
// (good for clean diagrams that should read calmly).
export const KEN_BURNS = ["zoom-in", "zoom-out", "pan-left", "pan-right", "static"];

// Narration pacing to estimate timestamps before TTS gives real word-level
// timings. ~150 wpm conversational storytelling pace.
export const WORDS_PER_SECOND = 2.55;
