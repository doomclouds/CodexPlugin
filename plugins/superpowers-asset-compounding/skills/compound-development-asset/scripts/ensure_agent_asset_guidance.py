#!/usr/bin/env python3
from __future__ import annotations

import argparse
import difflib
import json
import sys
from pathlib import Path

from _asset_utils import discover_superpowers_root


START_MARKER = "<!-- asset-compounding-guidance:start -->"
END_MARKER = "<!-- asset-compounding-guidance:end -->"


def skill_root() -> Path:
    return Path(__file__).resolve().parents[1]


def template_text() -> str:
    template = skill_root() / "references" / "agents-asset-guidance-template.md"
    return template.read_text(encoding="utf-8").strip() + "\n"


def default_agents_file(root: Path) -> Path:
    for name in ("AGENTS.md", "AGENT.md"):
        candidate = root / name
        if candidate.exists():
            return candidate
    return root / "AGENTS.md"


def replace_managed_block(text: str, block: str) -> tuple[str, str]:
    start = text.find(START_MARKER)
    end = text.find(END_MARKER)
    if start >= 0 and end >= 0 and end > start:
        end += len(END_MARKER)
        current_block = text[start:end].strip()
        if current_block == block.strip():
            return text, "unchanged"
        new_text = text[:start].rstrip() + "\n\n" + block.rstrip() + "\n\n" + text[end:].lstrip()
        return new_text, "updated"
    return insert_block(text, block), "inserted"


def insert_block(text: str, block: str) -> str:
    if not text.strip():
        return "# AGENTS\n\n" + block

    preferred_headings = [
        "## Document Maintenance Rules",
        "## Current Repository Hotspots",
        "## Language And Style",
    ]
    for heading in preferred_headings:
        index = text.find("\n" + heading)
        if index >= 0:
            return text[:index].rstrip() + "\n\n" + block.rstrip() + "\n\n" + text[index + 1 :].lstrip()

    return text.rstrip() + "\n\n" + block


def check_existing(text: str) -> dict[str, object]:
    has_block = START_MARKER in text and END_MARKER in text
    required_terms = [
        "docs/superpowers/specs",
        "docs/superpowers/plans",
        "docs/superpowers/archives",
        "docs/superpowers/problems",
        "docs/superpowers/inbox",
        "Milestone Navigation",
        "docs/milestones/INDEX.md",
        "Technical Debt Navigation",
        "docs/technical-debt/INDEX.md",
    ]
    missing_terms = [term for term in required_terms if term not in text]
    return {
        "has_managed_block": has_block,
        "missing_terms": missing_terms,
        "needs_update": (not has_block) or bool(missing_terms),
    }


def unified_diff(old: str, new: str, path: Path) -> str:
    return "".join(
        difflib.unified_diff(
            old.splitlines(keepends=True),
            new.splitlines(keepends=True),
            fromfile=f"{path}:before",
            tofile=f"{path}:after",
        )
    )


def main() -> int:
    parser = argparse.ArgumentParser(description="Ensure AGENTS.md contains asset-compounding retrieval guidance.")
    parser.add_argument("root", nargs="?", default=".", help="Repository root.")
    parser.add_argument("--file", help="Explicit AGENTS.md/AGENT.md path.")
    parser.add_argument("--write", action="store_true", help="Write changes. Default is check/dry-run only.")
    parser.add_argument("--diff", action="store_true", help="Print a unified diff for the proposed change.")
    parser.add_argument("--json", action="store_true", help="Emit machine-readable JSON.")
    args = parser.parse_args()

    root = Path(args.root).resolve()
    agents_file = Path(args.file).resolve() if args.file else default_agents_file(root)
    old_text = agents_file.read_text(encoding="utf-8") if agents_file.exists() else ""
    block = template_text()
    new_text, action = replace_managed_block(old_text, block)

    try:
        superpowers_root = str(discover_superpowers_root(root))
    except FileNotFoundError:
        superpowers_root = None

    existing = check_existing(old_text)
    changed = old_text != new_text
    result = {
        "agents_file": str(agents_file),
        "superpowers_root": superpowers_root,
        "action": action if changed else "unchanged",
        "changed": changed,
        "has_managed_block": existing["has_managed_block"],
        "missing_terms": existing["missing_terms"],
        "needs_update": changed,
    }

    if args.write and changed:
        agents_file.parent.mkdir(parents=True, exist_ok=True)
        agents_file.write_text(new_text, encoding="utf-8", newline="\n")

    if args.json:
        print(json.dumps(result, ensure_ascii=False, indent=2))
    else:
        if args.write and changed:
            print(f"UPDATED: {agents_file}")
        elif changed:
            print(f"NEEDS UPDATE: {agents_file} ({action})")
        else:
            print(f"OK: {agents_file} already has managed asset-compounding guidance")
        if existing["missing_terms"]:
            print("missing_terms:")
            for term in existing["missing_terms"]:
                print(f"- {term}")
        if args.diff and changed:
            print(unified_diff(old_text, new_text, agents_file))

    return 0 if (args.write or not changed) else 1


if __name__ == "__main__":
    sys.exit(main())
