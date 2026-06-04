#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import subprocess
import sys
import xml.etree.ElementTree as ET
from pathlib import Path

from _asset_utils import discover_superpowers_root, iter_assets


STRUCTURE_IGNORES = {
    ".git",
    ".github",
    ".idea",
    ".vs",
    ".vscode",
    ".worktrees",
    "bin",
    "obj",
    "docs",
    "src",
    "tests",
}


def git_ignored(root: Path, path: Path) -> bool:
    try:
        completed = subprocess.run(
            ["git", "status", "--ignored", "--short", "--", str(path.relative_to(root))],
            cwd=root,
            check=False,
            text=True,
            encoding="utf-8",
            stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL,
        )
    except (OSError, ValueError):
        return False
    return any(line.startswith("!! ") for line in completed.stdout.splitlines())


def issue(severity: str, code: str, message: str, *, path: str | None = None) -> dict[str, str]:
    item = {"severity": severity, "code": code, "message": message}
    if path:
        item["path"] = path
    return item


def relative(root: Path, path: Path) -> str:
    try:
        return path.relative_to(root).as_posix()
    except ValueError:
        return path.as_posix()


def canonical_slug(slug: object) -> str:
    value = str(slug).strip().lower().replace("_", "-").replace(" ", "-")
    if value.endswith(".md"):
        value = value[:-3]
    if len(value) > 11 and value[4] == "-" and value[7] == "-":
        value = value[11:]
    for suffix in ("-implementation-plan", "-implementation", "-design", "-archives", "-problem", "-inbox"):
        if value.endswith(suffix):
            return value[: -len(suffix)]
    return value


def collect_archive_coverage(root: Path) -> tuple[dict[str, set[str]], dict[str, list[Path]], list[dict[str, str]]]:
    try:
        superpowers_root = discover_superpowers_root(root)
    except FileNotFoundError:
        return {}, {}, [
            issue(
                "warning",
                "superpowers_assets_missing",
                "docs/superpowers could not be found; archive coverage could not be checked.",
            )
        ]

    assets = iter_assets(superpowers_root, ["specs", "plans", "archives"])
    by_slug: dict[str, set[str]] = {}
    paths_by_slug: dict[str, list[Path]] = {}
    for asset in assets:
        slug = canonical_slug(asset.slug)
        by_slug.setdefault(slug, set()).add(asset.kind)
        paths_by_slug.setdefault(slug, []).append(asset.path)
    return by_slug, paths_by_slug, []


def check_archive_coverage(root: Path, topics: list[str]) -> list[dict[str, str]]:
    issues: list[dict[str, str]] = []
    normalized_topics = {canonical_slug(topic) for topic in topics if str(topic).strip()}
    by_slug, paths_by_slug, discovery_issues = collect_archive_coverage(root)
    if discovery_issues:
        if normalized_topics:
            return [
                issue(
                    "error",
                    "superpowers_assets_missing",
                    "Completed topic check was requested, but docs/superpowers could not be found.",
                )
            ]
        return []

    if not normalized_topics:
        for slug, kinds in sorted(by_slug.items()):
            if {"spec", "plan"}.issubset(kinds) and "archive" not in kinds:
                related_paths = ", ".join(relative(root, path) for path in sorted(paths_by_slug.get(slug, [])))
                issues.append(
                    issue(
                        "warning",
                        "possible_missing_requirement_archive",
                        (
                            f"Topic '{slug}' has spec+plan coverage but no archive. "
                            "If this thread is complete, run with --completed-topic or route to archive."
                        ),
                        path=related_paths,
                    )
                )
        return issues

    matched = False
    for slug in sorted(normalized_topics):
        kinds = by_slug.get(slug, set())
        if kinds:
            matched = True
        if {"spec", "plan"}.issubset(kinds) and "archive" not in kinds:
            related_paths = ", ".join(relative(root, path) for path in sorted(paths_by_slug.get(slug, [])))
            issues.append(
                issue(
                    "error",
                    "missing_requirement_archive",
                    (
                        f"Completed topic '{slug}' has spec+plan coverage but no archive. "
                        "Route to archive or update-existing before close-out."
                    ),
                    path=related_paths,
                )
            )
    if not matched:
        issues.append(
            issue(
                "error",
                "completed_topic_not_found",
                "Completed topic check did not find matching spec, plan, or archive assets.",
                path=", ".join(sorted(normalized_topics)),
            )
        )
    return issues


def check_asset_gate_text(text: str, issues: list[dict[str, str]]) -> None:
    if "asset_gate:" not in text:
        issues.append(
            issue(
                "error",
                "missing_asset_gate_output",
                "Meaningful close-out requested an auditable asset_gate block, but none was found.",
            )
        )
        return
    for required in (
        "event_type:",
        "route:",
        "reason:",
        "evidence:",
        "related_assets:",
        "asset_candidates:",
        "deferred_signals:",
        "next_step:",
    ):
        if required not in text:
            issues.append(
                issue(
                    "warning",
                    "incomplete_asset_gate_output",
                    f"asset_gate output is missing '{required}'.",
                )
            )


def project_names_under(root: Path, area: str) -> set[str]:
    area_root = root / area
    if not area_root.is_dir():
        return set()
    return {path.parent.name for path in area_root.rglob("*.csproj")}


def check_relayout_leftovers(root: Path) -> list[dict[str, str]]:
    issues: list[dict[str, str]] = []
    names = project_names_under(root, "src") | project_names_under(root, "tests")
    for name in sorted(names):
        old_dir = root / name
        if not old_dir.is_dir():
            continue
        code = "ignored_old_project_directory" if git_ignored(root, old_dir) else "old_project_directory_after_relayout"
        issues.append(
            issue(
                "warning",
                code,
                "Project layout uses src/tests, but a same-named root directory still exists.",
                path=relative(root, old_dir),
            )
        )
    return issues


