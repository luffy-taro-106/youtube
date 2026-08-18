// Curiosity Channel — workflow UI server.
//
// A thin Express layer over the existing CLI steps. Unlike the finance studio
// (research → pick a topic → script), this channel is IDEA-FIRST: you type one
// idea and the script agent does brief + script + colored storyboard in one go.
//
// It:
//   • serves the single-page stepper UI (ui/public/index.html)
//   • starts each pipeline step as a child process and streams its logs
//   • reads the output files so the UI can show the script / prompts / metadata
//   • accepts a thumbnail upload and triggers the YouTube upload
//
//   npm run ui   →  http://localhost:4100

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
const PORT = Number(process.env.UI_PORT || 4100);

const IMG_EXT = /\.(jpe?g|png|webp)$/i;

// ── job runner ───────────────────────────────────────────────────────────────
const jobs = new Map();
let seq = 0;

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

// Pull the current idea + title for display.
function currentMeta() {
  const p = join(OUT, "topics.json");
  if (existsSync(p)) {
    try {
      const b = JSON.parse(read(p));
      const t = b.topics?.[0] || {};
      return { idea: b.idea || "", title: t.title || "", series: t.series || "" };
    } catch {}
  }
  return { idea: "", title: "", series: "" };
}

// Wipe everything for the current video so the next one starts clean, while
// keeping the auth token, configs, fonts, and any outro clip.
function finishCleanup() {
  rmrf(OUT);
  if (existsSync(IMAGES_DIR))
    for (const f of readdirSync(IMAGES_DIR)) if (IMG_EXT.test(f)) rmrf(join(IMAGES_DIR, f));
  rmrf(IMAGE_CLEAN_STATE);
}

function buildState() {
  const promptsTxt = read(join(OUT, "image_prompts.txt"));
  const video = finalVideo();
  return {
    meta: currentMeta(),
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

// Step 1: idea → brief + script + colored storyboard. Fresh video, so reset
// downstream artifacts so nothing stale is reused.
app.post("/api/run/script", (req, res) => {
  const idea = (req.body?.idea || "").trim();
  if (!idea) return res.status(400).json({ error: "no idea provided" });

  for (const p of ["topics.json", "script.md", "scenes.json", "image_prompts.txt",
    "metadata.json", "metadata.md", "thumbnail_prompts.txt"]) rmrf(join(OUT, p));
  rmrf(join(VIDEO_DIR, "work"));
  const v = finalVideo(); if (v) rmrf(v);
  rmrf(join(VIDEO_DIR, "timeline.json"));
  for (const n of ["thumbnail.jpg", "thumbnail.png"]) rmrf(join(VIDEO_DIR, n));

  const job = runChain([
    { cmd: "node", args: ["src/script.js", `--idea=${idea}`], label: `write script for: "${idea}"` },
  ]);
  res.json({ jobId: job.id });
});

// Step 4: make the video
app.post("/api/run/video", (_req, res) => {
  const job = runChain([{ cmd: KOKORO_PY, args: ["scripts/generate_video.py"], label: "generate video (Kokoro + ffmpeg)" }]);
  res.json({ jobId: job.id });
});

// Step 2 cleanup: remove visible/metadata AI watermarks from generated images.
app.post("/api/run/clean-images", (_req, res) => {
  const job = runChain([{ cmd: KOKORO_PY, args: ["scripts/clean_images.py"], label: "remove image AI watermarks" }]);
  res.json({ jobId: job.id });
});

// Step 5: metadata + thumbnail prompts
app.post("/api/run/metadata", (_req, res) => {
  const job = runChain([{ cmd: "node", args: ["src/metadata.js"], label: "generate metadata + thumbnail prompts (Claude)" }]);
  res.json({ jobId: job.id });
});

// Finish: clear the current video and stop the UI server.
app.post("/api/finish", (_req, res) => {
  try { finishCleanup(); } catch {}
  res.json({ ok: true, stopping: true });
  console.log("\n  Finished — cleared current video. Stopping UI.\n");
  setTimeout(() => process.exit(0), 600);
});

// Step 7: upload to YouTube
app.post("/api/run/upload", (req, res) => {
  const privacy = ["private", "unlisted", "public"].includes(req.body?.privacy) ? req.body.privacy : "private";
  const job = runChain([{ cmd: "node", args: ["src/upload.js", `--privacy=${privacy}`], label: `upload (${privacy})` }]);
  res.json({ jobId: job.id });
});

// Step 3 helper: clear the images folder (for a fresh topic's images)
app.post("/api/images/clear", (_req, res) => {
  if (existsSync(IMAGES_DIR))
    for (const f of readdirSync(IMAGES_DIR)) if (IMG_EXT.test(f)) rmrf(join(IMAGES_DIR, f));
  rmrf(IMAGE_CLEAN_STATE);
  res.json({ count: imageCount() });
});

// Step 6: thumbnail upload (raw image bytes)
app.post("/api/thumbnail", (req, res) => {
  if (!req.body || !req.body.length) return res.status(400).json({ error: "no image data" });
  mkdirSync(VIDEO_DIR, { recursive: true });
  for (const n of ["thumbnail.jpg", "thumbnail.png"]) rmrf(join(VIDEO_DIR, n));
  const isPng = (req.headers["content-type"] || "").includes("png");
  writeFileSync(join(VIDEO_DIR, isPng ? "thumbnail.png" : "thumbnail.jpg"), req.body);
  res.json({ ok: true });
});

// media
app.get("/api/video", (_req, res) => {
  const v = finalVideo();
  if (!v) return res.status(404).end();
  res.sendFile(v);
});
app.get("/api/thumbnail", (_req, res) => {
  const t = thumbPath();
  if (!t) return res.status(404).end();
  res.sendFile(t);
});

app.listen(PORT, () => {
  console.log(`\n  Curiosity Channel UI → http://localhost:${PORT}\n`);
});
