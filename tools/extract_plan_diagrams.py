#!/usr/bin/env python3
"""Extract mermaid diagrams from the shot-type-labelling plan into .dev/shots/diagrams/."""

import re
import subprocess
import sys
from pathlib import Path

PLAN = Path(__file__).parent.parent / "plans" / "2026-05-19-shot-type-labelling.md"
OUT_DIR = Path(__file__).parent.parent / ".dev" / "shots" / "diagrams"
MMDC = Path(__file__).parent.parent / "node_modules" / ".bin" / "mmdc"

HEADING_RE = re.compile(r"^#{1,6}\s+(.+)$", re.MULTILINE)
MERMAID_RE = re.compile(r"```mermaid\n(.*?)```", re.DOTALL)


def slugify(text: str) -> str:
    text = text.lower()
    text = re.sub(r"[^a-z0-9]+", "_", text)
    return text.strip("_")


def extract(plan_path: Path, out_dir: Path) -> list[Path]:
    source = plan_path.read_text()
    out_dir.mkdir(parents=True, exist_ok=True)

    # Collect (position, heading) pairs so we can associate each diagram with
    # the nearest preceding heading.
    headings = [(m.start(), m.group(1)) for m in HEADING_RE.finditer(source)]

    written: list[Path] = []
    diagram_index: dict[str, int] = {}  # slug → count, for deduplication

    for m in MERMAID_RE.finditer(source):
        pos = m.start()
        diagram = m.group(1).rstrip()

        # Find the closest heading that precedes this diagram.
        preceding = [h for h in headings if h[0] < pos]
        heading = preceding[-1][1] if preceding else "diagram"
        slug = slugify(heading)

        count = diagram_index.get(slug, 0)
        diagram_index[slug] = count + 1
        suffix = f"_{count}" if count > 0 else ""

        out_path = out_dir / f"{slug}{suffix}.mmd"
        out_path.write_text(diagram + "\n")
        written.append(out_path)
        print(f"wrote {out_path.relative_to(out_dir.parent.parent)}")

        png_path = out_path.with_suffix(".png")
        result = subprocess.run(
            [str(MMDC), "-i", str(out_path), "-o", str(png_path)],
            capture_output=True, text=True,
        )
        if result.returncode == 0:
            print(f"wrote {png_path.relative_to(out_dir.parent.parent)}")
        else:
            print(f"mmdc failed for {out_path.name}: {result.stderr.strip()}", file=sys.stderr)

    return written


if __name__ == "__main__":
    plan = Path(sys.argv[1]) if len(sys.argv) > 1 else PLAN
    written = extract(plan, OUT_DIR)
    print(f"\n{len(written)} diagram(s) extracted to {OUT_DIR.relative_to(OUT_DIR.parent.parent)}/")
