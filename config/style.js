// The locked stick-man visual style. This prefix is programmatically prepended
// to EVERY scene image prompt so all frames across all videos look like the
// same artist drew them. Scene prompts (from Claude) describe only what is
// specific to that scene: action, characters, props, composition, emotion.
//
// Edit this once and the entire channel's look changes consistently.

export const STICKMAN_STYLE_PREFIX = [
  "Simple hand-drawn stickman animation frame, 16:9, black ink on off-white background, minimal accent color, clean and easy to understand.",
].join(" ");

// Ken Burns directions FFmpeg supports in our assembly step.
export const KEN_BURNS = ["zoom-in", "zoom-out", "pan-left", "pan-right"];

// Narration pacing used to estimate timestamps before ElevenLabs gives us
// real word-level timings (Step 06 of the pipeline replaces these).
export const WORDS_PER_SECOND = 2.55; // ≈153 wpm conversational pace
