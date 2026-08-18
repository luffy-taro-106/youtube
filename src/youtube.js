// YouTube fetcher — for each competitor, pulls recent uploads and keeps
// the ones above the view threshold.
//
// Quota-cheap path (NOT search.list, which costs 100 units/call):
//   1. channels.list?forHandle      → channelId + uploads playlist   (1 unit)
//   2. playlistItems.list            → recent video IDs              (1 unit)
//   3. videos.list?part=statistics   → viewCount per video           (1 unit)
// ≈ 3 units per channel → ~60 units for all 20. Daily quota is 10,000.

import { COMPETITORS } from "../config/competitors.js";
import { envInt } from "./env.js";

const API = "https://www.googleapis.com/youtube/v3";

async function api(path, params) {
  const url = new URL(`${API}/${path}`);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  const res = await fetch(url);
  const data = await res.json();
  if (!res.ok) {
    const reason = data?.error?.errors?.[0]?.reason || res.status;
    const msg = data?.error?.message || "unknown error";
    throw new Error(`${reason}: ${msg}`);
  }
  return data;
}

// Resolve a channel handle (or hard channelId override) to its identity
// and uploads playlist.
async function resolveChannel(comp, apiKey) {
  if (comp.channelId) {
    const data = await api("channels", {
      part: "contentDetails,statistics,snippet",
      id: comp.channelId,
      key: apiKey,
    });
    return shapeChannel(data, comp);
  }
  const handle = comp.handle.startsWith("@") ? comp.handle.slice(1) : comp.handle;
  const data = await api("channels", {
    part: "contentDetails,statistics,snippet",
    forHandle: handle,
    key: apiKey,
  });
  return shapeChannel(data, comp);
}

function shapeChannel(data, comp) {
  const ch = data.items?.[0];
  if (!ch) throw new Error(`handle "${comp.handle}" did not resolve`);
  return {
    channelId: ch.id,
    title: ch.snippet?.title ?? comp.name,
    subscribers: Number(ch.statistics?.subscriberCount ?? 0),
    uploadsPlaylist: ch.contentDetails?.relatedPlaylists?.uploads,
  };
}

async function recentVideoIds(playlistId, apiKey, lookbackDays) {
  const cutoff = Date.now() - lookbackDays * 86400e3;
  const ids = [];
  let pageToken = "";

  // Walk pages until we pass the lookback window (uploads are newest-first).
  for (let page = 0; page < 4; page++) {
    const data = await api("playlistItems", {
      part: "contentDetails",
      playlistId,
      maxResults: "50",
      ...(pageToken ? { pageToken } : {}),
      key: apiKey,
    });
    let allOld = true;
    for (const it of data.items ?? []) {
      const published = new Date(it.contentDetails?.videoPublishedAt ?? 0).getTime();
      if (published >= cutoff) {
        ids.push(it.contentDetails.videoId);
        allOld = false;
      }
    }
    pageToken = data.nextPageToken;
    if (!pageToken || allOld) break;
  }
  return ids;
}

async function videoStats(videoIds, apiKey) {
  const out = [];
  // videos.list accepts up to 50 IDs per call.
  for (let i = 0; i < videoIds.length; i += 50) {
    const batch = videoIds.slice(i, i + 50);
    const data = await api("videos", {
      part: "snippet,statistics,contentDetails",
      id: batch.join(","),
      key: apiKey,
    });
    for (const v of data.items ?? []) {
      out.push({
        videoId: v.id,
        title: v.snippet?.title,
        publishedAt: v.snippet?.publishedAt,
        views: Number(v.statistics?.viewCount ?? 0),
        likes: Number(v.statistics?.likeCount ?? 0),
        comments: Number(v.statistics?.commentCount ?? 0),
        duration: v.contentDetails?.duration, // ISO 8601, e.g. PT12M3S
        url: `https://www.youtube.com/watch?v=${v.id}`,
      });
    }
  }
  return out;
}

export async function fetchCompetitorVideos() {
  const apiKey = process.env.YOUTUBE_API_KEY;
  if (!apiKey) throw new Error("YOUTUBE_API_KEY is not set (see .env.example)");

  const lookbackDays = envInt("VIDEO_LOOKBACK_DAYS", 60);
  const minViews = envInt("VIDEO_MIN_VIEWS", 20000);
  const perChannel = envInt("VIDEO_PER_CHANNEL", 8);

  const channels = [];
  const unresolved = [];
  let totalVideos = 0;

  for (const comp of COMPETITORS) {
    try {
      const ch = await resolveChannel(comp, apiKey);
      if (!ch.uploadsPlaylist) throw new Error("no uploads playlist");

      const ids = await recentVideoIds(ch.uploadsPlaylist, apiKey, lookbackDays);
      const stats = await videoStats(ids, apiKey);

      const videos = stats
        .filter((v) => v.views >= minViews)
        .sort((a, b) => b.views - a.views)
        .slice(0, perChannel);

      channels.push({
        name: comp.name,
        tier: comp.tier,
        pillars: comp.pillars,
        channelId: ch.channelId,
        subscribers: ch.subscribers,
        videos,
      });
      totalVideos += videos.length;
      console.log(
        `  yt   · ${comp.name.padEnd(28)} ${String(videos.length).padStart(2)} vids ≥${minViews / 1000}k  (of ${stats.length} recent)`
      );
    } catch (err) {
      unresolved.push({ name: comp.name, handle: comp.handle, error: err.message });
      console.warn(`  yt   · ${comp.name.padEnd(28)} FAILED — ${err.message}`);
    }
  }

  return { totalVideos, channels, unresolved, lookbackDays, minViews };
}
