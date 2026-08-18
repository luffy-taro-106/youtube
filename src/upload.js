// YouTube uploader.
//
//   npm run upload -- --check                 # validate everything, upload NOTHING
//   npm run upload                            # upload as PRIVATE (safe default)
//   npm run upload -- --privacy=unlisted
//   npm run upload -- --privacy=public
//   npm run upload -- --file=output/video/x.mp4 --thumbnail=output/video/thumb.jpg
//   npm run upload -- --publishAt=2026-06-20T14:00:00Z   # schedule (stays private until then)
//
// Pulls title/description/tags from output/metadata.json. Sets the thumbnail if
// one is found. Defaults to PRIVATE so nothing goes live by accident.

import { readFileSync, existsSync, readdirSync, createReadStream, statSync } from "node:fs";
import { join, basename } from "node:path";
import { google } from "googleapis";
import { loadEnv, projectRoot } from "./env.js";
import { authorizedClient, findClientSecretFile, TOKEN_PATH } from "./youtube-oauth.js";

loadEnv();

const OUT = join(projectRoot, "output");
const VIDEO_DIR = join(OUT, "video");
const CATEGORY_EDUCATION = "27";

const arg = (name, def = null) => {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.split("=").slice(1).join("=") : def;
};
const flag = (name) => process.argv.includes(`--${name}`);

function pickVideoFile() {
  const override = arg("file");
  if (override) return override.startsWith("/") ? override : join(projectRoot, override);
  const mp4s = existsSync(VIDEO_DIR)
    ? readdirSync(VIDEO_DIR).filter((f) => f.endsWith(".mp4"))
    : [];
  if (mp4s.length === 1) return join(VIDEO_DIR, mp4s[0]);
  if (mp4s.length === 0) throw new Error(`No .mp4 in ${VIDEO_DIR} — render the video first.`);
  throw new Error(`Multiple videos in ${VIDEO_DIR}; pass --file=… (${mp4s.join(", ")})`);
}

function pickThumbnail() {
  const override = arg("thumbnail");
  if (override) return override.startsWith("/") ? override : join(projectRoot, override);
  for (const name of ["thumbnail.jpg", "thumbnail.png", "thumb.jpg", "thumb.png"]) {
    const p = join(VIDEO_DIR, name);
    if (existsSync(p)) return p;
  }
  return null;
}

function loadMetadata() {
  const p = join(OUT, "metadata.json");
  if (!existsSync(p)) throw new Error("output/metadata.json not found — run `npm run metadata` first.");
  const m = JSON.parse(readFileSync(p, "utf8"));
  let title = arg("title") || m.titles?.primary || m.title;
  let description = m.description || "";
  let tags = Array.isArray(m.tags) ? m.tags : [];

  // YouTube limits: title ≤100, description ≤5000, tags total ≤~500 chars.
  if (title.length > 100) title = title.slice(0, 100);
  if (description.length > 5000) description = description.slice(0, 5000);
  let used = 0;
  tags = tags.filter((t) => (used += t.length + 1) <= 480);
  return { title, description, tags };
}

function human(bytes) {
  return bytes > 1e6 ? `${(bytes / 1e6).toFixed(1)} MB` : `${(bytes / 1e3).toFixed(0)} KB`;
}

async function main() {
  const privacy = arg("privacy", "private");
  if (!["private", "unlisted", "public"].includes(privacy)) {
    throw new Error(`--privacy must be private|unlisted|public (got "${privacy}")`);
  }
  const publishAt = arg("publishAt"); // ISO 8601; implies scheduled-private
  const videoFile = pickVideoFile();
  const thumbnail = pickThumbnail();
  const { title, description, tags } = loadMetadata();

  if (!existsSync(videoFile)) throw new Error(`Video not found: ${videoFile}`);

  // ── summary (always shown) ──
  console.log("YouTube upload plan");
  console.log("─".repeat(60));
  console.log(`  client secret : ${(() => { try { return basename(findClientSecretFile()); } catch { return "✗ MISSING"; } })()}`);
  console.log(`  token         : ${existsSync(TOKEN_PATH) ? "present" : "✗ run `npm run yt:auth`"}`);
  console.log(`  video         : ${videoFile} (${human(statSync(videoFile).size)})`);
  console.log(`  thumbnail     : ${thumbnail || "none (set later in Studio)"}`);
  console.log(`  title         : ${title}`);
  console.log(`  tags          : ${tags.length} tags`);
  console.log(`  privacy       : ${privacy}${publishAt ? ` (scheduled ${publishAt})` : ""}`);
  console.log(`  category      : Education (${CATEGORY_EDUCATION})`);
  console.log("─".repeat(60));

  if (flag("check")) {
    console.log("✓ --check: validation only, nothing uploaded.");
    return;
  }

  const auth = authorizedClient();
  const youtube = google.youtube({ version: "v3", auth });

  const status = { privacyStatus: privacy, selfDeclaredMadeForKids: false };
  if (publishAt) {
    status.privacyStatus = "private";   // required: scheduled videos must start private
    status.publishAt = publishAt;
  }

  console.log("\nUploading… (resumable; large files take a few minutes)");
  const res = await youtube.videos.insert(
    {
      part: ["snippet", "status"],
      requestBody: {
        snippet: { title, description, tags, categoryId: CATEGORY_EDUCATION, defaultLanguage: "en" },
        status,
      },
      media: { body: createReadStream(videoFile) },
    },
    {
      // surfaces resumable-upload progress
      onUploadProgress: (e) => {
        const mb = (e.bytesRead / 1e6).toFixed(1);
        process.stdout.write(`\r  uploaded ${mb} MB`);
      },
    }
  );

  const id = res.data.id;
  console.log(`\n✓ Uploaded: https://youtu.be/${id}`);
  console.log(`  Studio:   https://studio.youtube.com/video/${id}/edit`);

  if (thumbnail && existsSync(thumbnail)) {
    process.stdout.write("Setting thumbnail… ");
    await youtube.thumbnails.set({ videoId: id, media: { body: createReadStream(thumbnail) } });
    console.log("done.");
  }

  console.log("\nNote: if your Google Cloud app is still 'Testing'/unverified, YouTube");
  console.log("may keep the video locked to private regardless of --privacy until the");
  console.log("app is verified. Your own channel as a test user can still see it.");
}

main().catch((err) => {
  console.error("\n✗ Upload failed:", err.message);
  process.exit(1);
});
