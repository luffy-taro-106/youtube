#!/usr/bin/env python3
"""Generate the final video from storyboard scenes + stick-man images.

Pipeline (per scene):
  1. Synthesize the narration with Kokoro TTS (voice am_liam) -> a WAV whose
     REAL length defines how long the scene's image is on screen. This is more
     reliable than the estimated start/end stamps in scenes.json.
  2. Render a clip with ffmpeg: the matching image, a Ken Burns move
     (zoom-in / zoom-out / pan-left / pan-right from the scene), the scene's
     text overlay burned in, and the scene's audio muxed to it.
  3. Concatenate every scene clip into the final MP4.

Images are matched to scenes by the leading number in the filename
(e.g. "07_Simple_hand-drawn_stickma.jpg" -> scene id 7). Scenes without a
matching image are skipped (with a warning) so audio/video stay in sync —
perfect for the current 50-image trial.

Run it with the Kokoro venv's Python (Kokoro needs Python < 3.13):
  ~/.venv/kokoro-py312/bin/python scripts/generate_video.py
  ~/.venv/kokoro-py312/bin/python scripts/generate_video.py --limit 3   # quick test
"""

from __future__ import annotations

import argparse
import json
import re
import shutil
import subprocess
import sys
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parents[1]
SCENES_JSON = PROJECT_ROOT / "output" / "scenes.json"
IMAGES_DIR = PROJECT_ROOT / "Images" / "zapi-img"
OUT_DIR = PROJECT_ROOT / "output" / "video"
WORK_DIR = OUT_DIR / "work"
AUDIO_DIR = WORK_DIR / "audio"
CLIPS_DIR = WORK_DIR / "clips"

# Voice / render settings
VOICE = "am_eric"
SPEED = 1.0
TTS_SR = 24000          # Kokoro native sample rate
FPS = 30
WIDTH, HEIGHT = 1920, 1080
FONT_SRC = str(PROJECT_ROOT / "assets" / "fonts" / "Anton.ttf")

IMAGE_EXTS = {".jpg", ".jpeg", ".png", ".webp"}

# ── Outro: appended after the last scene. The existing outro video is used
# as-is (last frame frozen to fit), with a spoken CTA mixed over its audio.
OUTRO_VIDEO = PROJECT_ROOT / "Images" / "outro.mp4"
OUTRO_NARRATION = (
    "If this helped, do two quick things for me. Hit subscribe, so the next "
    "one finds you. And share it with one person you care about. It costs you "
    "nothing, and it might save them a very expensive mistake. I'll see you in "
    "the next one."
)

# ── Ken Burns: constant visual SPEED across scenes (not a fixed per-scene
# total). Zoom/pan distance scales with duration, then clamps — so a 3s punch
# and an 11s beat drift at the same rate instead of one whip-zooming.
ZOOM_RATE = 0.018       # fraction of zoom added per second
ZOOM_MIN, ZOOM_MAX = 0.05, 0.22
PAN_ZOOM = 1.16         # constant zoom while panning (gives travel room)
PAN_REF = 8.0           # seconds for a full pan sweep; shorter = partial sweep
KEN_BURNS = False       # False = static frames (no zoom/pan); True = restore Ken Burns motion

# ── Caption colors driven by the scene's `mood`. Red = loss/danger,
# green = safety/gain, amber = attention, white = neutral.
CAPTION_FILL = {
    "red": (240, 58, 48),
    "green": (38, 188, 92),
    "amber": (255, 184, 36),
    "white": (245, 245, 245),
}
MOOD_RED = {
    "alarm", "dread", "menace", "panic", "fear", "loss-of-control", "loss",
    "warning", "urgency", "pressure", "unsettling", "suspicion", "deception",
    "vulnerability", "unease", "finality", "gravity", "sobering",
    "false-comfort", "distrust",
}
MOOD_GREEN = {
    "reassurance", "relief", "hope", "control", "empowerment", "proactive",
    "security", "protective", "confidence", "triumph", "pride", "motivation",
    "resolve", "determination", "decisive", "firmness", "vigilance", "calm",
}
MOOD_AMBER = {
    "caution", "curiosity", "revelation", "insight", "debunking", "engagement",
    "lighthearted", "analytical", "practical", "clarity", "anticipation",
}


