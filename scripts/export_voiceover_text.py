#!/usr/bin/env python3
"""Export voiceover narration from storyboard JSON to a plain text file.

Default input:
  output/scenes.json

Default output:
  output/voiceover_narration.txt

Default chunks:
  output/voiceover_chunks/voiceover_part_01.txt
"""

from __future__ import annotations

import argparse
import json
import re
from pathlib import Path
from typing import Any


PROJECT_ROOT = Path(__file__).resolve().parents[1]
DEFAULT_INPUT = PROJECT_ROOT / "output" / "scenes.json"
DEFAULT_OUTPUT = PROJECT_ROOT / "output" / "voiceover_narration.txt"
DEFAULT_CHUNKS_DIR = PROJECT_ROOT / "output" / "voiceover_chunks"
DEFAULT_MAX_CHARS = 5000


def compact_text(text: str) -> str:
    return re.sub(r"\s+", " ", text).strip()


def load_narration_parts(path: Path) -> list[str]:
    with path.open("r", encoding="utf-8") as f:
        data = json.load(f)

    if isinstance(data, dict):
        scenes: Any = data.get("scenes")
    elif isinstance(data, list):
        scenes = data
    else:
        scenes = None

    if not isinstance(scenes, list):
        raise ValueError(f"{path} must contain a scenes array")

    parts: list[str] = []
    for index, scene in enumerate(scenes, start=1):
        if not isinstance(scene, dict):
            raise ValueError(f"Scene {index} is not an object")
        narration = scene.get("narration")
        if not isinstance(narration, str) or not narration.strip():
            raise ValueError(f"Scene {index} is missing narration")
        parts.append(compact_text(narration))

    return parts


def split_chunks(parts: list[str], max_chars: int) -> list[str]:
    if max_chars < 500:
        raise ValueError("--max-chars must be at least 500")

    chunks: list[str] = []
    current: list[str] = []

    for part in parts:
        if len(part) > max_chars:
            raise ValueError(
                f"A single narration scene is {len(part):,} characters, longer than max {max_chars:,}"
            )

        candidate = "\n\n".join([*current, part]) if current else part
        if current and len(candidate) > max_chars:
            chunks.append("\n\n".join(current))
            current = [part]
        else:
            current.append(part)

    if current:
        chunks.append("\n\n".join(current))

    return chunks


def write_chunks(chunks: list[str], chunks_dir: Path) -> None:
    chunks_dir.mkdir(parents=True, exist_ok=True)
    for old_file in chunks_dir.glob("voiceover_part_*.txt"):
        old_file.unlink()

    total = len(chunks)
    for index, chunk in enumerate(chunks, start=1):
        path = chunks_dir / f"voiceover_part_{index:02d}.txt"
        header = f"Part {index}/{total}\n\n"
        path.write_text(header + chunk + "\n", encoding="utf-8")


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Create a plain text voiceover file from output/scenes.json."
    )
    parser.add_argument(
        "input",
        nargs="?",
        type=Path,
        default=DEFAULT_INPUT,
        help=f"Storyboard JSON file. Default: {DEFAULT_INPUT}",
    )
    parser.add_argument(
        "-o",
        "--output",
        type=Path,
        default=DEFAULT_OUTPUT,
        help=f"Voiceover text file. Default: {DEFAULT_OUTPUT}",
    )
    parser.add_argument(
        "--chunks-dir",
        type=Path,
        default=DEFAULT_CHUNKS_DIR,
        help=f"Directory for chunked text files. Default: {DEFAULT_CHUNKS_DIR}",
    )
    parser.add_argument(
        "--max-chars",
        type=int,
        default=DEFAULT_MAX_CHARS,
        help=f"Maximum characters per chunk, including the part header. Default: {DEFAULT_MAX_CHARS}",
    )
    args = parser.parse_args()

    parts = load_narration_parts(args.input)
    narration = "\n\n".join(parts)
    header_budget = len("Part 999/999\n\n")
    chunks = split_chunks(parts, args.max_chars - header_budget)

    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(narration + "\n", encoding="utf-8")
    write_chunks(chunks, args.chunks_dir)

    print(f"Wrote {len(narration):,} characters to {args.output}")
    print(f"Wrote {len(chunks)} chunks to {args.chunks_dir}")
    for index, chunk in enumerate(chunks, start=1):
        header_len = len(f"Part {index}/{len(chunks)}\n\n")
        print(f"  part {index:02d}: {len(chunk) + header_len:,} characters")


if __name__ == "__main__":
    main()
