#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import subprocess
import sys
from pathlib import Path

from _asset_utils import discover_superpowers_root, iter_assets, read_text, tokenize_query
from find_related_assets import score_asset


def git_changed_files(root: Path) -> list[str]:
    try:
        completed = subprocess.run(
            ["git", "status", "--short"],
            cwd=root,
            check=False,
            text=True,
            encoding="utf-8",
            stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL,
        )
    except OSError:
        return []
    files: list[str] = []
    for line in completed.stdout.splitlines():
        if not line.strip():
            continue
        candidate = line[3:].strip()
        if " -> " in candidate:
            candidate = candidate.split(" -> ", 1)[1]
        files.append(candidate)
    return files


def classify_from_files(files: list[str]) -> tuple[set[str], list[str]]:
    routes: set[str] = set()
    facts: list[str] = []
    normalized = [path.replace("\\", "/") for path in files]
    if any("/docs/superpowers/inbox/" in f or f.startswith("docs/superpowers/inbox/") for f in normalized):
        routes.add("inbox")
        facts.append("Changed files include inbox assets.")
    if any("/docs/superpowers/problems/" in f or f.startswith("docs/superpowers/problems/") for f in normalized):
        routes.add("update-existing")
        facts.append("Changed files include problem assets; check whether this updates an existing failure class.")
    if any("/docs/superpowers/archives/" in f or f.startswith("docs/superpowers/archives/") for f in normalized):
        routes.add("archive")
        facts.append("Changed files include archive assets.")
    if any("/docs/superpowers/specs/" in f or "/docs/superpowers/plans/" in f or f.startswith("docs/superpowers/specs/") or f.startswith("docs/superpowers/plans/") for f in normalized):
        routes.add("archive")
        facts.append("Changed files include specs/plans; a completed thread may need archive coverage.")
    if any(f.startswith("src/") or f.startswith("tests/") for f in normalized):
        facts.append("Changed files include implementation or tests.")
    return routes, facts


def classify_from_text(text: str, *, problem_gate: bool = False) -> tuple[set[str], list[str]]:
    routes: set[str] = set()
    facts: list[str] = []
    lower = text.lower()
    uncertain_terms = ["uncertain", "unknown", "maybe", "possibly", "not sure", "plausible", "suspect", "inbox", "不确定", "可能", "待确认"]
    strong_problem_terms = [
        "root cause",
        "failure mode",
        "recovery rule",
        "postmortem",
        "flaky",
        "deadlock",
        "race",
        "regression",
        "根因",
        "故障模式",
        "恢复规则",
        "竞态",
        "回归",
    ]
    weak_problem_terms = ["bug", "failure", "fix", "issue", "problem", "问题", "故障", "失败", "修复"]
    release_feedback_terms = [
        "github actions",
        "actions",
        "workflow",
        "pipeline",
        "artifact",
        "upload-artifact",
        "download-artifact",
        "release",
        "tag",
        "node 20",
        "node.js 20",
        "deprecated",
        "warning",
        "ci",
        "发布",
        "流水线",
        "警告",
        "弃用",
    ]
    gate_problem_terms = [
        "review finding",
        "code quality",
        "spec review",
        "spec mismatch",
        "subagent",
        "tool quirk",
        "provider quirk",
        "candidate",
        "问题归档",
        "代码质量",
        "规格审查",
        "spec审查",
        "子代理",
        "工具问题",
        "候选",
    ]
    archive_terms = ["completed", "accepted", "delivered", "verified", "tests passed", "feature", "requirement", "完成", "验收", "提交", "归档"]
    lightweight_terms = [
        "minor",
        "small",
        "polish",
        "style",
        "visual",
        "copy",
        "label",
        "spacing",
        "position",
        "sizing",
        "font",
        "微调",
        "轻微",
        "视觉",
        "文案",
        "字号",
        "位置",
        "间距",
    ]
    has_uncertain = any(term in lower for term in uncertain_terms)
    has_strong_problem = any(term in lower for term in strong_problem_terms)
    has_weak_problem = any(term in lower for term in weak_problem_terms)
    has_release_feedback = any(term in lower for term in release_feedback_terms)
    has_gate_problem = any(term in lower for term in gate_problem_terms)
    has_archive = any(term in lower for term in archive_terms)
    has_lightweight = any(term in lower for term in lightweight_terms)
    if has_lightweight and has_weak_problem and not problem_gate and not (has_uncertain or has_strong_problem or has_archive):
        facts.append("Keywords suggest lightweight polish; choose none unless an existing asset should be updated.")
        return routes, facts
    if problem_gate and has_lightweight and has_weak_problem and not (has_uncertain or has_strong_problem or has_archive):
        routes.add("inbox")
        facts.append("Problem-gate mode treats lightweight problem signals as inbox candidates instead of dropping them.")
    if has_uncertain:
        routes.add("inbox")
        facts.append("Keywords suggest uncertainty; consider inbox before formal promotion.")
    if problem_gate and has_gate_problem:
        routes.add("inbox")
        facts.append("Problem-gate keywords suggest a review/subagent/tool signal; park in inbox unless evidence is stable.")
    if problem_gate and has_release_feedback:
        routes.add("inbox")
        facts.append("Release/CI feedback keywords suggest a post-release signal; update a related asset or park it in inbox.")
    if has_strong_problem:
        routes.add("new-problem")
        facts.append("Keywords suggest a stable debugging pattern or failure mode.")
    elif has_weak_problem:
        routes.add("inbox")
        facts.append("Keywords suggest a possible problem signal; park in inbox unless root cause evidence is stable.")
    if has_archive:
        routes.add("archive")
        facts.append("Keywords suggest a completed requirement or feature thread.")
    return routes, facts


