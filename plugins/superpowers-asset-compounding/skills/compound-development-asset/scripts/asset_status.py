#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

from _asset_utils import AssetFile, discover_superpowers_root, iter_assets, read_text, tokenize_query
from asset_core.issues import issue
from check_completion_gate import canonical_slug, check_archive_coverage
from check_indexes import check_area
from checks.milestone_checks import check_milestone, parse_checklist
from checks.technical_debt_checks import check_technical_debt, parse_debt_metadata


def repo_root_for(superpowers_root: Path) -> Path:
    if superpowers_root.name == "superpowers" and superpowers_root.parent.name == "docs":
        return superpowers_root.parent.parent
    return superpowers_root


def relative(repo_root: Path, path: Path) -> str:
    try:
        return path.relative_to(repo_root).as_posix()
    except ValueError:
        return path.as_posix()


def asset_item(repo_root: Path, asset: AssetFile) -> dict[str, object]:
    return {
        "area": asset.area,
        "kind": asset.kind,
        "date": asset.date,
        "slug": asset.slug,
        "title": asset.title,
        "path": relative(repo_root, asset.path),
    }


def asset_matches(asset: AssetFile, text: str, topic_slug: str, terms: list[str], *, exact_slug: bool = False) -> bool:
    if canonical_slug(asset.slug) == topic_slug:
        return True
    if exact_slug:
        return False
    haystack = f"{asset.path.as_posix()}\n{asset.title or ''}\n{text}".lower()
    return all(term in haystack for term in terms)


def milestone_text(asset: AssetFile) -> str:
    checklist = asset.path.parent / "CHECKLIST.md"
    text = read_text(asset.path)
    if checklist.exists():
        text += "\n" + read_text(checklist)
    return text


def milestone_matches(asset: AssetFile, text: str, topic_slug: str, terms: list[str]) -> bool:
    if canonical_slug(asset.slug) == topic_slug or canonical_slug(asset.title or "") == topic_slug:
        return True
    checklist = asset.path.parent / "CHECKLIST.md"
    if checklist.exists():
        parsed = parse_checklist(checklist)
        slices = parsed["slices"]
        if isinstance(slices, list):
            for item in slices:
                if isinstance(item, dict) and canonical_slug(item.get("title", "")) == topic_slug:
                    return True
    haystack = text.lower()
    return bool(terms) and all(term in haystack for term in terms)


def technical_debt_matches(asset: AssetFile, text: str, topic_slug: str) -> bool:
    if canonical_slug(asset.slug) == topic_slug:
        return True
    metadata = parse_debt_metadata(asset.path)
    return canonical_slug(metadata.get("topic_slug", "")) == topic_slug


def find_assets(superpowers_root: Path, repo_root: Path, topic: str) -> dict[str, list[dict[str, object]]]:
    topic_slug = canonical_slug(topic)
    terms = tokenize_query([topic])
    grouped = {"archives": [], "problems": [], "inbox": [], "milestones": [], "technical-debt": []}
    for asset in iter_assets(superpowers_root, ["archives", "problems", "inbox"]):
        text = read_text(asset.path)
        if asset.area == "archives":
            matches = asset_matches(asset, text, topic_slug, terms, exact_slug=True)
        else:
            matches = asset_matches(asset, text, topic_slug, terms)
        if matches:
            grouped[asset.area].append(asset_item(repo_root, asset))
    for asset in iter_assets(superpowers_root, ["milestones"]):
        text = milestone_text(asset)
        if milestone_matches(asset, text, topic_slug, terms):
            item = asset_item(repo_root, asset)
            item["checklist"] = relative(repo_root, asset.path.parent / "CHECKLIST.md")
            grouped["milestones"].append(item)
    for asset in iter_assets(superpowers_root, ["technical-debt"]):
        text = read_text(asset.path)
        if technical_debt_matches(asset, text, topic_slug):
            grouped["technical-debt"].append(asset_item(repo_root, asset))
    return grouped


def milestone_topic_issues(repo_root: Path, topic_slug: str, milestone_assets: list[dict[str, object]]) -> list[dict[str, str]]:
    issues: list[dict[str, str]] = []
    for item in milestone_assets:
        slug = str(item["slug"])
        issues.extend(check_milestone(repo_root, slug))
        checklist_path = repo_root / str(item.get("checklist", ""))
        if not checklist_path.exists():
            continue
        parsed = parse_checklist(checklist_path)
        slices = parsed["slices"]
        if not isinstance(slices, list):
            continue
        for slice_item in slices:
            if not isinstance(slice_item, dict):
                continue
            if canonical_slug(slice_item.get("title", "")) != topic_slug:
                continue
            archive = str(slice_item.get("archive", "")).strip()
            status = str(slice_item.get("status", "")).strip()
            if status != "Done" or not archive or archive == "None yet.":
                issues.append(
                    issue(
                        "error",
                        "milestone_status_progress_drift",
                        f"Milestone slice status/progress drift for completed topic {topic_slug}.",
                        path=relative(repo_root, checklist_path),
                    )
                )
    return issues