def mood_color(mood: str):
    m = (mood or "").strip().lower()
    if m in MOOD_RED:
        return CAPTION_FILL["red"]
    if m in MOOD_GREEN:
        return CAPTION_FILL["green"]
    if m in MOOD_AMBER:
        return CAPTION_FILL["amber"]
    return CAPTION_FILL["white"]


# ── helpers ──────────────────────────────────────────────────────────────────

def die(msg: str) -> None:
    print(f"\n✗ {msg}", file=sys.stderr)
    sys.exit(1)


def find_ffmpeg() -> str:
    exe = shutil.which("ffmpeg")
    if not exe:
        die("ffmpeg not found on PATH. Install it: brew install ffmpeg")
    return exe


def load_scenes() -> list[dict]:
    if not SCENES_JSON.exists():
        die(f"{SCENES_JSON} not found — run the script step first.")
    data = json.loads(SCENES_JSON.read_text(encoding="utf-8"))
    scenes = data.get("scenes") if isinstance(data, dict) else data
    if not isinstance(scenes, list) or not scenes:
        die("scenes.json has no scenes array.")
    return scenes


def build_image_map() -> dict[int, Path]:
    """Map scene id -> image path via the leading number in the filename."""
    if not IMAGES_DIR.exists():
        die(f"Images dir not found: {IMAGES_DIR}")
    mapping: dict[int, Path] = {}
    for p in sorted(IMAGES_DIR.iterdir()):
        if p.suffix.lower() not in IMAGE_EXTS:
            continue
        m = re.match(r"0*(\d+)", p.name)
        if not m:
            continue
        sid = int(m.group(1))
        # First sorted match wins (handles duplicate variants like 54_*_1..4).
        mapping.setdefault(sid, p)
    return mapping


def slugify(text: str) -> str:
    text = re.sub(r"[^\w\s-]", "", text).strip().lower()
    return re.sub(r"[\s_-]+", "-", text)[:60] or "video"


# ── Kokoro TTS ───────────────────────────────────────────────────────────────

def make_synth():
    """Return a function text -> (wav_float32, sample_rate). Loads Kokoro once."""
    try:
        from kokoro import KPipeline
        import soundfile as sf  # noqa: F401 (used by caller)
        import numpy as np
    except Exception as e:  # pragma: no cover
        die(
            "Could not import Kokoro. Run this script with the Kokoro venv:\n"
            "  ~/.venv/kokoro-py312/bin/python scripts/generate_video.py\n"
            f"  (import error: {e})"
        )

    print(f"Loading Kokoro pipeline (voice {VOICE})…")
    pipeline = KPipeline(lang_code="a")  # American English

    def synth(text: str):
        gen = pipeline(text, voice=VOICE, speed=SPEED, split_pattern=r"\n+")
        parts = [audio for _, _, audio in gen]
        if not parts:
            return None
        audio = parts[0] if len(parts) == 1 else np.concatenate(parts)
        return audio

    return synth


def ensure_audio(synth, scene: dict, path: Path, force: bool) -> float:
    """Synthesize (or reuse) the scene audio; return its duration in seconds."""
    import soundfile as sf

    if path.exists() and not force:
        info = sf.info(str(path))
        return info.frames / info.samplerate

    text = (scene.get("narration") or "").strip()
    audio = synth(text) if text else None
    if audio is None:
        # Fallback: ~0.4s of silence so the pipeline never breaks on an empty beat.
        import numpy as np
        audio = np.zeros(int(TTS_SR * 0.4), dtype="float32")

    sf.write(str(path), audio, TTS_SR)
    return len(audio) / TTS_SR


# ── ffmpeg per-scene render ──────────────────────────────────────────────────

