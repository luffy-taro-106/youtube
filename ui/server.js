// Founder Finance — workflow UI server.
//
// A thin Express layer over the existing CLI steps. It:
//   • serves the single-page stepper UI (ui/public/index.html)
//   • starts each pipeline step as a child process and streams its logs
//   • reads the output files so the UI can show topics / script / prompts / metadata
//   • accepts a thumbnail upload and triggers the YouTube upload
//
//   npm run ui   →  http://localhost:4000

import express from "express";
import { spawn } from "node:child_process";
import {
  readFileSync, writeFileSync, existsSync, readdirSync, statSync, rmSync, mkdirSync,
} from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import os from "node:os";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");
const OUT = join(ROOT, "output");
const VIDEO_DIR = join(OUT, "video");
const IMAGES_DIR = join(ROOT, "Images", "zapi-img");
const IMAGE_CLEAN_STATE = join(IMAGES_DIR, ".watermark_cleaned.json");
const TOKEN = join(ROOT, ".youtube-token.json");
const KOKORO_PY = process.env.KOKORO_PYTHON || join(os.homedir(), ".venv/kokoro-py312/bin/python");
const PORT = Number(process.env.UI_PORT || 4000);

const IMG_EXT = /\.(jpe?g|png|webp)$/i;

// ── job runner ───────────────────────────────────────────────────────────────
const jobs = new Map();
let seq = 0;
let selectedRank = 1; // remembered between the script + metadata steps

function runChain(steps) {
  const id = String(++seq);
  const job = { id, status: "running", logs: "", exitCode: null, startedAt: Date.now() };
  jobs.set(id, job);
  let i = 0;
  const next = () => {
    if (i >= steps.length) { job.status = "done"; job.exitCode = 0; job.endedAt = Date.now(); return; }
    const { cmd, args, label } = steps[i++];
    job.logs += `\n$ ${label || [cmd, ...args].join(" ")}\n`;
    const child = spawn(cmd, args, { cwd: ROOT, env: process.env });
    child.stdout.on("data", (d) => (job.logs += d));
    child.stderr.on("data", (d) => (job.logs += d));
    child.on("close", (code) => {
      if (code !== 0) { job.status = "error"; job.exitCode = code; job.endedAt = Date.now(); }
      else next();
    });
    child.on("error", (e) => { job.status = "error"; job.logs += `\n${e.message}\n`; job.exitCode = -1; });
  };
  next();
  return job;
}

const rmrf = (p) => { try { rmSync(p, { recursive: true, force: true }); } catch {} };

// ── helpers to read pipeline state ───────────────────────────────────────────
const read = (p) => (existsSync(p) ? readFileSync(p, "utf8") : "");
const finalVideo = () => {
  if (!existsSync(VIDEO_DIR)) return null;
  const f = readdirSync(VIDEO_DIR).find((x) => x.endsWith(".mp4"));
  return f ? join(VIDEO_DIR, f) : null;
};
const imageCount = () =>
  existsSync(IMAGES_DIR) ? readdirSync(IMAGES_DIR).filter((f) => IMG_EXT.test(f)).length : 0;
const markerCount = (p) => {
  if (!existsSync(p)) return 0;
  try { return Object.keys(JSON.parse(read(p)).files || {}).length; } catch { return 0; }
};
const thumbPath = () => {
  for (const n of ["thumbnail.jpg", "thumbnail.png"]) {
    const p = join(VIDEO_DIR, n);
    if (existsSync(p)) return p;
  }
  return null;
};

// The selected topic survives a restart by reading it back from scenes.json
// (written by the script step), falling back to the in-memory value.
function currentRank() {
  const p = join(OUT, "scenes.json");
  if (existsSync(p)) { try { const r = JSON.parse(read(p)).topicRank; if (r) return r; } catch {} }
  return selectedRank;
}

// Wipe everything for the current video so the next one starts clean, while
// keeping the auth token, configs, fonts, and the Intro/outro clips.
function finishCleanup() {
  rmrf(OUT); // all generated outputs (context, topics, script, scenes, video, metadata…)
  if (existsSync(IMAGES_DIR))
    for (const f of readdirSync(IMAGES_DIR)) if (IMG_EXT.test(f)) rmrf(join(IMAGES_DIR, f));
  rmrf(IMAGE_CLEAN_STATE);
  selectedRank = 1;
}

function buildState() {
  const topics = existsSync(join(OUT, "topics.json"))
    ? JSON.parse(read(join(OUT, "topics.json"))).topics
    : [];
  const promptsTxt = read(join(OUT, "image_prompts.txt"));
  const video = finalVideo();
  return {
    research: { ready: existsSync(join(OUT, "topics.json")), context: existsSync(join(OUT, "context.json")) },
    topics,
    selectedRank: currentRank(),
    script: { ready: existsSync(join(OUT, "script.md")), scenes: existsSync(join(OUT, "scenes.json")) },
    prompts: {
      ready: !!promptsTxt,
      count: promptsTxt ? promptsTxt.split(/\n\s*\n/).filter(Boolean).length : 0,
    },
    images: { count: imageCount(), cleaned: markerCount(IMAGE_CLEAN_STATE) },
    video: video
      ? { ready: true, name: video.split("/").pop(), sizeMB: +(statSync(video).size / 1e6).toFixed(1) }
      : { ready: false },
    metadata: { ready: existsSync(join(OUT, "metadata.json")), thumbPrompts: existsSync(join(OUT, "thumbnail_prompts.txt")) },
    thumbnail: { ready: !!thumbPath() },
    auth: { token: existsSync(TOKEN) },
  };
}