def find_related(superpowers_root: Path, terms: list[str], limit: int) -> list[dict[str, object]]:
    if not terms:
        return []
    results: list[dict[str, object]] = []
    for asset in iter_assets(superpowers_root):
        text = read_text(asset.path)
        score, hits = score_asset(asset.path, text, terms)
        if score <= 0:
            continue
        results.append(
            {
                "score": score,
                "area": asset.area,
                "kind": asset.kind,
                "date": asset.date,
                "slug": asset.slug,
                "path": str(asset.path),
                "hits": hits,
            }
        )
    results.sort(key=lambda item: (-int(item["score"]), str(item["path"])))
    return results[:limit]


def canonical_slug(slug: object) -> str:
    value = str(slug)
    for suffix in ("-implementation-plan", "-implementation", "-design", "-archives", "-problem", "-inbox"):
        if value.endswith(suffix):
            return value[: -len(suffix)]
    return value


def classify_from_related_assets(related: list[dict[str, object]]) -> tuple[set[str], list[str]]:
    routes: set[str] = set()
    facts: list[str] = []
    by_slug: dict[str, set[str]] = {}
    for item in related:
        slug = canonical_slug(item["slug"])
        by_slug.setdefault(slug, set()).add(str(item["kind"]))

    for slug, kinds in sorted(by_slug.items()):
        has_completed_thread = "spec" in kinds and "plan" in kinds
        has_archive_coverage = "archive" in kinds
        if has_completed_thread and not has_archive_coverage:
            routes.add("archive")
            facts.append(
                f"Related assets include spec+plan for '{slug}' without archive coverage; completed threads should be archived."
            )

    return routes, facts


def normalize_routes(routes: set[str], related: list[dict[str, object]]) -> list[str]:
    has_archive_intent = "archive" in routes
    has_problem_intent = "new-problem" in routes
    related_kinds = {str(item["kind"]) for item in related}
    if has_archive_intent and "archive" in related_kinds:
        routes.discard("archive")
        routes.add("update-existing")
    if "inbox" in routes and any(item["kind"] in {"problem", "archive", "inbox"} for item in related):
        routes.discard("inbox")
        routes.add("update-existing")
    if any(item["kind"] in {"problem", "archive", "inbox"} for item in related):
        if "new-problem" in routes:
            routes.discard("new-problem")
            routes.add("update-existing")
        elif routes == set():
            routes.add("update-existing")
    if has_archive_intent and has_problem_intent and "update-existing" in routes:
        return ["both"]
    if "archive" in routes and ("new-problem" in routes or "update-existing" in routes):
        return ["both"]
    if not routes:
        return ["none"]
    order = ["inbox", "update-existing", "new-problem", "archive", "both", "none"]
    return [route for route in order if route in routes]


def main() -> int:
    parser = argparse.ArgumentParser(description="Suggest an asset-compounding route from changed files and keywords.")
    parser.add_argument("root", nargs="?", default=".", help="Repository root or docs/superpowers path.")
    parser.add_argument("--keywords", nargs="*", default=[], help="Topic words, symptoms, slugs, or summary text.")
    parser.add_argument("--changed-file", action="append", default=[], help="Changed file path. Can be repeated. Defaults to git status when omitted.")
    parser.add_argument("--problem-gate", action="store_true", help="Bias weak task-boundary problem signals toward inbox.")
    parser.add_argument("--limit", type=int, default=8)
    parser.add_argument("--json", action="store_true")
    args = parser.parse_args()

    root = Path(args.root).resolve()
    try:
        superpowers_root = discover_superpowers_root(root)
    except FileNotFoundError:
        result = {
            "routes": ["none"],
            "facts": ["No docs/superpowers layout found; do not auto-write project assets."],
            "related": [],
        }
        print(json.dumps(result, ensure_ascii=False, indent=2) if args.json else "none: no docs/superpowers layout found")
        return 0

    files = args.changed_file or git_changed_files(root)
    query_text = " ".join(args.keywords + files)
    terms = tokenize_query(args.keywords + files)
    file_routes, file_facts = classify_from_files(files)
    text_routes, text_facts = classify_from_text(query_text, problem_gate=args.problem_gate)
    related = find_related(superpowers_root, terms, args.limit)
    related_routes, related_facts = classify_from_related_assets(related)
    routes = normalize_routes(file_routes | text_routes | related_routes, related)
    result = {
        "routes": routes,
        "facts": file_facts + text_facts + related_facts,
        "changed_files": files,
        "related": related,
        "note": "This is a suggestion, not a hard gate. Use judgment for final routing.",
    }

    if args.json:
        print(json.dumps(result, ensure_ascii=False, indent=2))
    else:
        print(f"suggested_routes: {', '.join(routes)}")
        for fact in result["facts"]:
            print(f"- {fact}")
        if related:
            print("related_assets:")
            for item in related:
                print(f"- {item['kind']} {item['slug']} ({item['score']}): {item['path']}")
        print(result["note"])
    return 0


if __name__ == "__main__":
    sys.exit(main())
