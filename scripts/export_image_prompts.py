#!/usr/bin/env python3
"""Export image prompts from a storyboard JSON file to a plain text file.

Default input:
  output/scenes.json

Default output:
  output/image_prompts.txt
"""

from __future__ import annotations

import argparse
import json
import re
from pathlib import Path
from typing import Any


PROJECT_ROOT = Path(__file__).resolve().parents[1]
DEFAULT_INPUT = PROJECT_ROOT / "output" / "scenes.json"
DEFAULT_OUTPUT = PROJECT_ROOT / "output" / "image_prompts.txt"


def compact_one_line(text: str) -> str:
    return re.sub(r"\s+", " ", text).strip()


def load_scenes(path: Path) -> list[dict[str, Any]]:
    with path.open("r", encoding="utf-8") as f:
        data = json.load(f)

    if isinstance(data, dict):
        scenes = data.get("scenes")
    elif isinstance(data, list):
        scenes = data
    else:
        scenes = None

    if not isinstance(scenes, list):
        raise ValueError(f"{path} must contain a scenes array")

    return scenes


def export_prompts(input_path: Path, output_path: Path) -> int:
    scenes = load_scenes(input_path)
    prompts: list[str] = []

    for index, scene in enumerate(scenes, start=1):
        if not isinstance(scene, dict):
            raise ValueError(f"Scene {index} is not an object")

        prompt = scene.get("imagePrompt")
        if not isinstance(prompt, str) or not prompt.strip():
            raise ValueError(f"Scene {index} is missing imagePrompt")

        prompts.append(compact_one_line(prompt))

    output_path.parent.mkdir(parents=True, exist_ok=True)
    output_path.write_text("\n\n".join(prompts) + "\n", encoding="utf-8")
    return len(prompts)


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Create a txt file with one image prompt per frame."
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
        help=f"Prompt text output file. Default: {DEFAULT_OUTPUT}",
    )
    args = parser.parse_args()

    count = export_prompts(args.input, args.output)
    print(f"Wrote {count} image prompts to {args.output}")


if __name__ == "__main__":
    main()
