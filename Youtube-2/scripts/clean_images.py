#!/usr/bin/env python3
"""Clean AI-generation watermarks from generated scene images.

This is a thin workflow wrapper around the remove-ai-watermarks CLI. It is
intended for images generated for this project, stored in Images/zapi-img.
"""

from __future__ import annotations

import hashlib
import json
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

try:
    from tqdm import tqdm
except Exception:  # pragma: no cover
    tqdm = None

PROJECT_ROOT = Path(__file__).resolve().parents[1]
IMAGES_DIR = PROJECT_ROOT / "Images" / "zapi-img"
STATE_FILE = IMAGES_DIR / ".watermark_cleaned.json"
IMAGE_EXTS = {".jpg", ".jpeg", ".png", ".webp"}


def die(message: str, code: int = 1) -> None:
    print(f"\nERROR: {message}", file=sys.stderr)
    sys.exit(code)


def require_tool() -> str:
    exe = shutil.which("remove-ai-watermarks")
    if exe:
        return exe
    die(
        "remove-ai-watermarks was not found on PATH.\n"
        "Install it first, for example:\n"
        "  brew install wiltodelta/tap/remove-ai-watermarks\n"
        "or:\n"
        "  pipx install git+https://github.com/wiltodelta/remove-ai-watermarks.git"
    )


def sha256(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as f:
        for chunk in iter(lambda: f.read(1024 * 1024), b""):
            h.update(chunk)
    return h.hexdigest()


def load_state() -> dict:
    if not STATE_FILE.exists():
        return {"files": {}}
    try:
        return json.loads(STATE_FILE.read_text(encoding="utf-8"))
    except Exception:
        return {"files": {}}


def save_state(state: dict) -> None:
    IMAGES_DIR.mkdir(parents=True, exist_ok=True)
    STATE_FILE.write_text(json.dumps(state, indent=2, sort_keys=True), encoding="utf-8")


def images() -> list[Path]:
    if not IMAGES_DIR.exists():
        return []
    return sorted(p for p in IMAGES_DIR.iterdir() if p.is_file() and p.suffix.lower() in IMAGE_EXTS)


def run(cmd: list[str], ok_codes: set[int] | None = None) -> subprocess.CompletedProcess[str]:
    ok = ok_codes or {0}
    proc = subprocess.run(cmd, cwd=PROJECT_ROOT, capture_output=True, text=True)
    if proc.returncode not in ok:
        joined = " ".join(cmd)
        details = "\n".join(x for x in [proc.stdout.strip(), proc.stderr.strip()] if x)
        raise RuntimeError(f"{joined} failed with exit {proc.returncode}\n{details}")
    return proc


def clean_one(exe: str, src: Path) -> tuple[str, str]:
    before_hash = sha256(src)
    with tempfile.TemporaryDirectory(prefix=".wm-clean-", dir=IMAGES_DIR) as tmpdir:
        tmp = Path(tmpdir) / src.name

        visible = run(
            [exe, "visible", str(src), "-o", str(tmp), "--mark", "auto"],
            ok_codes={0, 2},
        )
        if visible.returncode == 2:
            shutil.copy2(src, tmp)
            visible_status = "no visible mark"
        else:
            if not tmp.exists():
                raise RuntimeError("visible cleaner reported success but wrote no output")
            visible_status = "visible mark removed"

        run([exe, "metadata", str(tmp), "--remove"])
        shutil.move(str(tmp), str(src))

    after_hash = sha256(src)
    changed = "changed" if before_hash != after_hash else "unchanged"
    return visible_status, changed


def main() -> None:
    files = images()
    if not files:
        print(f"No generated images found in {IMAGES_DIR}")
        return

    exe = require_tool()
    state = load_state()
    cleaned = skipped = failed = 0
    iterator = tqdm(
        files,
        desc="Cleaning images",
        unit="img",
        ascii=True,
        dynamic_ncols=False,
        bar_format="{l_bar}{bar}| {n_fmt}/{total_fmt} images [{elapsed}<{remaining}]",
    ) if tqdm else files
    for path in iterator:
        current_hash = sha256(path)
        if state.get("files", {}).get(path.name, {}).get("sha256") == current_hash:
            print(f"SKIP {path.name} already cleaned")
            skipped += 1
            continue

        try:
            visible_status, changed = clean_one(exe, path)
            new_hash = sha256(path)
            state.setdefault("files", {})[path.name] = {
                "sha256": new_hash,
                "size": path.stat().st_size,
            }
            cleaned += 1
            print(f"OK   {path.name} - {visible_status}, metadata stripped ({changed})")
        except Exception as exc:
            failed += 1
            print(f"FAIL {path.name} - {exc}", file=sys.stderr)

        if tqdm:
            iterator.set_postfix(cleaned=cleaned, skipped=skipped, failed=failed)

    save_state(state)
    print(f"\nDone: {cleaned} cleaned, {skipped} skipped, {failed} failed")
    if failed:
        sys.exit(1)


if __name__ == "__main__":
    main()
