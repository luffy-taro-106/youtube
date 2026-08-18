# Curiosity Channel — idea-first content pipeline

A faceless YouTube pipeline for the **colored stick-figure / hidden-science**
lane (the "a thing you do every day is secretly an ancient or scientific truth"
formula). Same machinery as the Founder Finance project in the parent folder,
but **it starts from a single idea** instead of a news/trends fetch — and the
animation uses **color** as a storytelling device.

## The flow

```
IDEA  →  script agent  →  images (manual)  →  video render  →  metadata  →  upload
```

1. **Script agent** (`npm run script`) — the entry point. Give it one idea; it:
   - **Stage 0** expands the idea into a structured brief using the channel
     identity in [`config/channel.js`](config/channel.js) (title, hook, the
     everyday thing, the hidden truth, story beats, honest caveats, the closing
     open question) → `output/topics.json`.
   - **Stage 1** writes the full 7–8 min voiceover script → `output/script.md`.
   - **Stage 2** storyboards it into **colored doodle scenes** → `output/scenes.json`
     (each scene gets a background color + image prompt + overlay + Ken Burns + mood).
2. **Images** — paste `output/scenes.json` image prompts into your image model
   (Flow / Gemini), name each file with its leading scene number
   (`07_*.jpg` → scene 7), and drop them in `Images/zapi-img/`.
3. **Video render** (`scripts/generate_video.py`) — Kokoro TTS + ffmpeg: the
   real narration length drives each scene's screen time, Ken Burns motion,
   burned-in captions, concatenated to one MP4 → `output/video/<slug>.mp4`.
4. **Metadata** (`npm run metadata`) — 3 concrete thumbnail prompts, 5 titles,
   SEO description + chapters + tags + pinned comment → `output/metadata.*`.
5. **Upload** (`npm run yt:auth` once, then `npm run upload`) — OAuth upload to
   this channel (private by default).

## What's different from the finance channel

| | Finance | This channel |
|---|---|---|
| **Entry** | news + trends + competitor fetch → topic engine | **one idea string** |
| **Look** | black ink on off-white, minimal accent | **colored doodles; background color carries emotion** |
| **Color** | caption tint only | navy = night/ancient · white = explanation · black = drama · warm = light/day; **red = emphasis only** |
| **Script** | implementation-first money playbook, 10–12 min | narrative science, "you" as subject, 7–8 min |
| **Audience** | 40–65 with assets | broad, curious, mobile-first |
| **Thumbnail rule** | free style | **concrete: face/body/problem, on-brand doodle** |

The color system lives in [`config/style.js`](config/style.js): `BG_PALETTE`
(the four background colors and what each means) and `ACCENT_NOTE` (red is the
emphasis tool, never a background). Edit it once and every video's look changes.

## Setup

```bash
cp .env.example .env     # ANTHROPIC_API_KEY is pre-filled from the parent .env
```

No `npm install` needed — `@anthropic-ai/sdk` and `googleapis` resolve from the
parent project's `node_modules`. (Run `npm install` here only if you move this
folder out.)

The video step needs the Kokoro venv (Python < 3.13), `ffmpeg`, and Pillow —
same as the parent project.

Optional cleanup tool used by the UI image-clean button:

```bash
brew install wiltodelta/tap/remove-ai-watermarks
```

## Usage

```bash
# 1. Script + storyboard from an idea
npm run script -- --idea="What did ancient humans do at night?"
npm run script -- --idea-file=ideas/my-idea.txt
npm run script                       # falls back to ideas/idea.txt

# 2. (generate images on Flow/Gemini → Images/zapi-img/, named 01_*.jpg, 02_*.jpg, …)

# 3. Render the video (Kokoro venv)
~/.venv/kokoro-py312/bin/python scripts/generate_video.py
~/.venv/kokoro-py312/bin/python scripts/generate_video.py --limit 3   # quick test

# 4. Packaging
npm run metadata

# 5. Publish
npm run yt:auth                      # one-time consent (saves .youtube-token.json)
npm run upload -- --check            # validate, upload nothing
npm run upload                       # private by default
npm run upload -- --privacy=public
```

## The UI (`npm run ui`)

A local web studio ("Curiosity Studio") that wires the whole pipeline into
clickable steps — same idea as the finance studio, themed to this channel and
**idea-first**:

```bash
./scripts/ui.sh start     # launch + open in browser  → http://localhost:4100
./scripts/ui.sh stop
./scripts/ui.sh restart
# or just: npm run ui
```

A vertical stepper where each card unlocks when the previous one is ready:

1. **Start a new video** — type one idea; runs the script agent (brief + script
   + colored storyboard). The developed title + series show up as a chip.
2. **Generate images** — view the prompt file (each block shows its background
   color), generate on Flow / Gemini / Nano Banana 2, drop into
   `Images/zapi-img`, then click **Remove image watermark** to run the visible
   mark + metadata cleanup.
3. **Make the video** — runs the Kokoro + ffmpeg render; preview it inline.
4. **Metadata & thumbnail prompts** — SEO metadata + 3 Gemini prompts.
5. **Upload thumbnail** — upload the image you made in Gemini.
6. **Publish** — pick privacy and upload to YouTube; shows the resulting link.

**Finish & clear** wipes the current video's files and stops the studio, keeping
your login, configs, and fonts. Progress is file-backed — completed steps
re-light from disk when you reopen the UI. Runs on port **4100** (the finance
studio uses 4000, so both can run at once). The server (`ui/server.js`) just
shells out to the same CLI steps, so anything the UI does you can also do by hand.

## Tuning

- **Channel identity / strategy** → [`config/channel.js`](config/channel.js)
- **Colors, doodle style, Ken Burns moves, pacing** → [`config/style.js`](config/style.js)
- **Narrator voice** → `VOICE` near the top of `scripts/generate_video.py`
  (default `am_michael`; the parent project's kokoro notebook lists options).
- **Outro** → drop an `assets/outro.mp4`; it's appended with a spoken CTA, or
  skipped cleanly if absent. Edit `OUTRO_NARRATION` in the render script.

## Credentials in this folder

- `client_secret_*.json` — this channel's Google OAuth client (redirect
  `localhost:5858`). Auto-discovered by the auth/upload scripts.
- `.env` — `ANTHROPIC_API_KEY` (+ `OAUTH_PORT`).
- `.youtube-token.json` — written by `npm run yt:auth` (git-ignored).