def slnx_folders(path: Path) -> tuple[set[str], list[str]]:
    text = path.read_text(encoding="utf-8")
    try:
        root = ET.fromstring(text)
    except ET.ParseError:
        folders = set()
        project_paths: list[str] = []
        for line in text.splitlines():
            if 'Folder Name="' in line:
                start = line.find('Folder Name="') + len('Folder Name="')
                end = line.find('"', start)
                folders.add(line[start:end])
            if 'Project Path="' in line:
                start = line.find('Project Path="') + len('Project Path="')
                end = line.find('"', start)
                project_paths.append(line[start:end])
        return folders, project_paths

    folders = {element.attrib["Name"] for element in root.iter("Folder") if "Name" in element.attrib}
    project_paths = [element.attrib["Path"] for element in root.iter("Project") if "Path" in element.attrib]
    return folders, project_paths


def check_solution_folders(root: Path) -> list[dict[str, str]]:
    issues: list[dict[str, str]] = []
    for slnx in sorted(root.glob("*.slnx")):
        folders, project_paths = slnx_folders(slnx)
        normalized = [path.replace("\\", "/") for path in project_paths]
        has_src_projects = any(path.startswith("src/") for path in normalized)
        has_test_projects = any(path.startswith("tests/") for path in normalized)
        if has_src_projects and "/src/" not in folders:
            issues.append(
                issue(
                    "warning",
                    "missing_src_solution_folder",
                    "Solution references src projects but lacks a /src/ solution folder.",
                    path=relative(root, slnx),
                )
            )
        if has_test_projects and "/tests/" not in folders:
            issues.append(
                issue(
                    "warning",
                    "missing_tests_solution_folder",
                    "Solution references test projects but lacks a /tests/ solution folder.",
                    path=relative(root, slnx),
                )
            )
    return issues


def discover_possible_root_dirs(root: Path) -> list[str]:
    dirs: list[str] = []
    for child in sorted(root.iterdir()):
        if not child.is_dir() or child.name in STRUCTURE_IGNORES:
            continue
        if child.name.startswith("."):
            continue
        dirs.append(child.name)
    return dirs


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Check asset-compounding completion gate evidence.")
    parser.add_argument("root", nargs="?", default=".", help="Repository root.")
    parser.add_argument("--handoff-text", default="", help="Final handoff or gate text to inspect.")
    parser.add_argument("--handoff-file", help="File containing final handoff or gate text.")
    parser.add_argument("--require-asset-gate", action="store_true", help="Fail if handoff text lacks asset_gate output.")
    parser.add_argument("--asset-candidate", action="append", default=[], help="Candidate lesson from reviewer/subagent/tool output. Can repeat.")
    parser.add_argument("--completed-topic", action="append", default=[], help="Completed requirement slug/topic to verify archive coverage. Can repeat.")
    parser.add_argument("--require-asset-candidates", action="store_true", help="Warn when no candidate list was supplied.")
    parser.add_argument("--skip-structure-checks", action="store_true", help="Skip src/tests and solution-folder checks.")
    parser.add_argument("--json", action="store_true")
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    root = Path(args.root).resolve()
    issues: list[dict[str, str]] = []
    candidates = [candidate.strip() for candidate in args.asset_candidate if candidate.strip()]

    handoff_text = args.handoff_text
    if args.handoff_file:
        handoff_path = Path(args.handoff_file)
        if not handoff_path.is_absolute():
            handoff_path = root / handoff_path
        if handoff_path.is_file():
            handoff_text += "\n" + handoff_path.read_text(encoding="utf-8")
        else:
            issues.append(issue("error", "handoff_file_missing", "Handoff file does not exist.", path=str(handoff_path)))

    if args.require_asset_gate:
        check_asset_gate_text(handoff_text, issues)

    if args.require_asset_candidates and not candidates:
        issues.append(
            issue(
                "warning",
                "missing_asset_candidates",
                "No asset candidates were supplied; record 'none' explicitly when there are none.",
            )
        )

    issues.extend(check_archive_coverage(root, args.completed_topic))

    if not args.skip_structure_checks and root.is_dir():
        issues.extend(check_relayout_leftovers(root))
        issues.extend(check_solution_folders(root))

    errors = [item for item in issues if item["severity"] == "error"]
    result = {
        "status": "needs_attention" if issues else "pass",
        "issues": issues,
        "asset_candidates": candidates,
        "checks": {
            "asset_gate_required": args.require_asset_gate,
            "asset_candidates_required": args.require_asset_candidates,
            "completed_topics": [canonical_slug(topic) for topic in args.completed_topic],
            "structure_checks": not args.skip_structure_checks,
            "possible_root_dirs": discover_possible_root_dirs(root) if root.is_dir() else [],
        },
        "note": "This script reports completion-gate evidence and candidates; the main agent still chooses the final asset route.",
    }

    if args.json:
        print(json.dumps(result, ensure_ascii=False, indent=2))
    else:
        print(f"status: {result['status']}")
        for item in issues:
            path = f" ({item['path']})" if "path" in item else ""
            print(f"- {item['severity']} {item['code']}: {item['message']}{path}")
        if candidates:
            print("asset_candidates:")
            for candidate in candidates:
                print(f"- {candidate}")
        print(result["note"])
    return 1 if errors else 0


if __name__ == "__main__":
    sys.exit(main())
