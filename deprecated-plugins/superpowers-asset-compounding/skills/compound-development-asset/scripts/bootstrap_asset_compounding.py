#!/usr/bin/env python3
from __future__ import annotations

import argparse
import difflib
import json
import sys
from pathlib import Path

import ensure_agent_asset_guidance as guidance


ASSET_DIRS = [
    "docs/superpowers",
    "docs/superpowers/specs",
    "docs/superpowers/plans",
    "docs/superpowers/archives",
    "docs/superpowers/problems",
    "docs/superpowers/inbox",
    "docs/milestones",
    "docs/technical-debt",
]


def ensure_dirs(root: Path, write: bool) -> list[str]:
    created: list[str] = []
    for relative in ASSET_DIRS:
        path = root / relative
        if path.exists():
            continue
        created.append(relative)
        if write:
            path.mkdir(parents=True, exist_ok=True)
    return created


def managed_guidance(root: Path, agents_file: Path, write: bool) -> dict[str, object]:
    old_text = agents_file.read_text(encoding="utf-8") if agents_file.exists() else ""
    block = guidance.template_text()
    new_text, action = guidance.replace_managed_block(old_text, block)
    changed = old_text != new_text

    if write and changed:
        agents_file.parent.mkdir(parents=True, exist_ok=True)
        agents_file.write_text(new_text, encoding="utf-8", newline="\n")

    return {
        "agents_file": str(agents_file),
        "action": action if changed else "unchanged",
        "changed": changed,
        "has_managed_block_before": guidance.check_existing(old_text)["has_managed_block"],
        "diff": unified_diff(old_text, new_text, agents_file) if changed else "",
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


def bootstrap(root: Path, agents_file: Path | None, write: bool) -> dict[str, object]:
    root = root.resolve()
    target_agents_file = agents_file.resolve() if agents_file else guidance.default_agents_file(root)
    created_dirs = ensure_dirs(root, write)
    guidance_result = managed_guidance(root, target_agents_file, write)
    changed = bool(created_dirs) or bool(guidance_result["changed"])

    return {
        "root": str(root),
        "changed": changed,
        "created_dirs": created_dirs,
        "guidance": {
            key: value
            for key, value in guidance_result.items()
            if key != "diff"
        },
        "diff": guidance_result["diff"],
    }


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Bootstrap Superpowers asset compounding in a repository.")
    parser.add_argument("root", nargs="?", default=".", help="Repository root.")
    parser.add_argument("--file", help="Explicit AGENTS.md/AGENT.md path.")
    parser.add_argument("--write", action="store_true", help="Write changes. Default is dry-run only.")
    parser.add_argument("--diff", action="store_true", help="Print the AGENTS.md managed block diff.")
    parser.add_argument("--json", action="store_true", help="Emit machine-readable JSON.")
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    root = Path(args.root)
    agents_file = Path(args.file) if args.file else None
    result = bootstrap(root, agents_file, args.write)

    if args.json:
        print(json.dumps(result, ensure_ascii=False, indent=2))
    else:
        verb = "UPDATED" if args.write and result["changed"] else "NEEDS UPDATE" if result["changed"] else "OK"
        print(f"{verb}: asset compounding bootstrap for {result['root']}")
        if result["created_dirs"]:
            print("created_dirs:")
            for relative in result["created_dirs"]:
                print(f"- {relative}")
        print(f"guidance_action: {result['guidance']['action']}")
        if args.diff and result["diff"]:
            print(result["diff"])

    return 0 if args.write or not result["changed"] else 1


if __name__ == "__main__":
    sys.exit(main())