def technical_debt_topic_issues(repo_root: Path, technical_debt_assets: list[dict[str, object]]) -> list[dict[str, str]]:
    issues: list[dict[str, str]] = []
    for item in technical_debt_assets:
        slug = str(item["slug"])
        issues.extend(check_technical_debt(repo_root, slug))
        debt_path = repo_root / str(item["path"])
        if not debt_path.exists():
            continue
        metadata = parse_debt_metadata(debt_path)
        if metadata.get("status") == "Open":
            issues.append(
                issue(
                    "error",
                    "open_technical_debt_matches_topic",
                    "Open technical debt matches the completed topic.",
                    path=relative(repo_root, debt_path),
                )
            )
    return issues


def substatus(items: list[dict[str, object]], issues: list[dict[str, str]]) -> dict[str, object]:
    if not items:
        return {"status": "not_found", "issues": []}
    return {"status": "needs_attention" if issues else "pass", "issues": issues}


def build_status(root: Path, topic: str) -> dict[str, object]:
    superpowers_root = discover_superpowers_root(root)
    repo_root = repo_root_for(superpowers_root)
    grouped = find_assets(superpowers_root, repo_root, topic)
    archive_assets = grouped["archives"]
    non_requirement_assets = grouped["problems"] or grouped["inbox"]
    completion_issues = check_archive_coverage(repo_root, [topic])
    non_requirement_only = (
        bool(non_requirement_assets)
        and not archive_assets
        and completion_issues
        and all(issue["code"] == "completed_topic_not_found" for issue in completion_issues)
    )
    if non_requirement_only:
        completion_issues = []
    archive_required = not non_requirement_only
    requirement_archive = (
        {"status": "found", **archive_assets[0]}
        if archive_assets
        else (
            {"status": "missing", "path": None}
            if archive_required
            else {
                "status": "not_required",
                "path": None,
                "reason": "topic matched problem or inbox assets without requirement archive coverage",
            }
        )
    )

    index_issues = []
    for area in ("archives", "problems", "inbox"):
        index_issues.extend(check_area(superpowers_root, area))
    index_errors = [issue for issue in index_issues if issue["severity"] == "error"]

    completion_errors = [issue for issue in completion_issues if issue["severity"] == "error"]
    milestone_issues = milestone_topic_issues(repo_root, canonical_slug(topic), grouped["milestones"])
    technical_debt_issues = technical_debt_topic_issues(repo_root, grouped["technical-debt"])

    status = "pass"
    if index_errors or completion_errors or requirement_archive["status"] == "missing":
        status = "needs_attention"

    return {
        "status": status,
        "topic": canonical_slug(topic),
        "root": str(repo_root),
        "superpowers_root": str(superpowers_root),
        "requirement_archive": requirement_archive,
        "problem_assets": grouped["problems"],
        "inbox_assets": grouped["inbox"],
        "milestone_assets": grouped["milestones"],
        "technical_debt_assets": grouped["technical-debt"],
        "milestone_status": substatus(grouped["milestones"], milestone_issues),
        "technical_debt_status": substatus(grouped["technical-debt"], technical_debt_issues),
        "indexes": {
            "status": "pass" if not index_issues else "needs_attention",
            "issues": index_issues,
        },
        "completion_gate": {
            "status": "pass" if archive_required and not completion_issues else (
                "needs_attention" if completion_issues else "not_required"
            ),
            "issues": completion_issues,
        },
    }


def print_text(result: dict[str, object]) -> None:
    requirement_archive = result["requirement_archive"]
    assert isinstance(requirement_archive, dict)
    problem_assets = result["problem_assets"]
    inbox_assets = result["inbox_assets"]
    milestone_assets = result["milestone_assets"]
    technical_debt_assets = result["technical_debt_assets"]
    indexes = result["indexes"]
    completion_gate = result["completion_gate"]
    assert isinstance(problem_assets, list)
    assert isinstance(inbox_assets, list)
    assert isinstance(milestone_assets, list)
    assert isinstance(technical_debt_assets, list)
    assert isinstance(indexes, dict)
    assert isinstance(completion_gate, dict)

    print(f"Asset status: {result['status']}")
    print(f"- requirement_archive: {requirement_archive['status']}")
    if requirement_archive.get("path"):
        print(f"  path: {requirement_archive['path']}")
    print(f"- problem_assets: {len(problem_assets)}")
    for item in problem_assets:
        print(f"  - {item['path']}")
    print(f"- inbox_assets: {len(inbox_assets)}")
    for item in inbox_assets:
        print(f"  - {item['path']}")
    print(f"- milestone_assets: {len(milestone_assets)}")
    for item in milestone_assets:
        print(f"  - {item['path']}")
    print(f"- technical_debt_assets: {len(technical_debt_assets)}")
    for item in technical_debt_assets:
        print(f"  - {item['path']}")
    print(f"- indexes: {indexes['status']}")
    print(f"- completion_gate: {completion_gate['status']}")


def main() -> int:
    parser = argparse.ArgumentParser(description="Summarize Superpowers asset status for one topic.")
    parser.add_argument("root", nargs="?", default=".", help="Repository root or docs/superpowers path.")
    parser.add_argument("--topic", required=True, help="Requirement topic slug or keywords.")
    parser.add_argument("--json", action="store_true")
    args = parser.parse_args()

    result = build_status(Path(args.root).resolve(), args.topic)
    if args.json:
        print(json.dumps(result, ensure_ascii=False, indent=2))
    else:
        print_text(result)
    return 1 if result["status"] != "pass" else 0


if __name__ == "__main__":
    sys.exit(main())