def ken_burns_filter(move: str, frames: int, dur: float) -> str:
    """Build the zoompan expression for a Ken Burns move.

    Motion distance scales with `dur` so every scene moves at the same visual
    speed, and an ease-in-out (smoothstep) softens the start/stop so it never
    feels mechanical. The image is pre-scaled to 3840x2160 to kill the
    well-known single-image zoom jitter.
    """
    f = max(frames, 1)
    p = f"(on/{f})"                       # linear progress 0..1
    smooth = f"({p}*{p}*(3-2*{p}))"       # smoothstep ease-in-out
    center_x = "(iw/2-(iw/zoom/2))"
    center_y = "(ih/2-(ih/zoom/2))"

    total = min(ZOOM_MAX, max(ZOOM_MIN, ZOOM_RATE * dur))

    if not KEN_BURNS or move == "static":
        # No movement; a tiny constant zoom (1.001) avoids zoompan edge jitter.
        z, x, y = "1.001", center_x, center_y
    elif move == "zoom-out":
        z = f"{1+total:.4f}-{total:.4f}*{smooth}"
        x, y = center_x, center_y
    elif move in ("pan-left", "pan-right"):
        frac = min(1.0, max(0.35, dur / PAN_REF))   # sweep fraction
        sweep = f"{frac:.3f}*(2*{smooth}-1)"        # symmetric -frac..+frac
        sign = "+" if move == "pan-right" else "-"
        z = f"{PAN_ZOOM}"
        x = f"(iw-iw/zoom)/2*(1{sign}({sweep}))"
        y = "(ih-ih/zoom)/2"
    else:  # zoom-in (default)
        z = f"1+{total:.4f}*{smooth}"
        x, y = center_x, center_y

    pre = (
        f"scale={WIDTH}:{HEIGHT}:force_original_aspect_ratio=increase,"
        f"crop={WIDTH}:{HEIGHT},setsar=1,scale=3840:2160"
    )
    zp = (
        f"zoompan=z='{z}':x='{x}':y='{y}':"
        f"d={f}:s={WIDTH}x{HEIGHT}:fps={FPS}"
    )
    return f"{pre},{zp}"


def _wrap_to_width(text: str, font_path: Path, size: int, max_w: int):
    """Greedy word-wrap so each line fits max_w at the given size. Max 2 lines."""
    from PIL import ImageFont
    f = ImageFont.truetype(str(font_path), size)
    words, lines, cur = text.split(), [], ""
    for w in words:
        trial = f"{cur} {w}".strip()
        if cur and f.getlength(trial) > max_w:
            lines.append(cur)
            cur = w
        else:
            cur = trial
    if cur:
        lines.append(cur)
    return lines


