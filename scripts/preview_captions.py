#!/usr/bin/env python3
"""Render the same caption in several styles onto a real scene image, so we can
pick the channel's caption look. Outputs PNGs to output/video/_caption_previews/.
"""
from pathlib import Path
from PIL import Image, ImageDraw, ImageFont

ROOT = Path(__file__).resolve().parents[1]
FONTS = ROOT / "assets" / "fonts"
IMG = ROOT / "Images" / "zapi-img" / "02_Simple_hand-drawn_stickma.jpg"
OUT = ROOT / "output" / "video" / "_caption_previews"
OUT.mkdir(parents=True, exist_ok=True)
W, H = 1920, 1080

RED = (240, 58, 48)
GREEN = (38, 188, 92)
AMBER = (255, 188, 40)
WHITE = (255, 255, 255)
INK = (24, 24, 24)
NAVY = (18, 26, 42)


def base():
    """Scene image cropped to 1920x1080."""
    im = Image.open(IMG).convert("RGB")
    scale = max(W / im.width, H / im.height)
    im = im.resize((round(im.width * scale), round(im.height * scale)))
    x = (im.width - W) // 2
    y = (im.height - H) // 2
    return im.crop((x, y, x + W, y + H)).convert("RGBA")


def fit_font(path, text, target_w, start=150):
    for size in range(start, 40, -2):
        f = ImageFont.truetype(str(path), size)
        if ImageFont.truetype(str(path), size).getlength(text) <= target_w:
            return f
    return ImageFont.truetype(str(path), 44)


def centered(draw, text, font, y, fill, stroke=0, stroke_fill=(0, 0, 0)):
    w = font.getlength(text)
    draw.text(((W - w) / 2, y), text, font=font, fill=fill,
              stroke_width=stroke, stroke_fill=stroke_fill)


def style_scrim(text, accent, font_path, name):
    """White text + accent number on a soft bottom gradient scrim. Font: Anton."""
    im = base()
    scrim = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    sd = ImageDraw.Draw(scrim)
    for i in range(360):
        a = int(190 * (i / 360) ** 1.6)
        sd.line([(0, H - 360 + i), (W, H - 360 + i)], fill=(0, 0, 0, a))
    im = Image.alpha_composite(im, scrim)
    d = ImageDraw.Draw(im)
    font = fit_font(font_path, text, W - 240, 140)
    bbox = font.getbbox(text)
    centered(d, text, font, H - (bbox[3] - bbox[1]) - 120, accent, stroke=6)
    im.convert("RGB").save(OUT / f"{name}.jpg", quality=92)


def style_pill(text, accent, font_path, name):
    """Rounded dark pill, white text, accent kept for emphasis. Font: Bebas."""
    im = base()
    d = ImageDraw.Draw(im)
    font = fit_font(font_path, text, W - 360, 150)
    tw = font.getlength(text)
    bbox = font.getbbox(text)
    th = bbox[3] - bbox[1]
    pad_x, pad_y = 60, 36
    pill_w, pill_h = tw + pad_x * 2, th + pad_y * 2
    px = (W - pill_w) / 2
    py = H - pill_h - 90
    d.rounded_rectangle([px, py, px + pill_w, py + pill_h], radius=pill_h / 2,
                        fill=(*NAVY, 235))
    d.text(((W - tw) / 2, py + pad_y - bbox[1]), text, font=font, fill=accent)
    im.convert("RGB").save(OUT / f"{name}.jpg", quality=92)


def style_bar(text, accent, font_path, name):
    """Full-width solid bottom bar with a thin accent top edge. Font: Archivo."""
    im = base()
    d = ImageDraw.Draw(im)
    font = fit_font(font_path, text, W - 200, 110)
    bbox = font.getbbox(text)
    th = bbox[3] - bbox[1]
    bar_h = th + 96
    by = H - bar_h
    d.rectangle([0, by, W, H], fill=(*INK, 240))
    d.rectangle([0, by, W, by + 8], fill=accent)
    centered(d, text, font, by + (bar_h - th) / 2 - bbox[1], WHITE)
    im.convert("RGB").save(OUT / f"{name}.jpg", quality=92)


def style_outline(text, accent, font_path, name):
    """Bold accent-colored text with thick white outline + shadow, no plate. Font: Anton."""
    im = base()
    d = ImageDraw.Draw(im)
    font = fit_font(font_path, text, W - 240, 150)
    bbox = font.getbbox(text)
    th = bbox[3] - bbox[1]
    y = H - th - 130
    w = font.getlength(text)
    x = (W - w) / 2
    d.text((x + 6, y + 6), text, font=font, fill=(0, 0, 0, 120),
           stroke_width=14, stroke_fill=(0, 0, 0, 120))  # shadow
    d.text((x, y), text, font=font, fill=accent,
           stroke_width=12, stroke_fill=WHITE)            # white halo
    im.convert("RGB").save(OUT / f"{name}.jpg", quality=92)


# Red example (alarm) + a green example to check color logic.
style_scrim("$390,000 GONE", RED, FONTS / "Anton.ttf", "1_scrim_anton_red")
style_pill("$390,000 GONE", WHITE, FONTS / "BebasNeue.ttf", "2_pill_bebas")
style_bar("$390,000 GONE", RED, FONTS / "ArchivoBlack.ttf", "3_bar_archivo_red")
style_outline("$390,000 GONE", RED, FONTS / "Anton.ttf", "4_outline_anton_red")
style_scrim("$108,000 TAX-FREE", GREEN, FONTS / "Anton.ttf", "5_scrim_anton_green")
style_outline("SAFE WORD", GREEN, FONTS / "Anton.ttf", "6_outline_anton_green")

print("wrote previews to", OUT)
for p in sorted(OUT.glob("*.jpg")):
    print(" ", p.name)