// ── app ──────────────────────────────────────────────────────────────────────
const app = express();
app.use(express.json());
app.use(express.raw({ type: ["image/*", "application/octet-stream"], limit: "25mb" }));
app.use(express.static(join(__dirname, "public")));

app.get("/api/state", (_req, res) => res.json(buildState()));
app.get("/api/job/:id", (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job) return res.status(404).json({ error: "no such job" });
  res.json({ status: job.status, exitCode: job.exitCode, logs: job.logs });
});

// text outputs the UI displays
app.get("/api/file/:name", (req, res) => {
  const map = {
    script: join(OUT, "script.md"),
    prompts: join(OUT, "image_prompts.txt"),
    metadata: join(OUT, "metadata.md"),
    thumbs: join(OUT, "thumbnail_prompts.txt"),
  };
  const p = map[req.params.name];
  if (!p || !existsSync(p)) return res.status(404).send("");
  res.type("text/plain").send(read(p));
});

// Step 1: research + topics
app.post("/api/run/research", (_req, res) => {
  const job = runChain([
    { cmd: "node", args: ["src/index.js"], label: "fetch context (news + competitors + trends)" },
    { cmd: "node", args: ["src/topics.js"], label: "generate topic ideas (Claude)" },
  ]);
  res.json({ jobId: job.id });
});

// Step 2→3: pick topic → write script (+ export prompts & voiceover). Fresh video,
// so reset downstream artifacts so nothing stale is reused.
app.post("/api/run/script", (req, res) => {
  const rank = Number(req.body?.rank) || 1;
  selectedRank = rank;
  for (const p of ["script.md", "scenes.json", "image_prompts.txt", "voiceover_narration.txt",
    "metadata.json", "metadata.md", "thumbnail_prompts.txt"]) rmrf(join(OUT, p));
  rmrf(join(VIDEO_DIR, "work"));
  const v = finalVideo(); if (v) rmrf(v);
  rmrf(join(VIDEO_DIR, "timeline.json"));
  for (const n of ["thumbnail.jpg", "thumbnail.png"]) rmrf(join(VIDEO_DIR, n));
  rmrf(join(OUT, "voiceover_chunks"));

  const job = runChain([
    { cmd: "node", args: ["src/script.js", `--topic=${rank}`], label: `write script for topic ${rank}` },
    { cmd: "python3", args: ["scripts/export_image_prompts.py"], label: "export image prompts" },
    { cmd: "python3", args: ["scripts/export_voiceover_text.py"], label: "export voiceover text" },
  ]);
  res.json({ jobId: job.id });
});

// Step 5: make the video
app.post("/api/run/video", (_req, res) => {
  const job = runChain([{ cmd: KOKORO_PY, args: ["scripts/generate_video.py"], label: "generate video (Kokoro + ffmpeg)" }]);
  res.json({ jobId: job.id });
});

// Step 4 cleanup: remove visible/metadata AI watermarks from generated images.
app.post("/api/run/clean-images", (_req, res) => {
  const job = runChain([{ cmd: KOKORO_PY, args: ["scripts/clean_images.py"], label: "remove image AI watermarks" }]);
  res.json({ jobId: job.id });
});

// Step 6: metadata + thumbnail prompts
app.post("/api/run/metadata", (_req, res) => {
  const job = runChain([{ cmd: "node", args: ["src/metadata.js", `--topic=${currentRank()}`], label: "generate metadata + thumbnail prompts (Claude)" }]);
  res.json({ jobId: job.id });
});

// Finish: clear the current video and stop the UI server.
app.post("/api/finish", (_req, res) => {
  try { finishCleanup(); } catch {}
  res.json({ ok: true, stopping: true });
  console.log("\n  Finished — cleared current video. Stopping UI.\n");
  setTimeout(() => process.exit(0), 600); // let the response flush first
});

// Step 8: upload to YouTube
app.post("/api/run/upload", (req, res) => {
  const privacy = ["private", "unlisted", "public"].includes(req.body?.privacy) ? req.body.privacy : "private";
  const job = runChain([{ cmd: "node", args: ["src/upload.js", `--privacy=${privacy}`], label: `upload (${privacy})` }]);
  res.json({ jobId: job.id });
});

// Step 4 helper: clear the images folder (for a fresh topic's images)
app.post("/api/images/clear", (_req, res) => {
  if (existsSync(IMAGES_DIR))
    for (const f of readdirSync(IMAGES_DIR)) if (IMG_EXT.test(f)) rmrf(join(IMAGES_DIR, f));
  rmrf(IMAGE_CLEAN_STATE);
  res.json({ count: imageCount() });
});

// Step 7: thumbnail upload (raw image bytes)
app.post("/api/thumbnail", (req, res) => {
  if (!req.body || !req.body.length) return res.status(400).json({ error: "no image data" });
  mkdirSync(VIDEO_DIR, { recursive: true });
  for (const n of ["thumbnail.jpg", "thumbnail.png"]) rmrf(join(VIDEO_DIR, n));
  const isPng = (req.headers["content-type"] || "").includes("png");
  writeFileSync(join(VIDEO_DIR, isPng ? "thumbnail.png" : "thumbnail.jpg"), req.body);
  res.json({ ok: true });
});

// media
app.get("/api/video", (req, res) => {
  const v = finalVideo();
  if (!v) return res.status(404).end();
  res.sendFile(v);
});
app.get("/api/thumbnail", (req, res) => {
  const t = thumbPath();
  if (!t) return res.status(404).end();
  res.sendFile(t);
});

app.listen(PORT, () => {
  console.log(`\n  Founder Finance UI → http://localhost:${PORT}\n`);
});