def render_overlay_png(text: str, color, font: Path, out_png: Path) -> None:
    """Outline-style caption as a transparent 1920x1080 PNG (Pillow).

    Anton, uppercase, mood-colored fill with a thick BLACK outline + soft drop
    shadow and NO plate — the black border keeps it legible even on the white /
    off-white art, while leaving the drawing visible. Composited as a static
    layer over the Ken Burns motion.
    """
    from PIL import Image, ImageDraw, ImageFont

    text = text.upper()
    max_w = WIDTH - 220

    # Pick the largest size that fits in <=2 lines.
    size = 150
    while size > 70:
        lines = _wrap_to_width(text, font, size, max_w)
        if len(lines) <= 2 and all(
            ImageFont.truetype(str(font), size).getlength(ln) <= max_w for ln in lines
        ):
            break
        size -= 4
    pil_font = ImageFont.truetype(str(font), size)
    lines = _wrap_to_width(text, font, size, max_w)

    stroke = max(9, size // 7)            # black outline thickness
    ascent, descent = pil_font.getmetrics()
    line_h = ascent + descent + 12
    block_h = line_h * len(lines)
    y0 = HEIGHT - block_h - 110

    img = Image.new("RGBA", (WIDTH, HEIGHT), (0, 0, 0, 0))
    draw = ImageDraw.Draw(img)
    for i, ln in enumerate(lines):
        w = pil_font.getlength(ln)
        x = (WIDTH - w) / 2
        y = y0 + i * line_h
        # faint drop shadow for depth
        draw.text((x + 4, y + 5), ln, font=pil_font, fill=(0, 0, 0, 80))
        # mood-colored fill with a solid BLACK outline (legible on white or dark)
        draw.text((x, y), ln, font=pil_font, fill=(*color, 255),
                  stroke_width=stroke, stroke_fill=(0, 0, 0, 255))

    img.save(out_png)


def render_scene(ffmpeg: str, img: Path, wav: Path, dur: float, scene: dict,
                 font: Path, out: Path, force: bool) -> None:
    if out.exists() and not force:
        return
    frames = max(1, round(dur * FPS))
    kb = ken_burns_filter(scene.get("kenBurns", "zoom-in"), frames, dur)
    overlay = (scene.get("textOverlay") or "").strip()

    cmd = [ffmpeg, "-y", "-loop", "1", "-framerate", str(FPS), "-i", str(img)]

    if overlay:
        png = out.with_suffix(".png")
        render_overlay_png(overlay, mood_color(scene.get("mood", "")), font, png)
        cmd += ["-i", str(png), "-i", str(wav),
                "-filter_complex",
                f"[0:v]{kb}[bg];[bg][1:v]overlay=0:0:format=auto[v]",
                "-map", "[v]", "-map", "2:a:0"]
    else:
        cmd += ["-i", str(wav), "-vf", kb, "-map", "0:v:0", "-map", "1:a:0"]

    cmd += [
        "-t", f"{dur:.3f}",
        "-c:v", "libx264", "-preset", "veryfast", "-crf", "20",
        "-pix_fmt", "yuv420p", "-r", str(FPS),
        "-c:a", "aac", "-b:a", "192k", "-ar", "44100", "-ac", "2",
        "-shortest",
        str(out),
    ]
    subprocess.run(cmd, check=True, capture_output=True, text=True)


def probe_duration(path: Path) -> float:
    out = subprocess.run(
        ["ffprobe", "-v", "error", "-show_entries", "format=duration",
         "-of", "default=noprint_wrappers=1:nokey=1", str(path)],
        check=True, capture_output=True, text=True,
    )
    return float(out.stdout.strip())


def build_outro_clip(ffmpeg: str, synth, out: Path, force: bool) -> Path | None:
    """Normalize the outro video to scene specs, freeze its last frame to fit
    the CTA narration, and mix the narration over its existing audio."""
    if not OUTRO_VIDEO.exists():
        print(f"  (no outro video at {OUTRO_VIDEO} — skipping outro)")
        return None

    import soundfile as sf
    narr = AUDIO_DIR / "outro.wav"
    if force or not narr.exists():
        audio = synth(OUTRO_NARRATION)
        sf.write(str(narr), audio, TTS_SR)
    n_dur = sf.info(str(narr)).frames / sf.info(str(narr)).samplerate
    v_dur = probe_duration(OUTRO_VIDEO)
    total = max(v_dur, n_dur) + 0.5
    pad_v = max(0.0, total - v_dur)

    if out.exists() and not force:
        return out

    fc = (
        f"[0:v]scale={WIDTH}:{HEIGHT}:force_original_aspect_ratio=decrease,"
        f"pad={WIDTH}:{HEIGHT}:(ow-iw)/2:(oh-ih)/2,setsar=1,"
        f"tpad=stop_mode=clone:stop_duration={pad_v:.3f}[v];"
        f"[0:a]volume=0.25,apad[oa];"
        f"[1:a]adelay=400|400,volume=1.0[na];"
        f"[oa][na]amix=inputs=2:duration=longest:dropout_transition=0[a]"
    )
    cmd = [
        ffmpeg, "-y", "-i", str(OUTRO_VIDEO), "-i", str(narr),
        "-filter_complex", fc,
        "-map", "[v]", "-map", "[a]", "-t", f"{total:.3f}",
        "-c:v", "libx264", "-preset", "veryfast", "-crf", "20",
        "-pix_fmt", "yuv420p", "-r", str(FPS),
        "-c:a", "aac", "-b:a", "192k", "-ar", "44100", "-ac", "2",
        str(out),
    ]
    subprocess.run(cmd, check=True, capture_output=True, text=True)
    return out


def concat(ffmpeg: str, clips: list[Path], final: Path) -> None:
    listfile = WORK_DIR / "concat_list.txt"
    listfile.write_text(
        "".join(f"file '{c.resolve()}'\n" for c in clips), encoding="utf-8"
    )
    cmd = [
        ffmpeg, "-y", "-f", "concat", "-safe", "0", "-i", str(listfile),
        "-c", "copy", "-movflags", "+faststart", str(final),
    ]
    subprocess.run(cmd, check=True, capture_output=True, text=True)


# ── main ─────────────────────────────────────────────────────────────────────

def main() -> None:
    ap = argparse.ArgumentParser(description="Assemble the storyboard into a video.")
    ap.add_argument("--limit", type=int, default=0,
                    help="Render at most N scenes (0 = all that have images).")
    ap.add_argument("--force", action="store_true",
                    help="Re-synthesize audio and re-render clips even if cached.")
    ap.add_argument("--no-audio-cache", action="store_true",
                    help="Alias of --force for the audio step only.")
    ap.add_argument("--no-outro", action="store_true",
                    help="Skip appending the outro clip.")
    args = ap.parse_args()

    scenes = load_scenes()
    images = build_image_map()
    print(f"{len(scenes)} scenes in storyboard · {len(images)} images found")

    for d in (OUT_DIR, WORK_DIR, AUDIO_DIR, CLIPS_DIR):
        d.mkdir(parents=True, exist_ok=True)

    # Pick the scenes we can actually render (have an image), in order.
    todo = [s for s in scenes if s.get("id") in images]
    skipped = [s.get("id") for s in scenes if s.get("id") not in images]
    if args.limit > 0:
        todo = todo[: args.limit]
    if not todo:
        die("No scenes have a matching image — nothing to render.")
    print(f"Rendering {len(todo)} scenes"
          + (f" (skipping {len(skipped)} with no image: {skipped})" if skipped else ""))

    synth = make_synth()
    ffmpeg = find_ffmpeg()
    font = Path(FONT_SRC)
    if not font.exists():
        die(f"Font not found: {FONT_SRC}")

    clips: list[Path] = []
    timeline: list[dict] = []
    total = 0.0
    force_audio = args.force or args.no_audio_cache
    for i, scene in enumerate(todo, start=1):
        sid = scene["id"]
        img = images[sid]
        wav = AUDIO_DIR / f"scene_{sid:03d}.wav"
        clip = CLIPS_DIR / f"scene_{sid:03d}.mp4"

        dur = ensure_audio(synth, scene, wav, force_audio)
        render_scene(ffmpeg, img, wav, dur, scene, font, clip, args.force)
        clips.append(clip)
        timeline.append({"id": sid, "start": round(total, 2),
                         "end": round(total + dur, 2),
                         "narration": scene.get("narration", "")})
        total += dur
        ov = (scene.get("textOverlay") or "").strip()
        print(f"  [{i:>2}/{len(todo)}] scene {sid:>2}  {dur:5.1f}s  "
              f"{scene.get('kenBurns','zoom-in'):<9}"
              f"{'  «' + ov + '»' if ov else ''}")

    if not args.no_outro:
        print("Building outro (CTA narration over outro video)…")
        outro = build_outro_clip(ffmpeg, synth, CLIPS_DIR / "zz_outro.mp4", args.force)
        if outro:
            clips.append(outro)
            print(f"  outro appended ({probe_duration(outro):.1f}s)")

    title = "founder-finance"
    try:
        title = slugify(json.loads(SCENES_JSON.read_text())["title"])
    except Exception:
        pass
    final = OUT_DIR / f"{title}.mp4"

    # Persist the real timeline (Kokoro durations) for accurate chapters later.
    (OUT_DIR / "timeline.json").write_text(
        json.dumps({"title": json.loads(SCENES_JSON.read_text()).get("title", ""),
                    "contentDurationSec": round(total, 2),
                    "scenes": timeline}, indent=2),
        encoding="utf-8",
    )

    print(f"\nConcatenating {len(clips)} clips → {final.name} …")
    concat(ffmpeg, clips, final)

    mins = int(total // 60)
    secs = int(total % 60)
    print(f"\n✓ Done — {len(clips)} scenes, ~{mins}:{secs:02d} runtime")
    print(f"  → {final}")


if __name__ == "__main__":
    try:
        main()
    except subprocess.CalledProcessError as e:
        sys.stderr.write((e.stderr or "")[-2000:] + "\n")
        die(f"ffmpeg failed (exit {e.returncode}).")
