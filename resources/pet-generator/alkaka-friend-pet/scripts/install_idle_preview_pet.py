#!/usr/bin/env python3
"""Install a temporary playable pet package as soon as idle is ready."""

from __future__ import annotations

import argparse
import json
import shutil
import subprocess
import sys
from pathlib import Path


ROW_SPECS = [
    ("idle", 6),
    ("waving", 4),
    ("jumping", 5),
    ("failed", 8),
    ("waiting", 6),
    ("review", 6),
]


def run(command: list[str]) -> None:
    print("+ " + " ".join(command), flush=True)
    subprocess.run(command, check=True, text=True)


def copy_idle_frames(source_dir: Path, target_root: Path) -> None:
    idle_frames = sorted(source_dir.glob("*.png"))
    if not idle_frames:
        raise SystemExit(f"idle frames missing: {source_dir}")
    for state, frame_count in ROW_SPECS:
        state_dir = target_root / state
        state_dir.mkdir(parents=True, exist_ok=True)
        for index in range(frame_count):
            shutil.copy2(idle_frames[index % len(idle_frames)], state_dir / f"{index:02d}.png")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--run-dir", required=True)
    parser.add_argument("--petctl", required=True)
    parser.add_argument("--pet-id", required=True)
    parser.add_argument("--display-name", required=True)
    parser.add_argument("--description", required=True)
    parser.add_argument("--force", action="store_true")
    args = parser.parse_args()

    scripts_dir = Path(__file__).resolve().parent
    run_dir = Path(args.run_dir).expanduser().resolve()
    preview_dir = run_dir / "preview"
    frames_source = preview_dir / "idle-frames"
    frames_root = preview_dir / "frames"
    spritesheet = preview_dir / "spritesheet.png"
    webp = preview_dir / "spritesheet.webp"
    summary_path = preview_dir / "preview-summary.json"

    if not (run_dir / "decoded" / "idle.png").is_file():
        raise SystemExit(f"decoded idle strip missing: {run_dir / 'decoded' / 'idle.png'}")

    if preview_dir.exists():
        shutil.rmtree(preview_dir)
    frames_source.mkdir(parents=True, exist_ok=True)

    run([
        sys.executable,
        str(scripts_dir / "extract_strip_frames.py"),
        "--decoded-dir",
        str(run_dir / "decoded"),
        "--output-dir",
        str(frames_source),
        "--states",
        "idle",
        "--method",
        "auto",
    ])
    copy_idle_frames(frames_source / "idle", frames_root)
    run([
        sys.executable,
        str(scripts_dir / "compose_atlas.py"),
        "--frames-root",
        str(frames_root),
        "--output",
        str(spritesheet),
        "--webp-output",
        str(webp),
    ])

    command = [
        sys.executable,
        str(Path(args.petctl).expanduser().resolve()),
        "install",
        str(spritesheet),
        "--id",
        args.pet_id,
        "--name",
        args.display_name,
        "--description",
        args.description,
    ]
    if args.force:
        command.append("--force")
    run(command)

    summary = {
        "ok": True,
        "partial": True,
        "run_dir": str(run_dir),
        "spritesheet": str(spritesheet),
        "webp": str(webp),
        "pet_id": args.pet_id,
    }
    summary_path.write_text(json.dumps(summary, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(summary, indent=2), flush=True)


if __name__ == "__main__":
    main()
